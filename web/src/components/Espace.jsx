import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import './espace.css';

// Briques communes des espaces Enseignant / Censeur / Surveillant, pensées
// d'abord pour le mobile : cartes de rubriques, cartes de classes avec
// avancement de la saisie, choix de classe avant d'ouvrir une page.

// ── Données « mon espace » ────────────────────────────────────────────────
// Mises en cache le temps de la session (navigation entre rubriques sans
// rechargement visible), mais toujours revalidées en arrière-plan pour que
// l'avancement reflète les dernières saisies.
const cache = new Map();
// Requêtes en cours, partagées : deux composants montés ensemble (ex : la
// grille de saisie et son en-tête) ne déclenchent qu'un seul appel.
const enCours = new Map();

export function viderCacheEspaces() {
  cache.clear();
  enCours.clear();
}

function chargerEspace(base) {
  if (!enCours.has(base)) {
    const promesse = api.get(`${base}/mon-espace`)
      .then((data) => {
        cache.set(base, data);
        return data;
      })
      .finally(() => enCours.delete(base));
    enCours.set(base, promesse);
  }
  return enCours.get(base);
}

export function useMonEspace(base) {
  const [state, setState] = useState(() => ({ loading: !cache.has(base), data: cache.get(base) || null, error: null }));
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    chargerEspace(base)
      .then((data) => {
        if (!cancelled) setState({ loading: false, data, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState((s) => ({ loading: false, data: s.data, error }));
      });
    return () => { cancelled = true; };
  }, [base, version]);

  return { ...state, recharger: () => setVersion((v) => v + 1) };
}

// ── En-tête de page d'espace (titre + retour) ────────────────────────────
export function EspaceTitre({ titre, sousTitre, icon, retour = '/', retourLabel = 'Accueil', children }) {
  return (
    <div className="esp-titre">
      {retour && (
        <Link to={retour} className="esp-retour" aria-label={`Retour : ${retourLabel}`}>
          <i className="bx bx-chevron-left" />
          <span>{retourLabel}</span>
        </Link>
      )}
      <div className="esp-titre-ligne">
        {icon && <span className="esp-titre-icone"><i className={`bx ${icon}`} /></span>}
        <div className="flex-grow-1 min-w-0">
          <h4 className="mb-0">{titre}</h4>
          {sousTitre && <p className="esp-titre-sous mb-0">{sousTitre}</p>}
        </div>
        {children && <div className="esp-titre-actions">{children}</div>}
      </div>
    </div>
  );
}

// ── Rubriques ─────────────────────────────────────────────────────────────
export function RubriqueCard({ to, label, icon, color = 'primary', description, badge }) {
  return (
    <Link to={to} className={`esp-rubrique esp-tone-${color}`}>
      <span className="esp-rubrique-icone"><i className={`bx ${icon}`} /></span>
      <span className="esp-rubrique-label">{label}</span>
      {description && <span className="esp-rubrique-desc">{description}</span>}
      {badge && <span className="esp-rubrique-badge">{badge}</span>}
    </Link>
  );
}

// ── Avancement de la saisie ───────────────────────────────────────────────
export function Avancement({ saisies, attendues, libelle, compact = false }) {
  if (!attendues) {
    return <div className="esp-avancement esp-avancement-vide">{libelle ? `${libelle} · ` : ''}Aucune note attendue</div>;
  }
  const n = Math.min(saisies, attendues);
  const pct = Math.round((n / attendues) * 100);
  const termine = n >= attendues;
  const ton = termine ? 'success' : n === 0 ? 'muted' : 'primary';
  return (
    <div className={`esp-avancement esp-avancement-${ton}`}>
      {!compact && (
        <div className="esp-avancement-tete">
          <span>{libelle}</span>
          <span className="esp-avancement-chiffre">{n}/{attendues}{termine && <i className="bx bx-check-circle ms-1" />}</span>
        </div>
      )}
      <div className="esp-barre" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${n} notes saisies sur ${attendues}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {!compact && <div className="esp-avancement-pied">{termine ? 'Terminé' : `Il reste ${attendues - n} note${attendues - n > 1 ? 's' : ''}`}</div>}
    </div>
  );
}

// ── Carte de classe ───────────────────────────────────────────────────────
export function ClasseCard({ cycle, titre, sousTitre, effectif, avancement, extra, onClick, to }) {
  const contenu = (
    <>
      <div className="esp-classe-tete">
        <span className="esp-classe-cycle">{cycle || 'Classe'}</span>
        <span className="esp-classe-effectif" title="Effectif"><i className="bx bx-group" />{effectif ?? 0}</span>
      </div>
      <div className="esp-classe-nom">{titre}</div>
      {sousTitre && <div className="esp-classe-sous">{sousTitre}</div>}
      {extra && <div className="esp-classe-extra">{extra}</div>}
      {avancement && <Avancement {...avancement} />}
      <i className="bx bx-chevron-right esp-classe-fleche" />
    </>
  );
  if (to) return <Link to={to} className="esp-classe">{contenu}</Link>;
  return <button type="button" className="esp-classe" onClick={onClick}>{contenu}</button>;
}

// ── Pastilles (choix rapide, défilement horizontal sur mobile) ───────────
export function Pastilles({ options, value, onChange, ariaLabel }) {
  return (
    <div className="esp-pastilles" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={String(o.value) === String(value)}
          className={`esp-pastille ${String(o.value) === String(value) ? 'active' : ''}`}
          onClick={() => onChange(String(o.value))}
        >
          {o.label}
          {o.badge != null && <span className="esp-pastille-badge">{o.badge}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Grille de cartes de classes, regroupées par cycle ────────────────────
// items : [{ key, cycle, ...props de ClasseCard }]
export function ClassesGrille({ items, loading, vide, rechercheDes = 8 }) {
  const [cycle, setCycle] = useState('');
  const [recherche, setRecherche] = useState('');
  const cycles = useMemo(() => [...new Set(items.map((i) => i.cycle || 'Autres'))], [items]);

  const filtres = items.filter((i) => (!cycle || (i.cycle || 'Autres') === cycle)
    && (!recherche.trim() || `${i.titre} ${i.sousTitre || ''}`.toLowerCase().includes(recherche.trim().toLowerCase())));
  const groupes = cycles
    .map((c) => ({ cycle: c, items: filtres.filter((i) => (i.cycle || 'Autres') === c) }))
    .filter((g) => g.items.length);

  if (loading) {
    return (
      <div className="esp-grille">
        {[0, 1, 2].map((i) => <div key={i} className="esp-classe esp-squelette" aria-hidden="true" />)}
      </div>
    );
  }
  if (!items.length) {
    return <div className="esp-vide"><i className="bx bx-chalkboard" /><p className="mb-0">{vide}</p></div>;
  }

  return (
    <>
      {(cycles.length > 1 || items.length > rechercheDes) && (
        <div className="esp-filtres">
          {items.length > rechercheDes && (
            <div className="esp-recherche">
              <i className="bx bx-search" />
              <input type="search" className="form-control" placeholder="Rechercher une classe…" value={recherche} onChange={(e) => setRecherche(e.target.value)} aria-label="Rechercher une classe" />
            </div>
          )}
          {cycles.length > 1 && (
            <Pastilles
              ariaLabel="Filtrer par cycle"
              value={cycle}
              onChange={setCycle}
              options={[{ value: '', label: 'Tous' }, ...cycles.map((c) => ({ value: c, label: c }))]}
            />
          )}
        </div>
      )}
      {!groupes.length && <div className="esp-vide"><i className="bx bx-filter-alt" /><p className="mb-0">Aucune classe ne correspond.</p></div>}
      {groupes.map((g) => (
        <section key={g.cycle} className="mb-4">
          {cycles.length > 1 && <h6 className="esp-groupe-titre">{g.cycle} <span>{g.items.length}</span></h6>}
          <div className="esp-grille">
            {g.items.map(({ key, ...props }) => <ClasseCard key={key} {...props} />)}
          </div>
        </section>
      ))}
    </>
  );
}

// ── Choix de classe (Censeur / Surveillant) ──────────────────────────────
// Sans ?classe= dans l'URL : grille des classes assignées. Avec : barre de
// la classe choisie (et retour à la grille), puis la page elle-même.
const VIDE_CLASSES = "Aucune classe ne vous a été assignée pour le moment. Contactez l'administration de votre établissement.";

export function AvecChoixClasse({ titre, sousTitre, icon, avecAvancement = true, vide = VIDE_CLASSES, children }) {
  const espace = useMonEspace('/censeur');
  const [params, setParams] = useSearchParams();
  const classeId = params.get('classe');
  const data = espace.data || {};
  const classes = data.classes || [];
  const sequence = data.sequence_courante;

  if (!classeId) {
    const items = classes.map((c) => ({
      key: c.id,
      cycle: c.cycle_libelle,
      titre: c.label,
      effectif: c.effectif,
      extra: c.matieres_total ? `${c.matieres_completes}/${c.matieres_total} matière${c.matieres_total > 1 ? 's' : ''} complète${c.matieres_total > 1 ? 's' : ''}` : 'Aucune matière affectée',
      avancement: avecAvancement && sequence ? { saisies: c.notes_saisies, attendues: c.notes_attendues, libelle: sequence.libelle } : null,
      onClick: () => setParams({ classe: String(c.id) }),
    }));
    return (
      <>
        <EspaceTitre titre={titre} sousTitre={sousTitre || 'Choisissez une classe'} icon={icon} />
        {espace.error && !espace.data && <div className="alert alert-danger">{espace.error.message}</div>}
        <ClassesGrille
          items={items}
          loading={espace.loading}
          vide={vide}
        />
      </>
    );
  }

  const classe = classes.find((c) => String(c.id) === String(classeId)) || null;
  return (
    <>
      <BarreClasse
        titre={titre}
        classe={classe ? classe.label : espace.loading ? '…' : `Classe #${classeId}`}
        cycle={classe?.cycle_libelle}
        effectif={classe?.effectif}
        onChanger={() => setParams({})}
      />
      {children({ classeId, classe, espace })}
    </>
  );
}

export function BarreClasse({ titre, classe, cycle, effectif, detail, onChanger, changerLabel = 'Mes classes' }) {
  return (
    <div className="esp-barre-classe">
      <button type="button" className="esp-retour" onClick={onChanger}>
        <i className="bx bx-chevron-left" />
        <span>{changerLabel}</span>
      </button>
      <div className="esp-barre-classe-ligne">
        <div className="min-w-0">
          <div className="esp-barre-classe-rubrique">{titre}</div>
          <div className="esp-barre-classe-nom">{classe}</div>
          {detail && <div className="esp-barre-classe-detail">{detail}</div>}
        </div>
        <div className="esp-barre-classe-meta">
          {cycle && <span className="badge bg-label-primary">{cycle}</span>}
          {effectif != null && <span className="badge bg-label-secondary"><i className="bx bx-group me-1" />{effectif}</span>}
        </div>
      </div>
    </div>
  );
}

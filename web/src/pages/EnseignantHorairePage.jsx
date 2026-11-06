import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import { downloadCsv, StatCard, TableCard, useToast } from '../components/ui';
import { colorClassFor, FeuilleEmploiDuTemps, GrilleJour, heureCourte, JOURS, LEGEND_COLORS } from './HorairePage';
import { EspaceTitre } from '../components/Espace';
import './horaire.css';
import Select from '../components/Select';
import { SkelLignesTableau, SkelListe } from '../components/Skeleton';

// Portage de server/static/templates/enseignant/horaire.html : grille
// hebdomadaire (lecture seule) des cours de l'enseignant connecté, via
// /enseignant/mon-espace et /enseignant/horaire (pré-filtrés côté serveur).

export default function EnseignantHorairePage() {
  const toast = useToast();
  const { user } = useAuth();
  const etablissement = useEtablissementCourant();
  const nomEnseignant = user?.nom || '';

  const [annees, setAnnees] = useState([]);
  const [annee, setAnnee] = useState('');
  const [grille, setGrille] = useState({ creneaux: [], horaires: [] });
  const [loading, setLoading] = useState(true);
  const [alerte, setAlerte] = useState('');
  const [imprimer, setImprimer] = useState(false);

  const signaler = useCallback((e, prefixe) => {
    if (e.status === 404) setAlerte(e.message || "Aucun profil enseignant n'est relié à ce compte. Contactez l'administration de votre établissement.");
    else toast(`${prefixe} : ${e.message}`, 'error');
  }, [toast]);

  useEffect(() => {
    api.get('/enseignant/mon-espace').then((payload) => {
      const list = payload.annees_scolaires || [];
      if (!list.length) throw Object.assign(new Error('Aucune année scolaire trouvée'), { status: 0 });
      setAnnees(list);
      setAnnee(String((list.find((a) => a.active) || list[0]).id));
    }).catch((e) => {
      signaler(e, 'Mon espace');
      setLoading(false);
    });
  }, [signaler]);

  const loadHoraire = useCallback(async () => {
    if (!annee) return;
    setLoading(true);
    try {
      const payload = await api.get(`/enseignant/horaire?annee_scolaire_id=${annee}`);
      setGrille({ creneaux: payload.creneaux || [], horaires: payload.horaires || [] });
    } catch (e) {
      setGrille({ creneaux: [], horaires: [] });
      signaler(e, 'Emploi du temps');
    } finally {
      setLoading(false);
    }
  }, [annee, signaler]);

  useEffect(() => {
    loadHoraire();
  }, [loadHoraire]);

  useEffect(() => {
    if (!imprimer) return undefined;
    const after = () => setImprimer(false);
    window.addEventListener('afterprint', after);
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after); };
  }, [imprimer]);

  const { creneaux, horaires } = grille;
  const index = useMemo(() => Object.fromEntries(horaires.map((h) => [`${h.jour_semaine}|${h.creneau_id}`, h])), [horaires]);
  const total = creneaux.length * JOURS.length;
  const legende = [...new Set(horaires.map((h) => h.matiere_libelle))].filter(Boolean);
  const anneeLibelle = annees.find((a) => String(a.id) === String(annee))?.libelle || '—';

  const exportCsv = () => {
    const rows = [['Créneau', ...JOURS], ...creneaux.map((c) => [
      `${c.libelle} (${heureCourte(c.heure_debut)}-${heureCourte(c.heure_fin)})`,
      ...JOURS.map((j) => {
        const h = index[`${j}|${c.id}`];
        return h ? `${h.classe_label} — ${h.matiere_libelle}${h.salle ? ` — ${h.salle}` : ''}` : '';
      }),
    ])];
    downloadCsv(`emploi_du_temps_${(nomEnseignant || 'enseignant').replace(/\s+/g, '_')}.csv`, rows);
    toast('Le fichier CSV a été téléchargé (compatible Excel).');
  };

  return (
    <>
      <EspaceTitre titre="Mon emploi du temps" sousTitre="Vos cours de la semaine, toutes classes confondues" icon="bx-calendar">
        <button type="button" className="btn btn-icon btn-outline-secondary" title="Recharger la grille" aria-label="Actualiser" onClick={async () => { await loadHoraire(); toast('Grille actualisée.'); }}><i className="bx bx-refresh" /></button>
        <button type="button" className="btn btn-icon btn-outline-secondary" title="Imprimer mon emploi du temps" aria-label="Imprimer" onClick={() => setImprimer(true)}><i className="bx bx-printer" /></button>
        <button type="button" className="btn btn-icon btn-outline-secondary d-none d-sm-inline-flex" title="Exporter la grille en Excel/CSV" aria-label="Exporter" onClick={exportCsv}><i className="bx bx-spreadsheet" /></button>
      </EspaceTitre>

      {alerte && <div className="alert alert-warning"><i className="bx bx-error me-2" />{alerte}</div>}

      <div className="row g-3 mb-4 d-none d-md-flex">
        <StatCard label="Cours / semaine" loading={loading} value={horaires.length} sub={`sur ${total} créneaux`} icon="bx-book-open" color="primary" />
        <StatCard label="Classes couvertes" loading={loading} value={new Set(horaires.map((h) => h.classe_id)).size} sub="classes distinctes" icon="bx-chalkboard" color="info" />
        <StatCard label="Créneaux libres" loading={loading} value={Math.max(total - horaires.length, 0)} sub="disponibles" icon="bx-checkbox-checked" color="success" />
        <StatCard label="Jours couverts" value={JOURS.length} sub="Lundi à Samedi" icon="bx-calendar-week" color="warning" />
      </div>

      <div className="card mb-3">
        <div className="card-body py-3 d-flex flex-wrap align-items-end gap-3">
          <div>
            <label className="form-label">Année scolaire</label>
            <Select className="form-select form-select-sm" style={{ minWidth: 170 }} value={annee} onChange={(e) => setAnnee(e.target.value)}>
              {annees.length ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (Active)' : ''}</option>) : <option value="">{loading ? 'Chargement…' : 'Indisponible'}</option>}
            </Select>
          </div>
          <div className="ms-auto d-none d-md-block">
            <label className="form-label">Légende</label>
            <div>
              {loading ? <small className="text-muted">La couleur de chaque matière apparaît une fois la grille chargée.</small>
                : legende.length ? legende.map((nom) => <span key={nom} className="legend-item"><span className="legend-dot" style={{ background: LEGEND_COLORS[colorClassFor(nom)] }} />{nom}</span>)
                  : <small className="text-muted">Aucune matière programmée pour l'instant.</small>}
            </div>
          </div>
        </div>
      </div>

      <TableCard
        title={<>Ma charge horaire — {nomEnseignant || 'Moi'}</>}
        icon="bx-user-voice"
        actions={<span className="badge bg-label-secondary">{horaires.length} cours / semaine</span>}
        footer={<small className="text-muted"><i className="bx bx-info-circle me-1" />Cette grille reflète les cours qui vous ont été attribués par l'administration de votre établissement. Pour toute correction, contactez le censeur ou l'administration.</small>}
      >
        <div className="d-md-none">
          {loading ? (
            <SkelListe lignes={4} label="Chargement de l'emploi du temps…" className="px-3" />
          ) : !creneaux.length ? (
            <div className="text-center text-muted py-5 px-3">Aucun cours programmé pour l'instant sur cette année scolaire.</div>
          ) : (
            <GrilleJour
              creneaux={creneaux}
              horaires={horaires}
              carte={(h) => (
                <div className={`cours-chip edt-jour-cours readonly ${colorClassFor(h.matiere_libelle)}`}>
                  <span className="chip-matiere">{h.classe_label || 'Classe'}</span>
                  <span className="chip-meta"><i className="bx bx-book" /> {h.matiere_libelle || 'Matière'}</span>
                  {h.salle && <span className="chip-meta"><i className="bx bx-door-open" /> {h.salle}</span>}
                </div>
              )}
            />
          )}
        </div>
        <div className="horaire-grid-wrap d-none d-md-block">
          <table className="horaire-table">
            <thead><tr><th className="time-col">Créneau</th>{JOURS.map((j) => <th key={j}>{j}</th>)}</tr></thead>
            <tbody>
              {loading ? (
                <SkelLignesTableau colonnes={7} lignes={5} label="Chargement de la grille…" />
              ) : !creneaux.length ? (
                <tr><td colSpan={7} className="text-center text-muted py-5">Aucun cours programmé pour l'instant sur cette année scolaire.</td></tr>
              ) : creneaux.map((c) => (
                <tr key={c.id}>
                  <td className="time-col"><div className="time-slot-label">{c.libelle}</div><div className="time-slot-range">{heureCourte(c.heure_debut)} - {heureCourte(c.heure_fin)}</div></td>
                  {JOURS.map((jour) => {
                    const h = index[`${jour}|${c.id}`];
                    return (
                      <td key={jour}>
                        {h ? (
                          <div className={`cours-chip readonly ${colorClassFor(h.matiere_libelle)}`}>
                            <span className="chip-matiere">{h.classe_label || 'Classe'}</span>
                            <span className="chip-meta"><i className="bx bx-book" /> {h.matiere_libelle || 'Matière'}</span>
                            {h.salle && <span className="chip-meta"><i className="bx bx-door-open" /> {h.salle}</span>}
                          </div>
                        ) : <div className="cell-empty" />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </TableCard>

      {imprimer && (
        <div className="edt-print print-area">
          <FeuilleEmploiDuTemps
            etablissement={etablissement}
            anneeLibelle={anneeLibelle}
            sousTitre="EMPLOI DU TEMPS INDIVIDUEL"
            champs={[
              { label: 'Enseignant', valeur: nomEnseignant || '—' },
              { label: 'Matières enseignées', valeur: [...new Set(horaires.map((h) => h.matiere_libelle).filter(Boolean))].join(', ') || '—' },
              { label: 'Quota horaire', valeur: `${horaires.length} h / semaine` },
            ]}
            creneaux={creneaux}
            signatures={["L'Enseignant", 'Le Censeur']}
            cellule={(jour, c) => {
              const h = index[`${jour}|${c.id}`];
              return h ? [h.classe_label, h.matiere_libelle] : null;
            }}
          />
        </div>
      )}
    </>
  );
}

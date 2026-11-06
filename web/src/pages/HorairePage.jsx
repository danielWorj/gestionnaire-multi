import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import { downloadCsv, IconBtn, PageHeader, StatCard, TableCard, Tabs, TBody, useConfirm, useToast } from '../components/ui';
import { Pastilles } from '../components/Espace';
import './horaire.css';
import Select from '../components/Select';
import ImportModal from '../components/importConfigs';
import { SkelLignesTableau } from '../components/Skeleton';

// Portage de server/static/templates/horaire.html (Admin) et
// censeur/horaire.html (Censeur / Surveillant) — même page, seuls quelques
// libellés changent. Côté serveur, /classes/, /horaires/ et
// /matieres-classe/ sont déjà restreints aux classes assignées pour un
// Censeur/Surveillant : la page affiche ce que l'API renvoie.

export const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const COLOR_CLASSES = ['chip-c1', 'chip-c2', 'chip-c3', 'chip-c4', 'chip-c5'];
export const LEGEND_COLORS = { 'chip-c1': '#696cff', 'chip-c2': '#71dd37', 'chip-c3': '#ffab00', 'chip-c4': '#03c3ec', 'chip-c5': '#6d28d9' };

const VARIANTS = {
  admin: { subtitle: 'Construisez et consultez les grilles horaires par classe et par enseignant.', aucuneClasse: 'Aucune classe', signataire: 'Censeur' },
  censeur: { subtitle: 'Construisez et consultez les grilles horaires des classes dont vous avez la charge.', aucuneClasse: 'Aucune classe assignée', signataire: 'Censeur' },
  surveillant: { subtitle: 'Construisez et consultez les grilles horaires des classes dont vous avez la charge.', aucuneClasse: 'Aucune classe assignée', signataire: 'Surveillant' },
};

export function colorClassFor(key) {
  let hash = 0;
  const str = key || '';
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return COLOR_CLASSES[hash % COLOR_CLASSES.length];
}
export const heureCourte = (iso) => (iso ? iso.slice(0, 5).replace(':', 'h') : '--:--');
function dureeMinutes(debut, fin) {
  if (!debut || !fin) return '--';
  const [h1, m1] = debut.split(':').map(Number);
  const [h2, m2] = fin.split(':').map(Number);
  const total = (h2 * 60 + m2) - (h1 * 60 + m1);
  return total > 0 ? `${total} min` : '--';
}
const sortCreneaux = (list) => [...list].sort((a, b) => (a.heure_debut || '').localeCompare(b.heure_debut || ''));

const jourDuJour = () => {
  const d = new Date().getDay();
  return JOURS[d >= 1 && d <= 6 ? d - 1 : 0];
};

// Vue « un jour à la fois » des grilles hebdomadaires, pour les petits
// écrans : pastilles des jours (avec le nombre de cours), puis les créneaux
// en liste. `carte(h)` dessine un cours ; `onAdd` rend les créneaux libres
// cliquables (grille éditable).
export function GrilleJour({ creneaux, horaires, carte, onAdd }) {
  const [jour, setJour] = useState(jourDuJour);
  const index = useMemo(() => Object.fromEntries(horaires.map((h) => [`${h.jour_semaine}|${h.creneau_id}`, h])), [horaires]);
  const parJour = useMemo(() => Object.fromEntries(JOURS.map((j) => [j, horaires.filter((h) => h.jour_semaine === j).length])), [horaires]);
  return (
    <div className="edt-jour">
      <Pastilles ariaLabel="Jour" value={jour} onChange={setJour} options={JOURS.map((j) => ({ value: j, label: j.slice(0, 3), badge: parJour[j] || null }))} />
      <div className="edt-jour-titre">{jour}{jour === jourDuJour() && <span className="badge bg-label-primary ms-2">Aujourd'hui</span>}</div>
      <div className="edt-jour-liste">
        {creneaux.map((c) => {
          const h = index[`${jour}|${c.id}`];
          return (
            <div key={c.id} className="edt-jour-ligne">
              <div className="edt-jour-heure"><strong>{heureCourte(c.heure_debut)}</strong><span>{heureCourte(c.heure_fin)}</span></div>
              {h ? carte(h) : onAdd
                ? <button type="button" className="edt-jour-libre clickable" onClick={() => onAdd(jour, c.id)}><i className="bx bx-plus" /> Ajouter un cours</button>
                : <div className="edt-jour-libre">{c.libelle} · libre</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HorairePage({ variant = 'admin', classeImposee = null }) {
  const cfg = VARIANTS[variant];
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { activeEtablissementId } = useAuth();
  const etablissement = useEtablissementCourant();

  const [data, setData] = useState({ annees: [], cycles: [], classes: [], enseignants: [], matieres: [], matieresClasse: [], creneaux: [], horaires: [] });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('classe');
  const [annee, setAnnee] = useState('');
  const [classeId, setClasseId] = useState('');
  const [enseignantId, setEnseignantId] = useState('');
  const [modal, setModal] = useState(null);
  const [impression, setImpression] = useState(null);
  const [importOuvert, setImportOuvert] = useState(false);

  const safe = useCallback((path, label) => api.get(path).catch((e) => { if (label) toast(`${label} : ${e.message}`, 'error'); return []; }), [toast]);

  const loadHoraires = useCallback(async () => {
    const horaires = await safe('/horaires/', 'Horaires');
    setData((d) => ({ ...d, horaires }));
  }, [safe]);

  const loadCreneaux = useCallback(async () => {
    const creneaux = sortCreneaux(await safe('/creneaux-horaires/', 'Créneaux horaires'));
    setData((d) => ({ ...d, creneaux }));
  }, [safe]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    let annees = [];
    try {
      annees = await api.get('/annees-scolaires/');
      if (!annees.length) throw new Error('Aucune année scolaire trouvée');
    } catch (e) {
      toast(`Années scolaires : ${e.message}`, 'error');
    }
    const [cycles, classes, enseignantsRaw, matieres, creneaux] = await Promise.all([
      safe('/cycles/'), safe('/classes/', 'Classes'), safe('/enseignants/', 'Enseignants'), safe('/matieres/', 'Matières'), safe('/creneaux-horaires/', 'Créneaux horaires'),
    ]);
    const matieresClasse = await safe('/matieres-classe/', 'Matières-classe');
    const horaires = await safe('/horaires/', 'Horaires');
    const enseignants = enseignantsRaw.map((e) => ({ ...e, nom_complet: `${e.prenom || ''} ${e.nom || ''}`.trim() || e.nom || `Enseignant #${e.id}` }));
    setData({ annees, cycles, classes, enseignants, matieres, matieresClasse, creneaux: sortCreneaux(creneaux), horaires });
    setAnnee((prev) => prev || String((annees.find((a) => a.active) || annees[0])?.id ?? ''));
    setClasseId((prev) => (classeImposee ? String(classeImposee) : prev || String(classes[0]?.id ?? '')));
    setEnseignantId((prev) => prev || String(enseignants[0]?.id ?? ''));
    setLoading(false);
  }, [safe, toast, classeImposee]);

  useEffect(() => {
    loadAll();
  }, [loadAll, activeEtablissementId]);

  const { annees, cycles, classes, enseignants, matieres, matieresClasse, creneaux, horaires } = data;

  const classeLabel = useCallback((c) => {
    if (!c) return 'Classe';
    if (c.libelle || c.nom) return c.libelle || c.nom;
    return [cycles.find((cy) => cy.id === c.cycle_id)?.libelle, c.option].filter(Boolean).join(' ') || `Classe #${c.id}`;
  }, [cycles]);

  // matiere_classe_id -> { ...mc, matiere_nom, enseignant_nom, classe_nom }
  const mcIndex = useMemo(() => {
    const index = {};
    matieresClasse.forEach((mc) => {
      const matiere = matieres.find((m) => m.id === mc.matiere_id);
      const enseignant = enseignants.find((e) => e.id === mc.enseignant_id);
      const classe = classes.find((c) => c.id === mc.classe_id);
      index[mc.id] = {
        ...mc,
        matiere_nom: matiere ? (matiere.libelle || matiere.nom) : 'Matière',
        enseignant_nom: enseignant ? enseignant.nom_complet : 'Enseignant',
        classe_nom: classe ? classeLabel(classe) : 'Classe',
      };
    });
    return index;
  }, [matieresClasse, matieres, enseignants, classes, classeLabel]);

  const horairesEnrichis = useMemo(() => horaires.map((h) => ({ ...h, mc: mcIndex[h.matiere_classe_id] || null })), [horaires, mcIndex]);
  const horairesClasse = useMemo(() => horairesEnrichis.filter((h) => h.annee_scolaire_id === Number(annee) && h.mc && h.mc.classe_id === Number(classeId)), [horairesEnrichis, annee, classeId]);
  const horairesEnseignant = useMemo(() => horairesEnrichis.filter((h) => h.annee_scolaire_id === Number(annee) && h.mc && h.mc.enseignant_id === Number(enseignantId)), [horairesEnrichis, annee, enseignantId]);

  const classeCourante = classes.find((c) => c.id === Number(classeId));
  const enseignantCourant = enseignants.find((e) => e.id === Number(enseignantId));
  const anneeLibelle = annees.find((a) => a.id === Number(annee))?.libelle || '—';
  const totalCreneaux = creneaux.length * JOURS.length;

  const stats = tab === 'classe'
    ? [
      ['Cours programmés', horairesClasse.length, `sur ${totalCreneaux} créneaux`, 'bx-book-open', 'primary'],
      ['Créneaux définis', creneaux.length, 'dans la semaine', 'bx-time', 'info'],
      ['Créneaux libres', Math.max(totalCreneaux - horairesClasse.length, 0), 'à compléter', 'bx-checkbox-checked', 'success'],
      ['Jours couverts', JOURS.length, 'Lundi à Samedi', 'bx-calendar-week', 'warning'],
    ]
    : tab === 'enseignant'
      ? [
        ['Cours enseignés', horairesEnseignant.length, `sur ${totalCreneaux} créneaux`, 'bx-book-open', 'primary'],
        ['Classes couvertes', new Set(horairesEnseignant.map((h) => h.mc?.classe_nom)).size, 'classes distinctes', 'bx-chalkboard', 'info'],
        ['Créneaux libres', Math.max(totalCreneaux - horairesEnseignant.length, 0), 'disponibles', 'bx-checkbox-checked', 'success'],
        ['Jours couverts', JOURS.length, 'Lundi à Samedi', 'bx-calendar-week', 'warning'],
      ]
      : [['Créneaux définis', creneaux.length, 'au total', 'bx-time', 'primary']];

  const legende = [...new Set(horairesClasse.map((h) => h.mc?.matiere_nom))].filter(Boolean);

  /* ── Actions ── */
  const supprimerCours = async (h) => {
    if (!(await confirm("Supprimer ce cours de l'emploi du temps ? Cette action est irréversible."))) return;
    try {
      await api.del(`/horaires/${h.id}`);
      toast("Cours supprimé de l'emploi du temps.");
      await loadHoraires();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const supprimerCreneau = async (c) => {
    if (!(await confirm(`Supprimer le créneau "${c.libelle}" ? Les cours qui l'utilisent seront également supprimés.`))) return;
    try {
      await api.del(`/creneaux-horaires/${c.id}`);
      toast('Créneau horaire supprimé.');
      await loadCreneaux();
      await loadHoraires();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  /* ── Impression ── */
  useEffect(() => {
    if (!impression) return undefined;
    const after = () => setImpression(null);
    window.addEventListener('afterprint', after);
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after); };
  }, [impression]);

  const imprimerClasse = async () => {
    if (!classeId) {
      toast("Sélectionnez d'abord une classe à imprimer.", 'error');
      return;
    }
    await loadHoraires();
    setImpression({
      mode: 'classe',
      sousTitre: 'GRILLE DE LA CLASSE',
      champs: [{ label: 'Classe', valeur: classeLabel(classeCourante) }, { label: 'Cours / semaine', valeur: horairesClasse.length }],
    });
  };

  const imprimerEnseignant = async () => {
    if (!enseignantId) {
      toast("Sélectionnez d'abord un enseignant à imprimer.", 'error');
      return;
    }
    await loadHoraires();
    const ens = enseignantCourant || {};
    setImpression({
      mode: 'enseignant',
      sousTitre: 'EMPLOI DU TEMPS INDIVIDUEL',
      champs: [
        { label: 'Enseignant', valeur: ens.nom_complet || ens.nom || '—' },
        { label: 'Grade / Matière', valeur: ens.grade || ens.matiere || '—' },
        { label: 'Quota horaire', valeur: `${horairesEnseignant.length} h / semaine` },
      ],
    });
  };

  const exportCsv = () => {
    if (tab === 'creneaux') {
      downloadCsv('creneaux_horaires.csv', [['Libellé', 'Heure de début', 'Heure de fin', 'Durée'], ...creneaux.map((c) => [c.libelle, heureCourte(c.heure_debut), heureCourte(c.heure_fin), dureeMinutes((c.heure_debut || '').slice(0, 5), (c.heure_fin || '').slice(0, 5))])]);
    } else {
      const mode = tab;
      const list = mode === 'classe' ? horairesClasse : horairesEnseignant;
      const index = Object.fromEntries(list.map((h) => [`${h.jour_semaine}|${h.creneau_id}`, h]));
      const rows = [['Créneau', ...JOURS], ...creneaux.map((c) => [
        `${c.libelle} (${heureCourte(c.heure_debut)} - ${heureCourte(c.heure_fin)})`,
        ...JOURS.map((j) => {
          const h = index[`${j}|${c.id}`];
          if (!h) return '';
          return mode === 'classe' ? `${h.mc?.matiere_nom || 'Matière'} (${h.mc?.enseignant_nom || 'Enseignant'})` : `${h.mc?.classe_nom || 'Classe'} (${h.mc?.matiere_nom || 'Matière'})`;
        }),
      ])];
      const nom = mode === 'classe' ? `emploi_du_temps_${classeLabel(classeCourante).replace(/\s+/g, '_')}.csv` : `charge_horaire_${(enseignantCourant?.nom_complet || 'enseignant').replace(/\s+/g, '_')}.csv`;
      downloadCsv(nom, rows);
    }
    toast('Le fichier CSV a été téléchargé (compatible Excel).');
  };

  const afterSave = async (msg, reloadCreneaux) => {
    setModal(null);
    toast(msg);
    if (reloadCreneaux) await loadCreneaux();
    await loadHoraires();
  };

  return (
    <>
      {classeImposee ? (
        <div className="d-flex flex-wrap gap-2 mb-3">
          <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'cours', data: null })}><i className="bx bx-plus me-1" /> Nouveau cours</button>
          <button type="button" className="btn btn-icon btn-outline-secondary" title="Imprimer l'emploi du temps de la classe" aria-label="Imprimer" onClick={imprimerClasse}><i className="bx bx-printer" /></button>
          <button type="button" className="btn btn-icon btn-outline-secondary" title="Exporter la vue active en Excel/CSV" aria-label="Exporter" onClick={exportCsv}><i className="bx bx-spreadsheet" /></button>
        </div>
      ) : (
        <PageHeader title="Emploi du temps" subtitle={cfg.subtitle}>
          <button type="button" className="btn btn-outline-secondary btn-sm" title="Imprimer l'emploi du temps de la classe sélectionnée" onClick={imprimerClasse}><i className="bx bx-printer me-1" /> Imprimer (classe)</button>
          <button type="button" className="btn btn-outline-secondary btn-sm" title="Imprimer l'emploi du temps de l'enseignant sélectionné" onClick={imprimerEnseignant}><i className="bx bx-printer me-1" /> Imprimer (enseignant)</button>
          <button type="button" className="btn btn-outline-secondary btn-sm" title="Exporter la vue active en Excel/CSV" onClick={exportCsv}><i className="bx bx-spreadsheet me-1" /> Exporter Excel</button>
          <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => setImportOuvert(true)}><i className="bx bx-import me-1" /> Importer (Excel, CSV, Word)</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'cours', data: null })}><i className="bx bx-plus me-1" /> Nouveau cours</button>
        </PageHeader>
      )}

      <div className={`row g-3 mb-4 ${classeImposee ? 'd-none d-md-flex' : ''}`}>
        {stats.map(([label, value, sub, icon, color]) => <StatCard key={label} label={label} loading={loading} value={value} sub={sub} icon={icon} color={color} />)}
      </div>

      <div className="card mb-3">
        <div className="card-body py-3 d-flex flex-wrap align-items-end gap-3">
          <div>
            <label className="form-label">Année scolaire</label>
            <Select className="form-select form-select-sm" style={{ minWidth: 160 }} value={annee} onChange={(e) => setAnnee(e.target.value)}>
              {annees.length ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (Active)' : ''}</option>) : <option value="">{loading ? 'Chargement…' : 'Indisponible'}</option>}
            </Select>
          </div>
          {tab === 'classe' && !classeImposee && (
            <div>
              <label className="form-label">Classe</label>
              <Select className="form-select form-select-sm" style={{ minWidth: 160 }} value={classeId} onChange={(e) => setClasseId(e.target.value)}>
                {classes.length ? classes.map((c) => <option key={c.id} value={c.id}>{classeLabel(c)}</option>) : <option value="">{loading ? 'Chargement…' : cfg.aucuneClasse}</option>}
              </Select>
            </div>
          )}
          {tab === 'enseignant' && (
            <div>
              <label className="form-label">Enseignant</label>
              <Select className="form-select form-select-sm" style={{ minWidth: 220 }} value={enseignantId} onChange={(e) => setEnseignantId(e.target.value)}>
                {enseignants.length ? enseignants.map((e) => <option key={e.id} value={e.id}>{e.nom_complet}</option>) : <option value="">{loading ? 'Chargement…' : 'Aucun enseignant'}</option>}
              </Select>
            </div>
          )}
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

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'classe', icon: 'bx-chalkboard', label: 'Grille par classe' },
          { key: 'enseignant', icon: 'bx-user-voice', label: 'Grille par enseignant' },
          { key: 'creneaux', icon: 'bx-time', label: 'Créneaux horaires' },
        ]}
      />

      {tab === 'classe' && (
        <TableCard
          title={<>Emploi du temps — {classeCourante ? classeLabel(classeCourante) : cfg.aucuneClasse}</>}
          icon="bx-chalkboard"
          actions={<><span className="badge bg-label-secondary">{horairesClasse.length} cours / semaine</span><IconBtn icon="bx-printer" title="Imprimer cette grille" onClick={imprimerClasse} /></>}
          footer={<small className="text-muted"><i className="bx bx-info-circle me-1" />Cliquez sur un cours pour le modifier ou le supprimer, ou sur une case vide pour en ajouter un.</small>}
        >
          <Grille
            mode="classe"
            loading={loading}
            ready={Boolean(classeId && annee)}
            emptyMessage="Sélectionnez une classe."
            creneaux={creneaux}
            horaires={horairesClasse}
            onAdd={(jour, creneauId) => setModal({ kind: 'cours', data: null, preset: { jour, creneauId } })}
            onEdit={(h) => setModal({ kind: 'cours', data: h })}
            onDelete={supprimerCours}
          />
        </TableCard>
      )}

      {tab === 'enseignant' && (
        <TableCard
          title={<>Charge horaire — {enseignantCourant?.nom_complet || '—'}</>}
          icon="bx-user-voice"
          actions={<><span className="badge bg-label-secondary">{horairesEnseignant.length} cours / semaine</span><IconBtn icon="bx-printer" title="Imprimer cette grille" onClick={imprimerEnseignant} /></>}
          footer={<small className="text-muted"><i className="bx bx-info-circle me-1" />Cette vue permet de repérer rapidement les créneaux libres d'un enseignant avant de lui affecter un nouveau cours.</small>}
        >
          <Grille mode="enseignant" loading={loading} ready={Boolean(enseignantId && annee)} emptyMessage="Sélectionnez un enseignant." creneaux={creneaux} horaires={horairesEnseignant} />
        </TableCard>
      )}

      {tab === 'creneaux' && (
        <TableCard
          title="Créneaux horaires"
          icon="bx-time"
          count={creneaux.length}
          actions={<button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'creneau', data: null })}><i className="bx bx-plus me-1" /> Nouveau créneau</button>}
          footer={<small className="text-muted"><i className="bx bx-info-circle me-1" />Les créneaux sont propres à votre établissement et triés automatiquement par heure de début.</small>}
        >
          <table className="table table-hover mb-0">
            <thead><tr><th>Libellé</th><th>Heure de début</th><th>Heure de fin</th><th>Durée</th><th className="text-end">Actions</th></tr></thead>
            <TBody colSpan={5} loading={loading} rows={creneaux.length} empty="Aucun créneau défini pour le moment.">
              {creneaux.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.libelle}</strong></td>
                  <td>{heureCourte(c.heure_debut)}</td>
                  <td>{heureCourte(c.heure_fin)}</td>
                  <td>{dureeMinutes(c.heure_debut, c.heure_fin)}</td>
                  <td className="text-end text-nowrap">
                    <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setModal({ kind: 'creneau', data: c })} />
                    <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimerCreneau(c)} />
                  </td>
                </tr>
              ))}
            </TBody>
          </table>
        </TableCard>
      )}

      {modal?.kind === 'cours' && (
        <CoursModal
          data={modal.data}
          preset={modal.preset}
          anneeLibelle={anneeLibelle}
          annee={annee}
          classes={classes}
          classeLabel={classeLabel}
          defaultClasse={classeId}
          mcIndex={mcIndex}
          creneaux={creneaux}
          onClose={() => setModal(null)}
          onSaved={() => afterSave('Cours enregistré avec succès.')}
        />
      )}
      {modal?.kind === 'creneau' && <CreneauModal data={modal.data} onClose={() => setModal(null)} onSaved={() => afterSave('Créneau horaire enregistré avec succès.', true)} />}
      {confirmNode}
      {importOuvert && <ImportModal module="emploi-du-temps" optionsInitiales={{ annee_scolaire_id: annee }} onClose={() => setImportOuvert(false)} onImported={loadAll} />}

      {impression && (
        <div className="edt-print print-area">
          <FeuilleImpression
            impression={impression}
            etablissement={etablissement}
            anneeLibelle={anneeLibelle}
            creneaux={creneaux}
            horaires={impression.mode === 'classe' ? horairesClasse : horairesEnseignant}
            signataire={cfg.signataire}
          />
        </div>
      )}
    </>
  );
}

function Grille({ mode, loading, ready, emptyMessage, creneaux, horaires, onAdd, onEdit, onDelete }) {
  const editable = mode === 'classe';
  let body;
  let message = null;
  if (!ready) {
    message = emptyMessage;
  } else if (!creneaux.length) {
    message = "Aucun créneau horaire défini. Créez-en dans l'onglet \"Créneaux horaires\".";
  }
  if (loading) {
    body = <SkelLignesTableau colonnes={7} lignes={5} label="Chargement de la grille…" />;
  } else if (message) {
    body = <tr><td colSpan={7} className="text-center text-muted py-5">{message}</td></tr>;
  } else {
    const index = Object.fromEntries(horaires.map((h) => [`${h.jour_semaine}|${h.creneau_id}`, h]));
    body = creneaux.map((creneau) => (
      <tr key={creneau.id}>
        <td className="time-col">
          <div className="time-slot-label">{creneau.libelle}</div>
          <div className="time-slot-range">{heureCourte(creneau.heure_debut)} - {heureCourte(creneau.heure_fin)}</div>
        </td>
        {JOURS.map((jour) => {
          const h = index[`${jour}|${creneau.id}`];
          if (h) {
            const mc = h.mc || {};
            const matiereNom = mc.matiere_nom || 'Matière';
            return (
              <td key={jour}>
                <div className={`cours-chip ${colorClassFor(matiereNom)} ${editable ? '' : 'readonly'}`} onClick={editable ? () => onEdit(h) : undefined} role={editable ? 'button' : undefined}>
                  {editable && (
                    <div className="chip-actions">
                      <button type="button" title="Modifier" onClick={(e) => { e.stopPropagation(); onEdit(h); }}><i className="bx bx-pencil" /></button>
                      <button type="button" title="Supprimer" onClick={(e) => { e.stopPropagation(); onDelete(h); }}><i className="bx bx-x" /></button>
                    </div>
                  )}
                  <span className="chip-matiere">{editable ? matiereNom : mc.classe_nom || 'Classe'}</span>
                  {editable
                    ? <span className="chip-meta"><i className="bx bx-user" /> {mc.enseignant_nom || 'Enseignant'}</span>
                    : <span className="chip-meta"><i className="bx bx-book" /> {matiereNom}</span>}
                </div>
              </td>
            );
          }
          return (
            <td key={jour}>
              {editable
                ? <div className="cell-empty clickable" title="Ajouter un cours" role="button" onClick={() => onAdd(jour, creneau.id)}><i className="bx bx-plus" /></div>
                : <div className="cell-empty" />}
            </td>
          );
        })}
      </tr>
    ));
  }
  // Petits écrans : un jour à la fois, cours en cartes (modifier / supprimer
  // toujours visibles, pas de survol au doigt).
  const carte = (h) => {
    const mc = h.mc || {};
    const matiereNom = mc.matiere_nom || 'Matière';
    return (
      <div className={`cours-chip edt-jour-cours ${colorClassFor(matiereNom)} ${editable ? '' : 'readonly'}`} onClick={editable ? () => onEdit(h) : undefined} role={editable ? 'button' : undefined}>
        <span className="chip-matiere">{editable ? matiereNom : mc.classe_nom || 'Classe'}</span>
        {editable
          ? <span className="chip-meta"><i className="bx bx-user" /> {mc.enseignant_nom || 'Enseignant'}</span>
          : <span className="chip-meta"><i className="bx bx-book" /> {matiereNom}</span>}
        {h.salle && <span className="chip-meta"><i className="bx bx-door-open" /> {h.salle}</span>}
        {editable && (
          <span className="edt-jour-actions">
            <button type="button" aria-label="Modifier" onClick={(e) => { e.stopPropagation(); onEdit(h); }}><i className="bx bx-pencil" /></button>
            <button type="button" aria-label="Supprimer" onClick={(e) => { e.stopPropagation(); onDelete(h); }}><i className="bx bx-trash" /></button>
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="horaire-grid-wrap d-none d-md-block">
        <table className="horaire-table">
          <thead><tr><th className="time-col">Créneau</th>{JOURS.map((j) => <th key={j}>{j}</th>)}</tr></thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      <div className="d-md-none">
        {message
          ? <div className="text-center text-muted py-5 px-3">{message}</div>
          : <GrilleJour creneaux={creneaux} horaires={horaires} carte={carte} onAdd={editable ? onAdd : null} />}
      </div>
    </>
  );
}

// Document « EMPLOI DU TEMPS » imprimé (modèle papier de l'établissement).
// `cellule(jour, creneau)` renvoie [ligne principale, ligne secondaire] ou null.
export function FeuilleEmploiDuTemps({ etablissement, anneeLibelle, sousTitre, champs, creneaux, cellule, signatures }) {
  const e = etablissement || {};
  const ligneAdresse = [e.adresse, e.bp ? `BP ${e.bp}` : ''].filter(Boolean).join(' — ');
  const lieu = e.region || e.adresse || '';
  const aujourdhui = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <div className="print-sheet">
      <div className="print-header-top">
        <div className="print-etab">
          <div className="print-etab-nom">{e.nom || 'Établissement'}</div>
          {e.nom_bilingue && <div className="print-etab-bilingue">{e.nom_bilingue}</div>}
          {ligneAdresse && <div className="print-etab-detail">{ligneAdresse}</div>}
          {e.telephone && <div className="print-etab-detail">Tél : {e.telephone}</div>}
          <div className="print-annee">Année scolaire : {anneeLibelle}</div>
        </div>
        <div className="print-etab-logo">{e.logo_url && <img src={e.logo_url} alt={`Logo ${e.nom || ''}`} />}</div>
        <div className="print-titre">
          <div className="print-titre-principal">EMPLOI DU TEMPS</div>
          <div className="print-titre-secondaire">{sousTitre}</div>
        </div>
      </div>
      <div className="print-champs">
        {champs.map((c) => <div key={c.label} className="print-champ"><span>{c.label}</span> : <strong>{c.valeur}</strong></div>)}
      </div>
      {creneaux.length ? (
        <table className="edt-table">
          <thead>
            <tr><th className="print-jour-header">Jour</th>{creneaux.map((c, i) => <th key={c.id} className="print-periode-cell">{i + 1}</th>)}</tr>
            <tr><th className="print-jour-header">Horaires</th>{creneaux.map((c) => <th key={c.id} className="print-horaire-cell">{heureCourte(c.heure_debut)}<br />{heureCourte(c.heure_fin)}</th>)}</tr>
          </thead>
          <tbody>
            {JOURS.map((jour) => (
              <tr key={jour}>
                <td className="print-jour">{jour}</td>
                {creneaux.map((c) => {
                  const lignes = cellule(jour, c);
                  return lignes
                    ? <td key={c.id}><div className="pc-matiere">{lignes[0]}</div><div className="pc-sub">{lignes[1]}</div></td>
                    : <td key={c.id} className="print-cell-vide" />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>Aucun créneau horaire défini.</p>}
      <div className="print-footer">
        <div>{lieu ? `${lieu}, ` : ''}le {aujourdhui}</div>
        <div className="print-signatures">
          {signatures.map((sig) => <div key={sig} className="print-signature">{sig}</div>)}
        </div>
      </div>
    </div>
  );
}

function FeuilleImpression({ impression, etablissement, anneeLibelle, creneaux, horaires, signataire }) {
  const index = Object.fromEntries(horaires.map((h) => [`${h.jour_semaine}|${h.creneau_id}`, h]));
  return (
    <FeuilleEmploiDuTemps
      etablissement={etablissement}
      anneeLibelle={anneeLibelle}
      sousTitre={impression.sousTitre}
      champs={impression.champs}
      creneaux={creneaux}
      signatures={[`Le ${signataire}`, 'Le Proviseur']}
      cellule={(jour, c) => {
        const h = index[`${jour}|${c.id}`];
        if (!h) return null;
        const mc = h.mc || {};
        return impression.mode === 'classe'
          ? [mc.matiere_nom || 'Matière', mc.enseignant_nom || 'Enseignant']
          : [mc.classe_nom || 'Classe', mc.matiere_nom || 'Matière'];
      }}
    />
  );
}

function CoursModal({ data, preset, anneeLibelle, annee, classes, classeLabel, defaultClasse, mcIndex, creneaux, onClose, onSaved }) {
  const [form, setForm] = useState({
    classe_id: defaultClasse || '',
    matiere_classe_id: data ? String(data.matiere_classe_id) : '',
    jour_semaine: data?.jour_semaine || preset?.jour || '',
    creneau_id: data ? String(data.creneau_id) : String(preset?.creneauId ?? ''),
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value, ...(name === 'classe_id' ? { matiere_classe_id: '' } : {}) }));
  const mcDeLaClasse = Object.values(mcIndex).filter((mc) => mc.classe_id === Number(form.classe_id));

  const submit = async () => {
    setError('');
    if (!form.classe_id || !form.matiere_classe_id || !form.jour_semaine || !form.creneau_id) {
      setError('Veuillez renseigner la classe, la matière, le jour et le créneau.');
      return;
    }
    const payload = {
      matiere_classe_id: parseInt(form.matiere_classe_id, 10),
      annee_scolaire_id: parseInt(annee, 10),
      jour_semaine: form.jour_semaine,
      creneau_id: parseInt(form.creneau_id, 10),
    };
    setSaving(true);
    try {
      if (data) await api.put(`/horaires/${data.id}`, payload);
      else await api.post('/horaires/', payload);
      await onSaved();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={<><i className={`bx ${data ? 'bx-edit-alt' : 'bx-calendar-plus'} me-2 text-primary`} />{data ? 'Modifier le cours' : 'Nouveau cours'}</>} onClose={onClose} onSubmit={submit} footer={<><button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>Annuler</button><button type="submit" className="btn btn-primary" disabled={saving}><i className="bx bx-check me-1" /> Enregistrer</button></>}>
      <div className="alert alert-info d-flex gap-2 mb-3"><i className="bx bx-info-circle" /><div>La disponibilité de la classe et de l'enseignant sur ce créneau sera vérifiée automatiquement avant l'enregistrement.</div></div>
      {error && <div className="alert alert-danger">{error}</div>}
      <div className="row g-3">
        <div className="col-md-6"><label className="form-label">Année scolaire</label><Select className="form-select" disabled><option>{anneeLibelle}</option></Select></div>
        <div className="col-md-6"><label className="form-label">Classe *</label><Select className="form-select" value={form.classe_id} onChange={set('classe_id')}><option value="">-- Choisir --</option>{classes.map((c) => <option key={c.id} value={c.id}>{classeLabel(c)}</option>)}</Select></div>
        <div className="col-12">
          <label className="form-label">Matière — Enseignant *</label>
          <Select className="form-select" value={form.matiere_classe_id} disabled={!form.classe_id} onChange={set('matiere_classe_id')}>
            {!form.classe_id
              ? <option value="">-- Choisir la classe d'abord --</option>
              : mcDeLaClasse.length
                ? <><option value="">-- Choisir --</option>{mcDeLaClasse.map((mc) => <option key={mc.id} value={mc.id}>{mc.matiere_nom} — {mc.enseignant_nom}</option>)}</>
                : <option value="">Aucune matière affectée à cette classe</option>}
          </Select>
          <div className="form-text">Liste filtrée selon les matières affectées à la classe sélectionnée.</div>
        </div>
        <div className="col-md-6"><label className="form-label">Jour de la semaine *</label><Select className="form-select" value={form.jour_semaine} onChange={set('jour_semaine')}><option value="">-- Choisir --</option>{JOURS.map((j) => <option key={j}>{j}</option>)}</Select></div>
        <div className="col-md-6"><label className="form-label">Créneau horaire *</label><Select className="form-select" value={form.creneau_id} onChange={set('creneau_id')}><option value="">-- Choisir --</option>{creneaux.map((c) => <option key={c.id} value={c.id}>{c.libelle} — {heureCourte(c.heure_debut)}-{heureCourte(c.heure_fin)}</option>)}</Select></div>
      </div>
    </Modal>
  );
}

function CreneauModal({ data, onClose, onSaved }) {
  const [form, setForm] = useState({ libelle: data?.libelle || '', heure_debut: (data?.heure_debut || '').slice(0, 5), heure_fin: (data?.heure_fin || '').slice(0, 5) });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  const submit = async () => {
    setError('');
    if (!form.libelle.trim() || !form.heure_debut || !form.heure_fin) {
      setError("Veuillez renseigner le libellé, l'heure de début et l'heure de fin.");
      return;
    }
    setSaving(true);
    try {
      const payload = { libelle: form.libelle.trim(), heure_debut: form.heure_debut, heure_fin: form.heure_fin };
      if (data) await api.put(`/creneaux-horaires/${data.id}`, payload);
      else await api.post('/creneaux-horaires/', payload);
      await onSaved();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <Modal size="" title={<><i className={`bx ${data ? 'bx-edit-alt' : 'bx-time'} me-2 text-primary`} />{data ? 'Modifier le créneau' : 'Nouveau créneau'}</>} onClose={onClose} onSubmit={submit} footer={<><button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>Annuler</button><button type="submit" className="btn btn-primary" disabled={saving}><i className="bx bx-check me-1" /> Enregistrer</button></>}>
      {error && <div className="alert alert-danger">{error}</div>}
      <div className="mb-3"><label className="form-label">Libellé *</label><input type="text" className="form-control" maxLength={50} placeholder="Ex : Créneau 8" value={form.libelle} onChange={set('libelle')} /></div>
      <div className="row g-3">
        <div className="col-md-6"><label className="form-label">Heure de début *</label><input type="time" className="form-control" value={form.heure_debut} onChange={set('heure_debut')} /></div>
        <div className="col-md-6"><label className="form-label">Heure de fin *</label><input type="time" className="form-control" value={form.heure_fin} onChange={set('heure_fin')} /></div>
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import ChartCanvas from '../components/ChartCanvas';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import { Avancement, BarreClasse, ClassesGrille, EspaceTitre, useMonEspace } from '../components/Espace';
import { useToast } from '../components/ui';
import ImportModal from '../components/importConfigs';
import {
  appreciationInfo, calculerStatistiques, EleveIdentite, filtrerRoster, KpiRow, lignesStatistiques,
  noteValeur, NotesFiltres, ReleveImprime, SaveState, StatsTable, useNotesContexte,
} from '../components/NotesCommun';

// Saisie des notes de l'enseignant, pensée d'abord pour le téléphone :
// 1. cartes « classe · matière » avec l'avancement de la séquence en cours ;
// 2. liste des élèves, une note par ligne (clavier numérique, Entrée = élève
//    suivant, enregistrement automatique, notes gardées en attente si la
//    connexion coupe), puis statistiques et relevé imprimable.

const PRIMARY = '#696cff';
const ATTENTE_KEY = 'notesEnAttente';

export default function EnseignantNotesPage() {
  const [params, setParams] = useSearchParams();
  const mc = params.get('mc');
  if (mc) return <SaisieNotes key={mc} mcId={mc} onRetour={() => setParams({})} />;
  return <ChoixMatiereClasse onChoisir={(id) => setParams({ mc: String(id) })} />;
}

function ChoixMatiereClasse({ onChoisir }) {
  const espace = useMonEspace('/enseignant');
  const data = espace.data || {};
  const sequence = data.sequence_courante;
  const items = (data.matieres_classe || []).map((mc) => ({
    key: mc.id,
    cycle: mc.cycle_libelle,
    titre: mc.classe_label,
    sousTitre: `${mc.matiere_libelle} · coef. ${mc.coefficient}`,
    effectif: mc.effectif,
    avancement: sequence ? { saisies: mc.notes_saisies, attendues: mc.effectif, libelle: sequence.libelle } : null,
    onClick: () => onChoisir(mc.id),
  }));
  return (
    <>
      <EspaceTitre titre="Saisie des notes" sousTitre="Choisissez une classe et une matière" icon="bx-edit" />
      {espace.error && !espace.data && <div className="alert alert-warning"><i className="bx bx-error me-2" />{espace.error.message}</div>}
      <ClassesGrille items={items} loading={espace.loading} vide="Aucune matière-classe ne vous a été attribuée pour le moment. Contactez l'administration de votre établissement." />
    </>
  );
}

// ── Notes en attente (connexion perdue) ───────────────────────────────────
function lireAttente() {
  try {
    return JSON.parse(localStorage.getItem(ATTENTE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function ecrireAttente(attente) {
  try {
    localStorage.setItem(ATTENTE_KEY, JSON.stringify(attente));
  } catch {
    // Stockage indisponible : la note reste en attente en mémoire seulement.
  }
}

const cleNote = (body) => `${body.inscription_id}|${body.matiere_classe_id}|${body.sequence_id}`;
const estCoupure = (e) => e?.status === 0;

function parseNote(texte) {
  const t = String(texte).trim().replace(',', '.');
  if (t === '') return { ok: true, valeur: null };
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return { ok: false };
  const v = Number(t);
  return v >= 0 && v <= 20 ? { ok: true, valeur: v } : { ok: false };
}

function SaisieNotes({ mcId: mcParam, onRetour }) {
  const toast = useToast();
  const etablissement = useEtablissementCourant();
  const classesDepuis = useCallback((payload) => {
    const map = new Map();
    (payload.matieres_classe || []).forEach((m) => {
      if (!map.has(m.classe_id)) map.set(m.classe_id, { id: m.classe_id, label: m.classe_label || `Classe #${m.classe_id}`, effectif: m.effectif, cycle: m.cycle_libelle });
    });
    return [...map.values()];
  }, []);
  const ctx = useNotesContexte({ base: '/enseignant', toast, classesDepuis, mcImpose: mcParam });
  const { espace, classeId, mcId, sequenceId, mcActive, roster, notes, setNotes, notesIndex, sequenceLibelle, sequencesTree } = ctx;

  const [recherche, setRecherche] = useState('');
  const [statsOuvertes, setStatsOuvertes] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 992);
  const [saveStates, setSaveStates] = useState({});
  const [imprimer, setImprimer] = useState(false);
  const [attente, setAttente] = useState(lireAttente);
  const [importOuvert, setImportOuvert] = useState(false);

  const classe = espace.classes.find((c) => String(c.id) === String(classeId)) || null;
  const introuvable = !espace.loading && espace.matieresClasse.length > 0 && !espace.matieresClasse.some((m) => String(m.id) === String(mcParam));
  const pret = Boolean(classeId && mcId && sequenceId);
  const eleves = useMemo(() => filtrerRoster(roster, recherche), [roster, recherche]);
  const stats = useMemo(() => calculerStatistiques(roster, notesIndex), [roster, notesIndex]);
  const lignes = useMemo(() => lignesStatistiques(stats), [stats]);

  // Lu par envoyer() (renvois différés) : toujours la dernière version.
  const notesIndexRef = useRef(notesIndex);
  useEffect(() => { notesIndexRef.current = notesIndex; }, [notesIndex]);

  // Évolution : moyenne de la classe sur chaque séquence de l'année.
  const evolution = useMemo(() => {
    const ids = new Set(roster.map((e) => String(e.inscription_id)));
    const donnees = [];
    sequencesTree.forEach((tri) => (tri.sequences || []).forEach((seq) => {
      const vals = notes
        .filter((n) => String(n.matiere_classe_id) === String(mcId) && String(n.sequence_id) === String(seq.id) && ids.has(String(n.inscription_id)) && !n.absent && n.valeur !== null && n.valeur !== undefined)
        .map((n) => Number(n.valeur));
      donnees.push({ libelle: seq.libelle, active: String(seq.id) === String(sequenceId), moyenne: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null });
    }));
    if (donnees.filter((d) => d.moyenne !== null).length < 2) return null;
    return {
      type: 'line',
      data: {
        labels: donnees.map((d) => d.libelle),
        datasets: [{
          label: 'Moyenne de la classe (/20)',
          data: donnees.map((d) => (d.moyenne === null ? null : Number(d.moyenne.toFixed(2)))),
          spanGaps: true,
          borderColor: PRIMARY,
          backgroundColor: `${PRIMARY}22`,
          tension: 0.3,
          fill: true,
          pointRadius: donnees.map((d) => (d.active ? 6 : 3)),
          pointHoverRadius: 7,
          pointBackgroundColor: PRIMARY,
        }],
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (c.parsed.y === null ? 'Aucune note saisie' : `Moyenne : ${c.parsed.y.toFixed(2)} / 20`) } } },
        scales: { y: { min: 0, max: 20, ticks: { stepSize: 4 } } },
      },
    };
  }, [roster, notes, mcId, sequenceId, sequencesTree]);

  useEffect(() => {
    if (!imprimer) return undefined;
    const after = () => setImprimer(false);
    window.addEventListener('afterprint', after);
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after); };
  }, [imprimer]);

  const majAttente = useCallback((fn) => {
    setAttente((prev) => {
      const next = fn({ ...prev });
      ecrireAttente(next);
      return next;
    });
  }, []);

  const envoyer = useCallback(async (body) => {
    const id = String(body.inscription_id);
    setSaveStates((s) => ({ ...s, [id]: 'saving' }));
    const existante = String(body.matiere_classe_id) === String(mcId) && String(body.sequence_id) === String(sequenceId)
      ? notesIndexRef.current[body.inscription_id] : null;
    try {
      const result = existante?.id ? await api.put(`/notes/${existante.id}`, body) : await api.post('/notes/', body);
      setNotes((list) => {
        const i = list.findIndex((n) => n.id === result.id);
        if (i < 0) return [...list, result];
        const next = [...list];
        next[i] = result;
        return next;
      });
      majAttente((a) => { delete a[cleNote(body)]; return a; });
      setSaveStates((s) => ({ ...s, [id]: 'ok' }));
      return true;
    } catch (e) {
      if (estCoupure(e)) {
        // Connexion perdue : la note est gardée sur l'appareil et renvoyée
        // dès que le réseau revient.
        majAttente((a) => { a[cleNote(body)] = body; return a; });
        setSaveStates((s) => ({ ...s, [id]: 'pending' }));
      } else {
        // Refus du serveur (note invalide, droits…) : inutile de la renvoyer.
        majAttente((a) => { delete a[cleNote(body)]; return a; });
        setSaveStates((s) => ({ ...s, [id]: 'error' }));
        toast(`Enregistrement impossible : ${e.message}`, 'error');
      }
      return false;
    }
  }, [mcId, sequenceId, setNotes, majAttente, toast]);

  const sauvegarderNote = (inscriptionId, { valeur, absent }) => envoyer({
    inscription_id: Number(inscriptionId),
    matiere_classe_id: Number(mcId),
    sequence_id: Number(sequenceId),
    valeur: absent ? null : valeur,
    absent: Boolean(absent),
  });

  // Notes en attente de cette matière-classe (toutes séquences).
  const enAttente = Object.values(attente).filter((b) => String(b.matiere_classe_id) === String(mcId));
  // Un seul renvoi à la fois : l'événement « online » et le bouton
  // « Réessayer » peuvent se déclencher ensemble (sinon doublon refusé en 409).
  const renvoiEnCours = useRef(false);
  const renvoyer = useCallback(async () => {
    if (renvoiEnCours.current) return;
    renvoiEnCours.current = true;
    try {
      for (const body of Object.values(lireAttente()).filter((b) => String(b.matiere_classe_id) === String(mcId))) {
        // Séquentiel : évite de saturer une connexion qui revient à peine.
        // eslint-disable-next-line no-await-in-loop
        if (!(await envoyer(body))) break;
      }
    } finally {
      renvoiEnCours.current = false;
    }
  }, [envoyer, mcId]);

  useEffect(() => {
    window.addEventListener('online', renvoyer);
    return () => window.removeEventListener('online', renvoyer);
  }, [renvoyer]);

  // Saisie enchaînée : Entrée valide la note et passe à l'élève suivant.
  const focusSuivant = (index) => {
    const suivant = document.querySelector(`[data-saisie-index="${index + 1}"]`);
    if (suivant) {
      suivant.focus();
      suivant.select?.();
    }
  };

  const saisies = stats.classe.notesSaisies;

  if (introuvable) {
    return (
      <>
        <EspaceTitre titre="Saisie des notes" retour="/enseignant/notes" retourLabel="Mes matières" />
        <div className="esp-vide"><i className="bx bx-error-circle" /><p className="mb-0">Cette matière-classe ne vous est pas (ou plus) attribuée.</p></div>
      </>
    );
  }

  return (
    <>
      <BarreClasse
        titre="Saisie des notes"
        classe={classe?.label || '…'}
        detail={mcActive ? `${mcActive.matiere_libelle} · coef. ${mcActive.coefficient}` : null}
        cycle={classe?.cycle}
        effectif={roster.length || classe?.effectif}
        onChanger={onRetour}
        changerLabel="Mes matières"
      />

      <NotesFiltres ctx={ctx} recherche={recherche} setRecherche={setRecherche} masquerClasse masquerMatiere />

      {pret && (
        <div className="saisie-entete">
          <div className="flex-grow-1 min-w-0">
            <Avancement saisies={saisies} attendues={roster.length} libelle={sequenceLibelle} />
          </div>
          <div className="saisie-entete-actions">
            <button type="button" className="btn btn-icon btn-outline-secondary" title="Actualiser" aria-label="Actualiser" onClick={() => { ctx.actualiser(); toast('Grille actualisée.'); }}><i className="bx bx-refresh" /></button>
            <button type="button" className="btn btn-icon btn-outline-primary" title="Imprimer / PDF" aria-label="Imprimer le relevé" onClick={() => setImprimer(true)}><i className="bx bx-printer" /></button>
            <button type="button" className="btn btn-icon btn-outline-primary" title="Importer des notes (Excel, CSV, Word)" aria-label="Importer des notes" onClick={() => setImportOuvert(true)}><i className="bx bx-import" /></button>
          </div>
        </div>
      )}

      {enAttente.length > 0 && (
        <div className="alert alert-warning d-flex align-items-center gap-2 saisie-attente">
          <i className="bx bx-wifi-off fs-4" />
          <div className="flex-grow-1">
            <strong>{enAttente.length} note{enAttente.length > 1 ? 's' : ''} en attente d'envoi.</strong>
            <div className="small">Elles sont gardées sur cet appareil et seront envoyées dès le retour de la connexion.</div>
          </div>
          <button type="button" className="btn btn-sm btn-warning" onClick={renvoyer}>Réessayer</button>
        </div>
      )}

      <div className="saisie-liste mb-4">
        <div className="saisie-ligne saisie-tete d-none d-md-grid">
          <span>#</span><span>Élève</span><span className="text-center">Note / 20</span>
        </div>
        {!pret ? (
          <div className="saisie-vide"><i className="bx bx-info-circle me-1" />{espace.loading ? 'Chargement…' : 'Choisissez une séquence pour afficher la grille de saisie.'}</div>
        ) : ctx.chargement && !roster.length ? (
          <div className="saisie-vide"><span className="spinner-border spinner-border-sm me-1" /> Chargement…</div>
        ) : !eleves.length ? (
          <div className="saisie-vide"><i className="bx bx-user-x me-1" />{roster.length ? 'Aucun élève ne correspond à la recherche.' : 'Aucun élève inscrit dans cette classe.'}</div>
        ) : eleves.map((eleve, idx) => (
          <NoteLigne
            key={`${eleve.inscription_id}-${mcId}-${sequenceId}`}
            index={idx}
            eleve={eleve}
            note={notesIndex[eleve.inscription_id]}
            attente={attente[`${eleve.inscription_id}|${mcId}|${sequenceId}`]}
            saveState={saveStates[eleve.inscription_id]}
            onSave={(payload) => sauvegarderNote(eleve.inscription_id, payload)}
            onInvalid={() => toast('La note doit être un nombre entre 0 et 20 (ex : 12,5).', 'error')}
            onSuivant={() => focusSuivant(idx)}
          />
        ))}
      </div>

      {pret && (
        <div className="card mb-3">
          <button type="button" className="card-header d-flex align-items-center justify-content-between w-100 btn-reset text-start" onClick={() => setStatsOuvertes((o) => !o)} aria-expanded={statsOuvertes}>
            <h6 className="mb-0"><i className="bx bx-bar-chart-alt-2 me-2 text-primary" />Statistiques et évolution</h6>
            <i className={`bx ${statsOuvertes ? 'bx-chevron-up' : 'bx-chevron-down'} text-muted fs-4`} />
          </button>
          {statsOuvertes && (
            <div className="card-body">
              <KpiRow stats={stats} />
              <h6 className="mt-2"><i className="bx bx-line-chart me-2 text-primary" />Évolution de la moyenne</h6>
              {evolution ? <ChartCanvas config={evolution} height={200} /> : (
                <div className="text-center text-muted py-3"><i className="bx bx-line-chart bx-md d-block mb-2" />Pas encore assez de séquences notées pour tracer une évolution.</div>
              )}
              <div className="table-responsive mt-3"><StatsTable lignes={lignes} /></div>
            </div>
          )}
        </div>
      )}

      {importOuvert && (
        <ImportModal
          module="notes"
          optionsInitiales={{ matiere_classe_id: String(mcId), sequence_id: sequenceId ? String(sequenceId) : '' }}
          onClose={() => setImportOuvert(false)}
          onImported={() => ctx.actualiser()}
        />
      )}
      {imprimer && (
        <ReleveImprime
          variante="enseignant"
          avecSexe
          etablissement={etablissement}
          classe={classe?.label}
          matiere={mcActive?.matiere_libelle}
          coefficient={mcActive?.coefficient}
          sequence={sequenceLibelle}
          effectif={roster.length}
          lignes={lignes}
          eleves={eleves}
          notesIndex={notesIndex}
        />
      )}
    </>
  );
}

function NoteLigne({ index, eleve, note, attente, saveState, onSave, onInvalid, onSuivant }) {
  // Une note en attente d'envoi prime sur celle connue du serveur.
  const source = attente || note;
  const absent = Boolean(source?.absent);
  const initial = attente ? attente.valeur : noteValeur(note);
  const texteInitial = initial === null || initial === undefined ? '' : String(initial).replace('.', ',');
  const [valeur, setValeur] = useState(texteInitial);
  const appr = appreciationInfo(source);
  const parsed = parseNote(valeur);
  const v = parsed.ok ? parsed.valeur : null;
  const noteCls = v === null ? '' : v < 10 ? 'note-faible' : v >= 14 ? 'note-forte' : '';

  // Lit le champ lui-même (et non l'état) : Entrée peut arriver avant que
  // React n'ait rendu la dernière frappe.
  const commit = (e) => {
    const texte = e.target.value;
    const p = parseNote(texte);
    if (!p.ok) {
      onInvalid();
      setValeur(texteInitial);
      return;
    }
    if (texte.trim() === texteInitial) return;
    onSave({ valeur: p.valeur, absent: false });
  };

  const toggleAbsent = () => {
    const nouvelEtat = !absent;
    if (nouvelEtat) setValeur('');
    onSave({ valeur: null, absent: nouvelEtat });
  };

  return (
    <div className={`saisie-ligne ${saveState === 'ok' ? 'row-saved-flash' : ''} ${absent ? 'est-absent' : ''}`}>
      <span className="saisie-num">{index + 1}</span>
      <div className="saisie-eleve">
        <EleveIdentite eleve={eleve} />
        <span className={`appreciation-badge ${appr.classe} saisie-appr`}>{appr.label}</span>
      </div>
      <div className="saisie-note">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="next"
          className={`note-input saisie-input ${noteCls}`}
          placeholder="—"
          aria-label={`Note de ${eleve.nom} ${eleve.prenom}`}
          data-saisie-index={index}
          disabled={absent}
          value={valeur}
          onChange={(e) => setValeur(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
              onSuivant();
            }
          }}
        />
        <button type="button" className={`note-abs-toggle saisie-abs ${absent ? 'is-absent' : ''}`} aria-pressed={absent} title="Marquer absent" onClick={toggleAbsent}>ABS</button>
        <SaveState state={saveState || (attente ? 'pending' : null)} />
      </div>
    </div>
  );
}

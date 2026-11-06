import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, avecEtablissement } from '../lib/api';
import { cleDiscipline, cleNote, enregistrer, SYNCHRO_EVENT, useOperationsEnAttente } from '../lib/offline';
import { useAuth } from '../context/AuthContext';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import { AvecChoixClasse, Avancement, Pastilles } from '../components/Espace';
import { useToast } from '../components/ui';
import ImportModal from '../components/importConfigs';
import { focusSuivant, NoteLigne, useEnregistrementNotes } from '../components/SaisieNote';
import {
  appreciationInfo, calculerStatistiques, EleveIdentite, filtrerRoster, KpiRow, lignesStatistiques,
  noteValeur, NotesFiltres, ReleveImprime, SaveState, StatsTable, useNotesContexte,
} from '../components/NotesCommun';
import { SkelSaisie } from '../components/Skeleton';

// Notes & discipline du Censeur / Surveillant : choix de la classe sur des
// cartes, puis notes en lecture seule (saisie réservée à l'enseignant) et
// suivi disciplinaire éditable, enregistré automatiquement — y compris hors
// connexion (gardé sur l'appareil, envoyé au retour du réseau ; en cas de
// modification concurrente, l'utilisateur tranche, cf. lib/offline.js).
//
// Le SuperAdmin utilise le même écran sur l'établissement choisi dans la
// barre du haut, avec en plus la SAISIE des notes (toutes les classes et
// matières) : il saisit pour le compte d'un établissement qui le demande
// (zone sans réseau mobile…). Chaque saisie est tracée à son nom.

const classesDepuisEspace = (payload) => payload.classes || [];

export default function CenseurNotesPage() {
  const { isSuperAdmin } = useAuth();
  return (
    <AvecChoixClasse
      titre="Notes & discipline"
      icon="bx-spreadsheet"
      vide={isSuperAdmin ? "Cet établissement n'a encore aucune classe (à créer dans Configuration). Vérifiez l'établissement choisi en haut de l'écran." : undefined}
    >
      {({ classeId }) => <NotesClasse key={classeId} classeId={classeId} />}
    </AvecChoixClasse>
  );
}

function NotesClasse({ classeId }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const etablissement = useEtablissementCourant();
  const roleLabel = isSuperAdmin ? 'SuperAdmin' : user?.role?.libelle === 'Surveillant' ? 'Surveillant' : 'Censeur';
  const ctx = useNotesContexte({ base: '/censeur', toast, classesDepuis: classesDepuisEspace, classeImposee: classeId });
  const { espace, annee, trimestreId, sequenceId, mcActive, roster, notes, setNotes, notesIndex, sequenceLibelle, sequencesTree } = ctx;
  // Saisie des notes : SuperAdmin seulement (le serveur refuse les autres).
  const saisie = isSuperAdmin;
  const { envoyer, saveStates } = useEnregistrementNotes({ notes, setNotes, roster, mcActive, classeId, sequencesTree, toast });
  const notesAttente = useOperationsEnAttente('notes');
  const [importOuvert, setImportOuvert] = useState(false);

  const [onglet, setOnglet] = useState('notes');
  const [recherche, setRecherche] = useState('');
  const [disciplines, setDisciplines] = useState([]);
  const [disciplinesChargees, setDisciplinesChargees] = useState(false);
  const [disciplineVersion, setDisciplineVersion] = useState(0);
  const [imprimer, setImprimer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDisciplinesChargees(false);
    api.get(`/disciplines/?classe_id=${classeId}`)
      .then((d) => { if (!cancelled) setDisciplines(d || []); })
      .catch((e) => { if (!cancelled) { setDisciplines([]); toast(`Discipline : ${e.message}`, 'error'); } })
      .finally(() => { if (!cancelled) setDisciplinesChargees(true); });
    return () => { cancelled = true; };
  }, [classeId, disciplineVersion, toast]);

  const disciplinesIndex = useMemo(() => {
    const idx = {};
    disciplines.filter((d) => String(d.sequence_id) === String(sequenceId)).forEach((d) => { idx[d.inscription_id] = d; });
    return idx;
  }, [disciplines, sequenceId]);

  const classe = espace.classes.find((c) => String(c.id) === String(classeId)) || null;
  const pret = Boolean(ctx.mcId && sequenceId);
  const eleves = useMemo(() => filtrerRoster(roster, recherche), [roster, recherche]);
  // Notes affichées, y compris celles saisies hors connexion et pas encore
  // envoyées (statistiques et relevé imprimé à jour).
  const notesAffichees = useMemo(() => {
    const idx = { ...notesIndex };
    Object.values(notesAttente).forEach(({ body: b }) => {
      if (String(b.matiere_classe_id) === String(ctx.mcId) && String(b.sequence_id) === String(sequenceId)) {
        idx[b.inscription_id] = { ...idx[b.inscription_id], ...b };
      }
    });
    return idx;
  }, [notesIndex, notesAttente, ctx.mcId, sequenceId]);
  const stats = useMemo(() => calculerStatistiques(roster, notesAffichees), [roster, notesAffichees]);
  const lignes = useMemo(() => lignesStatistiques(stats), [stats]);

  useEffect(() => {
    if (!imprimer) return undefined;
    const after = () => setImprimer(false);
    window.addEventListener('afterprint', after);
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after); };
  }, [imprimer]);

  const actualiser = () => {
    ctx.actualiser();
    setDisciplineVersion((v) => v + 1);
    toast('Grille actualisée.');
  };

  const genererBulletins = () => {
    const params = new URLSearchParams({ classe: classeId, annee_scolaire_id: annee || '', trimestre_id: trimestreId || '' });
    navigate(`/bulletins?${params.toString()}`);
  };

  const onDisciplineSaved = useCallback((result) => setDisciplines((list) => {
    const i = list.findIndex((d) => d.id === result.id);
    if (i < 0) return [...list, result];
    const next = [...list];
    next[i] = result;
    return next;
  }), []);
  const onDisciplineError = useCallback((msg) => toast(`Enregistrement discipline impossible : ${msg}`, 'error'), [toast]);

  // Fiches en attente d'envoi (ou en conflit), et résultats de la
  // synchronisation globale (envoyées, ou valeur du serveur conservée).
  const ficheAttente = useOperationsEnAttente('discipline');
  useEffect(() => {
    const onSynchro = (e) => {
      const deDiscipline = (liste) => liste.filter((x) => x.op.module === 'discipline');
      deDiscipline(e.detail.envoyees).forEach((x) => onDisciplineSaved(x.resultat));
      deDiscipline(e.detail.ignorees).forEach((x) => x.serveur && onDisciplineSaved(x.serveur));
    };
    window.addEventListener(SYNCHRO_EVENT, onSynchro);
    return () => window.removeEventListener(SYNCHRO_EVENT, onSynchro);
  }, [onDisciplineSaved]);

  return (
    <>
      <div className="d-flex flex-wrap gap-2 mb-3">
        <Pastilles
          ariaLabel="Rubrique"
          value={onglet}
          onChange={setOnglet}
          options={[{ value: 'notes', label: 'Notes' }, { value: 'discipline', label: 'Discipline' }]}
        />
        <div className="ms-auto d-flex gap-2">
          <button type="button" className="btn btn-icon btn-outline-secondary" title="Actualiser" aria-label="Actualiser" onClick={actualiser}><i className="bx bx-refresh" /></button>
          <button type="button" className="btn btn-primary" onClick={genererBulletins}><i className="bx bx-file me-1" />Bulletins</button>
        </div>
      </div>

      <NotesFiltres ctx={ctx} recherche={recherche} setRecherche={setRecherche} masquerClasse masquerMatiere={onglet !== 'notes'} />

      {onglet === 'notes' ? (
        <>
          {pret && (
            <div className="saisie-entete">
              <div className="flex-grow-1 min-w-0">
                <Avancement saisies={stats.classe.notesSaisies} attendues={roster.length} libelle={`${mcActive?.matiere_libelle || '—'}${mcActive?.enseignant_nom ? ` · ${mcActive.enseignant_nom}` : ''}`} />
              </div>
              <div className="saisie-entete-actions">
                <button type="button" className="btn btn-icon btn-outline-primary" title="Imprimer / PDF" aria-label="Imprimer le relevé" onClick={() => setImprimer(true)}><i className="bx bx-printer" /></button>
                {saisie && (
                  <button type="button" className="btn btn-icon btn-outline-primary" title="Importer des notes (Excel, CSV, Word)" aria-label="Importer des notes" onClick={() => setImportOuvert(true)}><i className="bx bx-import" /></button>
                )}
              </div>
            </div>
          )}

          <div className="saisie-liste mb-3">
            {!pret ? (
              espace.loading ? <SkelSaisie avecNote={saisie} /> : <div className="saisie-vide"><i className="bx bx-info-circle me-1" />{ctx.matieres.length ? 'Choisissez une séquence pour afficher les notes.' : 'Aucune matière affectée à cette classe.'}</div>
            ) : ctx.chargement && !roster.length ? (
              <SkelSaisie avecNote={saisie} />
            ) : !eleves.length ? (
              <div className="saisie-vide"><i className="bx bx-user-x me-1" />{roster.length ? 'Aucun élève ne correspond à la recherche.' : 'Aucun élève inscrit dans cette classe.'}</div>
            ) : saisie ? eleves.map((eleve, idx) => {
              const cle = cleNote({ inscription_id: eleve.inscription_id, matiere_classe_id: ctx.mcId, sequence_id: sequenceId });
              return (
                <NoteLigne
                  key={`${eleve.inscription_id}-${ctx.mcId}-${sequenceId}`}
                  index={idx}
                  eleve={eleve}
                  note={notesIndex[eleve.inscription_id]}
                  attente={notesAttente[cle]}
                  saveState={saveStates[cle]}
                  onSave={({ valeur, absent }) => envoyer({
                    inscription_id: Number(eleve.inscription_id),
                    matiere_classe_id: Number(ctx.mcId),
                    sequence_id: Number(sequenceId),
                    valeur: absent ? null : valeur,
                    absent: Boolean(absent),
                  })}
                  onInvalid={() => toast('La note doit être un nombre entre 0 et 20 (ex : 12,5).', 'error')}
                  onSuivant={() => focusSuivant(idx)}
                />
              );
            }) : eleves.map((eleve, idx) => {
              const n = notesIndex[eleve.inscription_id];
              const v = noteValeur(n);
              const appr = appreciationInfo(n);
              return (
                <div key={eleve.inscription_id} className="saisie-ligne">
                  <span className="saisie-num">{idx + 1}</span>
                  <div className="saisie-eleve">
                    <EleveIdentite eleve={eleve} />
                    <span className={`appreciation-badge ${appr.classe} saisie-appr`}>{appr.label}</span>
                  </div>
                  <span className={`note-lecture ${v === null ? 'note-vide' : v < 10 ? 'note-faible' : v >= 14 ? 'note-forte' : ''}`}>{n?.absent ? 'Abs.' : v === null ? '—' : v.toFixed(2).replace('.', ',')}</span>
                </div>
              );
            })}
          </div>
          {saisie ? (
            <p className="small text-muted mb-4"><i className="bx bx-edit me-1" />Saisie pour le compte de {etablissement?.nom || "l'établissement"} : Entrée passe à l'élève suivant, chaque note est enregistrée aussitôt (gardée sur l'appareil si la connexion manque) et inscrite à votre nom dans le journal.</p>
          ) : (
            <p className="small text-muted mb-4"><i className="bx bx-lock-alt me-1" />Consultation uniquement — la saisie reste réservée à l'enseignant de la matière.</p>
          )}

          {pret && (
            <div className="card mb-3">
              <div className="card-header"><h6 className="mb-0"><i className="bx bx-bar-chart-alt-2 me-2 text-primary" />Statistiques de la séquence</h6></div>
              <div className="card-body">
                <KpiRow stats={stats} />
                <div className="table-responsive"><StatsTable lignes={lignes} /></div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="saisie-liste mb-3">
            {!sequenceId ? (
              <div className="saisie-vide"><i className="bx bx-info-circle me-1" />Choisissez une séquence pour afficher le suivi disciplinaire.</div>
            ) : !disciplinesChargees ? (
              <SkelSaisie avecNote={false} label="Chargement du suivi disciplinaire…" />
            ) : !eleves.length ? (
              <div className="saisie-vide"><i className="bx bx-user-x me-1" />{roster.length ? 'Aucun élève ne correspond à la recherche.' : 'Aucun élève inscrit dans cette classe.'}</div>
            ) : eleves.map((eleve, idx) => (
              <DisciplineLigne
                key={`${eleve.inscription_id}-${sequenceId}-${disciplineVersion}`}
                index={idx}
                eleve={eleve}
                sequenceId={sequenceId}
                fiche={disciplinesIndex[eleve.inscription_id]}
                operation={ficheAttente[cleDiscipline({ inscription_id: eleve.inscription_id, sequence_id: sequenceId })]}
                classeId={classeId}
                libelleSequence={sequenceLibelle}
                onSaved={onDisciplineSaved}
                onError={onDisciplineError}
              />
            ))}
          </div>
          <p className="small text-muted mb-4"><i className="bx bx-info-circle me-1" />Enregistrement automatique dès qu'un champ est modifié, même sans connexion (envoi au retour du réseau).</p>
        </>
      )}

      {imprimer && (
        <ReleveImprime
          variante={roleLabel}
          etablissement={etablissement}
          classe={classe?.label}
          matiere={mcActive?.matiere_libelle}
          coefficient={mcActive?.coefficient}
          sequence={sequenceLibelle}
          effectif={roster.length}
          lignes={lignes}
          eleves={eleves}
          notesIndex={notesAffichees}
        />
      )}
      {importOuvert && (
        <ImportModal
          module="notes"
          optionsInitiales={{ matiere_classe_id: String(ctx.mcId), sequence_id: sequenceId ? String(sequenceId) : '' }}
          onClose={() => setImportOuvert(false)}
          onImported={() => ctx.actualiser()}
        />
      )}
    </>
  );
}

const CHAMPS = [
  ['absences_justifiees', 'Abs. just.'],
  ['absences_non_justifiees', 'Abs. injust.'],
  ['retards', 'Retards'],
  ['exclusions', 'Exclusions'],
];

const valeursFiche = (f) => ({
  absences_justifiees: f?.absences_justifiees ?? 0,
  absences_non_justifiees: f?.absences_non_justifiees ?? 0,
  retards: f?.retards ?? 0,
  exclusions: f?.exclusions ?? 0,
  observation: f?.observation || '',
});

function DisciplineLigne({ index, eleve, sequenceId, fiche, operation, classeId, libelleSequence, onSaved, onError }) {
  // Une saisie en attente d'envoi (ou en conflit) prime sur la fiche du serveur.
  const reference = operation?.body || fiche;
  const [values, setValues] = useState(() => valeursFiche(reference));
  const [saveState, setSaveState] = useState(null);
  const [flash, setFlash] = useState(false);
  const timer = useRef(null);
  const ligneRef = useRef(null);
  const ficheRef = useRef(fiche);
  useEffect(() => { ficheRef.current = fiche; }, [fiche]);

  // La référence change sans saisie de l'utilisateur (conflit tranché
  // « garder celle du serveur », synchronisation) : les champs suivent, sauf
  // pendant la saisie.
  const signature = JSON.stringify(valeursFiche(reference));
  useEffect(() => {
    if (!timer.current && !ligneRef.current?.contains(document.activeElement)) setValues(JSON.parse(signature));
  }, [signature]);

  const sauvegarder = useCallback(async (v) => {
    timer.current = null;
    setSaveState('saving');
    const body = {
      inscription_id: Number(eleve.inscription_id),
      sequence_id: Number(sequenceId),
      absences_justifiees: Number(v.absences_justifiees || 0),
      absences_non_justifiees: Number(v.absences_non_justifiees || 0),
      retards: Number(v.retards || 0),
      exclusions: Number(v.exclusions || 0),
      observation: v.observation || null,
    };
    const actuelle = ficheRef.current;
    const res = await enregistrer({
      cle: cleDiscipline(body),
      module: 'discipline',
      methode: actuelle?.id ? 'PUT' : 'POST',
      url: avecEtablissement(actuelle?.id ? `/disciplines/${actuelle.id}` : '/disciplines/'),
      body,
      versionBase: actuelle ? actuelle.version ?? undefined : null,
      libelle: `${eleve.nom} ${eleve.prenom} — ${libelleSequence}`,
      cache: avecEtablissement(`/disciplines/?classe_id=${classeId}`),
    });
    if (res.statut === 'ok') {
      onSaved(res.resultat);
      setSaveState('ok');
      setFlash(true);
      setTimeout(() => setFlash(false), 700);
      return;
    }
    if (res.statut === 'refus') onError(res.message);
    setSaveState({ attente: 'pending', conflit: 'conflit', refus: 'error' }[res.statut]);
  }, [eleve.inscription_id, eleve.nom, eleve.prenom, sequenceId, classeId, libelleSequence, onSaved, onError]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (name) => (e) => {
    const next = { ...values, [name]: e.target.value };
    setValues(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => sauvegarder(next), 500);
  };

  const etat = operation?.conflit ? 'conflit' : saveState === 'ok' || saveState === 'saving' ? saveState : operation ? 'pending' : saveState;
  return (
    <div ref={ligneRef} className={`discipline-ligne ${flash ? 'row-saved-flash' : ''}`}>
      <span className="saisie-num">{index + 1}</span>
      <div className="saisie-eleve"><EleveIdentite eleve={eleve} /></div>
      <div className="discipline-champs">
        {CHAMPS.map(([name, label]) => (
          <div key={name} className="discipline-champ">
            <label htmlFor={`d-${eleve.inscription_id}-${name}`}>{label}</label>
            <input id={`d-${eleve.inscription_id}-${name}`} type="number" inputMode="numeric" className="discipline-input" min="0" step="1" value={values[name]} onChange={change(name)} />
          </div>
        ))}
      </div>
      <input type="text" className="discipline-obs" placeholder="Observation…" aria-label={`Observation pour ${eleve.nom} ${eleve.prenom}`} value={values.observation} onChange={change('observation')} />
      <SaveState state={etat} />
    </div>
  );
}

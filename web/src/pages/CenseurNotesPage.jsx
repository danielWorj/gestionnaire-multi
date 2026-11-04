import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import { AvecChoixClasse, Avancement, Pastilles } from '../components/Espace';
import { useToast } from '../components/ui';
import {
  appreciationInfo, calculerStatistiques, EleveIdentite, filtrerRoster, KpiRow, lignesStatistiques,
  noteValeur, NotesFiltres, ReleveImprime, SaveState, StatsTable, useNotesContexte,
} from '../components/NotesCommun';

// Notes & discipline du Censeur / Surveillant : choix de la classe sur des
// cartes, puis notes en lecture seule (saisie réservée à l'enseignant) et
// suivi disciplinaire éditable, enregistré automatiquement.

const classesDepuisEspace = (payload) => payload.classes || [];

export default function CenseurNotesPage() {
  return (
    <AvecChoixClasse titre="Notes & discipline" icon="bx-spreadsheet">
      {({ classeId }) => <NotesClasse key={classeId} classeId={classeId} />}
    </AvecChoixClasse>
  );
}

function NotesClasse({ classeId }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const etablissement = useEtablissementCourant();
  const roleLabel = user?.role?.libelle === 'Surveillant' ? 'Surveillant' : 'Censeur';
  const ctx = useNotesContexte({ base: '/censeur', toast, classesDepuis: classesDepuisEspace, classeImposee: classeId });
  const { espace, annee, trimestreId, sequenceId, mcActive, roster, notesIndex, sequenceLibelle } = ctx;

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
  const stats = useMemo(() => calculerStatistiques(roster, notesIndex), [roster, notesIndex]);
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
              </div>
            </div>
          )}

          <div className="saisie-liste mb-3">
            {!pret ? (
              <div className="saisie-vide"><i className="bx bx-info-circle me-1" />{espace.loading ? 'Chargement…' : ctx.matieres.length ? 'Choisissez une séquence pour afficher les notes.' : 'Aucune matière affectée à cette classe.'}</div>
            ) : ctx.chargement && !roster.length ? (
              <div className="saisie-vide"><span className="spinner-border spinner-border-sm me-1" /> Chargement…</div>
            ) : !eleves.length ? (
              <div className="saisie-vide"><i className="bx bx-user-x me-1" />{roster.length ? 'Aucun élève ne correspond à la recherche.' : 'Aucun élève inscrit dans cette classe.'}</div>
            ) : eleves.map((eleve, idx) => {
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
          <p className="small text-muted mb-4"><i className="bx bx-lock-alt me-1" />Consultation uniquement — la saisie reste réservée à l'enseignant de la matière.</p>

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
              <div className="saisie-vide"><span className="spinner-border spinner-border-sm me-1" /> Chargement…</div>
            ) : !eleves.length ? (
              <div className="saisie-vide"><i className="bx bx-user-x me-1" />{roster.length ? 'Aucun élève ne correspond à la recherche.' : 'Aucun élève inscrit dans cette classe.'}</div>
            ) : eleves.map((eleve, idx) => (
              <DisciplineLigne
                key={`${eleve.inscription_id}-${sequenceId}-${disciplineVersion}`}
                index={idx}
                eleve={eleve}
                sequenceId={sequenceId}
                fiche={disciplinesIndex[eleve.inscription_id]}
                onSaved={onDisciplineSaved}
                onError={onDisciplineError}
              />
            ))}
          </div>
          <p className="small text-muted mb-4"><i className="bx bx-info-circle me-1" />Enregistrement automatique dès qu'un champ est modifié.</p>
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
          notesIndex={notesIndex}
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

function DisciplineLigne({ index, eleve, sequenceId, fiche, onSaved, onError }) {
  const [values, setValues] = useState(() => ({
    absences_justifiees: fiche?.absences_justifiees ?? 0,
    absences_non_justifiees: fiche?.absences_non_justifiees ?? 0,
    retards: fiche?.retards ?? 0,
    exclusions: fiche?.exclusions ?? 0,
    observation: fiche?.observation || '',
  }));
  const [saveState, setSaveState] = useState(null);
  const [flash, setFlash] = useState(false);
  const timer = useRef(null);
  const ficheId = useRef(fiche?.id);
  useEffect(() => {
    if (fiche?.id) ficheId.current = fiche.id;
  }, [fiche?.id]);

  const sauvegarder = useCallback(async (v) => {
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
    try {
      const result = ficheId.current ? await api.put(`/disciplines/${ficheId.current}`, body) : await api.post('/disciplines/', body);
      ficheId.current = result.id;
      onSaved(result);
      setSaveState('ok');
      setFlash(true);
      setTimeout(() => setFlash(false), 700);
    } catch (e) {
      setSaveState('error');
      onError(e.message);
    }
  }, [eleve.inscription_id, sequenceId, onSaved, onError]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (name) => (e) => {
    const next = { ...values, [name]: e.target.value };
    setValues(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => sauvegarder(next), 500);
  };

  return (
    <div className={`discipline-ligne ${flash ? 'row-saved-flash' : ''}`}>
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
      <SaveState state={saveState} />
    </div>
  );
}

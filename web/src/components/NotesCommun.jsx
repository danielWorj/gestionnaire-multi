import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Pastilles, useMonEspace } from './Espace';
import '../pages/notes.css';
import Select from './Select';

// Éléments communs aux pages « Notes » du Censeur/Surveillant
// (censeur/notes.html) et de l'Enseignant (enseignant/notes.html) :
// statistiques de séquence, KPI, tableau de stats, relevé imprimé.

const moyenne = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
const pct20 = (v) => (v === null ? null : (v / 20) * 100);
export const fmtNote = (v) => (v === null ? '—' : v.toFixed(2));
export const fmtPct = (v) => (v === null ? '—' : `${v.toFixed(1)} %`);

export function noteValeur(n) {
  if (!n || n.absent || n.valeur === null || n.valeur === undefined) return null;
  return Number(n.valeur);
}

export function appreciationInfo(n) {
  if (!n) return { classe: 'vide', label: '—' };
  if (n.absent) return { classe: 'absent', label: 'Absent' };
  if (n.valeur === null || n.valeur === undefined) return { classe: 'vide', label: '—' };
  const v = Number(n.valeur);
  if (v >= 14) return { classe: 'ok', label: 'Très bien' };
  if (v >= 10) return { classe: 'moyen', label: 'Passable' };
  return { classe: 'faible', label: 'Insuffisant' };
}


function groupe(eleves, notesIndex) {
  const valeurs = eleves.map((e) => noteValeur(notesIndex[e.inscription_id])).filter((v) => v !== null);
  const absents = eleves.filter((e) => notesIndex[e.inscription_id]?.absent).length;
  const effectif = eleves.length;
  const notesSaisies = valeurs.length + absents;
  const moy = moyenne(valeurs);
  return {
    effectif,
    notesSaisies,
    absents,
    moy,
    moyPct: pct20(moy),
    tauxReussite: valeurs.length ? (valeurs.filter((v) => v >= 10).length / valeurs.length) * 100 : null,
    meilleureNote: valeurs.length ? Math.max(...valeurs) : null,
    noteLaPlusBasse: valeurs.length ? Math.min(...valeurs) : null,
    insuffisant: effectif === 0 || valeurs.length === 0,
    notesIncompletes: effectif > 0 && notesSaisies < effectif,
  };
}

export function calculerStatistiques(roster, notesIndex) {
  return {
    classe: groupe(roster, notesIndex),
    filles: groupe(roster.filter((e) => e.sexe === 'F'), notesIndex),
    garcons: groupe(roster.filter((e) => e.sexe === 'M'), notesIndex),
  };
}

const zero = (v) => (v === null ? 0 : v);
export function lignesStatistiques(s) {
  const cell = (g, texte, cls = '') => ({ texte, cls: g.insuffisant ? 'valeur-insuffisante' : cls });
  const niveau = (v, haut, bas) => (v >= haut ? 'valeur-forte' : v < bas ? 'valeur-faible' : '');
  const mk = (fn) => ({ classe: fn(s.classe), filles: fn(s.filles), garcons: fn(s.garcons) });
  return [
    { libelle: 'Effectif', ...mk((g) => ({ texte: `${g.effectif}`, cls: g.effectif === 0 ? 'valeur-insuffisante' : '' })) },
    { libelle: "Notes saisies (sur l'effectif)", ...mk((g) => ({ texte: `${g.notesSaisies} / ${g.effectif}`, cls: g.effectif === 0 || g.notesIncompletes ? 'valeur-insuffisante' : '' })) },
    { libelle: 'Absents à cette séquence', ...mk((g) => ({ texte: `${g.absents}`, cls: g.effectif === 0 ? 'valeur-insuffisante' : '' })) },
    { libelle: 'Moyenne générale (/20)', ...mk((g) => cell(g, fmtNote(zero(g.moy)), niveau(g.moy, 14, 10))) },
    { libelle: 'Pourcentage de moyenne (%)', ...mk((g) => cell(g, fmtPct(zero(g.moyPct)), niveau(g.moyPct, 60, 40))) },
    { libelle: 'Taux de réussite (notes ≥ 10/20)', ...mk((g) => cell(g, fmtPct(zero(g.tauxReussite)), niveau(g.tauxReussite, 60, 40))) },
    { libelle: 'Meilleure note', ...mk((g) => cell(g, fmtNote(zero(g.meilleureNote)))) },
    { libelle: 'Note la plus basse', ...mk((g) => cell(g, fmtNote(zero(g.noteLaPlusBasse)))) },
  ];
}

export function KpiRow({ stats }) {
  const k = (label, value, sub, cls) => (
    <div className="col-6 col-xl-3">
      <div className={`kpi-card ${cls}`}>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value}</div>
        <div className="kpi-sub">{sub}</div>
      </div>
    </div>
  );
  return (
    <div className="row g-3 mb-3">
      {k('Moyenne générale', fmtPct(zero(stats.classe.moyPct)), 'de la moyenne des notes saisies', 'kpi-primary')}
      {k('Moyenne des filles', fmtPct(zero(stats.filles.moyPct)), `${stats.filles.effectif} fille(s) — moy. ${fmtNote(zero(stats.filles.moy))}/20`, 'kpi-info')}
      {k('Moyenne des garçons', fmtPct(zero(stats.garcons.moyPct)), `${stats.garcons.effectif} garçon(s) — moy. ${fmtNote(zero(stats.garcons.moy))}/20`, 'kpi-info')}
      {k('Taux de réussite', fmtPct(zero(stats.classe.tauxReussite)), 'élèves avec une moyenne ≥ 10/20', 'kpi-success')}
    </div>
  );
}

export function StatsTable({ lignes }) {
  return (
    <table className="stats-table">
      <thead><tr><th style={{ textAlign: 'left' }}>Indicateur</th><th>Ensemble de la classe</th><th>Filles</th><th>Garçons</th></tr></thead>
      <tbody>
        {lignes.map((l) => (
          <tr key={l.libelle}>
            <td className="libelle-col">{l.libelle}</td>
            <td className={l.classe.cls}>{l.classe.texte}</td>
            <td className={l.filles.cls}>{l.filles.texte}</td>
            <td className={l.garcons.cls}>{l.garcons.texte}</td>
          </tr>
        ))}
        <tr><td colSpan={4} className="stats-note-insuffisant"><i className="bx bx-error-circle me-1" />* donnée insuffisante (aucun élève dans le groupe, ou aucune note encore saisie)</td></tr>
      </tbody>
    </table>
  );
}

export function ContexteBandeau({ classe, matiere, sequence, effectif }) {
  return (
    <div className="contexte-bandeau">
      <div className="item"><i className="bx bx-chalkboard" /> {classe}</div>
      <div className="sep" />
      <div className="item"><i className="bx bx-book" /> {matiere}</div>
      <div className="sep" />
      <div className="item"><i className="bx bx-calendar" /> {sequence}</div>
      <div className="sep" />
      <div className="item"><i className="bx bx-group" /> {effectif} élève(s)</div>
    </div>
  );
}

// Relevé de notes imprimé (zone .notes-print, visible uniquement à l'impression).
export function ReleveImprime({ variante, etablissement: e, classe, matiere, coefficient, sequence, effectif, lignes, eleves, notesIndex, avecSexe }) {
  const date = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
  const heure = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const matiereTexte = matiere ? `${matiere}${coefficient != null ? ` (coef. ${coefficient})` : ''}` : '—';
  return (
    <div className="notes-print print-area">
      <div className="print-topbar">
        <span>{variante === 'enseignant' ? `${date} ${heure}` : `Imprimé le ${date}`}</span>
        <span>{variante === 'enseignant' ? 'Notes — Enseignant' : `Notes & discipline — ${variante}`}</span>
      </div>
      <div className="print-etablissement">
        <div className="print-etab-logo">{e?.logo_url ? <img src={e.logo_url} alt="Logo" /> : <i className="bx bx-building-house" />}</div>
        <div>
          <p className="print-etab-nom">{e?.nom || '—'}</p>
          <p className="print-etab-contact">{[e?.region, e?.bp, e?.telephone ? `Tél. ${e.telephone}` : null].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <hr className="print-separator" />
      <div className="print-header">
        <h2>Relevé de notes</h2>
        {variante === 'enseignant' && <p className="print-sous-titre">{matiere || '—'} — {classe || '—'} — {sequence}</p>}
        <div className="print-meta">
          <span><strong>Classe :</strong> {classe || '—'}</span>
          <span><strong>Matière :</strong> {matiereTexte}</span>
          <span><strong>Séquence :</strong> {sequence}</span>
          <span><strong>Effectif :</strong> {effectif} élève(s)</span>
          {variante === 'enseignant' && <span><strong>Date d'impression :</strong> {date}</span>}
        </div>
      </div>
      <h3>{variante === 'enseignant' ? 'Statistiques de la classe pour cette séquence' : 'Statistiques'}</h3>
      <table className="print-stats-table">
        <thead><tr><th style={{ textAlign: 'left' }}>Indicateur</th><th>{variante === 'enseignant' ? 'Ensemble de la classe' : 'Classe'}</th><th>Filles</th><th>Garçons</th></tr></thead>
        <tbody>
          {lignes.map((l) => (
            <tr key={l.libelle}>
              <td style={{ textAlign: 'left', fontWeight: 600 }}>{l.libelle}</td>
              <td className={l.classe.cls}>{l.classe.texte}</td>
              <td className={l.filles.cls}>{l.filles.texte}</td>
              <td className={l.garcons.cls}>{l.garcons.texte}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>{variante === 'enseignant' ? 'Notes des élèves' : 'Résultats des élèves'}</h3>
      <table className="print-eleves-table">
        <thead><tr><th>#</th><th style={{ textAlign: 'left' }}>Élève</th><th>Matricule</th>{avecSexe && <th>Sexe</th>}<th>{avecSexe ? 'Note / 20' : 'Note'}</th></tr></thead>
        <tbody>
          {eleves.map((eleve, idx) => {
            const n = notesIndex[eleve.inscription_id];
            const absent = Boolean(n?.absent);
            const v = noteValeur(n);
            const cls = !absent && v !== null ? (v < 10 ? 'note-faible' : v >= 14 ? 'note-forte' : '') : '';
            return (
              <tr key={eleve.inscription_id}>
                <td>{idx + 1}</td>
                <td style={{ textAlign: 'left' }}>{eleve.nom} {eleve.prenom}</td>
                <td>{eleve.matricule || '—'}</td>
                {avecSexe && <td>{eleve.sexe || '?'}</td>}
                <td className={cls}>{absent ? 'Absent' : v === null ? 'Non noté' : `${v.toFixed(2)} / 20`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Filtres + chargement communs : année → trimestres/séquences, classe →
// matières, roster de la classe/année, notes de la classe.
// `base` : '/censeur' ou '/enseignant' (endpoints mon-espace/sequences/roster).
// `classeImposee` / `mcImpose` : classe (Censeur) ou matière-classe
// (Enseignant) choisie sur sa carte, qui fixe la sélection.
export function useNotesContexte({ base, toast, classesDepuis, classeImposee = null, mcImpose = null }) {
  const monEspace = useMonEspace(base);
  const payload = monEspace.data;
  const espace = useMemo(() => (payload
    ? {
      loading: false,
      classes: classesDepuis(payload),
      matieresClasse: payload.matieres_classe || [],
      annees: payload.annees_scolaires || [],
      sequenceCourante: payload.sequence_courante || null,
    }
    : { loading: monEspace.loading, classes: [], matieresClasse: [], annees: [], sequenceCourante: null }),
  // classesDepuis : stable pour la durée de vie de la page
  [payload, monEspace.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const [annee, setAnnee] = useState('');
  const [classeId, setClasseId] = useState('');
  const [mcId, setMcId] = useState('');
  const [trimestreId, setTrimestreId] = useState('');
  const [sequenceId, setSequenceId] = useState('');
  const [sequencesTree, setSequencesTree] = useState([]);
  const [roster, setRoster] = useState([]);
  const [notes, setNotes] = useState([]);
  const [chargement, setChargement] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (monEspace.error && !payload) toast(`Impossible de charger votre espace : ${monEspace.error.message}`, 'error');
  }, [monEspace.error]); // eslint-disable-line react-hooks/exhaustive-deps

  const mcImposeObj = mcImpose ? espace.matieresClasse.find((mc) => String(mc.id) === String(mcImpose)) : null;
  const classeVoulue = classeImposee ?? mcImposeObj?.classe_id ?? null;

  // Valeurs par défaut : l'espace est revalidé en arrière-plan, ces mises à
  // jour ne doivent jamais écraser une sélection encore valide.
  useEffect(() => {
    if (!payload) return;
    setAnnee((prev) => prev || String((espace.annees.find((a) => a.active) || espace.annees[0])?.id ?? ''));
    setClasseId((prev) => {
      if (classeVoulue != null) return String(classeVoulue);
      return prev && espace.classes.some((c) => String(c.id) === prev) ? prev : String(espace.classes[0]?.id ?? '');
    });
  }, [payload, classeVoulue]); // eslint-disable-line react-hooks/exhaustive-deps

  const matieres = useMemo(() => espace.matieresClasse
    .filter((mc) => String(mc.classe_id) === String(classeId))
    .sort((a, b) => (a.matiere_libelle || '').localeCompare(b.matiere_libelle || '', 'fr')), [espace.matieresClasse, classeId]);

  // Classe changée : matière imposée, sinon première matière de la classe.
  useEffect(() => {
    setMcId((prev) => {
      if (prev && matieres.some((mc) => String(mc.id) === prev)) return prev;
      const voulue = mcImpose && matieres.find((mc) => String(mc.id) === String(mcImpose));
      return String((voulue || matieres[0])?.id ?? '');
    });
  }, [matieres, mcImpose]);

  // Année changée : arbre trimestres/séquences.
  useEffect(() => {
    if (!annee) {
      setSequencesTree([]);
      return undefined;
    }
    let cancelled = false;
    api.get(`${base}/sequences?annee_scolaire_id=${annee}`)
      .then((tree) => { if (!cancelled) setSequencesTree(tree || []); })
      .catch((e) => { if (!cancelled) { setSequencesTree([]); toast(`Séquences : ${e.message}`, 'error'); } });
    return () => { cancelled = true; };
  }, [annee, base]); // eslint-disable-line react-hooks/exhaustive-deps

  // Par défaut : la séquence en cours (et son trimestre), sinon la première.
  useEffect(() => {
    setTrimestreId((prev) => {
      if (prev && sequencesTree.some((t) => String(t.trimestre_id) === prev)) return prev;
      const sc = espace.sequenceCourante;
      const tri = sc && sequencesTree.find((t) => String(t.trimestre_id) === String(sc.trimestre_id));
      return String((tri || sequencesTree[0])?.trimestre_id ?? '');
    });
  }, [sequencesTree]); // eslint-disable-line react-hooks/exhaustive-deps
  const sequences = useMemo(() => sequencesTree.find((t) => String(t.trimestre_id) === String(trimestreId))?.sequences || [], [sequencesTree, trimestreId]);
  useEffect(() => {
    setSequenceId((prev) => {
      if (prev && sequences.some((s) => String(s.id) === prev)) return prev;
      const sc = espace.sequenceCourante;
      const seq = sc && sequences.find((s) => String(s.id) === String(sc.id));
      return String((seq || sequences[0])?.id ?? '');
    });
  }, [sequences]); // eslint-disable-line react-hooks/exhaustive-deps

  // Choix direct d'une séquence (pastilles) : fixe aussi son trimestre.
  const choisirSequence = (id) => {
    const tri = sequencesTree.find((t) => (t.sequences || []).some((s) => String(s.id) === String(id)));
    if (tri) setTrimestreId(String(tri.trimestre_id));
    setSequenceId(String(id));
  };

  // Roster de la classe/année.
  useEffect(() => {
    if (!classeId || !annee) {
      setRoster([]);
      return undefined;
    }
    let cancelled = false;
    api.get(`${base}/roster?classe_id=${classeId}&annee_scolaire_id=${annee}`)
      .then((r) => { if (!cancelled) setRoster(r || []); })
      .catch((e) => { if (!cancelled) { setRoster([]); toast(`Liste des élèves : ${e.message}`, 'error'); } });
    return () => { cancelled = true; };
  }, [classeId, annee, base, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notes de la classe (toutes matières et séquences visibles), filtrées
  // côté serveur : changer de matière ou de séquence ne recharge rien.
  useEffect(() => {
    if (!classeId) {
      setNotes([]);
      return undefined;
    }
    let cancelled = false;
    setChargement(true);
    api.get(`/notes/?classe_id=${classeId}`)
      .then((n) => { if (!cancelled) setNotes(n || []); })
      .catch((e) => { if (!cancelled) { setNotes([]); toast(`Notes : ${e.message}`, 'error'); } })
      .finally(() => { if (!cancelled) setChargement(false); });
    return () => { cancelled = true; };
  }, [classeId, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const notesIndex = useMemo(() => {
    const idx = {};
    notes.filter((n) => String(n.matiere_classe_id) === String(mcId) && String(n.sequence_id) === String(sequenceId)).forEach((n) => { idx[n.inscription_id] = n; });
    return idx;
  }, [notes, mcId, sequenceId]);

  const sequenceLibelle = useMemo(() => {
    for (const tri of sequencesTree) {
      const seq = (tri.sequences || []).find((s) => String(s.id) === String(sequenceId));
      if (seq) return `${tri.trimestre_libelle} — ${seq.libelle}`;
    }
    return '—';
  }, [sequencesTree, sequenceId]);

  return {
    espace, annee, setAnnee, classeId, setClasseId, mcId, setMcId, trimestreId, setTrimestreId, sequenceId, setSequenceId,
    choisirSequence, sequencesTree, sequences, matieres, roster, notes, setNotes, notesIndex, chargement, sequenceLibelle,
    mcActive: matieres.find((mc) => String(mc.id) === String(mcId)) || null,
    actualiser: () => {
      setVersion((v) => v + 1);
      monEspace.recharger();
    },
  };
}

// Toutes les séquences de l'année en une rangée de pastilles (un seul geste
// sur mobile) ; le trimestre n'est préfixé que si les libellés se répètent.
export function optionsSequences(sequencesTree, sequenceCourante) {
  const toutes = sequencesTree.flatMap((t) => (t.sequences || []).map((s) => ({ ...s, trimestre_libelle: t.trimestre_libelle })));
  const uniques = new Set(toutes.map((s) => s.libelle)).size === toutes.length;
  return toutes.map((s) => ({
    value: s.id,
    label: uniques ? s.libelle : `${s.trimestre_libelle} · ${s.libelle}`,
    badge: sequenceCourante && String(sequenceCourante.id) === String(s.id) ? 'en cours' : null,
  }));
}

// Barre de filtres commune : année, classe (sauf si imposée), matière en
// pastilles (sauf si imposée), séquence en pastilles, recherche.
export function NotesFiltres({ ctx, recherche, setRecherche, masquerClasse = false, masquerMatiere = false }) {
  const { espace, annee, setAnnee, classeId, setClasseId, mcId, setMcId, sequenceId, choisirSequence, sequencesTree, matieres } = ctx;
  const seqOptions = optionsSequences(sequencesTree, espace.sequenceCourante);
  return (
    <div className="card mb-3 notes-filtres">
      <div className="card-body">
        <div className="notes-filtres-ligne">
          <div className="notes-filtre-champ">
            <label className="form-label">Année scolaire</label>
            <Select className="form-select" value={annee} onChange={(e) => setAnnee(e.target.value)}>
              {espace.loading ? <option value="">Chargement…</option> : espace.annees.length
                ? espace.annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (active)' : ''}</option>)
                : <option value="">Aucune année scolaire</option>}
            </Select>
          </div>
          {!masquerClasse && (
            <div className="notes-filtre-champ">
              <label className="form-label">Classe</label>
              <Select className="form-select" value={classeId} onChange={(e) => setClasseId(e.target.value)}>
                {espace.loading ? <option value="">Chargement…</option> : espace.classes.length
                  ? espace.classes.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)
                  : <option value="">Aucune classe assignée</option>}
              </Select>
            </div>
          )}
          <div className="notes-filtre-champ notes-filtre-recherche">
            <label className="form-label">Rechercher un élève</label>
            <div className="esp-recherche">
              <i className="bx bx-search" />
              <input type="search" className="form-control" placeholder="Nom, prénom, matricule…" value={recherche} onChange={(e) => setRecherche(e.target.value)} />
            </div>
          </div>
        </div>
        {!masquerMatiere && (
          <div className="notes-filtre-bloc">
            <div className="notes-filtre-label">Matière</div>
            {matieres.length
              ? <Pastilles ariaLabel="Matière" value={mcId} onChange={setMcId} options={matieres.map((mc) => ({ value: mc.id, label: mc.matiere_libelle }))} />
              : <small className="text-muted">{espace.classes.length ? 'Aucune matière affectée à cette classe.' : '—'}</small>}
          </div>
        )}
        <div className="notes-filtre-bloc">
          <div className="notes-filtre-label">Séquence</div>
          {seqOptions.length
            ? <Pastilles ariaLabel="Séquence" value={sequenceId} onChange={choisirSequence} options={seqOptions} />
            : <small className="text-muted">{annee ? 'Aucune séquence pour cette année.' : '—'}</small>}
        </div>
      </div>
    </div>
  );
}

export function filtrerRoster(roster, recherche) {
  const q = recherche.trim().toLowerCase();
  return roster
    .filter((e) => !q || `${e.nom} ${e.prenom} ${e.matricule || ''}`.toLowerCase().includes(q))
    .sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr'));
}

export function EleveIdentite({ eleve }) {
  return (
    <div className="eleve-identite">
      <div>
        <div className="eleve-nom">{eleve.nom} {eleve.prenom}</div>
        <div className="eleve-matricule">{eleve.matricule || '—'}</div>
      </div>
    </div>
  );
}

export function SaveState({ state }) {
  const icons = { saving: 'bx-loader-alt bx-spin', error: 'bx-error', ok: 'bx-check', pending: 'bx-time-five' };
  return <span className={`save-state ${state || ''}`}>{state && <i className={`bx ${icons[state]}`} />}</span>;
}

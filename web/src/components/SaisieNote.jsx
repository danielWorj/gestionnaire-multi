import { useCallback, useEffect, useRef, useState } from 'react';
import { avecEtablissement } from '../lib/api';
import { cleNote, enregistrer, SYNCHRO_EVENT } from '../lib/offline';
import { appreciationInfo, codeComposante, EleveIdentite, noteSequence, noteValeur, SaveState } from './NotesCommun';

// Saisie des notes, partagée par l'espace Enseignant (ses matières) et le
// SuperAdmin (saisie pour le compte d'un établissement, cf. CenseurNotesPage) :
// - useEnregistrementNotes : envoi d'une note (tout de suite si possible,
//   sinon gardée sur l'appareil ; conflit tranché par l'utilisateur, cf.
//   lib/offline.js), suivi de l'état de chaque ligne, fusion des résultats
//   de la synchronisation globale ;
// - NoteLigne : une ligne « élève + note + ABS » (Entrée = élève suivant) ;
// - GrilleNotes : la liste des élèves d'une séquence, une évaluation à la
//   fois ou, en mode Collège/Institut, toutes les évaluations (CC, DS…) sur
//   la même ligne (NoteLigneMulti).

export function parseNote(texte) {
  const t = String(texte).trim().replace(',', '.');
  if (t === '') return { ok: true, valeur: null };
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return { ok: false };
  const v = Number(t);
  return v >= 0 && v <= 20 ? { ok: true, valeur: v } : { ok: false };
}

export function useEnregistrementNotes({ notes, setNotes, roster, mcActive, classeId, sequencesTree, composantes = [], toast }) {
  const [saveStates, setSaveStates] = useState({});

  // Lu par envoyer() : toujours la dernière version des notes de la classe.
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  const libelleSequence = useCallback((id) => {
    for (const tri of sequencesTree) {
      const seq = (tri.sequences || []).find((x) => String(x.id) === String(id));
      if (seq) return `${tri.trimestre_libelle} — ${seq.libelle}`;
    }
    return 'Séquence';
  }, [sequencesTree]);

  const fusionnerNotes = useCallback((recues) => setNotes((list) => {
    const next = [...list];
    recues.forEach((note) => {
      const i = next.findIndex((n) => n.id === note.id);
      if (i < 0) next.push(note);
      else next[i] = note;
    });
    return next;
  }), [setNotes]);

  // Synchronisation globale (components/HorsLigne.jsx) : notes envoyées,
  // conflits tranchés (« garder celle du serveur ») ou refusés.
  useEffect(() => {
    const onSynchro = (e) => {
      const deNotes = (liste) => liste.filter((x) => (x.op || x).module === 'notes');
      const { envoyees, ignorees, refusees, conflits } = e.detail;
      fusionnerNotes([...deNotes(envoyees).map((x) => x.resultat), ...deNotes(ignorees).map((x) => x.serveur)].filter(Boolean));
      setSaveStates((s) => {
        const next = { ...s };
        deNotes(envoyees).forEach(({ op }) => { next[op.cle] = 'ok'; });
        deNotes(ignorees).forEach(({ op }) => { delete next[op.cle]; });
        deNotes(refusees).forEach(({ op }) => { next[op.cle] = 'error'; });
        deNotes(conflits).forEach((op) => { next[op.cle] = 'conflit'; });
        return next;
      });
    };
    window.addEventListener(SYNCHRO_EVENT, onSynchro);
    return () => window.removeEventListener(SYNCHRO_EVENT, onSynchro);
  }, [fusionnerNotes]);

  // Si quelqu'un d'autre a modifié la note entre-temps, l'utilisateur
  // tranche (écraser / ignorer). URL figée sur l'établissement de la saisie
  // (SuperAdmin) : une note gardée hors connexion part au bon endroit.
  const envoyer = useCallback(async (body) => {
    const id = String(body.inscription_id);
    const cle = cleNote(body);
    const existante = notesRef.current.find((n) => String(n.inscription_id) === id
      && String(n.matiere_classe_id) === String(body.matiere_classe_id) && String(n.sequence_id) === String(body.sequence_id)
      && codeComposante(n) === codeComposante(body)) || null;
    const eleve = roster.find((r) => String(r.inscription_id) === id);
    const evaluation = body.composante ? composantes.find((c) => c.code === body.composante)?.libelle : null;
    setSaveStates((s) => ({ ...s, [cle]: 'saving' }));
    const res = await enregistrer({
      cle,
      module: 'notes',
      methode: existante?.id ? 'PUT' : 'POST',
      url: avecEtablissement(existante?.id ? `/notes/${existante.id}` : '/notes/'),
      body,
      // Version vue à l'écran ; null : la note n'existait pas (création).
      // undefined (copie locale antérieure au versionnage) : pas de contrôle.
      versionBase: existante ? existante.version ?? undefined : null,
      libelle: `${eleve ? `${eleve.nom} ${eleve.prenom}` : `Élève n°${id}`} — ${mcActive?.matiere_libelle || 'Matière'} · ${libelleSequence(body.sequence_id)}${evaluation ? ` · ${evaluation}` : ''}`,
      cache: avecEtablissement(`/notes/?classe_id=${classeId}`),
    });
    if (res.statut === 'ok') {
      fusionnerNotes([res.resultat]);
      setSaveStates((s) => ({ ...s, [cle]: 'ok' }));
      return true;
    }
    if (res.statut === 'refus') toast(`Enregistrement impossible : ${res.message}`, 'error');
    setSaveStates((s) => ({ ...s, [cle]: { attente: 'pending', conflit: 'conflit', refus: 'error' }[res.statut] }));
    return false;
  }, [roster, mcActive, libelleSequence, classeId, fusionnerNotes, composantes, toast]);

  return { envoyer, saveStates };
}

// Saisie enchaînée : Entrée valide la note et passe à l'élève suivant.
export function focusSuivant(index) {
  const suivant = document.querySelector(`[data-saisie-index="${index + 1}"]`);
  if (suivant) {
    suivant.focus();
    suivant.select?.();
  }
}

export function NoteLigne({ index, eleve, note, attente: operation, saveState, onSave, onInvalid, onSuivant, evaluation = 'Note', verrouille = false }) {
  // Une note en attente d'envoi (ou en conflit) prime sur celle du serveur.
  const attente = operation?.body || null;
  const source = attente || note;
  const absent = Boolean(source?.absent);
  const initial = attente ? attente.valeur : noteValeur(note);
  const texteInitial = initial === null || initial === undefined ? '' : String(initial).replace('.', ',');
  const [valeur, setValeur] = useState(texteInitial);
  const champRef = useRef(null);
  // La valeur de référence change sans que l'utilisateur tape (conflit tranché
  // « garder celle du serveur », synchronisation) : le champ suit, sauf s'il
  // est en cours de saisie.
  useEffect(() => {
    if (document.activeElement !== champRef.current) setValeur(texteInitial);
  }, [texteInitial]);
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
          aria-label={`${evaluation} de ${eleve.nom} ${eleve.prenom}`}
          ref={champRef}
          data-saisie-index={index}
          disabled={absent || verrouille}
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
        <button type="button" className={`note-abs-toggle saisie-abs ${absent ? 'is-absent' : ''}`} aria-pressed={absent} title="Marquer absent" onClick={toggleAbsent} disabled={verrouille}>ABS</button>
        <SaveState state={operation?.conflit ? 'conflit' : saveState || (attente ? 'pending' : null)} />
      </div>
    </div>
  );
}

// « abs » (ou « a ») = absent, sinon une note de 0 à 20 (vide = effacée).
export function parseSaisie(texte) {
  const t = String(texte).trim().toLowerCase();
  if (t === 'a' || t === 'abs' || t === 'absent') return { ok: true, valeur: null, absent: true };
  const p = parseNote(t);
  return p.ok ? { ok: true, valeur: p.valeur, absent: false } : { ok: false };
}

export const texteSaisie = (n) => {
  if (!n) return '';
  if (n.absent) return 'abs';
  return n.valeur === null || n.valeur === undefined ? '' : String(Number(n.valeur)).replace('.', ',');
};

// Un champ par évaluation (CC, DS, Ev. Tr.) dans la vue « toutes ».
function ChampEvaluation({ composante, eleve, note, operation, saveState, index, onSave, onInvalid, onSuivant, verrouille = false }) {
  const source = operation?.body || note;
  const texteInitial = texteSaisie(source);
  const [texte, setTexte] = useState(texteInitial);
  const champRef = useRef(null);
  useEffect(() => {
    if (document.activeElement !== champRef.current) setTexte(texteInitial);
  }, [texteInitial]);
  const v = noteValeur(source);
  const cls = source?.absent ? 'is-absent' : v === null ? '' : v < 10 ? 'note-faible' : v >= 14 ? 'note-forte' : '';

  const commit = (e) => {
    const brut = e.target.value;
    if (brut.trim().toLowerCase() === texteInitial.toLowerCase()) return;
    const p = parseSaisie(brut);
    if (!p.ok) {
      onInvalid();
      setTexte(texteInitial);
      return;
    }
    onSave({ valeur: p.valeur, absent: p.absent });
  };

  return (
    <label className="saisie-eval">
      <span className="saisie-eval-libelle">{composante.libelle}</span>
      <span className="saisie-eval-champ">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="next"
          className={`note-input saisie-input saisie-input-eval ${cls}`}
          placeholder="—"
          aria-label={`${composante.libelle} de ${eleve.nom} ${eleve.prenom}`}
          ref={champRef}
          data-saisie-index={index}
          disabled={verrouille}
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
              onSuivant();
            }
          }}
        />
        <SaveState state={operation?.conflit ? 'conflit' : saveState || (operation ? 'pending' : null)} />
      </span>
    </label>
  );
}

export function NoteLigneMulti({ index, eleve, composantes, notes, operations, saveStates, onSave, onInvalid, verrouille = false }) {
  const detail = Object.fromEntries(composantes.map((c) => [c.code, operations[c.code]?.body || notes[c.code]]));
  const calculee = noteSequence(detail, composantes);
  const v = noteValeur(calculee);
  const appr = appreciationInfo(calculee);
  const premier = index * composantes.length;
  return (
    <div className="saisie-ligne saisie-ligne-multi">
      <span className="saisie-num">{index + 1}</span>
      <div className="saisie-eleve">
        <EleveIdentite eleve={eleve} />
        <span className={`appreciation-badge ${appr.classe} saisie-appr`}>{appr.label}</span>
      </div>
      <div className="saisie-evals">
        {composantes.map((c, k) => (
          <ChampEvaluation
            key={c.code}
            composante={c}
            eleve={eleve}
            note={notes[c.code]}
            operation={operations[c.code]}
            saveState={saveStates[c.code]}
            index={premier + k}
            onSave={(payload) => onSave(c.code, payload)}
            onInvalid={onInvalid}
            onSuivant={() => focusSuivant(premier + k)}
            verrouille={verrouille}
          />
        ))}
        <div className="saisie-eval saisie-eval-resultat" title="Note de la séquence (calculée)">
          <span className="saisie-eval-libelle">Séq.</span>
          <span className={`saisie-eval-note ${v === null ? 'text-muted' : v < 10 ? 'note-faible' : v >= 14 ? 'note-forte' : ''}`}>{v === null ? '—' : v.toFixed(2).replace('.', ',')}</span>
        </div>
      </div>
    </div>
  );
}

// Liste de saisie d'une séquence. vue : code d'une évaluation (une seule
// colonne, comme en mode Lycée) ou 'tout' (toutes les évaluations par ligne).
// onSave(inscription_id, composante, { valeur, absent }).
// verrouille : séquence clôturée pour ce compte (champs en lecture seule).
export function GrilleNotes({ eleves, composantes, vue, index, attente, saveStates, mcId, sequenceId, onSave, onInvalid, verrouille = false }) {
  const cle = (inscriptionId, code) => cleNote({ inscription_id: inscriptionId, matiere_classe_id: mcId, sequence_id: sequenceId, composante: code });
  if (vue === 'tout' && composantes.length > 1) {
    return eleves.map((eleve, idx) => (
      <NoteLigneMulti
        key={`${eleve.inscription_id}-${mcId}-${sequenceId}`}
        index={idx}
        eleve={eleve}
        composantes={composantes}
        notes={Object.fromEntries(composantes.map((c) => [c.code, index.parCode[c.code]?.[eleve.inscription_id]]))}
        operations={Object.fromEntries(composantes.map((c) => [c.code, attente[cle(eleve.inscription_id, c.code)]]))}
        saveStates={Object.fromEntries(composantes.map((c) => [c.code, saveStates[cle(eleve.inscription_id, c.code)]]))}
        onSave={(code, payload) => onSave(eleve.inscription_id, code, payload)}
        onInvalid={onInvalid}
        verrouille={verrouille}
      />
    ));
  }
  const evaluation = composantes.find((c) => c.code === vue) || composantes[0];
  return eleves.map((eleve, idx) => (
    <NoteLigne
      key={`${eleve.inscription_id}-${mcId}-${sequenceId}-${evaluation.code}`}
      index={idx}
      eleve={eleve}
      evaluation={composantes.length > 1 ? evaluation.libelle : 'Note'}
      note={index.parCode[evaluation.code]?.[eleve.inscription_id]}
      attente={attente[cle(eleve.inscription_id, evaluation.code)]}
      saveState={saveStates[cle(eleve.inscription_id, evaluation.code)]}
      onSave={(payload) => onSave(eleve.inscription_id, evaluation.code, payload)}
      onInvalid={onInvalid}
      onSuivant={() => focusSuivant(idx)}
      verrouille={verrouille}
    />
  ));
}

// Pastilles « CC | DS | Ev. Tr. | Les 3 » (mode Collège/Institut seulement).
export function optionsEvaluations(composantes) {
  if (composantes.length < 2) return [];
  return [
    ...composantes.map((c) => ({ value: c.code, label: c.libelle })),
    { value: 'tout', label: `Les ${composantes.length}` },
  ];
}

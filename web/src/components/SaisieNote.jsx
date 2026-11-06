import { useCallback, useEffect, useRef, useState } from 'react';
import { avecEtablissement } from '../lib/api';
import { cleNote, enregistrer, SYNCHRO_EVENT } from '../lib/offline';
import { appreciationInfo, EleveIdentite, noteValeur, SaveState } from './NotesCommun';

// Saisie des notes, partagée par l'espace Enseignant (ses matières) et le
// SuperAdmin (saisie pour le compte d'un établissement, cf. CenseurNotesPage) :
// - useEnregistrementNotes : envoi d'une note (tout de suite si possible,
//   sinon gardée sur l'appareil ; conflit tranché par l'utilisateur, cf.
//   lib/offline.js), suivi de l'état de chaque ligne, fusion des résultats
//   de la synchronisation globale ;
// - NoteLigne : une ligne « élève + note + ABS » (Entrée = élève suivant).

export function parseNote(texte) {
  const t = String(texte).trim().replace(',', '.');
  if (t === '') return { ok: true, valeur: null };
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return { ok: false };
  const v = Number(t);
  return v >= 0 && v <= 20 ? { ok: true, valeur: v } : { ok: false };
}

export function useEnregistrementNotes({ notes, setNotes, roster, mcActive, classeId, sequencesTree, toast }) {
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
      && String(n.matiere_classe_id) === String(body.matiere_classe_id) && String(n.sequence_id) === String(body.sequence_id)) || null;
    const eleve = roster.find((r) => String(r.inscription_id) === id);
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
      libelle: `${eleve ? `${eleve.nom} ${eleve.prenom}` : `Élève n°${id}`} — ${mcActive?.matiere_libelle || 'Matière'} · ${libelleSequence(body.sequence_id)}`,
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
  }, [roster, mcActive, libelleSequence, classeId, fusionnerNotes, toast]);

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

export function NoteLigne({ index, eleve, note, attente: operation, saveState, onSave, onInvalid, onSuivant }) {
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
          aria-label={`Note de ${eleve.nom} ${eleve.prenom}`}
          ref={champRef}
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
        <SaveState state={operation?.conflit ? 'conflit' : saveState || (attente ? 'pending' : null)} />
      </div>
    </div>
  );
}

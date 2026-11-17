import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ChartCanvas from '../components/ChartCanvas';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import { Avancement, BarreClasse, ClassesGrille, EspaceTitre, nomClasse, Pastilles, useMonEspace } from '../components/Espace';
import { useToast } from '../components/ui';
import ImportModal from '../components/importConfigs';
import { cleNote, useOperationsEnAttente } from '../lib/offline';
import {
  GrilleNotes, optionsEvaluations, parseSaisie, texteSaisie, useEnregistrementNotes,
} from '../components/SaisieNote';
import {
  calculerStatistiques, compterSaisies, EleveIdentite, filtrerRoster, indexerNotes, KpiRow, lignesStatistiques,
  noteSequence, noteValeur, NotesFiltres, ReleveImprime, SaveState, StatsTable, useNotesContexte,
} from '../components/NotesCommun';
import { SkelListe, SkelSaisie } from '../components/Skeleton';

// Saisie des notes de l'enseignant, pensée d'abord pour le téléphone :
// 1. cartes « classe · matière » avec l'avancement de la séquence en cours ;
// 2. liste des élèves, une note par ligne (clavier numérique, Entrée = élève
//    suivant, enregistrement automatique, notes gardées sur l'appareil sans
//    connexion et envoyées à son retour — cf. lib/offline.js), puis
//    statistiques et relevé imprimable. En mode Collège/Institut, l'enseignant
//    choisit l'évaluation à remplir (CC, DS, Ev. Tr.) ou toutes à la fois ;
// 3. « Relevé de l'année » : toutes les notes de la matière-classe, séquence
//    par séquence, pour revoir et corriger après coup (même enregistrement,
//    y compris hors connexion).

const PRIMARY = '#696cff';

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
    titre: nomClasse(mc.classe_option, mc.classe_label),
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

function SaisieNotes({ mcId: mcParam, onRetour }) {
  const toast = useToast();
  const etablissement = useEtablissementCourant();
  const classesDepuis = useCallback((payload) => {
    const map = new Map();
    (payload.matieres_classe || []).forEach((m) => {
      if (!map.has(m.classe_id)) map.set(m.classe_id, { id: m.classe_id, label: m.classe_label || `Classe #${m.classe_id}`, nom: nomClasse(m.classe_option, m.classe_label), effectif: m.effectif, cycle: m.cycle_libelle });
    });
    return [...map.values()];
  }, []);
  const ctx = useNotesContexte({ base: '/enseignant', toast, classesDepuis, mcImpose: mcParam });
  const { espace, classeId, mcId, sequenceId, mcActive, roster, notes, setNotes, sequenceLibelle, sequencesTree, composantes } = ctx;
  const { envoyer, saveStates } = useEnregistrementNotes({ notes, setNotes, roster, mcActive, classeId, sequencesTree, composantes, toast });
  // Évaluation remplie (mode Collège/Institut) : CC, DS, Ev. Tr. ou 'tout'.
  const evaluations = optionsEvaluations(composantes);
  const [choixEvaluation, setChoixEvaluation] = useState('');
  const vueEvaluation = evaluations.some((o) => o.value === choixEvaluation) ? choixEvaluation : composantes[0].code;
  const libelleEvaluation = evaluations.find((o) => o.value === vueEvaluation)?.label;

  const [recherche, setRecherche] = useState('');
  const [statsOuvertes, setStatsOuvertes] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 992);
  const [imprimer, setImprimer] = useState(false);
  const attente = useOperationsEnAttente('notes');
  const [importOuvert, setImportOuvert] = useState(false);
  const [vue, setVue] = useState('saisie');

  const classe = espace.classes.find((c) => String(c.id) === String(classeId)) || null;
  const introuvable = !espace.loading && espace.matieresClasse.length > 0 && !espace.matieresClasse.some((m) => String(m.id) === String(mcParam));
  const pret = Boolean(classeId && mcId && sequenceId);
  // Séquence clôturée (date de fin passée ou clôture par l'administration) :
  // la grille passe en lecture seule (le serveur refuse de toute façon).
  const sequenceActive = ctx.sequencesTree.flatMap((t) => t.sequences || []).find((s) => String(s.id) === String(sequenceId));
  const verrouillee = Boolean(sequenceActive?.verrouillee);
  const eleves = useMemo(() => filtrerRoster(roster, recherche), [roster, recherche]);
  // Notes de la séquence affichée, y compris celles saisies hors connexion
  // et pas encore envoyées (statistiques et relevé imprimé à jour) ; la note
  // de la séquence est calculée en mode Collège/Institut.
  const index = useMemo(() => indexerNotes(notes, { mcId, sequenceId, composantes, attente }), [notes, mcId, sequenceId, composantes, attente]);
  const notesAffichees = index.sequence;
  const stats = useMemo(() => calculerStatistiques(roster, notesAffichees), [roster, notesAffichees]);
  const lignes = useMemo(() => lignesStatistiques(stats), [stats]);

  // Évolution : moyenne de la classe sur chaque séquence de l'année.
  const evolution = useMemo(() => {
    const ids = new Set(roster.map((e) => String(e.inscription_id)));
    const donnees = [];
    sequencesTree.forEach((tri) => (tri.sequences || []).forEach((seq) => {
      const parEleve = indexerNotes(notes, { mcId, sequenceId: seq.id, composantes }).sequence;
      const vals = Object.entries(parEleve)
        .filter(([id]) => ids.has(String(id)))
        .map(([, n]) => noteValeur(n))
        .filter((v) => v !== null);
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
  }, [roster, notes, mcId, sequenceId, sequencesTree, composantes]);

  useEffect(() => {
    if (!imprimer) return undefined;
    const after = () => setImprimer(false);
    window.addEventListener('afterprint', after);
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after); };
  }, [imprimer]);

  const sauvegarderNote = (inscriptionId, composante, { valeur, absent }, seqId = sequenceId) => envoyer({
    inscription_id: Number(inscriptionId),
    matiere_classe_id: Number(mcId),
    sequence_id: Number(seqId),
    // Mode Lycée : pas de composante (le serveur prend « note »).
    ...(composantes.length > 1 ? { composante } : {}),
    valeur: absent ? null : valeur,
    absent: Boolean(absent),
  });

  const saisies = compterSaisies(index, vueEvaluation, roster);

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
        classe={classe?.nom || classe?.label || '…'}
        detail={mcActive ? `${mcActive.matiere_libelle} · coef. ${mcActive.coefficient}` : null}
        cycle={classe?.cycle}
        effectif={roster.length || classe?.effectif}
        onChanger={onRetour}
        changerLabel="Mes matières"
      />

      <div className="d-flex mb-3">
        <Pastilles
          ariaLabel="Affichage"
          value={vue}
          onChange={setVue}
          options={[{ value: 'saisie', label: 'Saisie par séquence' }, { value: 'releve', label: "Relevé de l'année" }]}
        />
      </div>

      {vue === 'releve' ? (
        <>
          <div className="card mb-3"><div className="card-body py-2">
            <div className="esp-recherche">
              <i className="bx bx-search" />
              <input type="search" className="form-control" placeholder="Rechercher un élève…" value={recherche} onChange={(e) => setRecherche(e.target.value)} />
            </div>
          </div></div>
          <ReleveAnnee
            eleves={eleves}
            sequencesTree={sequencesTree}
            notes={notes}
            mcId={mcId}
            composantes={composantes}
            attente={attente}
            saveStates={saveStates}
            chargement={ctx.chargement && !roster.length}
            onSave={(inscriptionId, composante, payload, seqId) => sauvegarderNote(inscriptionId, composante, payload, seqId)}
            onInvalid={() => toast('Saisissez une note entre 0 et 20 (ex : 12,5), ou « abs » pour absent.', 'error')}
          />
        </>
      ) : (
      <>
      <NotesFiltres ctx={ctx} recherche={recherche} setRecherche={setRecherche} masquerClasse masquerMatiere />

      {evaluations.length > 0 && (
        <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
          <span className="notes-filtre-label mb-0">Remplir</span>
          <Pastilles ariaLabel="Évaluation à remplir" value={vueEvaluation} onChange={setChoixEvaluation} options={evaluations} />
        </div>
      )}

      {pret && (
        <div className="saisie-entete">
          <div className="flex-grow-1 min-w-0">
            <Avancement saisies={saisies} attendues={roster.length} libelle={libelleEvaluation ? `${sequenceLibelle} · ${libelleEvaluation}` : sequenceLibelle} />
          </div>
          <div className="saisie-entete-actions">
            <button type="button" className="btn btn-icon btn-outline-secondary" title="Actualiser" aria-label="Actualiser" onClick={() => { ctx.actualiser(); toast('Grille actualisée.'); }}><i className="bx bx-refresh" /></button>
            <button type="button" className="btn btn-icon btn-outline-primary" title="Imprimer / PDF" aria-label="Imprimer le relevé" onClick={() => setImprimer(true)}><i className="bx bx-printer" /></button>
            <button type="button" className="btn btn-icon btn-outline-primary" title="Importer des notes (Excel, CSV, Word)" aria-label="Importer des notes" onClick={() => setImportOuvert(true)} disabled={verrouillee}><i className="bx bx-import" /></button>
          </div>
        </div>
      )}

      {pret && verrouillee && (
        <div className="alert alert-warning d-flex gap-2 align-items-start">
          <i className="bx bx-lock-alt fs-5" />
          <div>La saisie de <strong>{sequenceLibelle}</strong> est clôturée : vos notes sont en lecture seule. Pour corriger une note, adressez-vous à l'administration de l'établissement.</div>
        </div>
      )}

      <div className="saisie-liste mb-4">
        <div className="saisie-ligne saisie-tete d-none d-md-grid">
          <span>#</span><span>Élève</span><span className="text-center">{vueEvaluation === 'tout' ? 'Évaluations / 20' : `${composantes.length > 1 ? libelleEvaluation : 'Note'} / 20`}</span>
        </div>
        {!pret ? (
          espace.loading ? <SkelSaisie /> : <div className="saisie-vide"><i className="bx bx-info-circle me-1" />Choisissez une séquence pour afficher la grille de saisie.</div>
        ) : ctx.chargement && !roster.length ? (
          <SkelSaisie />
        ) : !eleves.length ? (
          <div className="saisie-vide"><i className="bx bx-user-x me-1" />{roster.length ? 'Aucun élève ne correspond à la recherche.' : 'Aucun élève inscrit dans cette classe.'}</div>
        ) : (
          <GrilleNotes
            eleves={eleves}
            composantes={composantes}
            vue={vueEvaluation}
            index={index}
            attente={attente}
            saveStates={saveStates}
            mcId={mcId}
            sequenceId={sequenceId}
            onSave={(inscriptionId, composante, payload) => sauvegarderNote(inscriptionId, composante, payload)}
            onInvalid={() => toast('Saisissez une note entre 0 et 20 (ex : 12,5), ou « abs » pour absent.', 'error')}
            verrouille={verrouillee}
          />
        )}
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

      </>
      )}

      {importOuvert && (
        <ImportModal
          module="notes"
          optionsInitiales={{
            matiere_classe_id: String(mcId),
            sequence_id: sequenceId ? String(sequenceId) : '',
            ...(composantes.length > 1 && vueEvaluation !== 'tout' ? { composante: vueEvaluation } : {}),
          }}
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
          notesIndex={notesAffichees}
        />
      )}
    </>
  );
}

// ── Relevé de l'année : élèves × séquences, chaque note modifiable ─────────
// (en mode Collège/Institut : une colonne par évaluation de chaque séquence).
// Toucher une note l'ouvre en saisie (Entrée ou sortie du champ : enregistrée ;
// Échap : annulée). « abs » (ou « a ») marque l'élève absent.

function CelluleNote({ note, operation, etat, onSave, onInvalid, libelle }) {
  const source = operation?.body || note;
  const [edition, setEdition] = useState(null);
  const texte = texteSaisie(source);
  const v = noteValeur(source);
  const cls = source?.absent ? 'releve-absent' : v === null ? 'releve-vide' : v < 10 ? 'note-faible' : v >= 14 ? 'note-forte' : '';
  const marque = operation?.conflit ? 'conflit' : operation ? 'pending' : etat === 'saving' || etat === 'error' ? etat : null;

  const valider = (valeur) => {
    setEdition(null);
    if (valeur.trim() === texte) return;
    const p = parseSaisie(valeur);
    if (!p.ok) {
      onInvalid();
      return;
    }
    onSave({ valeur: p.valeur, absent: p.absent });
  };

  if (edition !== null) {
    return (
      <td className="releve-cellule en-edition">
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="text"
          inputMode="decimal"
          enterKeyHint="done"
          className="note-input releve-input"
          aria-label={libelle}
          value={edition}
          onChange={(e) => setEdition(e.target.value)}
          onBlur={(e) => valider(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === 'Escape') setEdition(null);
          }}
        />
      </td>
    );
  }
  return (
    <td className="releve-cellule">
      <button type="button" className={`releve-note ${cls}`} title={`${libelle} — toucher pour modifier`} onClick={() => setEdition(texte)}>
        {source?.absent ? 'Abs.' : v === null ? '—' : v.toFixed(2).replace('.', ',')}
        {marque && <SaveState state={marque} />}
      </button>
    </td>
  );
}

function ReleveAnnee({ eleves, sequencesTree, notes, mcId, composantes, attente, saveStates, chargement, onSave, onInvalid }) {
  const sequences = useMemo(() => sequencesTree.flatMap((t) => (t.sequences || []).map((s) => ({ ...s, trimestre_libelle: t.trimestre_libelle }))), [sequencesTree]);
  const compose = composantes.length > 1;
  const colonnes = useMemo(() => sequences.flatMap((s) => composantes.map((c) => ({
    cle: `${s.id}|${c.code}`, sequence: s, composante: c, libelle: compose ? `${s.libelle} · ${c.libelle}` : s.libelle,
  }))), [sequences, composantes, compose]);
  const index = useMemo(() => {
    const idx = {};
    notes.filter((n) => String(n.matiere_classe_id) === String(mcId)).forEach((n) => { idx[`${n.inscription_id}|${n.sequence_id}|${n.composante || 'note'}`] = n; });
    return idx;
  }, [notes, mcId]);

  if (chargement) {
    return (
      <div className="card mb-4"><div className="card-body">
        <SkelListe lignes={8} label="Chargement du relevé de l'année…" />
      </div></div>
    );
  }
  if (!sequences.length) return <div className="saisie-vide"><i className="bx bx-info-circle me-1" />Aucune séquence pour cette année scolaire.</div>;
  if (!eleves.length) return <div className="saisie-vide"><i className="bx bx-user-x me-1" />Aucun élève à afficher.</div>;

  return (
    <div className="card mb-4">
      <div className="table-responsive releve-conteneur">
        <table className="table table-sm releve-table mb-0">
          <thead>
            <tr>
              <th className="releve-eleve">Élève</th>
              {colonnes.map((col) => <th key={col.cle} className="text-center" title={`${col.sequence.trimestre_libelle} — ${col.libelle}`}>{col.libelle}</th>)}
              <th className="text-center">Moy.</th>
            </tr>
          </thead>
          <tbody>
            {eleves.map((eleve) => {
              const detail = {};
              const cellules = colonnes.map(({ cle: col, sequence: s, composante: c, libelle }) => {
                const cle = cleNote({ inscription_id: eleve.inscription_id, matiere_classe_id: mcId, sequence_id: s.id, composante: c.code });
                const operation = attente[cle];
                const note = index[`${eleve.inscription_id}|${s.id}|${c.code}`];
                (detail[s.id] = detail[s.id] || {})[c.code] = operation?.body || note;
                return (
                  <CelluleNote
                    key={col}
                    note={note}
                    operation={operation}
                    etat={saveStates[cle]}
                    libelle={`${eleve.nom} ${eleve.prenom} — ${libelle}`}
                    onSave={(payload) => onSave(eleve.inscription_id, c.code, payload, s.id)}
                    onInvalid={onInvalid}
                  />
                );
              });
              // Moyenne des notes de séquence (calculées en Collège/Institut).
              const valeurs = sequences
                .map((s) => noteValeur(noteSequence(detail[s.id] || {}, composantes)))
                .filter((v) => v !== null);
              const moy = valeurs.length ? valeurs.reduce((a, b) => a + b, 0) / valeurs.length : null;
              return (
                <tr key={eleve.inscription_id}>
                  <th scope="row" className="releve-eleve"><EleveIdentite eleve={eleve} /></th>
                  {cellules}
                  <td className={`text-center fw-semibold ${moy === null ? 'text-muted' : moy < 10 ? 'note-faible' : moy >= 14 ? 'note-forte' : ''}`}>{moy === null ? '—' : moy.toFixed(2).replace('.', ',')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card-footer small text-muted py-2">
        <i className="bx bx-info-circle me-1" />Touchez une note pour la modifier ; « abs » pour absent. Moyenne simple des séquences notées (indicative){compose ? ' ; note de séquence calculée selon le mode d\'évaluation de l\'année' : ''}.
      </div>
    </div>
  );
}

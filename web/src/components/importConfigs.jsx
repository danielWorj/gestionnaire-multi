import { useMemo } from 'react';
import ImportAssistant from './ImportAssistant';
import Select from './Select';
import { downloadCsv } from './ui';

// Configuration de l'assistant d'import (ImportAssistant.jsx) pour les
// enseignants, les classes et les matières. Chaque configuration décrit les
// options du module, les colonnes de l'aperçu, les champs corrigeables et le
// bilan ; le déroulé (fichiers, colonnes, vérification, import) est commun.

const pluriel = (n, un, plusieurs = `${un}s`) => `${n} ${n > 1 ? plusieurs : un}`;

function ListeSuggestions({ id, valeurs }) {
  return <datalist id={id}>{(valeurs || []).map((v) => <option key={v} value={v} />)}</datalist>;
}

function NouveauBadge({ visible }) {
  return visible ? <span className="badge bg-label-warning ms-1">nouveau</span> : null;
}

function SeparationNoms({ options, setOptions, champsMappes, rep }) {
  if (!champsMappes.has('nom_complet')) return null;
  const exemple = rep?.lignes.find((l) => l.donnees.nom && l.donnees.prenom && l.donnees.prenom !== '-' && l.statut !== 'exclu');
  return (
    <div className="border rounded p-3 mt-3">
      <div className="fw-semibold small mb-2">Découpage « Nom et prénoms »</div>
      <div className="d-flex flex-wrap gap-3 small">
        {[['premier', 'Le 1er mot est le nom'], ['deux', 'Les 2 premiers mots sont le nom'], ['dernier', 'Le dernier mot est le prénom']].map(([k, label]) => (
          <label key={k} className="form-check mb-0">
            <input type="radio" className="form-check-input" name="separation" checked={options.separation === k} onChange={() => setOptions((o) => ({ ...o, separation: k }))} />
            <span className="form-check-label">{label}</span>
          </label>
        ))}
      </div>
      {exemple && (
        <div className="small mt-2">
          Exemple : <span className="badge bg-label-primary">Nom : {exemple.donnees.nom}</span> <span className="badge bg-label-info">Prénom : {exemple.donnees.prenom}</span>
        </div>
      )}
      <div className="form-text">Les civilités (M., Mme, Mlle) sont retirées et donnent le sexe. Une virgule ou des MAJUSCULES pour le nom sont reconnues automatiquement.</div>
    </div>
  );
}

/* ── Enseignants ──────────────────────────────────────────────────────── */

function OptionsEnseignants({ rep, options, setOpt, champsMappes }) {
  return (
    <>
      <h6 className="mb-2">Valeurs par défaut</h6>
      <div className="border rounded p-3 small mb-3">
        <div className="row g-2 mb-2">
          <div className="col-6">
            <label className="form-label small mb-1">Département {champsMappes.has('departement') ? 'si vide' : 'de tous'}</label>
            <input className="form-control form-control-sm" list="imp-departements" placeholder="Ex : Lettres" value={options.departement_defaut} onChange={setOpt('departement_defaut')} />
            <ListeSuggestions id="imp-departements" valeurs={rep.departements} />
          </div>
          <div className="col-6">
            <label className="form-label small mb-1">Grade {champsMappes.has('grade') ? 'si vide' : 'de tous'}</label>
            <input className="form-control form-control-sm" list="imp-grades" placeholder="Ex : PLEG" value={options.grade_defaut} onChange={setOpt('grade_defaut')} />
            <ListeSuggestions id="imp-grades" valeurs={rep.grades} />
          </div>
        </div>
        <div className="form-text mb-3">Départements et grades absents de l'application sont créés automatiquement.</div>
        <div className="row g-2">
          <div className="col-6">
            <label className="form-label small mb-1">Sexe manquant</label>
            <Select className="form-select form-select-sm" value={options.sexe_defaut} onChange={setOpt('sexe_defaut')}>
              <option value="">Signaler en erreur</option>
              <option value="M">Masculin par défaut</option>
              <option value="F">Féminin par défaut</option>
            </Select>
          </div>
          <div className="col-6">
            <label className="form-label small mb-1">Prénom absent (« Mme ABENG »)</label>
            <Select className="form-select form-select-sm" value={options.prenom_absent} onChange={setOpt('prenom_absent')}>
              <option value="erreur">Signaler en erreur</option>
              <option value="tiret">Mettre un tiret (« - »)</option>
            </Select>
          </div>
        </div>
      </div>

      <h6 className="mb-2">Règles de traitement</h6>
      <div className="border rounded p-3 small">
        <label className="form-label small mb-1">Enseignants déjà enregistrés (même e-mail, téléphone ou nom)</label>
        <Select className="form-select form-select-sm mb-3" value={options.doublons} onChange={setOpt('doublons')}>
          <option value="ignorer">Ne pas modifier leur fiche</option>
          <option value="mettre_a_jour">Mettre à jour leur fiche avec le fichier</option>
        </Select>
        <label className="form-check mb-2">
          <input type="checkbox" className="form-check-input" checked={options.creer_comptes} onChange={setOpt('creer_comptes')} />
          <span className="form-check-label">Créer leur compte de connexion (code + PIN)</span>
        </label>
        <label className="form-check mb-0">
          <input type="checkbox" className="form-check-input" checked={options.harmoniser_casse} onChange={setOpt('harmoniser_casse')} />
          <span className="form-check-label">Harmoniser l'écriture : NOM en majuscules, Prénom en minuscules</span>
        </label>
      </div>
    </>
  );
}

function BilanEnseignants({ bilan }) {
  const identifiants = bilan.identifiants || [];
  if (!identifiants.length) return null;
  const exporter = () => downloadCsv('identifiants-enseignants.csv', [['Enseignant', 'Code de connexion', 'PIN'], ...identifiants.map((i) => [i.nom, i.code, i.pin])]);
  return (
    <div className="border rounded p-3">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <h6 className="mb-0 me-auto"><i className="bx bx-key me-1 text-primary" />Identifiants de connexion</h6>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => window.print()}><i className="bx bx-printer me-1" /> Imprimer</button>
        <button type="button" className="btn btn-outline-primary btn-sm" onClick={exporter}><i className="bx bx-download me-1" /> Télécharger (CSV)</button>
      </div>
      <div className="alert alert-warning small py-2">
        <i className="bx bx-error me-1" />
        Ces PIN ne seront plus jamais affichés après la fermeture de cette fenêtre. Imprimez ou téléchargez la liste, et remettez à chacun son code et son PIN (chacun pourra ensuite changer son PIN depuis son espace).
      </div>
      <div className="print-area">
        <h5 className="d-none d-print-block mb-3">Identifiants de connexion des enseignants</h5>
        <table className="table table-sm small mb-0">
          <thead><tr><th>Enseignant</th><th>Code de connexion</th><th>PIN</th></tr></thead>
          <tbody>
            {identifiants.map((i) => (
              <tr key={i.code}><td>{i.nom}</td><td><code className="fs-6">{i.code}</code></td><td><code className="fs-6">{i.pin}</code></td></tr>
            ))}
          </tbody>
        </table>
        <p className="d-none d-print-block small mt-3">Connectez-vous avec votre code puis votre PIN, et choisissez votre propre PIN de 4 chiffres. Ne communiquez jamais votre PIN.</p>
      </div>
    </div>
  );
}

const ENSEIGNANTS = {
  module: 'enseignants',
  titre: 'Importer des enseignants',
  icone: 'bx-user-voice',
  titreIgnore: "Ce tableau ne ressemble pas à une liste d'enseignants (emploi du temps, liste d'élèves…). Cochez-le pour l'importer quand même.",
  aideFichiers: "Listes du personnel en tableau, ou fiches Word « NOMS ET PRÉNOMS : …  GRADE : …  CONTACT : … » (une fiche par enseignant) : les deux sont reconnues.",
  exempleCollage: 'Nom\tPrénom\tSexe\tTéléphone\tGrade\nABENG\tMarie\tF\t696516429\tPLEG',
  optionsDefaut: {
    separation: 'premier', harmoniser_casse: true, doublons: 'ignorer', sexe_defaut: '', prenom_absent: 'erreur',
    departement_defaut: '', grade_defaut: '', creer_comptes: true,
  },
  optionsMemorisees: ['separation', 'harmoniser_casse', 'doublons', 'sexe_defaut', 'prenom_absent', 'departement_defaut', 'grade_defaut', 'creer_comptes'],
  manquants: (champs, options) => {
    const m = [];
    if (!champs.has('nom_complet') && !champs.has('nom')) m.push('le nom (une colonne « Nom et prénoms », ou « Nom »)');
    if (!champs.has('departement') && !options.departement_defaut.trim()) m.push('le département (colonne, ou valeur par défaut à droite)');
    if (!champs.has('grade') && !options.grade_defaut.trim()) m.push('le grade (colonne, ou valeur par défaut à droite)');
    return m;
  },
  Options: OptionsEnseignants,
  OptionsColonnes: SeparationNoms,
  colonnesApercu: [
    ['Enseignant', (l) => (
      <>
        <div className="fw-semibold">{l.donnees.nom || <span className="text-danger">—</span>} {l.donnees.prenom || <span className="text-danger">—</span>}</div>
        <small className="text-muted">{l.source}</small>
      </>
    )],
    ['Sexe', (l) => l.donnees.sexe || <span className="text-danger">—</span>],
    ['Contact', (l) => <>{l.donnees.telephone || '—'}<div className="text-muted">{l.donnees.email}</div></>],
    ['Département', (l) => <>{l.donnees.departement || <span className="text-danger">—</span>}<NouveauBadge visible={l.donnees.departement_nouveau} /></>],
    ['Grade', (l) => <>{l.donnees.grade || <span className="text-danger">—</span>}<NouveauBadge visible={l.donnees.grade_nouveau} /></>],
    ['Compte', (l) => ({ a_creer: <span className="badge bg-label-primary">à créer</span>, deja: <span className="text-muted">existant</span> }[l.compte] || <span className="text-muted">—</span>)],
  ],
  edition: {
    champs: (rep) => [
      { cle: 'nom', label: 'Nom', col: 'col-md-3' },
      { cle: 'prenom', label: 'Prénom(s)', col: 'col-md-3' },
      { cle: 'sexe', label: 'Sexe', col: 'col-md-2', choix: [['', '—'], ['M', 'Masculin'], ['F', 'Féminin']] },
      { cle: 'telephone', label: 'Téléphone', col: 'col-md-2' },
      { cle: 'email', label: 'E-mail', col: 'col-md-2' },
      { cle: 'departement', label: 'Département', col: 'col-md-4', suggestions: rep.departements },
      { cle: 'grade', label: 'Grade', col: 'col-md-4', suggestions: rep.grades },
    ],
    initial: (l) => ({
      nom: l.donnees.nom || '', prenom: l.donnees.prenom || '', sexe: l.donnees.sexe || '', telephone: l.donnees.telephone || '',
      email: l.donnees.email || '', departement: l.donnees.departement || '', grade: l.donnees.grade || '',
    }),
  },
  exportColonnes: [
    ['Nom', (l) => l.donnees.nom], ['Prénom', (l) => l.donnees.prenom], ['Sexe', (l) => l.donnees.sexe || ''],
    ['Téléphone', (l) => l.donnees.telephone], ['E-mail', (l) => l.donnees.email],
    ['Département', (l) => l.donnees.departement], ['Grade', (l) => l.donnees.grade],
  ],
  resumeApercu: (rep) => {
    const r = rep.resume;
    return [
      r.comptes > 0 && ['bx-key', pluriel(r.comptes, 'compte de connexion à créer', 'comptes de connexion à créer')],
      r.departements_nouveaux > 0 && ['bx-buildings', pluriel(r.departements_nouveaux, 'département à créer', 'départements à créer')],
      r.grades_nouveaux > 0 && ['bx-layer', pluriel(r.grades_nouveaux, 'grade à créer', 'grades à créer')],
    ].filter(Boolean);
  },
  nbActions: (rep) => rep.resume.nouveaux + rep.resume.mises_a_jour + rep.resume.comptes,
  libelleImport: (rep) => {
    const r = rep.resume;
    const n = r.nouveaux + r.mises_a_jour;
    return n ? `Importer ${pluriel(n, 'enseignant')}` : `Créer ${pluriel(r.comptes, 'compte')}`;
  },
  cartesBilan: [
    ['enseignants_crees', 'Enseignants créés', 'success'],
    ['enseignants_mis_a_jour', 'Enseignants mis à jour', 'info'],
    ['comptes_crees', 'Comptes de connexion créés', 'primary'],
    ['departements_crees', 'Départements créés', 'secondary'],
  ],
  Bilan: BilanEnseignants,
};

/* ── Classes ──────────────────────────────────────────────────────────── */

function OptionsClasses({ rep, options, setOpt }) {
  return (
    <>
      <h6 className="mb-2">Classes et cycles</h6>
      <div className="border rounded p-3 small">
        <label className="form-check mb-2">
          <input type="checkbox" className="form-check-input" checked={options.depuis_titres} onChange={setOpt('depuis_titres')} />
          <span className="form-check-label">Prendre aussi les classes dans le titre des tableaux et le nom des fichiers (« LISTE DES ÉLÈVES DE 6e A »)</span>
        </label>
        <label className="form-check mb-3">
          <input type="checkbox" className="form-check-input" checked={options.cycle_auto} onChange={setOpt('cycle_auto')} />
          <span className="form-check-label">Déduire le cycle : 6e à 3e → premier cycle, 2nde à Tle → second cycle</span>
        </label>
        <label className="form-label small mb-1">Cycle des autres classes</label>
        <input className="form-control form-control-sm" list="imp-cycles" placeholder="Ex : Premier cycle" value={options.cycle_defaut} onChange={setOpt('cycle_defaut')} />
        <ListeSuggestions id="imp-cycles" valeurs={rep.cycles} />
        <div className="form-text mb-3">Choisissez un cycle existant ou saisissez-en un nouveau : il sera créé.</div>
        <label className="form-check mb-0">
          <input type="checkbox" className="form-check-input" checked={options.majuscules} onChange={setOpt('majuscules')} />
          <span className="form-check-label">Écrire les noms de classes en MAJUSCULES</span>
        </label>
      </div>
      <p className="small text-muted mt-3 mb-0"><i className="bx bx-info-circle me-1" />Une classe déjà enregistrée n'est jamais recréée, quelle que soit son écriture (« 6ème A » = « 6e A »).</p>
    </>
  );
}

const ORIGINES_CYCLE = { deduit: 'déduit', defaut: 'par défaut', fichier: 'du fichier' };

const CLASSES = {
  module: 'classes',
  titre: 'Importer des classes',
  icone: 'bx-chalkboard',
  afficherClasseBloc: true,
  titreIgnore: "Aucune classe trouvée dans ce tableau (ou grille d'emploi du temps). Cochez-le pour l'utiliser quand même.",
  aideFichiers: 'Une liste de classes, ou directement vos listes d\'élèves : chaque classe trouvée (colonne « Classe » ou titre du tableau) n\'est proposée qu\'une fois.',
  exempleCollage: 'Classe\tCycle\n6e A\tPremier cycle\nTle C\tSecond cycle',
  optionsDefaut: { depuis_titres: true, cycle_auto: true, cycle_defaut: '', majuscules: false },
  optionsMemorisees: ['depuis_titres', 'cycle_auto', 'cycle_defaut', 'majuscules'],
  manquants: (champs, options) => (!champs.has('classe') && !options.depuis_titres
    ? ['les classes : une colonne « Classe », ou cochez « Prendre aussi les classes dans le titre des tableaux »'] : []),
  Options: OptionsClasses,
  colonnesApercu: [
    ['Classe', (l) => <span className="fw-semibold">{l.donnees.classe || <span className="text-danger">—</span>}</span>],
    ['Cycle', (l) => (
      <>
        {l.donnees.cycle || <span className="text-danger">—</span>}
        <NouveauBadge visible={l.donnees.cycle_nouveau} />
        {ORIGINES_CYCLE[l.donnees.cycle_origine] && <div className="text-muted" style={{ fontSize: 11 }}>{ORIGINES_CYCLE[l.donnees.cycle_origine]}</div>}
      </>
    )],
    ['Trouvée dans', (l) => <small className="text-muted">{l.source}{l.nb > 1 ? ` (${l.nb} fois)` : ''}</small>],
  ],
  edition: {
    champs: (rep) => [
      { cle: 'classe', label: 'Classe', col: 'col-md-5' },
      { cle: 'cycle', label: 'Cycle', col: 'col-md-7', suggestions: rep.cycles },
    ],
    initial: (l) => ({ classe: l.donnees.classe || '', cycle: l.donnees.cycle || '' }),
  },
  exportColonnes: [['Classe', (l) => l.donnees.classe], ['Cycle', (l) => l.donnees.cycle]],
  resumeApercu: (rep) => (rep.resume.cycles_nouveaux > 0 ? [['bx-sitemap', pluriel(rep.resume.cycles_nouveaux, 'cycle à créer', 'cycles à créer')]] : []),
  nbActions: (rep) => rep.resume.nouveaux,
  libelleImport: (rep) => `Créer ${pluriel(rep.resume.nouveaux, 'classe')}`,
  cartesBilan: [
    ['classes_creees', 'Classes créées', 'success'],
    ['cycles_crees', 'Cycles créés', 'secondary'],
  ],
};

/* ── Matières ─────────────────────────────────────────────────────────── */

function TableCorrespondance({ titre, lignes, choix, valeurDe, onChange, vide }) {
  if (!lignes.length) return null;
  return (
    <>
      <div className="small fw-semibold mt-3 mb-1">{titre}</div>
      <table className="table table-sm mb-1 small align-middle">
        <tbody>
          {lignes.map((c) => (
            <tr key={c.libelle}>
              <td className="text-nowrap"><span className="badge bg-label-secondary">{c.libelle}</span><div className="text-muted" style={{ fontSize: 11 }}>{c.nb} fois</div></td>
              <td className="w-100">
                <div className="d-flex align-items-center gap-1">
                  <Select className="form-select form-select-sm" value={valeurDe(c) ? String(valeurDe(c)) : ''} onChange={onChange(c.libelle)}>
                    <option value="">{vide}</option>
                    {choix.map((x) => <option key={x.id} value={x.id}>{x.libelle}</option>)}
                  </Select>
                  {c.suggere && <span className="badge bg-label-success">auto</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function OptionsMatieres({ rep, options, setOptions, setOpt, champsMappes }) {
  const setCorr = (cle) => (libelle) => (e) => setOptions((o) => ({ ...o, [cle]: { ...o[cle], [libelle]: e.target.value } }));
  const affectations = champsMappes.has('classe') || champsMappes.has('coef_classe');
  return (
    <>
      <h6 className="mb-2">Matières</h6>
      <div className="border rounded p-3 small mb-3">
        <label className="form-label small mb-1">Groupe {champsMappes.has('groupe') ? 'si vide' : 'des matières sans groupe'}</label>
        <input className="form-control form-control-sm" list="imp-groupes" placeholder="Ex : Matières générales" value={options.groupe_defaut} onChange={setOpt('groupe_defaut')} />
        <ListeSuggestions id="imp-groupes" valeurs={rep.groupes} />
        <div className="form-text">Une ligne de titre « MATIÈRES LITTÉRAIRES » dans le tableau donne le groupe des matières qui suivent. Les groupes absents sont créés.</div>
      </div>

      <h6 className="mb-2">Affectations aux classes</h6>
      <div className="border rounded p-3 small">
        {!affectations && <p className="text-muted mb-0">Aucune colonne de classe ni de coefficient : seules les matières seront créées.</p>}
        {affectations && (
          <>
            <div className="row g-2">
              <div className="col-6">
                <label className="form-label small mb-1">Coefficient manquant</label>
                <input type="number" min="1" max="99" className="form-control form-control-sm" placeholder="Signaler" value={options.coefficient_defaut} onChange={setOpt('coefficient_defaut')} />
              </div>
              <div className="col-6">
                <label className="form-label small mb-1">Enseignant {champsMappes.has('enseignant') ? 'si non trouvé' : 'de toutes les affectations'}</label>
                <Select className="form-select form-select-sm" value={String(options.enseignant_defaut)} onChange={setOpt('enseignant_defaut')}>
                  <option value="">— Aucun (affectation ignorée) —</option>
                  {rep.enseignants.map((e) => <option key={e.id} value={e.id}>{e.libelle}</option>)}
                </Select>
              </div>
            </div>
            <div className="form-text mb-2">Une affectation exige une classe, un coefficient entier et un enseignant : sinon la matière est créée seule et l'affectation est signalée.</div>
            <label className="form-label small mb-1">Affectations déjà enregistrées</label>
            <Select className="form-select form-select-sm" value={options.doublons} onChange={setOpt('doublons')}>
              <option value="ignorer">Ne pas les modifier</option>
              <option value="mettre_a_jour">Mettre à jour coefficient et enseignant</option>
            </Select>
            <TableCorrespondance titre="Classes trouvées dans les fichiers" lignes={rep.classes_detectees} choix={rep.classes} valeurDe={(c) => c.classe_id} onChange={setCorr('classes')} vide="— Ne pas affecter —" />
            <TableCorrespondance titre="Enseignants trouvés dans les fichiers" lignes={rep.enseignants_detectes} choix={rep.enseignants} valeurDe={(c) => c.enseignant_id} onChange={setCorr('enseignants')} vide="— Non trouvé —" />
          </>
        )}
      </div>
    </>
  );
}

const STATUT_AFFECTATION = {
  nouvelle: ['text-success', 'bx-plus-circle'],
  maj: ['text-info', 'bx-refresh'],
  existe: ['text-muted', 'bx-check'],
  ignoree: ['text-warning', 'bx-error'],
};

const MATIERES = {
  module: 'matieres',
  titre: 'Importer des matières',
  icone: 'bx-book-open',
  titreIgnore: "Ce tableau ne contient pas de colonne de matières (ou c'est une grille d'emploi du temps). Cochez-le pour l'utiliser quand même.",
  aideFichiers: "Tableau des matières, avec ou sans coefficients : « Matière | Classe | Coef | Professeur », ou en grille « Matière | 6e A | 5e A | … » avec le coefficient dans chaque case.",
  exempleCollage: 'Matière\tGroupe\tClasse\tCoef\tProfesseur\nMathématiques\tScientifiques\t6e A\t4\tABENG Marie',
  optionsDefaut: { groupe_defaut: '', doublons: 'ignorer', coefficient_defaut: '', enseignant_defaut: '', classes: {}, enseignants: {} },
  optionsMemorisees: ['groupe_defaut', 'doublons', 'classes', 'enseignants'],
  manquants: (champs, options) => {
    const m = [];
    if (!champs.has('matiere')) m.push('la colonne des matières');
    if (!champs.has('groupe') && !options.groupe_defaut.trim()) m.push('le groupe de matières (colonne, ou groupe par défaut à droite)');
    return m;
  },
  Options: OptionsMatieres,
  colonnesApercu: [
    ['Matière', (l) => <><div className="fw-semibold">{l.donnees.matiere || <span className="text-danger">—</span>}</div><small className="text-muted">{l.source}</small></>],
    ['Groupe', (l) => <>{l.donnees.groupe || <span className="text-danger">—</span>}<NouveauBadge visible={l.donnees.groupe_nouveau && l.statut === 'nouveau'} /></>],
    ['Affectations', (l) => (l.affectations.length ? (
      <div className="d-flex flex-column gap-1">
        {l.affectations.map((a) => {
          const [couleur, icone] = STATUT_AFFECTATION[a.statut] || STATUT_AFFECTATION.ignoree;
          return (
            <span key={`${a.classe_libelle}-${a.classe_id}`} className={couleur} title={a.motif || ''}>
              <i className={`bx ${icone} me-1`} />{a.classe_nom || a.classe_libelle} · coef {a.coefficient ?? '?'}{a.enseignant_nom ? ` · ${a.enseignant_nom}` : ''}
            </span>
          );
        })}
      </div>
    ) : <span className="text-muted">—</span>)],
  ],
  edition: {
    champs: (rep, l) => {
      const champs = [
        { cle: 'matiere', label: 'Matière', col: 'col-md-4' },
        { cle: 'groupe', label: 'Groupe', col: 'col-md-4', suggestions: rep.groupes },
      ];
      if (l.affectations.length) {
        champs.push({ cle: 'enseignant_id', label: 'Enseignant', col: 'col-md-4', choix: [['', '— Selon le fichier —'], ...rep.enseignants.map((e) => [String(e.id), e.libelle])] });
      }
      if (l.affectations.length === 1 && !l.grille) {
        champs.push({ cle: 'classe_id', label: 'Classe', col: 'col-md-4', choix: [['', '— Selon le fichier —'], ...rep.classes.map((c) => [String(c.id), c.libelle])] });
        champs.push({ cle: 'coefficient', label: 'Coefficient', col: 'col-md-2' });
      }
      return champs;
    },
    initial: (l) => {
      const a = l.affectations[0];
      return {
        matiere: l.donnees.matiere || '',
        groupe: l.donnees.groupe || '',
        ...(l.affectations.length ? { enseignant_id: '' } : {}),
        ...(l.affectations.length === 1 && !l.grille ? { classe_id: a.classe_id ? String(a.classe_id) : '', coefficient: a.coefficient ?? '' } : {}),
      };
    },
  },
  exportColonnes: [
    ['Matière', (l) => l.donnees.matiere], ['Groupe', (l) => l.donnees.groupe],
    ['Affectations', (l) => l.affectations.map((a) => `${a.classe_nom || a.classe_libelle} (coef ${a.coefficient ?? '?'})`).join(' | ')],
  ],
  resumeApercu: (rep) => {
    const r = rep.resume;
    return [
      r.groupes_nouveaux > 0 && ['bx-layer', pluriel(r.groupes_nouveaux, 'groupe à créer', 'groupes à créer')],
      r.affectations_nouvelles > 0 && ['bx-link', pluriel(r.affectations_nouvelles, 'affectation à créer', 'affectations à créer')],
      r.affectations_maj > 0 && ['bx-refresh', pluriel(r.affectations_maj, 'affectation mise à jour', 'affectations mises à jour')],
      r.affectations_ignorees > 0 && ['bx-error', pluriel(r.affectations_ignorees, 'affectation incomplète', 'affectations incomplètes')],
    ].filter(Boolean);
  },
  nbActions: (rep) => rep.resume.nouveaux + rep.resume.affectations_nouvelles + rep.resume.affectations_maj,
  libelleImport: (rep) => {
    const r = rep.resume;
    const aff = r.affectations_nouvelles + r.affectations_maj;
    return `Importer ${pluriel(r.nouveaux, 'matière')}${aff ? ` et ${pluriel(aff, 'affectation')}` : ''}`;
  },
  cartesBilan: [
    ['matieres_creees', 'Matières créées', 'success'],
    ['groupes_crees', 'Groupes créés', 'secondary'],
    ['affectations_creees', 'Affectations créées', 'primary'],
    ['affectations_mises_a_jour', 'Affectations mises à jour', 'info'],
  ],
};

const CONFIGS = { enseignants: ENSEIGNANTS, classes: CLASSES, matieres: MATIERES };

export default function ImportModal({ module, onClose, onImported }) {
  const config = useMemo(() => CONFIGS[module], [module]);
  return <ImportAssistant config={config} onClose={onClose} onImported={onImported} />;
}

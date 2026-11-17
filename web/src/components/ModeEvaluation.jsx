import Select from './Select';

// Modes d'évaluation (cf. server/models/structure_models.MODES_EVALUATION) :
// choisis à la création de l'établissement (mode par défaut de ses années),
// puis portés par chaque année scolaire, définitifs dès la première note.
export const MODES_EVALUATION = [
  { code: 'lycee', libelle: 'Lycée', detail: 'Une note par séquence' },
  { code: 'college', libelle: 'Collège', detail: 'Par séquence : CC (30 %) + DS (70 %)' },
  { code: 'institut', libelle: 'Institut', detail: 'Par séquence : CC + DS + Ev. Tr., à parts égales' },
];

// Modèles de bulletin (cf. server/models/structure_models.MODELES_BULLETIN) :
// chacun appartient à un ou plusieurs modes d'évaluation ; l'établissement
// choisit le sien parmi ceux de son mode.
export const MODELES_BULLETIN = [
  { code: 'original', libelle: 'Original', modes: ['lycee'],
    detail: 'Bulletin standard (rang par matière, récapitulatifs travail et discipline)' },
  { code: 'original_extremes', libelle: 'Original + rang et extrêmes', modes: ['lycee'],
    detail: 'Bulletin standard avec la note min et la note max de la classe par matière' },
  { code: 'bilingue_groupes', libelle: 'Bilingue, totaux par groupe', modes: ['lycee'],
    detail: 'En-tête bilingue, total par groupe de matières, profil de la classe, travail et conduite' },
  { code: 'professeurs_groupes', libelle: 'Professeurs et moyenne de classe', modes: ['lycee'],
    detail: 'Nom du professeur et moyenne de la classe par matière, moyennes du premier et du dernier' },
  { code: 'original_college', libelle: 'Original', modes: ['college'],
    detail: 'Colonnes CC, DS et Note (30 % CC + 70 % DS), total et rang par groupe, décision du conseil' },
  { code: 'original_institut', libelle: 'Original', modes: ['institut'],
    detail: 'Colonnes CC, DS et Ev. Tr., total et rang par groupe, décision du conseil' },
];
const MODELES_BULLETIN_DEFAUT = { lycee: 'original', college: 'original_college', institut: 'original_institut' };
export const modeleBulletinDefaut = (mode) => MODELES_BULLETIN_DEFAUT[mode] || MODELES_BULLETIN_DEFAUT.lycee;
export const modelesBulletinDuMode = (mode) => MODELES_BULLETIN.filter((m) => m.modes.includes(mode || 'lycee'));
// Modèle conservé s'il appartient au mode, sinon modèle par défaut du mode.
export const modeleBulletinPourMode = (code, mode) => (
  modelesBulletinDuMode(mode).some((m) => m.code === code) ? code : modeleBulletinDefaut(mode));

export const modeEvaluation = (code) => MODES_EVALUATION.find((m) => m.code === code) || MODES_EVALUATION[0];

export function BadgeModeEvaluation({ code, verrouille = false }) {
  const mode = modeEvaluation(code);
  return (
    <span className="badge bg-label-info" title={`${mode.detail}${verrouille ? ' — définitif : des notes ont été saisies' : ''}`}>
      {verrouille && <i className="bx bx-lock-alt me-1" />}{mode.libelle}
    </span>
  );
}

export function ChampModeEvaluation({ id, value, onChange, verrouille = false, aide }) {
  const mode = modeEvaluation(value);
  return (
    <div className="mb-3">
      <label className="form-label" htmlFor={id}>Mode d'évaluation</label>
      <Select id={id} className="form-select" value={mode.code} disabled={verrouille} onChange={(e) => onChange(e.target.value)}>
        {MODES_EVALUATION.map((m) => <option key={m.code} value={m.code}>{m.libelle} — {m.detail}</option>)}
      </Select>
      <div className="form-text">
        {verrouille
          ? <><i className="bx bx-lock-alt me-1" />Des notes ont déjà été saisies : le mode de cette année est définitif.</>
          : aide}
      </div>
    </div>
  );
}

// Libellé d'une note dans les listes (historique, suppressions) :
// « Séquence 1 », ou « Séquence 1 · CC » en mode Collège/Institut.
const LIBELLES_COMPOSANTES = { cc: 'CC', ds: 'DS', evtr: 'Ev. Tr.' };
export const libelleSequenceNote = (n) => (LIBELLES_COMPOSANTES[n.composante]
  ? `${n.sequence} · ${LIBELLES_COMPOSANTES[n.composante]}`
  : n.sequence);

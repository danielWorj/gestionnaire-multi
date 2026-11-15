import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/ui';
import { AvecChoixClasse } from '../components/Espace';
import Select from '../components/Select';
import { SkelListe } from '../components/Skeleton';
import './notes.css';
import './procesVerbal.css';

// Procès-verbal d'évaluation (« Contrôle continu N°x ») : le tableau de toute
// une classe pour une séquence, en A4 paysage. Admin et SuperAdmin uniquement.
//
// Tout est calculé et mis en page par le serveur (/api/pv/, cf.
// server/services/pv_services.py) : aucune moyenne n'est recalculée ici.
// L'aperçu, l'impression et le PDF utilisent le même gabarit
// (server/static/templates/pv/pv_evaluation.html), donc la feuille imprimée
// et le PDF sont identiques à l'aperçu.
//
// Page autonome : seul le choix de classe (AvecChoixClasse) est partagé ;
// rien n'est importé de la page des bulletins. Le PV n'est jamais lu depuis
// la copie hors connexion (cf. lib/stockageLocal.js) : il reflète toujours
// l'état du serveur.

const VIDE_CLASSES = "Aucune classe dans cet établissement pour le moment. Créez les classes dans « Configuration ».";

// Choix de la classe sur des cartes, puis procès-verbal de la classe choisie.
export default function ProcesVerbalPage() {
  const { activeEtablissementId } = useAuth();
  const [, setParams] = useSearchParams();
  const etabPrecedent = useRef(activeEtablissementId);

  // SuperAdmin : la classe choisie appartient à l'établissement consulté ;
  // en changer ramène au choix de classe (pas au premier chargement, où
  // l'établissement passe de « aucun » à celui mémorisé).
  useEffect(() => {
    const precedent = etabPrecedent.current;
    etabPrecedent.current = activeEtablissementId;
    if (precedent != null && precedent !== activeEtablissementId) setParams({}, { replace: true });
  }, [activeEtablissementId, setParams]);

  return (
    <AvecChoixClasse key={activeEtablissementId ?? 'etablissement'} titre="Procès-verbal" icon="bx-table" avecAvancement={false} vide={VIDE_CLASSES}>
      {({ classeId, espace }) => <PvClasse key={classeId} classeId={classeId} espace={espace} />}
    </AvecChoixClasse>
  );
}

// Même règle que le serveur pour le nom du PDF (pv_api.pv_pdf) : ASCII,
// accents retirés, tout autre caractère remplacé par « _ ».
const nomFichier = (texte) => texte.normalize('NFKD').replace(/[^ -~]/g, '').replace(/[^A-Za-z0-9_.-]+/g, '_');

const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

// Séquences regroupées par trimestre (dans l'ordre renvoyé par le serveur).
function parTrimestre(sequences) {
  const groupes = [];
  sequences.forEach((s) => {
    const dernier = groupes[groupes.length - 1];
    if (dernier && dernier.trimestreId === s.trimestre_id) dernier.sequences.push(s);
    else groupes.push({ trimestreId: s.trimestre_id, libelle: s.trimestre, sequences: [s] });
  });
  return groupes;
}

function PvClasse({ classeId, espace }) {
  const toast = useToast();

  // Années scolaires et séquence en cours : déjà chargées par le choix de
  // classe (/censeur/mon-espace, ouvert à l'Admin et au SuperAdmin).
  const annees = espace.data ? espace.data.annees_scolaires || [] : espace.error ? [] : null;
  const sequenceCouranteId = espace.data?.sequence_courante?.id;

  const [anneeChoisie, setAnneeChoisie] = useState('');
  const [sequenceChoisie, setSequenceChoisie] = useState('');
  const [ordre, setOrdre] = useState('alphabetique');
  const [valeurs, setValeurs] = useState('points');
  const [version, setVersion] = useState(0);
  // Réponses du serveur, chacune rangée avec la demande à laquelle elle
  // répond : une réponse qui ne correspond plus aux filtres n'est jamais
  // affichée, et « en cours » se déduit de la comparaison (aucun état à
  // remettre à zéro quand un filtre change).
  const [repSequences, setRepSequences] = useState(null); // { annee, liste, erreur }
  const [repPv, setRepPv] = useState(null); // { selection, demande, donnees, erreur }
  const [repApercu, setRepApercu] = useState(null); // { selection, donnees, requete, html }
  const [occupe, setOccupe] = useState(null);
  const [aImprimer, setAImprimer] = useState('');
  const impressionRef = useRef(null);

  // Année active présélectionnée (à défaut, la plus récente).
  const annee = anneeChoisie || String((annees?.find((a) => a.active) || annees?.[0])?.id ?? '');

  // Séquences de l'année (null : en cours de chargement) ; la séquence en
  // cours est présélectionnée tant que l'utilisateur n'en a pas choisi une.
  const sequences = repSequences?.annee === annee ? repSequences.liste : null;
  const erreurSequences = repSequences?.annee === annee ? repSequences.erreur : null;
  const sequence = !sequences ? ''
    : sequences.some((s) => String(s.id) === sequenceChoisie) ? sequenceChoisie
      : String((sequences.find((s) => s.id === sequenceCouranteId) || sequences[0])?.id ?? '');

  useEffect(() => {
    if (!annee) return undefined;
    let cancelled = false;
    api.get(`/pv/sequences?annee_scolaire_id=${annee}`)
      .then((liste) => { if (!cancelled) setRepSequences({ annee, liste: liste || [], erreur: null }); })
      .catch((e) => {
        if (cancelled) return;
        setRepSequences({ annee, liste: [], erreur: e.message });
        toast(`Séquences : ${e.message}`, 'error');
      });
    return () => { cancelled = true; };
  }, [annee, version, toast]);

  // Données du PV (bandeau, alertes, statistiques). `demande` change aussi
  // avec « Actualiser » : les données affichées restent alors à l'écran,
  // estompées, jusqu'à l'arrivée des nouvelles.
  const selection = annee && sequence ? `${annee}|${sequence}` : '';
  const demande = selection ? `${selection}|${version}` : '';

  useEffect(() => {
    if (!demande) return undefined;
    let cancelled = false;
    api.get(`/pv/?${new URLSearchParams({ classe_id: classeId, annee_scolaire_id: annee, sequence_id: sequence })}`)
      .then((data) => { if (!cancelled) setRepPv({ selection, demande, donnees: data, erreur: null }); })
      .catch((e) => {
        if (cancelled) return;
        setRepPv({ selection, demande, donnees: null, erreur: e.message });
        toast(`Procès-verbal : ${e.message}`, 'error');
      });
    return () => { cancelled = true; };
  }, [classeId, annee, sequence, selection, demande, toast]);

  const pv = selection && repPv?.selection === selection ? repPv : null;
  const donnees = pv?.donnees || null;
  const erreur = pv?.erreur || null;
  const chargement = Boolean(demande) && repPv?.demande !== demande;

  const nbMatieres = donnees?.matieres.length || 0;
  const affichable = Boolean(donnees && donnees.effectif > 0 && nbMatieres > 0);

  // Requête des sorties (aperçu, impression, PDF) : construite à partir des
  // données AFFICHÉES, pour que la feuille corresponde toujours au bandeau.
  const requete = useMemo(() => (donnees ? new URLSearchParams({
    classe_id: donnees.classe.id, annee_scolaire_id: donnees.annee.id, sequence_id: donnees.sequence.id, ordre, valeurs,
  }).toString() : ''), [donnees, ordre, valeurs]);

  // Aperçu : le gabarit du serveur, tel qu'il sera imprimé. Rechargé quand
  // les données changent (« Actualiser » compris), l'ordre ou les valeurs.
  useEffect(() => {
    if (!affichable) return undefined;
    let cancelled = false;
    api.get(`/pv/html?${requete}`)
      .then((html) => { if (!cancelled) setRepApercu({ selection, donnees, requete, html }); })
      .catch((e) => {
        if (cancelled) return;
        setRepApercu({ selection, donnees, requete, html: '' });
        toast(`Aperçu : ${e.message}`, 'error');
      });
    return () => { cancelled = true; };
  }, [affichable, selection, donnees, requete, toast]);

  const apercu = repApercu?.selection === selection ? repApercu.html : '';
  const apercuEnCours = affichable && !(repApercu?.donnees === donnees && repApercu?.requete === requete);

  const imprimer = async () => {
    setOccupe('impression');
    try {
      setAImprimer(await api.get(`/pv/html?${requete}`));
    } catch (e) {
      toast(`Impression : ${e.message}`, 'error');
      setOccupe(null);
    }
  };

  // Impression via un iframe caché, une fois le HTML chargé (logo compris).
  const lancerImpression = () => {
    const fenetre = impressionRef.current?.contentWindow;
    if (fenetre) {
      fenetre.focus();
      fenetre.print();
    }
    setOccupe(null);
    setTimeout(() => setAImprimer(''), 1000);
  };

  const telechargerPdf = async () => {
    setOccupe('pdf');
    try {
      const blob = await api.blob(`/pv/pdf?${requete}`);
      const url = URL.createObjectURL(blob);
      const lien = document.createElement('a');
      lien.href = url;
      lien.download = `${nomFichier(`pv_${donnees.classe.label}_${donnees.sequence.libelle}`)}.pdf`;
      document.body.appendChild(lien);
      lien.click();
      lien.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      // 503 du serveur d'application : WeasyPrint absent. L'impression reste possible.
      const sansPdf = e.status === 503 && e.payload?.erreur;
      toast(sansPdf ? `${e.message}. Utilisez « Imprimer », puis « Enregistrer au format PDF ».` : `PDF : ${e.message}`, 'error');
    } finally {
      setOccupe(null);
    }
  };

  const actualiser = () => {
    if (espace.error) espace.recharger();
    setVersion((v) => v + 1);
  };

  const stats = donnees?.statistiques;
  const alertes = donnees?.alertes || [];
  const enAttente = annees === null || (Boolean(annee) && sequences === null) || (chargement && !donnees);
  const sortiesInactives = !affichable || chargement || Boolean(occupe);
  const groupes = useMemo(() => parTrimestre(sequences || []), [sequences]);
  const optionsSequence = (liste) => liste.map((s) => <option key={s.id} value={s.id}>{s.libelle}</option>);

  return (
    <>
      {espace.error && !espace.data && <div className="alert alert-danger">Impossible de charger les années scolaires : {espace.error.message}</div>}

      <div className="card mb-3">
        <div className="card-body py-3 pv-filtres">
          <div className="pv-filtres-champs">
            <div>
              <label className="form-label">Année scolaire</label>
              <Select className="form-select form-select-sm" value={annee} onChange={(e) => setAnneeChoisie(e.target.value)} disabled={!annees?.length}>
                {annees === null ? <option value="">Chargement…</option> : annees.length ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (active)' : ''}</option>) : <option value="">Aucune année scolaire</option>}
              </Select>
            </div>
            <div>
              <label className="form-label">Séquence</label>
              <Select className="form-select form-select-sm" value={sequence} onChange={(e) => setSequenceChoisie(e.target.value)} disabled={!sequences?.length}>
                {!annee ? <option value="">—</option>
                  : sequences === null ? <option value="">Chargement…</option>
                    : !sequences.length ? <option value="">Aucune séquence</option>
                      : groupes.map((g) => (g.libelle
                        ? <optgroup key={g.trimestreId} label={g.libelle}>{optionsSequence(g.sequences)}</optgroup>
                        : optionsSequence(g.sequences)))}
              </Select>
            </div>
            <div>
              <label className="form-label">Ordre des élèves</label>
              <Select className="form-select form-select-sm" value={ordre} onChange={(e) => setOrdre(e.target.value)}>
                <option value="alphabetique">Alphabétique</option>
                <option value="rang">Rang (classement)</option>
              </Select>
            </div>
            <div>
              <label className="form-label">Valeurs des cellules</label>
              <Select className="form-select form-select-sm" value={valeurs} onChange={(e) => setValeurs(e.target.value)}>
                <option value="points">Points (note × coef.)</option>
                <option value="notes">Notes sur 20</option>
              </Select>
            </div>
          </div>
          <div className="pv-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={sortiesInactives} onClick={imprimer}>
              {occupe === 'impression' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-printer me-1" />}Imprimer
            </button>
            <button type="button" className="btn btn-outline-primary btn-sm" disabled={sortiesInactives} onClick={telechargerPdf}>
              {occupe === 'pdf' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bxs-file-pdf me-1" />}Télécharger le PDF
            </button>
            <button type="button" className="btn btn-icon btn-sm btn-outline-secondary" title="Actualiser" aria-label="Actualiser" disabled={chargement || Boolean(occupe)} onClick={actualiser}>
              <i className={`bx bx-refresh ${chargement ? 'bx-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {donnees && (
        <div className="contexte-bandeau">
          <div className="item"><i className="bx bx-chalkboard" /> {donnees.classe.label}</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-calendar" /> {donnees.sequence.titre}</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-group" /> {pluriel(donnees.effectif, 'élève')}</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-line-chart" /> Moy. classe : {stats.moyenne_classe_fmt ? `${stats.moyenne_classe_fmt}/20` : '—'}</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-check-circle" /> Réussite : {stats.taux_reussite_fmt ? `${stats.taux_reussite_fmt} %` : '—'}</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-user-x" /> Non classés : {stats.nb_non_classes}</div>
        </div>
      )}

      {affichable && alertes.length > 0 && (
        <div className="alert alert-warning pv-alertes" role="status">
          <div className="pv-alertes-titre">
            <i className="bx bx-error me-1" />
            Notes non saisies : {pluriel(stats.nb_non_classes, 'élève')} {stats.nb_non_classes > 1 ? 'non classés' : 'non classé'} (N.C.)
          </div>
          <ul className="pv-alertes-liste">
            {alertes.map((a) => (
              <li key={a.mc_id}>
                <strong>{a.matiere}</strong> : {a.manquantes >= donnees.effectif ? 'aucune note saisie' : `${pluriel(a.manquantes, 'élève')} sans note`}
              </li>
            ))}
          </ul>
          <small>Un élève sans note dans une matière reste « N.C. » : ni moyenne ni rang. Un élève saisi « absent » compte 0 et reste classé.</small>
        </div>
      )}

      {enAttente ? (
        <div className="card"><SkelListe lignes={8} label="Chargement du procès-verbal…" className="px-3 py-2" /></div>
      ) : !annee ? (
        <Vide icon="bx-calendar-x">Aucune année scolaire n'est configurée. Créez-la dans <Link to="/configuration">Configuration</Link>.</Vide>
      ) : !sequence ? (
        <Vide icon={erreurSequences ? 'bx-error-circle' : 'bx-calendar-x'} onReessayer={erreurSequences ? actualiser : null}>
          {erreurSequences || <>Aucune séquence n'est définie pour cette année scolaire. Créez-les dans <Link to="/configuration">Configuration</Link>.</>}
        </Vide>
      ) : !donnees ? (
        <Vide icon="bx-error-circle" onReessayer={actualiser}>{erreur || 'Le procès-verbal n\'a pas pu être chargé.'}</Vide>
      ) : !nbMatieres ? (
        <Vide icon="bx-book-open">Aucune matière n'est affectée à cette classe : le procès-verbal n'a aucune colonne. Affectez les matières dans <Link to="/matieres">Matières</Link> (onglet « Affectations Classe »).</Vide>
      ) : !donnees.effectif ? (
        <Vide icon="bx-user-x">Aucun élève en cours d'inscription dans cette classe pour l'année {donnees.annee.libelle}.</Vide>
      ) : apercu ? (
        <ApercuPv html={apercu} enCours={chargement || apercuEnCours} />
      ) : apercuEnCours ? (
        <div className="card"><SkelListe lignes={8} label="Préparation de l'aperçu…" className="px-3 py-2" /></div>
      ) : (
        <Vide icon="bx-error-circle" onReessayer={actualiser}>L'aperçu n'a pas pu être chargé.</Vide>
      )}

      {aImprimer && <iframe ref={impressionRef} title="Impression du procès-verbal" className="pv-impression" srcDoc={aImprimer} onLoad={lancerImpression} />}
    </>
  );
}

function Vide({ icon, onReessayer, children }) {
  return (
    <div className="card">
      <div className="card-body text-center text-muted py-5">
        <i className={`bx ${icon} bx-md d-block mb-2`} />
        <p className="mb-0">{children}</p>
        {onReessayer && <button type="button" className="btn btn-outline-secondary btn-sm mt-3" onClick={onReessayer}><i className="bx bx-refresh me-1" />Réessayer</button>}
      </div>
    </div>
  );
}

// Largeur de la feuille A4 paysage du gabarit (297 mm) et de ses marges à l'écran.
const LARGEUR_FEUILLE = 1152;
const HAUTEUR_MIN = 420;
// En dessous, le tableau devient illisible : l'aperçu défile horizontalement.
const ECHELLE_MIN = 0.6;
// Une variation plus petite qu'une barre de défilement ne fait pas grandir
// l'aperçu (sinon il oscille quand la barre de la page apparaît / disparaît).
const TOLERANCE = 20;

// Aperçu : la feuille est réduite pour tenir dans la largeur disponible, et
// l'iframe prend la hauteur du document (pas de défilement dans le cadre).
function ApercuPv({ html, enCours }) {
  const cadreRef = useRef(null);
  const iframeRef = useRef(null);
  const largeurRef = useRef(0);
  const [echelle, setEchelle] = useState(1);
  const [hauteur, setHauteur] = useState(HAUTEUR_MIN);

  useEffect(() => {
    const cadre = cadreRef.current;
    if (!cadre) return undefined;
    const ajuster = () => {
      const largeur = cadre.clientWidth;
      const ecart = largeur - largeurRef.current;
      if (!largeur || (ecart > 0 && ecart <= TOLERANCE && largeurRef.current)) return;
      largeurRef.current = largeur;
      setEchelle(Math.min(1, Math.max(ECHELLE_MIN, largeur / LARGEUR_FEUILLE)));
    };
    ajuster();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observateur = new ResizeObserver(ajuster);
    observateur.observe(cadre);
    return () => observateur.disconnect();
  }, []);

  const mesurer = () => {
    const corps = iframeRef.current?.contentDocument?.body;
    if (corps) setHauteur(Math.max(HAUTEUR_MIN, Math.ceil(corps.getBoundingClientRect().height)));
  };

  return (
    <div ref={cadreRef} className={`pv-apercu ${enCours ? 'est-en-cours' : ''}`} aria-busy={enCours}>
      <div className="pv-apercu-feuille" style={{ width: Math.floor(LARGEUR_FEUILLE * echelle), height: Math.ceil(hauteur * echelle) }}>
        <iframe
          ref={iframeRef}
          title="Aperçu du procès-verbal"
          srcDoc={html}
          onLoad={mesurer}
          style={{ width: LARGEUR_FEUILLE, height: hauteur, transform: `scale(${echelle})` }}
        />
      </div>
    </div>
  );
}

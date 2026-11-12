import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import {
  dateDernierPrechargement, echeanceSaisiesEnAttente, PRECHARGE_EVENT, prechargerEspace, rolePrecharge,
  SYNCHRO_EVENT, synchroniser, useEnLigne, useOperationsEnAttente,
} from '../lib/offline';
import ConflitsSynchro, { OUVRIR_CONFLITS_EVENT } from './ConflitsSynchro';
import Modal from './Modal';
import { useToast } from './ui';

// Bandeau + moteur du mode hors connexion, monté une fois dans le Layout :
// envoie les saisies en attente dès que le réseau revient (et toutes les
// 30 s tant qu'il en reste), soumet les conflits à l'utilisateur, et recopie
// sur l'appareil les données de saisie à chaque connexion.

const RELANCE_MS = 30 * 1000;

const fmtDate = (ts) => new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

// Saisies gardées sur l'appareil : avertissement 5 jours avant l'échéance la
// plus proche (cf. echeanceSaisiesEnAttente), alerte à 3 jours, avec une
// fenêtre à confirmer une fois par jour.
const JOUR_MS = 24 * 60 * 60 * 1000;
const PREVENIR_JOURS = 5;
const ALERTER_JOURS = 3;
const ALERTE_VUE_KEY = 'horsLigneAlerteEcheanceVue';

function messageEcheance(e, jours) {
  const date = new Date(e.le).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const quand = jours <= 0 ? "aujourd'hui" : jours === 1 ? `demain (${date})` : `le ${date}, dans ${jours} jours`;
  const saisies = `${pluriel(e.nb, 'saisie')} gardée${e.nb > 1 ? 's' : ''} sur cet appareil`;
  if (e.type === 'sequence' && jours < 0) {
    return {
      titre: `Séquence ${e.libelle} terminée`,
      texte: `${saisies} ${e.nb > 1 ? "n'ont" : "n'a"} pas encore été envoyée${e.nb > 1 ? 's' : ''}. Connectez-vous à Internet au plus vite pour qu'${e.nb > 1 ? 'elles figurent' : 'elle figure'} sur les bulletins.`,
    };
  }
  if (e.type === 'sequence') {
    return {
      titre: `Séquence ${e.libelle} : fin ${jours <= 0 ? "aujourd'hui" : quand}`,
      texte: `${saisies} ${e.nb > 1 ? 'doivent' : 'doit'} être envoyée${e.nb > 1 ? 's' : ''} avant la fin de la séquence, sinon ${e.nb > 1 ? 'elles' : 'elle'} ne figurer${e.nb > 1 ? 'ont' : 'a'} pas sur les bulletins. Connectez-vous à Internet dès que possible : l'envoi est automatique.`,
    };
  }
  return {
    titre: `Connexion à Internet nécessaire ${jours <= 0 ? "aujourd'hui" : `d'ici ${jours === 1 ? 'demain' : `${jours} jours`}`}`,
    texte: `Sans connexion d'ici ${quand}, l'application ne pourra plus s'ouvrir sur cet appareil. Vos ${saisies} y resteront et partiront dès votre reconnexion, mais vous ne pourrez plus rien saisir d'ici là.`,
  };
}

function lireAlerteVue() {
  try {
    return localStorage.getItem(ALERTE_VUE_KEY);
  } catch {
    return null;
  }
}

function memoriserAlerteVue(cle) {
  try {
    localStorage.setItem(ALERTE_VUE_KEY, cle);
  } catch {
    // stockage indisponible : la fenêtre se rouvrira, sans gravité
  }
}

export default function HorsLigne({ role }) {
  const { horsLigne: sessionHorsLigne, user } = useAuth();
  const toast = useToast();
  const enLigne = useEnLigne();
  const attente = useOperationsEnAttente();
  const ops = Object.values(attente);
  const nbConflits = ops.filter((o) => o.conflit).length;
  const nbRefus = ops.filter((o) => o.refus).length;
  const nbAttente = ops.length - nbConflits - nbRefus;
  const nbAttenteRef = useRef(nbAttente);
  useEffect(() => { nbAttenteRef.current = nbAttente; }, [nbAttente]);
  const [precharge, setPrecharge] = useState(dateDernierPrechargement);
  const [envoi, setEnvoi] = useState(false);
  const prechargeable = rolePrecharge(role);
  const [sequences, setSequences] = useState([]);
  const [alerteOuverte, setAlerteOuverte] = useState(false);
  const compteEtablissement = user?.type === 'utilisateur';

  // Dates de fin des séquences : relues à chaque retour du réseau, et
  // servies hors connexion par la copie locale.
  useEffect(() => {
    if (!compteEtablissement) return undefined;
    let actif = true;
    api.get('/notifications/echeances-saisie')
      .then((d) => { if (actif) setSequences(d?.sequences || []); })
      .catch(() => {});
    return () => { actif = false; };
  }, [compteEtablissement, enLigne]);

  const echeance = echeanceSaisiesEnAttente(ops.filter((o) => !o.refus), sequences);
  const joursRestants = echeance ? Math.ceil((echeance.le - Date.now()) / JOUR_MS) : null;
  const prevenir = echeance && joursRestants <= PREVENIR_JOURS;
  const alerter = prevenir && joursRestants <= ALERTER_JOURS;
  const cleAlerte = alerter ? `${new Date().toDateString()}|${echeance.type}|${echeance.le}` : null;
  const message = prevenir ? messageEcheance(echeance, joursRestants) : null;

  useEffect(() => {
    if (cleAlerte && lireAlerteVue() !== cleAlerte) setAlerteOuverte(true);
  }, [cleAlerte]);

  const fermerAlerte = () => {
    if (cleAlerte) memoriserAlerteVue(cleAlerte);
    setAlerteOuverte(false);
  };

  useEffect(() => {
    const maj = () => setPrecharge(dateDernierPrechargement());
    window.addEventListener(PRECHARGE_EVENT, maj);
    return () => window.removeEventListener(PRECHARGE_EVENT, maj);
  }, []);

  // Résultat des envois.
  useEffect(() => {
    const onSynchro = (e) => {
      const { envoyees, refusees } = e.detail;
      const horsLigne = envoyees.filter((x) => x.op._saisieLe);
      if (horsLigne.length) toast(`${pluriel(horsLigne.length, 'saisie')} hors connexion enregistrée${horsLigne.length > 1 ? 's' : ''} sur le serveur.`);
      refusees.forEach((r) => toast(`Saisie refusée par le serveur (${r.op.libelle}) : ${r.message}${r.conservee ? ' — elle reste affichée sur sa page, à corriger ou abandonner.' : ''}`, 'error'));
    };
    window.addEventListener(SYNCHRO_EVENT, onSynchro);
    return () => window.removeEventListener(SYNCHRO_EVENT, onSynchro);
  }, [toast]);

  // Envoi des saisies en attente, puis copie des données à jour (forcée si
  // des saisies viennent de partir : les versions locales doivent suivre).
  useEffect(() => {
    if (!enLigne) return undefined;
    let actif = true;
    const cycle = async () => {
      if (!actif) return;
      const { envoyees } = await synchroniser();
      if (actif && prechargeable) prechargerEspace(role, { force: envoyees.length > 0 });
    };
    cycle();
    const onVisible = () => { if (document.visibilityState === 'visible') cycle(); };
    document.addEventListener('visibilitychange', onVisible);
    const t = setInterval(() => { if (nbAttenteRef.current) synchroniser(); }, RELANCE_MS);
    return () => {
      actif = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enLigne, prechargeable, role]);

  const envoyerMaintenant = async () => {
    setEnvoi(true);
    try {
      const { restantes, enConflit, refuseesConservees } = await synchroniser();
      if (restantes > enConflit + refuseesConservees) toast('Le serveur est toujours injoignable. Les saisies restent gardées sur cet appareil.', 'error');
    } finally {
      setEnvoi(false);
    }
  };

  const horsConnexion = !enLigne || sessionHorsLigne;
  const bandeau = horsConnexion || nbAttente > 0 || nbConflits > 0 || nbRefus > 0;

  return (
    <>
      <ConflitsSynchro />
      {message && (
        <div className={`alert ${alerter ? 'alert-danger' : 'alert-warning'} d-flex align-items-start gap-2 py-2 hors-ligne-bandeau`} role="alert">
          <i className="bx bx-time-five fs-4" />
          <div className="small"><strong>{message.titre}.</strong> {message.texte}</div>
        </div>
      )}
      {alerteOuverte && message && (
        <Modal
          size=""
          title={<span className="text-danger"><i className="bx bx-time-five me-2" />{message.titre}</span>}
          onClose={fermerAlerte}
          footer={<button type="button" className="btn btn-primary btn-sm" onClick={fermerAlerte}>J'ai compris</button>}
        >
          <p className="mb-0">{message.texte}</p>
        </Modal>
      )}
      {bandeau && (
        <div className={`alert ${nbConflits || nbRefus ? 'alert-danger' : horsConnexion ? 'alert-secondary' : 'alert-warning'} d-flex flex-wrap align-items-center gap-2 py-2 hors-ligne-bandeau`} role="status">
          <i className={`bx ${nbConflits ? 'bx-error' : horsConnexion ? 'bx-wifi-off' : 'bx-cloud-upload'} fs-4`} />
          <div className="flex-grow-1 small">
            {horsConnexion ? (
              <>
                <strong>Mode hors connexion.</strong>{' '}
                {prechargeable && (precharge ? `Données enregistrées le ${fmtDate(precharge)}. ` : 'Aucune donnée enregistrée sur cet appareil pour le moment. ')}
                Vos saisies sont gardées sur l'appareil et seront envoyées automatiquement au retour de la connexion.
              </>
            ) : nbAttente > 0 ? (
              <><strong>Connexion rétablie.</strong> Envoi des saisies en attente…</>
            ) : null}
            {nbAttente > 0 && <div><strong>{pluriel(nbAttente, 'saisie')} en attente d'envoi.</strong></div>}
            {nbConflits > 0 && <div><strong>{pluriel(nbConflits, 'conflit')} à trancher :</strong> la donnée a changé sur le serveur entre-temps.</div>}
            {nbRefus > 0 && <div><strong>{pluriel(nbRefus, 'saisie')} refusée{nbRefus > 1 ? 's' : ''} par le serveur</strong> : à corriger ou abandonner depuis sa page.</div>}
          </div>
          {nbConflits > 0 && (
            <button type="button" className="btn btn-sm btn-danger" onClick={() => window.dispatchEvent(new Event(OUVRIR_CONFLITS_EVENT))}>Voir</button>
          )}
          {nbAttente > 0 && (
            <button type="button" className="btn btn-sm btn-warning" onClick={envoyerMaintenant} disabled={envoi}>
              {envoi ? <span className="spinner-border spinner-border-sm" /> : 'Envoyer'}
            </button>
          )}
        </div>
      )}
    </>
  );
}

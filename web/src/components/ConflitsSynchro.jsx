import { useEffect, useMemo, useState } from 'react';
import { resoudreConflit, SYNCHRO_EVENT, useOperationsEnAttente } from '../lib/offline';
import { moduleHorsLigne } from '../lib/modulesHorsLigne';
import { Auteur, EntreeAudit, fmtHorodatage } from './Historique';
import Modal from './Modal';
import { useToast } from './ui';

// Conflits de synchronisation : une saisie (souvent faite hors connexion)
// porte sur une donnée que quelqu'un d'autre a modifiée — ou créée — entre-
// temps. Rien n'a été écrit : on montre les deux versions et QUI a fait la
// modification concurrente, QUAND (journal d'audit), et l'utilisateur décide :
//  - « Garder ma saisie » : elle remplace celle du serveur ;
//  - « Garder celle du serveur » : sa saisie est abandonnée.
// S'ouvre tout seul à l'apparition d'un conflit ; « Décider plus tard » le
// referme (le bandeau hors connexion permet de le rouvrir).

export const OUVRIR_CONFLITS_EVENT = 'horsLigne:ouvrir-conflits';

// Dossier à plusieurs fiches (parent, élève, inscription) : un bloc par
// fiche déjà présente sur le serveur.
function Doublons({ doublons }) {
  return (
    <div className="d-flex flex-column gap-2 mb-2">
      {doublons.map((d) => {
        const m = moduleHorsLigne(d.type);
        return (
          <div key={d.type} className="row g-2">
            <div className="col-md-6">
              <div className="conflit-version conflit-mienne">
                <div className="small text-muted mb-1">{m.titre} — votre saisie</div>
                <div className="fw-semibold">{m.resume(d.saisie)}</div>
              </div>
            </div>
            <div className="col-md-6">
              <div className="conflit-version conflit-serveur">
                <div className="small text-muted mb-1">{m.titre} — déjà sur le serveur</div>
                <div className="fw-semibold">{m.resume(d.serveur)}</div>
                {d.modification ? (
                  <div className="small">
                    {d.modification.action === 'creation' ? 'Saisi par ' : 'Modifié par '}<Auteur auteur={d.modification.auteur} />
                    <span className="text-muted"> le {fmtHorodatage(d.modification.horodatage)}</span>
                  </div>
                ) : <div className="small text-muted">Auteur inconnu (antérieur au journal).</div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Conflit({ op, onChoix, enCours }) {
  const m = moduleHorsLigne(op.module);
  const { code, serveur, modification, doublons } = op.conflit;
  if (doublons?.length) {
    return (
      <div className="conflit-carte">
        <div className="d-flex align-items-start gap-2 mb-2">
          <i className={`bx ${m.icone} fs-4 text-primary`} />
          <div className="flex-grow-1">
            <div className="fw-semibold">{m.titre} — {op.libelle}</div>
            <div className="small text-muted">
              Saisi le {fmtHorodatage(new Date(op._saisieLe).toISOString())}. {op.conflit.erreur}
              {' '}« Garder ma saisie » met à jour ces fiches avec vos valeurs ; « Garder celle du serveur » abandonne votre saisie.
            </div>
          </div>
        </div>
        <Doublons doublons={doublons} />
        <div className="d-flex flex-wrap gap-2 justify-content-end">
          <button type="button" className="btn btn-sm btn-outline-secondary" disabled={enCours} onClick={() => onChoix(op.cle, 'ignorer')}>
            <i className="bx bx-cloud me-1" />Garder celle du serveur
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={enCours} onClick={() => onChoix(op.cle, 'ecraser')}>
            <i className="bx bx-check me-1" />Garder ma saisie
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="conflit-carte">
      <div className="d-flex align-items-start gap-2 mb-2">
        <i className={`bx ${m.icone} fs-4 text-primary`} />
        <div className="flex-grow-1">
          <div className="fw-semibold">{m.titre} — {op.libelle}</div>
          <div className="small text-muted">
            {code === 'doublon' ? 'Cette donnée a déjà été saisie sur le serveur.' : 'Cette donnée a été modifiée sur le serveur depuis votre saisie.'}
          </div>
        </div>
      </div>
      <div className="row g-2 mb-2">
        <div className="col-md-6">
          <div className="conflit-version conflit-mienne">
            <div className="small text-muted mb-1">Votre saisie</div>
            <div className="conflit-valeur">{m.resume(op.body)}</div>
            <div className="small text-muted">Saisie le {fmtHorodatage(new Date(op._saisieLe).toISOString())}</div>
          </div>
        </div>
        <div className="col-md-6">
          <div className="conflit-version conflit-serveur">
            <div className="small text-muted mb-1">Sur le serveur</div>
            <div className="conflit-valeur">{m.resume(serveur)}</div>
            {modification ? (
              <div className="small">
                {modification.action === 'creation' ? 'Saisie par ' : 'Modifiée par '}<Auteur auteur={modification.auteur} />
                <span className="text-muted"> le {fmtHorodatage(modification.horodatage)}</span>
              </div>
            ) : <div className="small text-muted">Auteur inconnu (antérieur au journal).</div>}
          </div>
        </div>
      </div>
      {modification && Object.keys(modification.changements || {}).length > 0 && (
        <details className="small mb-2">
          <summary className="text-muted">Détail de la dernière modification sur le serveur</summary>
          <ul className="audit-liste list-unstyled mb-0"><EntreeAudit entree={modification} /></ul>
        </details>
      )}
      <div className="d-flex flex-wrap gap-2 justify-content-end">
        <button type="button" className="btn btn-sm btn-outline-secondary" disabled={enCours} onClick={() => onChoix(op.cle, 'ignorer')}>
          <i className="bx bx-cloud me-1" />{m.choix?.ignorer || 'Garder celle du serveur'}
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={enCours} onClick={() => onChoix(op.cle, 'ecraser')}>
          <i className="bx bx-check me-1" />{m.choix?.ecraser || 'Garder ma saisie'}
        </button>
      </div>
    </div>
  );
}

export default function ConflitsSynchro() {
  const toast = useToast();
  const attente = useOperationsEnAttente();
  const conflits = useMemo(() => Object.values(attente).filter((op) => op.conflit)
    .sort((a, b) => a._saisieLe - b._saisieLe), [attente]);
  const [ouvert, setOuvert] = useState(false);
  const [enCours, setEnCours] = useState(false);

  // Ouverture automatique à l'apparition de nouveaux conflits, ou sur demande.
  useEffect(() => {
    const onSynchro = (e) => { if (e.detail.conflits.length) setOuvert(true); };
    const onOuvrir = () => setOuvert(true);
    window.addEventListener(SYNCHRO_EVENT, onSynchro);
    window.addEventListener(OUVRIR_CONFLITS_EVENT, onOuvrir);
    return () => {
      window.removeEventListener(SYNCHRO_EVENT, onSynchro);
      window.removeEventListener(OUVRIR_CONFLITS_EVENT, onOuvrir);
    };
  }, []);

  const choisir = async (cles, choix) => {
    setEnCours(true);
    try {
      for (const cle of cles) {
        // eslint-disable-next-line no-await-in-loop
        await resoudreConflit(cle, choix);
      }
      if (choix === 'ignorer') toast(cles.length > 1 ? 'Les valeurs du serveur ont été conservées.' : 'La valeur du serveur a été conservée.');
    } catch (e) {
      toast(`Impossible d'appliquer votre choix : ${e.message}`, 'error');
    } finally {
      setEnCours(false);
    }
  };

  if (!ouvert || !conflits.length) return null;

  const cles = conflits.map((c) => c.cle);
  return (
    <Modal
      title={`${conflits.length} conflit${conflits.length > 1 ? 's' : ''} à trancher`}
      subtitle="Ces saisies n'ont pas été enregistrées : la donnée a changé sur le serveur entre-temps. Choisissez la version à garder."
      onClose={() => setOuvert(false)}
      footer={(
        <div className="d-flex flex-wrap gap-2 w-100">
          <button type="button" className="btn btn-outline-secondary me-auto" onClick={() => setOuvert(false)}>Décider plus tard</button>
          {conflits.length > 1 && (
            <>
              <button type="button" className="btn btn-outline-secondary" disabled={enCours} onClick={() => choisir(cles, 'ignorer')}>Tout garder du serveur</button>
              <button type="button" className="btn btn-primary" disabled={enCours} onClick={() => choisir(cles, 'ecraser')}>Garder toutes mes saisies</button>
            </>
          )}
        </div>
      )}
    >
      <div className="d-flex flex-column gap-3">
        {conflits.map((op) => <Conflit key={op.cle} op={op} enCours={enCours} onChoix={(cle, choix) => choisir([cle], choix)} />)}
      </div>
    </Modal>
  );
}

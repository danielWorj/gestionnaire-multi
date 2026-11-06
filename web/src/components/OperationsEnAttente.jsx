import { useMemo } from 'react';
import { reessayer, retirerAttente, synchroniser, useEnLigne, useOperationsEnAttente } from '../lib/offline';
import { moduleHorsLigne } from '../lib/modulesHorsLigne';
import { OUVRIR_CONFLITS_EVENT } from './ConflitsSynchro';
import { fmtHorodatage } from './Historique';
import { useConfirm } from './ui';

// Encart « saisies pas encore enregistrées sur le serveur » d'une page
// (inscriptions, élèves, parents, paiements…) : ce qui a été saisi hors
// connexion apparaît tout de suite, avec son état, et peut être annulé.

export default function OperationsEnAttente({ modules, titre = "Saisies en attente d'envoi" }) {
  const attente = useOperationsEnAttente();
  const enLigne = useEnLigne();
  const [confirm, confirmNode] = useConfirm();
  const ops = useMemo(() => Object.values(attente).filter((op) => modules.includes(op.module))
    .sort((a, b) => a._saisieLe - b._saisieLe), [attente, modules]);
  if (!ops.length) return null;

  const annuler = async (op) => {
    const ok = await confirm(`« ${op.libelle} » n'a pas encore été enregistrée sur le serveur. Elle sera définitivement perdue.`, {
      title: 'Abandonner cette saisie ?',
      confirmLabel: 'Abandonner',
      confirmIcon: 'bx-x',
    });
    if (ok) retirerAttente(op.cle);
  };

  return (
    <div className="card mb-3 border border-warning">
      {confirmNode}
      <div className="card-header d-flex flex-wrap align-items-center gap-2 py-2">
        <h6 className="mb-0 flex-grow-1"><i className="bx bx-cloud-upload me-2 text-warning" />{titre} ({ops.length})</h6>
        {enLigne && <button type="button" className="btn btn-sm btn-outline-warning" onClick={() => synchroniser()}>Envoyer maintenant</button>}
      </div>
      <ul className="list-group list-group-flush">
        {ops.map((op) => {
          const m = moduleHorsLigne(op.module);
          return (
            <li key={op.cle} className="list-group-item d-flex flex-wrap align-items-center gap-2">
              <i className={`bx ${m.icone} text-muted`} />
              <div className="flex-grow-1 min-w-0">
                <div className="fw-semibold text-truncate">{op.libelle}</div>
                <div className="small text-muted">{m.titre} · saisi le {fmtHorodatage(new Date(op._saisieLe).toISOString())}</div>
                {op.refus && <div className="small text-danger"><i className="bx bx-block me-1" />Refusé par le serveur : {op.refus.message}</div>}
              </div>
              {op.refus ? (
                enLigne && <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => reessayer(op.cle)}><i className="bx bx-revision me-1" />Réessayer</button>
              ) : op.conflit ? (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => window.dispatchEvent(new Event(OUVRIR_CONFLITS_EVENT))}>
                  <i className="bx bx-git-compare me-1" />À trancher
                </button>
              ) : <span className="badge bg-label-warning"><i className="bx bx-time-five me-1" />En attente</span>}
              <button type="button" className="btn btn-sm btn-icon btn-outline-secondary" title="Abandonner cette saisie" onClick={() => annuler(op)}><i className="bx bx-x" /></button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

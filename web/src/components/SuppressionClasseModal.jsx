import { useState } from 'react';
import Modal from './Modal';

// Fenêtre affichée quand une classe contient des données (élèves, notes,
// liens…) : on les signale et on demande confirmation avant la suppression
// DÉFINITIVE (DELETE /classes/<id>?cascade=1, réservé à l'administrateur).
// Les élèves ne sont pas supprimés : seule leur inscription dans cette classe
// l'est, avec ses notes, fiches de discipline et paiements.
const LIBELLES = [
  ['inscriptions', 'bx-user', 'élève(s) inscrit(s) (inscription retirée, dossier conservé)'],
  ['notes', 'bx-edit', 'note(s)'],
  ['disciplines', 'bx-shield-quarter', 'fiche(s) de discipline'],
  ['paiements', 'bx-wallet', 'paiement(s) et leurs reçus'],
  ['tranches', 'bx-money', 'tranche(s) de paiement'],
  ['matieres', 'bx-book', 'matière(s) rattachée(s) (enseignants, coefficients)'],
  ['horaires', 'bx-time', "créneau(x) d'emploi du temps"],
  ['epreuves', 'bx-file', 'épreuve(s) (fichiers compris)'],
  ['titulaires', 'bx-user-check', 'titulaire(s)'],
  ['censeurs', 'bx-id-card', 'censeur(s) assigné(s)'],
  ['surveillants', 'bx-id-card', 'surveillant(s) assigné(s)'],
];

export default function SuppressionClasseModal({ label, liens, peutSupprimer, enCours, onConfirm, onClose }) {
  const [compris, setCompris] = useState(false);
  return (
    <Modal
      title={`Supprimer la classe « ${label} » ?`}
      onClose={enCours ? () => {} : onClose}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={enCours}>Annuler</button>
          {peutSupprimer && (
            <button type="button" className="btn btn-danger" disabled={!compris || enCours} onClick={onConfirm}>
              <i className="bx bx-trash me-1" />{enCours ? 'Suppression…' : 'Supprimer définitivement'}
            </button>
          )}
        </>
      )}
    >
      <div className="alert alert-warning py-2 small">Cette classe contient des données rattachées :</div>
      <ul className="list-unstyled mb-3">
        {LIBELLES.filter(([cle]) => liens[cle]).map(([cle, icone, texte]) => (
          <li key={cle} className="mb-1">
            <i className={`bx ${icone} me-2 text-primary`} />
            <span className="badge bg-label-primary me-1">{liens[cle]}</span>{texte}
          </li>
        ))}
      </ul>
      <div className="alert alert-danger mb-0 small">
        <strong>Action irréversible.</strong> Si vous confirmez, tout ce qui précède sera supprimé, puis la classe elle-même.
        {peutSupprimer ? (
          <div className="form-check mt-2">
            <input id="supp-classe-compris" type="checkbox" className="form-check-input" checked={compris} disabled={enCours} onChange={(e) => setCompris(e.target.checked)} />
            <label htmlFor="supp-classe-compris" className="form-check-label">Je comprends que cette suppression est définitive.</label>
          </div>
        ) : (
          <div className="mt-2 fw-semibold">Seul un administrateur peut effectuer cette suppression définitive.</div>
        )}
      </div>
    </Modal>
  );
}

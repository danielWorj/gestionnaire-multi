import { useState } from 'react';
import Modal from './Modal';
import { formatDate, formatMontant } from './ui';
import { libelleSequenceNote } from './ModeEvaluation';

// Fenêtre affichée après le refus « élève déjà lié à des notes / paiements » :
// journal des notes et des paiements + bouton de suppression DÉFINITIVE
// (notes, paiements, inscriptions, puis l'élève — en une seule transaction
// côté serveur, DELETE /eleves/<id>?cascade=1, réservé à l'administrateur).
export default function SuppressionEleveModal({ historique, message, peutSupprimer, enCours, onConfirm, onClose }) {
  const [compris, setCompris] = useState(false);
  const { eleve, notes, disciplines, paiements, total_paye: totalPaye } = historique;
  const nom = `${eleve.prenom} ${eleve.nom}`;

  return (
    <Modal
      title={`Supprimer ${nom} et tout son historique ?`}
      subtitle={eleve.matricule ? `Matricule ${eleve.matricule}` : undefined}
      onClose={enCours ? () => {} : onClose}
      size="modal-lg modal-dialog-scrollable"
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
      {message && <div className="alert alert-warning py-2 small">{message}</div>}

      <Section titre="Journal des notes" icone="bx-edit" vide="Aucune note." count={notes.length}>
        <table className="table table-sm align-middle mb-0">
          <thead><tr><th>Année</th><th>Séquence</th><th>Matière</th><th className="text-end">Note</th><th>Saisie</th></tr></thead>
          <tbody>
            {notes.map((n) => (
              <tr key={n.id}>
                <td>{n.annee || '—'}</td>
                <td>{libelleSequenceNote(n)}</td>
                <td>{n.matiere}</td>
                <td className="text-end">{n.absent ? <span className="badge bg-label-secondary">Absent</span> : (n.valeur ?? '—')}</td>
                <td className="text-muted small">{formatDate(n.date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {disciplines.length > 0 && (
        <Section titre="Fiches de discipline" icone="bx-shield-quarter" count={disciplines.length}>
          <table className="table table-sm align-middle mb-0">
            <thead><tr><th>Année</th><th>Séquence</th><th className="text-end">Abs. just.</th><th className="text-end">Abs. non just.</th><th className="text-end">Retards</th><th className="text-end">Excl.</th></tr></thead>
            <tbody>
              {disciplines.map((d) => (
                <tr key={d.id}>
                  <td>{d.annee || '—'}</td><td>{d.sequence}</td>
                  <td className="text-end">{d.absences_justifiees}</td><td className="text-end">{d.absences_non_justifiees}</td>
                  <td className="text-end">{d.retards}</td><td className="text-end">{d.exclusions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section
        titre="Journal des paiements"
        icone="bx-wallet"
        vide="Aucun paiement."
        count={paiements.length}
        extra={paiements.length > 0 ? `Total encaissé : ${formatMontant(totalPaye)}` : null}
      >
        <table className="table table-sm align-middle mb-0">
          <thead><tr><th>Reçu</th><th>Date</th><th>Détail</th><th>Mode</th><th>Statut</th><th className="text-end">Montant</th></tr></thead>
          <tbody>
            {paiements.map((p) => (
              <tr key={p.id}>
                <td className="fw-semibold">{p.numero_recu}</td>
                <td className="text-muted small">{formatDate(p.date)}</td>
                <td className="small">{p.tranches.map((t) => t.libelle).join(', ') || '—'}</td>
                <td className="small">{p.mode_paiement}</td>
                <td><span className={`badge ${p.statut === 'VALIDE' ? 'bg-label-success' : 'bg-label-secondary'}`}>{p.statut}</span></td>
                <td className="text-end">{formatMontant(p.montant_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <div className="alert alert-danger mt-3 mb-0 small">
        <strong>Action irréversible.</strong> Seront supprimés pour toujours : {notes.length} note(s), {disciplines.length} fiche(s) de
        discipline, {paiements.length} paiement(s) et leurs reçus, {historique.inscriptions} inscription(s), puis l'élève lui-même.
        Pour garder cet historique, fermez cette fenêtre et passez plutôt son statut à « Inactif ».
        {peutSupprimer ? (
          <div className="form-check mt-2">
            <input id="supp-eleve-compris" type="checkbox" className="form-check-input" checked={compris} disabled={enCours} onChange={(e) => setCompris(e.target.checked)} />
            <label htmlFor="supp-eleve-compris" className="form-check-label">Je comprends que cette suppression est définitive.</label>
          </div>
        ) : (
          <div className="mt-2 fw-semibold">Seul un administrateur peut effectuer cette suppression définitive.</div>
        )}
      </div>
    </Modal>
  );
}

function Section({ titre, icone, count, vide, extra, children }) {
  return (
    <div className="card mb-3">
      <div className="card-header py-2 d-flex justify-content-between align-items-center">
        <span className="fw-semibold"><i className={`bx ${icone} me-1`} />{titre} <span className="badge bg-label-primary ms-1">{count}</span></span>
        {extra && <small className="text-muted">{extra}</small>}
      </div>
      {count === 0 ? <div className="card-body py-2 text-muted small">{vide}</div> : <div className="table-responsive" style={{ maxHeight: 220 }}>{children}</div>}
    </div>
  );
}

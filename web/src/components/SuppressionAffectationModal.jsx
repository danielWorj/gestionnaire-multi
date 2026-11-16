import { useState } from 'react';
import { api } from '../lib/api';
import Modal from './Modal';
import { formatDate } from './ui';

// Suppression d'une affectation matière → classe, en deux temps :
//  1. confirmation simple ; une affectation vierge est alors supprimée ;
//  2. si le serveur répond 409 « affectation_liee » (notes, cours à l'emploi
//     du temps, épreuves déjà rattachés), cette fenêtre affiche l'historique
//     complet de ces données (GET /matieres-classe/<id>/historique) ; le
//     bouton de suppression définitive (DELETE ...?cascade=1, administrateur
//     uniquement) ne s'active qu'une fois la case de confirmation cochée.
// Tout ce qui est supprimé est tracé dans le Journal (audit serveur).

export function useSuppressionAffectation({ confirm, toast, peutSupprimerDefinitivement, onSupprime }) {
  const [etat, setEtat] = useState(null); // { mc, label, historique, message, enCours }

  const demander = async (mc, label) => {
    const ok = await confirm(
      <>Supprimer l'affectation <strong>{label}</strong> ?<span className="d-block mt-2 text-muted">Si des notes, des cours ou des épreuves y sont déjà rattachés, leur historique vous sera montré avant toute suppression définitive.</span></>,
      { title: "Supprimer l'affectation", confirmLabel: 'Supprimer' },
    );
    if (!ok) return;
    try {
      await api.del(`/matieres-classe/${mc.id}`);
      toast('Affectation supprimée.');
      await onSupprime?.();
    } catch (err) {
      if (err.status === 409 && err.payload?.code === 'affectation_liee') {
        try {
          const historique = await api.get(`/matieres-classe/${mc.id}/historique`, { sansCopieLocale: true });
          setEtat({ mc, label, historique, message: err.message, enCours: false });
        } catch (err2) {
          toast(err2.message, 'error');
        }
        return;
      }
      toast(err.message, 'error');
    }
  };

  const supprimerDefinitivement = async () => {
    const { mc, label } = etat;
    setEtat((s) => ({ ...s, enCours: true }));
    try {
      await api.del(`/matieres-classe/${mc.id}?cascade=1`);
      setEtat(null);
      toast(`Affectation « ${label} » et ses données supprimées`);
      await onSupprime?.();
    } catch (err) {
      setEtat((s) => (s ? { ...s, enCours: false } : s));
      toast(err.message, 'error');
    }
  };

  const node = etat ? (
    <SuppressionAffectationModal
      historique={etat.historique}
      message={etat.message}
      peutSupprimer={peutSupprimerDefinitivement}
      enCours={etat.enCours}
      onConfirm={supprimerDefinitivement}
      onClose={() => setEtat(null)}
    />
  ) : null;

  return [demander, node];
}

export default function SuppressionAffectationModal({ historique, message, peutSupprimer, enCours, onConfirm, onClose }) {
  const [compris, setCompris] = useState(false);
  const { affectation: a, notes, horaires, epreuves } = historique;

  return (
    <Modal
      title={`Supprimer définitivement « ${a.matiere} — ${a.classe} » ?`}
      subtitle={`Enseignant : ${a.enseignant} · coefficient ${a.coefficient}`}
      onClose={enCours ? () => {} : onClose}
      size="modal-lg modal-dialog-scrollable"
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={enCours}>Annuler</button>
          {peutSupprimer && (
            <button type="button" className="btn btn-danger" disabled={!compris || enCours} onClick={onConfirm}>
              {enCours ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-trash me-1" />}
              {enCours ? 'Suppression…' : 'Supprimer définitivement'}
            </button>
          )}
        </>
      )}
    >
      {message && <div className="alert alert-warning py-2 small">{message}</div>}

      <Section titre="Notes saisies" icone="bx-edit" count={notes.length} vide="Aucune note.">
        <table className="table table-sm align-middle mb-0">
          <thead><tr><th>Élève</th><th>Matricule</th><th>Année</th><th>Séquence</th><th className="text-end">Note</th><th>Saisie</th></tr></thead>
          <tbody>
            {notes.map((n) => (
              <tr key={n.id}>
                <td>{n.eleve}</td>
                <td className="small text-muted">{n.matricule || '—'}</td>
                <td className="small">{n.annee || '—'}</td>
                <td className="small">{n.sequence}</td>
                <td className="text-end">{n.absent ? <span className="badge bg-label-secondary">Absent</span> : (n.valeur ?? '—')}</td>
                <td className="text-muted small">{formatDate(n.date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section titre="Cours à l'emploi du temps" icone="bx-time" count={horaires.length} vide="Aucun cours programmé.">
        <table className="table table-sm align-middle mb-0">
          <thead><tr><th>Année</th><th>Jour</th><th>Créneau</th><th>Salle</th></tr></thead>
          <tbody>
            {horaires.map((h) => (
              <tr key={h.id}>
                <td className="small">{h.annee || '—'}</td>
                <td>{h.jour}</td>
                <td className="small">{h.debut && h.fin ? `${h.debut} – ${h.fin}` : (h.creneau || '—')}</td>
                <td className="small">{h.salle || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section titre="Épreuves déposées" icone="bx-file" count={epreuves.length} vide="Aucune épreuve.">
        <table className="table table-sm align-middle mb-0">
          <thead><tr><th>Titre</th><th>Fichier</th><th>Année</th><th>Déposée le</th></tr></thead>
          <tbody>
            {epreuves.map((e) => (
              <tr key={e.id}>
                <td>{e.titre}</td>
                <td className="small text-muted text-break">{e.fichier}</td>
                <td className="small">{e.annee || '—'}</td>
                <td className="text-muted small">{formatDate(e.date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <div className="alert alert-danger mt-3 mb-0 small">
        <strong>Action irréversible.</strong> Seront supprimés pour toujours : {notes.length} note(s), {horaires.length} cours
        à l'emploi du temps, {epreuves.length} épreuve(s) (fichiers compris), puis l'affectation elle-même. Les moyennes et
        bulletins de la classe ne tiendront plus compte de cette matière. La suppression est enregistrée dans le Journal.
        {peutSupprimer ? (
          <div className="form-check mt-2">
            <input id="supp-affectation-compris" type="checkbox" className="form-check-input" checked={compris} disabled={enCours} onChange={(e) => setCompris(e.target.checked)} />
            <label htmlFor="supp-affectation-compris" className="form-check-label">Je confirme la suppression définitive de cette affectation et de toutes les données ci-dessus.</label>
          </div>
        ) : (
          <div className="mt-2 fw-semibold">Seul un administrateur peut effectuer cette suppression définitive.</div>
        )}
      </div>
    </Modal>
  );
}

function Section({ titre, icone, count, vide, children }) {
  return (
    <div className="card mb-3">
      <div className="card-header py-2 d-flex justify-content-between align-items-center">
        <span className="fw-semibold"><i className={`bx ${icone} me-1`} />{titre} <span className="badge bg-label-primary ms-1">{count}</span></span>
      </div>
      {count === 0 ? <div className="card-body py-2 text-muted small">{vide}</div> : <div className="table-responsive" style={{ maxHeight: 240 }}>{children}</div>}
    </div>
  );
}

import { EspaceTitre } from '../components/Espace';
import { SkelListe } from '../components/Skeleton';
import { ChoixEnfant, EtatEspace, Pastille, PhotoEnfant, ProchaineEcheance } from '../components/EspaceParent';
import { prenomNom, statutTranche, useEnfantChoisi, useEspaceParent } from '../lib/espaceParent';
import { formatDate, formatMontant } from '../components/ui';

// Frais de scolarité d'un enfant : résumé, échéancier tranche par tranche,
// versements enregistrés par l'économat.

const MODES = { ESPECES: 'Espèces', MOBILE_MONEY: 'Mobile money', VIREMENT: 'Virement', CHEQUE: 'Chèque' };

export default function ParentPaiementsPage() {
  const espace = useEspaceParent();
  const enfants = espace.data?.enfants || [];
  const [enfant, choisir] = useEnfantChoisi(enfants);
  const p = enfant?.paiements;

  return (
    <>
      <EspaceTitre titre="Paiements" sousTitre="Frais de scolarité de l'année en cours" icon="bx-wallet" />
      <EtatEspace espace={espace} />
      <ChoixEnfant enfants={enfants} enfant={enfant} onChoisir={choisir} />

      {espace.loading && !espace.data && <SkelListe lignes={4} label="Chargement des paiements…" />}

      {enfant && (
        <>
          <div className="d-flex align-items-center gap-2 mb-3">
            <PhotoEnfant eleve={enfant.eleve} taille={40} />
            <div className="min-w-0">
              <div className="fw-bold">{prenomNom(enfant.eleve)}</div>
              <small className="text-muted">{enfant.inscription?.classe || "Pas inscrit cette année"}</small>
            </div>
          </div>

          {!p?.a_echeancier ? (
            <div className="esp-vide">
              <i className="bx bx-receipt" />
              <p className="mb-0">L'échéancier de la classe n'a pas encore été publié par l'établissement.</p>
            </div>
          ) : (
            <>
              <div className="par-resume">
                <div className="par-resume-case"><div className="par-resume-libelle">Total de l'année</div><div className="par-resume-valeur">{formatMontant(p.total_attendu)}</div></div>
                <div className="par-resume-case esp-tone-success"><div className="par-resume-libelle">Déjà payé</div><div className="par-resume-valeur">{formatMontant(p.total_verse)}</div></div>
                <div className="par-resume-case"><div className="par-resume-libelle">Reste à payer</div><div className="par-resume-valeur">{formatMontant(p.reste_annuel)}</div></div>
                <div className={`par-resume-case esp-tone-${p.en_retard ? 'danger' : 'success'}`}><div className="par-resume-libelle">Dont en retard</div><div className="par-resume-valeur">{formatMontant(p.impaye_exigible)}</div></div>
              </div>
              <div className="mb-3"><ProchaineEcheance paiements={p} /></div>

              <div className="card mb-3">
                <h6 className="card-header mb-0"><i className="bx bx-list-ol me-1" />Échéancier</h6>
                <div className="table-responsive">
                  <table className="table mb-0">
                    <thead><tr><th>Tranche</th><th>Date limite</th><th className="text-end">Montant</th><th className="text-end">Payé</th><th className="text-end">Reste</th><th>Statut</th></tr></thead>
                    <tbody>
                      {p.tranches.map((t) => {
                        const s = statutTranche(t);
                        return (
                          <tr key={t.tranche_classe_id}>
                            <td className="fw-semibold">{t.libelle}</td>
                            <td>{t.date_limite ? formatDate(t.date_limite) : "Dès l'inscription"}</td>
                            <td className="text-end">{formatMontant(t.montant_attendu)}</td>
                            <td className="text-end">{formatMontant(t.montant_verse)}</td>
                            <td className="text-end fw-semibold">{formatMontant(t.reste_du)}</td>
                            <td><Pastille ton={s.ton}>{s.libelle}</Pastille></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          <div className="card">
            <h6 className="card-header mb-0"><i className="bx bx-receipt me-1" />Versements enregistrés</h6>
            {enfant.versements.length ? (
              <div className="table-responsive">
                <table className="table mb-0">
                  <thead><tr><th>Reçu</th><th>Date</th><th>Mode</th><th className="text-end">Montant</th></tr></thead>
                  <tbody>
                    {enfant.versements.map((v) => (
                      <tr key={v.id}>
                        <td><code>{v.numero_recu}</code></td>
                        <td>{formatDate(v.date_paiement)}</td>
                        <td>{MODES[v.mode_paiement] || v.mode_paiement}</td>
                        <td className="text-end fw-semibold">{formatMontant(v.montant)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="card-body text-muted">Aucun versement enregistré pour cette année.</div>}
          </div>
          <p className="text-muted small mt-3 mb-0">
            <i className="bx bx-info-circle me-1" />Les paiements se font auprès de l'économat de l'établissement, qui vous remet un reçu. Une erreur ? Présentez votre reçu au secrétariat.
          </p>
        </>
      )}

      {!espace.loading && espace.data && !enfants.length && (
        <div className="esp-vide"><i className="bx bx-user-x" /><p className="mb-0">Aucun enfant n'est rattaché à votre compte.</p></div>
      )}
    </>
  );
}

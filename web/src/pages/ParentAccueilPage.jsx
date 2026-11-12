import { Link } from 'react-router-dom';
import { SkelCartes } from '../components/Skeleton';
import { BarrePaiement, EtatEspace, Pastille, PhotoEnfant, ProchaineEcheance } from '../components/EspaceParent';
import { prenomNom, statutPaiement, useEspaceParent } from '../lib/espaceParent';
import { formatMontant } from '../components/ui';

// Accueil de l'espace parent : un coup d'œil par enfant (classe, frais,
// prochaine échéance) et, en tête, les frais en retard.

export default function ParentAccueilPage() {
  const espace = useEspaceParent();
  const data = espace.data || {};
  const enfants = data.enfants || [];
  const enRetard = enfants.filter((e) => e.paiements?.en_retard);

  return (
    <>
      <div className="esp-bienvenue">
        <h4>Bonjour{data.parent?.prenom ? `, ${data.parent.prenom}` : ''} 👋</h4>
        <p>Espace parent{data.etablissement?.nom ? ` · ${data.etablissement.nom}` : ''}</p>
        {!espace.loading && data.annee_scolaire && (
          <div className="esp-bienvenue-meta">
            <span><i className="bx bx-calendar" />{data.annee_scolaire.libelle}</span>
            <span><i className="bx bx-group" />{enfants.length} enfant{enfants.length > 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      <EtatEspace espace={espace} />

      {enRetard.map((e) => (
        <Link key={e.eleve.id} to={`/parent/paiements?enfant=${e.eleve.id}`} className="par-alerte">
          <i className="bx bx-error-circle" />
          <span className="par-alerte-texte">
            <strong>Frais en retard pour {e.eleve.prenom}</strong> : {formatMontant(e.paiements.impaye_exigible)} à régler.
            {e.bulletin?.bloque && ' Son bulletin est suspendu jusqu\'au règlement.'}
          </span>
          <i className="bx bx-chevron-right" />
        </Link>
      ))}

      <div className="esp-section-titre"><span>Mes enfants</span></div>
      {espace.loading && !espace.data ? (
        <SkelCartes nombre={2} className="col-md-6" label="Chargement de vos enfants…" />
      ) : enfants.length ? (
        <div className="par-enfants">
          {enfants.map((e) => {
            const statut = statutPaiement(e.paiements);
            return (
              <div key={e.eleve.id} className="par-enfant">
                <div className="par-enfant-tete">
                  <PhotoEnfant eleve={e.eleve} taille={52} />
                  <div className="min-w-0 flex-grow-1">
                    <div className="par-enfant-nom">{prenomNom(e.eleve)}</div>
                    <div className="par-enfant-classe">
                      {e.inscription ? e.inscription.classe : "Pas inscrit cette année"} · Matricule {e.eleve.matricule}
                    </div>
                  </div>
                  {e.inscription && <Pastille ton={statut.ton} icon={statut.icon}>{statut.libelle}</Pastille>}
                </div>
                <BarrePaiement paiements={e.paiements} />
                <ProchaineEcheance paiements={e.paiements} />
                {e.inscription && (
                  <div className="par-enfant-actions">
                    <Link to={`/parent/paiements?enfant=${e.eleve.id}`} className="btn btn-outline-primary btn-sm"><i className="bx bx-wallet" />Paiements</Link>
                    <Link to={`/parent/bulletins?enfant=${e.eleve.id}`} className="btn btn-outline-primary btn-sm">
                      <i className={`bx ${e.bulletin?.bloque ? 'bx-lock-alt' : 'bx-file'}`} />Bulletins
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="esp-vide">
          <i className="bx bx-user-x" />
          <p className="mb-0">Aucun enfant n'est encore rattaché à votre compte. Rapprochez-vous du secrétariat de l'établissement.</p>
        </div>
      )}
    </>
  );
}

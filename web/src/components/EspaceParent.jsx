import { useState } from 'react';
import { API_BASE } from '../lib/api';
import { prenomNom } from '../lib/espaceParent';
import { formatDate, formatMontant } from './ui';
import { Pastilles } from './Espace';
import './parent.css';

// Composants de l'espace parent (pages Parent*Page) : choix de l'enfant,
// photo, avancement des paiements. Données et règles : lib/espaceParent.js.

export function Pastille({ ton, icon, children }) {
  return <span className={`par-pastille esp-tone-${ton}`}>{icon && <i className={`bx ${icon}`} />}{children}</span>;
}

export function PhotoEnfant({ eleve, taille = 48 }) {
  const [echec, setEchec] = useState(false);
  const style = { width: taille, height: taille, fontSize: taille * 0.36 };
  if (eleve?.a_photo && !echec) {
    return <img className="par-photo" style={style} src={`${API_BASE}/parent/enfants/${eleve.id}/photo`} alt="" onError={() => setEchec(true)} />;
  }
  // Pas de photo : icône de profil neutre (pas d'initiales).
  return <span className="par-photo par-photo-initiales" style={{ ...style, fontSize: taille * 0.5 }} aria-hidden="true"><i className="bx bxs-user" /></span>;
}

export function ChoixEnfant({ enfants, enfant, onChoisir }) {
  if (enfants.length < 2) return null;
  return (
    <div className="mb-3">
      <Pastilles
        ariaLabel="Enfant"
        value={enfant?.eleve.id}
        onChange={onChoisir}
        options={enfants.map((e) => ({ value: e.eleve.id, label: e.eleve.prenom || prenomNom(e.eleve), badge: e.paiements?.en_retard ? '!' : null }))}
      />
    </div>
  );
}

export function BarrePaiement({ paiements }) {
  if (!paiements?.a_echeancier) return null;
  const pct = paiements.total_attendu ? Math.round((paiements.total_verse / paiements.total_attendu) * 100) : 0;
  const ton = paiements.en_retard ? 'danger' : 'success';
  return (
    <div className={`par-barre esp-tone-${ton}`}>
      <div className="par-barre-tete">
        <span>Scolarité payée</span>
        <span className="par-barre-chiffre">{formatMontant(paiements.total_verse)} / {formatMontant(paiements.total_attendu)}</span>
      </div>
      <div className="esp-barre" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Scolarité payée à ${pct} %`}>
        <span style={{ width: `${pct}%`, background: 'var(--esp-ton)' }} />
      </div>
    </div>
  );
}

export function ProchaineEcheance({ paiements }) {
  if (paiements?.en_retard) {
    return <div className="par-ligne-info text-danger"><i className="bx bx-error-circle" />Reste à payer en retard : <strong>{formatMontant(paiements.impaye_exigible)}</strong></div>;
  }
  const p = paiements?.prochaine_echeance;
  if (!p) return null;
  return <div className="par-ligne-info"><i className="bx bx-calendar" />Prochaine échéance : {p.libelle}, {formatMontant(p.reste_du)} avant le {formatDate(p.date_limite)}</div>;
}

export function EtatEspace({ espace }) {
  if (espace.error && !espace.data) {
    return <div className="alert alert-warning"><i className="bx bx-error me-2" />{espace.error.message}</div>;
  }
  return null;
}

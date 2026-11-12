import { useSearchParams } from 'react-router-dom';
import { useMonEspace } from '../components/Espace';

// Espace parent : données de la famille (GET /api/parent/mon-espace) et
// statuts affichés (cf. server/services/espace_parent_services.py).

export const useEspaceParent = () => useMonEspace('/parent');

export const prenomNom = (eleve) => `${eleve?.prenom || ''} ${eleve?.nom || ''}`.trim();

// Statut global des frais d'un enfant.
export function statutPaiement(paiements) {
  if (!paiements?.a_echeancier) return { ton: 'secondary', libelle: "Pas d'échéancier", icon: 'bx-minus-circle' };
  if (paiements.en_retard) return { ton: 'danger', libelle: 'En retard', icon: 'bx-error-circle' };
  if (paiements.reste_annuel <= 0) return { ton: 'success', libelle: 'Soldé', icon: 'bx-check-circle' };
  return { ton: 'success', libelle: 'À jour', icon: 'bx-check-circle' };
}

// Date du jour (heure locale) au format AAAA-MM-JJ des dates de l'API.
function aujourdhuiIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Statut d'une tranche de l'échéancier.
export function statutTranche(t) {
  if (t.reste_du <= 0) return { ton: 'success', libelle: 'Payée' };
  if (t.en_retard) return { ton: 'danger', libelle: 'En retard' };
  if (t.date_limite === aujourdhuiIso()) return { ton: 'warning', libelle: "Dernier jour aujourd'hui" };
  return { ton: 'secondary', libelle: 'À venir' };
}

// Enfant affiché (?enfant=<id> dans l'URL), par défaut le premier.
export function useEnfantChoisi(enfants) {
  const [params, setParams] = useSearchParams();
  const voulu = params.get('enfant');
  const enfant = enfants.find((e) => String(e.eleve.id) === voulu) || enfants[0] || null;
  const choisir = (id) => setParams((p) => { p.set('enfant', id); return p; }, { replace: true });
  return [enfant, choisir];
}

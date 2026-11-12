// Trésorerie : libellés et période par défaut, partagés par la page, les
// impressions et le préchargement hors connexion (lib/offline.js).

export const SENS = {
  ENTREE: { label: 'Entrée', pluriel: 'Entrées', icon: 'bx-down-arrow-circle', color: 'success', titre: 'Nouvelle entrée' },
  SORTIE: { label: 'Dépense', pluriel: 'Dépenses', icon: 'bx-up-arrow-circle', color: 'danger', titre: 'Nouvelle dépense' },
  TRANSFERT: { label: 'Transfert', pluriel: 'Transferts', icon: 'bx-transfer-alt', color: 'info', titre: 'Transfert entre comptes' },
};
export const TYPES_COMPTE = { CAISSE: 'Caisse (espèces)', BANQUE: 'Banque', MOBILE_MONEY: 'Mobile Money' };

const pad = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Période par défaut : du 1er septembre de l'année scolaire en cours à
// aujourd'hui (même règle que le serveur, tresorerie_services._periode).
export function periodeParDefaut() {
  const d = new Date();
  const annee = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return { du: `${annee}-09-01`, au: isoLocal(d) };
}

// Requête d'un état : sans paramètres pour la période par défaut (le serveur
// la calcule) — la copie locale garde ainsi la même clé d'un jour à l'autre
// et reste disponible hors connexion.
export function urlEtat(etat, periode) {
  const defaut = periodeParDefaut();
  if (periode.du === defaut.du && periode.au === defaut.au) return `/tresorerie/${etat}`;
  return `/tresorerie/${etat}?du=${periode.du}&au=${periode.au}`;
}

// Copiées sur l'appareil à chaque connexion (Comptable, Admin) : la page
// s'ouvre hors connexion sur la période par défaut.
export const URLS_TRESORERIE = [
  '/tresorerie/categories', '/tresorerie/comptes', '/tresorerie/categories?type=ENTREE',
  '/tresorerie/synthese', '/tresorerie/journal',
];

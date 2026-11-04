// Présentation des rôles (écran « Choisir un espace ») et rubriques de
// l'accueil des espaces Enseignant / Censeur / Surveillant. Les routes
// correspondent à PAGES dans App.jsx.

export const ROLES_INFO = {
  Admin: { label: 'Administration', icon: 'bx-shield-quarter', color: 'primary', description: "Gérez l'établissement : élèves, enseignants, classes et configuration." },
  Proviseur: { label: 'Proviseur', icon: 'bx-crown', color: 'primary', description: "Vue d'ensemble de l'établissement." },
  Censeur: { label: 'Censeur', icon: 'bx-briefcase-alt-2', color: 'info', description: 'Suivez les notes, la discipline et les bulletins de vos classes.' },
  Surveillant: { label: 'Surveillant', icon: 'bx-shield-alt-2', color: 'warning', description: 'Tenez à jour la discipline et suivez vos classes.' },
  Enseignant: { label: 'Enseignant', icon: 'bx-chalkboard', color: 'success', description: 'Saisissez vos notes, consultez vos classes et votre emploi du temps.' },
  Comptable: { label: 'Comptabilité', icon: 'bx-wallet', color: 'danger', description: 'Encaissez et suivez les paiements de scolarité.' },
  Secretaire: { label: 'Secrétariat', icon: 'bx-folder-open', color: 'secondary', description: 'Gestion administrative des dossiers.' },
  Infirmier: { label: 'Infirmerie', icon: 'bx-plus-medical', color: 'danger', description: 'Suivi de santé des élèves.' },
  Parent: { label: 'Parent', icon: 'bx-group', color: 'secondary', description: 'Suivez la scolarité de vos enfants.' },
};

// Rôles prévus mais sans aucun espace dans l'application pour l'instant :
// non proposés à l'attribution (un compte n'aurait accès à rien).
export const ROLES_SANS_ESPACE = ['Proviseur', 'Infirmier', 'Parent'];

export const roleInfo = (libelle) => ROLES_INFO[libelle] || { label: libelle, icon: 'bx-user', color: 'secondary', description: '' };

const RUBRIQUES_CENSEUR = [
  { to: '/notes', label: 'Notes & discipline', icon: 'bx-spreadsheet', color: 'primary', description: 'Notes de vos classes et suivi disciplinaire' },
  { to: '/bulletins', label: 'Bulletins', icon: 'bx-file', color: 'success', description: 'Bulletins par séquence ou trimestre' },
  { to: '/emploi-du-temps', label: 'Emploi du temps', icon: 'bx-calendar', color: 'warning', description: 'Grilles horaires de vos classes' },
  { to: '/pedagogie', label: 'Pédagogie', icon: 'bx-git-branch', color: 'info', description: 'Matières et enseignants par classe' },
];

export const RUBRIQUES = {
  Enseignant: [
    { to: '/enseignant/notes', label: 'Saisie des notes', icon: 'bx-edit', color: 'primary', description: 'Vos notes, classe par classe' },
    { to: '/enseignant/classes', label: 'Mes classes', icon: 'bx-group', color: 'success', description: 'Listes des élèves de vos classes' },
    { to: '/enseignant/emploi-du-temps', label: 'Emploi du temps', icon: 'bx-calendar', color: 'warning', description: 'Vos cours de la semaine' },
  ],
  Censeur: RUBRIQUES_CENSEUR,
  Surveillant: RUBRIQUES_CENSEUR,
};

// Libellés courts de la barre de navigation basse (mobile).
export const NAV_COURTE = {
  '/': 'Accueil',
  '/etablissements': 'Écoles',
  '/matieres': 'Matières',
  '/enseignants': 'Profs',
  '/eleves': 'Élèves',
  '/parents': 'Parents',
  '/inscriptions': 'Inscriptions',
  '/paiements': 'Paiements',
  '/configuration': 'Réglages',
  '/enseignant/notes': 'Notes',
  '/enseignant/classes': 'Classes',
  '/enseignant/emploi-du-temps': 'Horaires',
  '/notes': 'Notes',
  '/bulletins': 'Bulletins',
  '/emploi-du-temps': 'Horaires',
  '/pedagogie': 'Pédagogie',
};

// Onglets de la barre de navigation basse, par rôle (4 au plus : le 5e est
// toujours « Menu », qui donne accès à tout le reste). Un rôle absent prend
// les premières entrées de son menu.
export const NAV_MOBILE = {
  SuperAdmin: ['/', '/etablissements', '/eleves', '/paiements'],
  Admin: ['/', '/eleves', '/inscriptions', '/paiements'],
  Censeur: ['/', '/notes', '/bulletins', '/emploi-du-temps'],
  Surveillant: ['/', '/notes', '/bulletins', '/emploi-du-temps'],
  Enseignant: ['/', '/enseignant/notes', '/enseignant/classes', '/enseignant/emploi-du-temps'],
  Comptable: ['/paiements'],
  Secretaire: ['/inscriptions', '/eleves', '/parents'],
};

const DERNIER_ROLE_KEY = 'dernierEspace';

export function lireDernierRole() {
  try {
    return localStorage.getItem(DERNIER_ROLE_KEY);
  } catch {
    return null;
  }
}

export function memoriserDernierRole(role) {
  try {
    localStorage.setItem(DERNIER_ROLE_KEY, role);
  } catch {
    // Stockage indisponible (navigation privée…) : simple confort perdu.
  }
}

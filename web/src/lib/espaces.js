// Présentation des rôles (écran « Choisir un espace ») et rubriques de
// l'accueil des espaces Enseignant / Censeur / Surveillant. Les routes
// correspondent à PAGES dans App.jsx.

export const ROLES_INFO = {
  Admin: { label: 'Administration', icon: 'bx-shield-quarter', color: 'primary', description: "Gérez l'établissement : élèves, enseignants, classes et configuration." },
  Proviseur: { label: 'Proviseur', icon: 'bx-crown', color: 'primary', description: "Vue d'ensemble de l'établissement." },
  Censeur: { label: 'Censeur', icon: 'bx-briefcase-alt-2', color: 'info', description: 'Suivez les notes, la discipline et les bulletins de vos classes.' },
  Surveillant: { label: 'Surveillant', icon: 'bx-shield-alt-2', color: 'warning', description: 'Tenez à jour la discipline et suivez vos classes.' },
  Enseignant: { label: 'Enseignant', icon: 'bx-chalkboard', color: 'success', description: 'Saisissez vos notes, déposez vos épreuves, consultez vos classes et votre emploi du temps.' },
  Comptable: { label: 'Comptabilité', icon: 'bx-wallet', color: 'danger', description: 'Encaissez les paiements de scolarité et tenez la trésorerie.' },
  Secretaire: { label: 'Secrétariat', icon: 'bx-folder-open', color: 'secondary', description: 'Gestion administrative des dossiers.' },
  Infirmier: { label: 'Infirmerie', icon: 'bx-plus-medical', color: 'danger', description: 'Suivi de santé des élèves.' },
  Parent: { label: 'Parent', icon: 'bx-group', color: 'secondary', description: 'Suivez la scolarité de vos enfants.' },
};

// Rôles non proposés dans le formulaire des comptes du personnel :
// Proviseur et Infirmier n'ont pas encore d'espace (un compte n'aurait accès
// à rien) ; Parent s'attribue depuis la page Parents (« Accès à l'espace
// parent »), qui relie le compte à la fiche de la famille.
export const ROLES_NON_ATTRIBUABLES = ['Proviseur', 'Infirmier', 'Parent'];

export const roleInfo = (libelle) => ROLES_INFO[libelle] || { label: libelle, icon: 'bx-user', color: 'secondary', description: '' };

const RUBRIQUES_CENSEUR = [
  { to: '/notes', label: 'Notes & discipline', icon: 'bx-spreadsheet', color: 'primary', description: 'Notes de vos classes et suivi disciplinaire' },
  { to: '/bulletins', label: 'Bulletins', icon: 'bx-file', color: 'success', description: 'Bulletins par séquence ou trimestre' },
  { to: '/proces-verbal', label: 'Procès-verbal', icon: 'bx-table', color: 'info', description: 'PV des évaluations de vos classes' },
  { to: '/emploi-du-temps', label: 'Emploi du temps', icon: 'bx-calendar', color: 'warning', description: 'Grilles horaires de vos classes' },
  { to: '/pedagogie', label: 'Pédagogie', icon: 'bx-git-branch', color: 'info', description: 'Matières et enseignants par classe' },
  { to: '/listes-classes', label: 'Listes de classe', icon: 'bx-list-ul', color: 'secondary', description: 'Imprimer ou télécharger la liste des élèves' },
];

// Rubriques supplémentaires de l'enseignant titulaire (professeur
// principal), pour les classes dont il a la charge.
export const RUBRIQUES_TITULAIRE = [
  { to: '/notes', label: 'Ma classe : notes & discipline', icon: 'bx-spreadsheet', color: 'primary', description: 'Toutes les notes de votre classe et son suivi disciplinaire' },
  { to: '/bulletins', label: 'Bulletins de ma classe', icon: 'bx-file', color: 'success', description: 'Bulletins par séquence, trimestre ou année' },
  { to: '/proces-verbal', label: 'Procès-verbal', icon: 'bx-table', color: 'info', description: 'PV des évaluations de votre classe' },
  { to: '/emploi-du-temps', label: 'Emploi du temps de ma classe', icon: 'bx-calendar-check', color: 'warning', description: 'Grille horaire de votre classe' },
];

export const RUBRIQUES = {
  Enseignant: [
    { to: '/enseignant/notes', label: 'Saisie des notes', icon: 'bx-edit', color: 'primary', description: 'Vos notes, classe par classe' },
    { to: '/enseignant/classes', label: 'Mes classes', icon: 'bx-group', color: 'success', description: 'Listes des élèves de vos classes' },
    { to: '/enseignant/epreuves', label: 'Épreuves', icon: 'bx-file', color: 'secondary', description: 'Déposez vos épreuves, classe par classe' },
    { to: '/enseignant/emploi-du-temps', label: 'Emploi du temps', icon: 'bx-calendar', color: 'warning', description: 'Vos cours de la semaine' },
    { to: '/listes-classes', label: 'Listes de classe', icon: 'bx-list-ul', color: 'info', description: 'Imprimer ou télécharger la liste de vos classes' },
  ],
  Censeur: [...RUBRIQUES_CENSEUR, { to: '/conseil-de-classe', label: 'Conseil de classe', icon: 'bx-group', color: 'primary', description: 'Bilan de vos classes : séquence, trimestre, année' }],
  Surveillant: RUBRIQUES_CENSEUR,
};

// Libellés courts de la barre de navigation basse (mobile).
export const NAV_COURTE = {
  '/': 'Accueil',
  '/etablissements': 'Écoles',
  '/etablissement': 'École',
  '/utilisateurs': 'Comptes',
  '/super-admins': 'SuperAdmins',
  '/journal': 'Journal',
  '/matieres': 'Matières',
  '/enseignants': 'Profs',
  '/eleves': 'Élèves',
  '/parents': 'Parents',
  '/inscriptions': 'Inscriptions',
  '/listes-classes': 'Listes',
  '/paiements': 'Paiements',
  '/tresorerie': 'Trésorerie',
  '/configuration': 'Réglages',
  '/enseignant/notes': 'Notes',
  '/enseignant/classes': 'Classes',
  '/enseignant/epreuves': 'Épreuves',
  '/enseignant/emploi-du-temps': 'Horaires',
  '/notes': 'Notes',
  '/bulletins': 'Bulletins',
  '/proces-verbal': 'PV',
  '/conseil-de-classe': 'Conseil',
  '/emploi-du-temps': 'Horaires',
  '/pedagogie': 'Pédagogie',
  '/parent/paiements': 'Paiements',
  '/parent/bulletins': 'Bulletins',
};

// Onglets de la barre de navigation basse, par rôle (4 au plus : le 5e est
// toujours « Menu », qui donne accès à tout le reste). Un rôle absent prend
// les premières entrées de son menu.
export const NAV_MOBILE = {
  SuperAdmin: ['/', '/etablissements', '/utilisateurs', '/etablissement'],
  Admin: ['/', '/eleves', '/inscriptions', '/paiements'],
  Censeur: ['/', '/notes', '/bulletins', '/emploi-du-temps'],
  Surveillant: ['/', '/notes', '/bulletins', '/emploi-du-temps'],
  Enseignant: ['/', '/enseignant/notes', '/enseignant/classes', '/enseignant/epreuves'],
  Comptable: ['/paiements', '/tresorerie'],
  Secretaire: ['/inscriptions', '/eleves', '/parents'],
  Parent: ['/', '/parent/paiements', '/parent/bulletins'],
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

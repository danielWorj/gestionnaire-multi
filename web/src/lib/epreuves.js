import { useEffect, useState } from 'react';
import { api, apiRequest } from './api';

// Épreuves : documents (PDF, Word, images) déposés par les enseignants.
//
// Deux jeux de routes côté serveur (cf. server/api/epreuve_api.py et
// server/api/evaluation_api.py) :
//   - espace « enseignant » : /api/enseignant/epreuves (uniquement les siennes)
//   - espace « admin »      : /api/epreuves/ (Admin et SuperAdmin, tout l'établissement)
//
// Ces requêtes ne sont jamais mises en cache pour le mode hors connexion
// (cf. PREFIXES_EXCLUS dans stockageLocal.js) et un dépôt ne peut pas être
// mis en file d'attente : un fichier ne se rejoue pas comme une note.

export const EPREUVES_PAR_PAGE_ENSEIGNANT = 6;
export const EPREUVES_PAR_PAGE_ADMIN = 25;

// Mêmes bornes que le serveur (services/epreuve_services.py), pour répondre
// tout de suite ; le serveur reste juge (extension ET signature du fichier).
export const EPREUVE_TAILLE_MAX = 15 * 1024 * 1024;
export const EPREUVE_TITRE_MAX = 150;
const EXTENSIONS = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'webp'];
// Les types MIME (et non « image/* ») excluent GIF/SVG tout en laissant le
// téléphone proposer l'appareil photo.
export const EPREUVE_ACCEPT = '.pdf,.doc,.docx,image/jpeg,image/png,image/webp';
export const EPREUVE_FORMATS_AIDE = 'PDF, Word (DOC, DOCX) ou image (JPEG, PNG, WEBP) · 15 Mo maximum';

const ROUTES = {
  enseignant: { liste: '/enseignant/epreuves', element: (id) => `/enseignant/epreuves/${id}` },
  // Route Flask « /api/epreuves/ » : le slash final est conservé par api.js.
  admin: { liste: '/epreuves/', element: (id) => `/epreuves/${id}` },
};

function requete(params) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([cle, valeur]) => {
    if (valeur !== '' && valeur != null) q.set(cle, String(valeur));
  });
  const texte = q.toString();
  return texte ? `?${texte}` : '';
}

// → { items, total, page, pages, per_page }. `enseignantId` n'a d'effet que
// côté admin (le serveur ignore ce paramètre pour un enseignant).
export function listerEpreuves(espace, { page = 1, perPage, classeId = '', matiereId = '', enseignantId = '' }) {
  return api.get(`${ROUTES[espace].liste}${requete({
    page,
    per_page: perPage,
    classe_id: classeId,
    matiere_id: matiereId,
    enseignant_id: espace === 'admin' ? enseignantId : '',
  })}`);
}

// Envoi multipart : api.js laisse le navigateur fixer le Content-Type (avec
// sa frontière) quand le corps est un FormData.
export function deposerEpreuve(espace, { matiereClasseId, titre, fichier }) {
  const body = new FormData();
  body.append('matiere_classe_id', String(matiereClasseId));
  body.append('titre', titre.trim());
  body.append('fichier', fichier);
  return apiRequest(ROUTES[espace].liste, { method: 'POST', body });
}

export const supprimerEpreuve = (espace, id) => api.del(ROUTES[espace].element(id));

// Téléchargement (administration) du fichier d'origine, sous son nom d'origine.
export async function telechargerEpreuve(epreuve) {
  const blob = await api.blob(`/epreuves/${epreuve.id}/fichier`);
  const url = URL.createObjectURL(blob);
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = epreuve.nom_original || `epreuve-${epreuve.id}`;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── Contrôle local du fichier choisi ─────────────────────────────────── */

export const extensionDe = (nom) => (nom || '').split('.').pop().toLowerCase();

// Message d'erreur, ou '' si le fichier peut partir.
export function verifierFichierLocal(fichier) {
  if (!EXTENSIONS.includes(extensionDe(fichier.name)) || !fichier.name.includes('.')) {
    return 'Format non pris en charge (PDF, DOC, DOCX, JPEG, PNG ou WEBP uniquement).';
  }
  if (fichier.size === 0) return 'Le fichier est vide.';
  if (fichier.size > EPREUVE_TAILLE_MAX) {
    return `Fichier trop volumineux (${formaterTaille(fichier.size)}) : 15 Mo maximum.`;
  }
  return '';
}

/* ── Affichage ────────────────────────────────────────────────────────── */

export function formaterTaille(octets) {
  const n = Number(octets) || 0;
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

// Icône Boxicons et teinte (bg-label-*) selon le type du fichier.
export function styleEpreuve(mime) {
  if (mime === 'application/pdf') return { icone: 'bxs-file-pdf', ton: 'danger' };
  if (mime?.startsWith('image/')) return { icone: 'bxs-file-image', ton: 'success' };
  if (mime?.includes('word')) return { icone: 'bxs-file-doc', ton: 'primary' };
  return { icone: 'bxs-file-blank', ton: 'secondary' };
}

/* ── Classes / matières / enseignants à partir des affectations ──────────
   Une « affectation » (MatiereClasse) normalisée :
   { id, classe_id, classe_label, matiere_id, matiere_libelle,
     enseignant_id?, enseignant_nom? }
   Espace enseignant : /enseignant/mon-espace → matieres_classe (déjà de ce
   format). Administration : useAffectationsAdmin ci-dessous. */

const trier = (a, b) => a.localeCompare(b, 'fr', { numeric: true });

export function classesDe(mcs) {
  const map = new Map();
  mcs.forEach((mc) => map.set(mc.classe_id, { id: mc.classe_id, label: mc.classe_label }));
  return [...map.values()].sort((a, b) => trier(a.label, b.label));
}

// Matières, éventuellement limitées à une classe (classeId '' = toutes).
export function matieresDe(mcs, classeId = '') {
  const map = new Map();
  mcs
    .filter((mc) => !classeId || String(mc.classe_id) === String(classeId))
    .forEach((mc) => map.set(mc.matiere_id, { id: mc.matiere_id, libelle: mc.matiere_libelle }));
  return [...map.values()].sort((a, b) => trier(a.libelle, b.libelle));
}

export function enseignantsDe(mcs) {
  const map = new Map();
  mcs.filter((mc) => mc.enseignant_id).forEach((mc) => map.set(mc.enseignant_id, { id: mc.enseignant_id, nom: mc.enseignant_nom }));
  return [...map.values()].sort((a, b) => trier(a.nom, b.nom));
}

// Administration : toutes les affectations de l'établissement, avec libellés.
// `cle` (ex. l'établissement consulté par le SuperAdmin) relance le chargement.
export function useAffectationsAdmin(cle) {
  const [etat, setEtat] = useState({ mcs: [], loading: true, error: '' });

  useEffect(() => {
    let annule = false;
    setEtat({ mcs: [], loading: true, error: '' });
    Promise.all([
      api.get('/matieres-classe/'),
      api.get('/classes/'),
      api.get('/cycles/'),
      api.get('/matieres/'),
      api.get('/enseignants/'),
    ])
      .then(([liens, classes, cycles, matieres, enseignants]) => {
        if (annule) return;
        const cycleLibelle = new Map((cycles || []).map((c) => [c.id, c.libelle]));
        const classeLabel = new Map((classes || []).map((c) => [
          c.id,
          [cycleLibelle.get(c.cycle_id), c.option].filter(Boolean).join(' ') || `Classe #${c.id}`,
        ]));
        const matiereLibelle = new Map((matieres || []).map((m) => [m.id, m.libelle || m.nom]));
        const enseignantNom = new Map((enseignants || []).map((e) => [e.id, `${e.nom || ''} ${e.prenom || ''}`.trim()]));
        const mcs = (liens || [])
          .filter((l) => classeLabel.has(l.classe_id))
          .map((l) => ({
            id: l.id,
            classe_id: l.classe_id,
            classe_label: classeLabel.get(l.classe_id),
            matiere_id: l.matiere_id,
            matiere_libelle: matiereLibelle.get(l.matiere_id) || `Matière #${l.matiere_id}`,
            enseignant_id: l.enseignant_id,
            enseignant_nom: enseignantNom.get(l.enseignant_id) || 'Enseignant',
          }));
        setEtat({ mcs, loading: false, error: '' });
      })
      .catch((e) => {
        if (!annule) setEtat({ mcs: [], loading: false, error: e.message });
      });
    return () => { annule = true; };
  }, [cle]);

  return etat;
}

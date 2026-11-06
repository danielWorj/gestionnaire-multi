import { api, apiRequest, avecEtablissement } from './api';

// Photo d'identité des élèves (fiche élève, en-tête du bulletin).
// Côté serveur : POST/DELETE /api/eleves/<id>/photo (cf.
// server/api/inscription_api.py) ; l'URL de lecture (photo_url) est protégée
// par le cookie JWT, envoyé automatiquement par un <img> de même origine.

// Format portrait type photo d'identité, largement suffisant pour un
// bulletin A4 (la photo y fait ~20 × 25 mm).
const LARGEUR_MAX = 480;
const HAUTEUR_MAX = 600;
const QUALITE_JPEG = 0.85;
// Limite du serveur (PHOTO_TAILLE_MAX) : après redimensionnement on en est
// très loin, elle ne sert qu'en cas de repli sur le fichier d'origine.
export const PHOTO_TAILLE_MAX = 2 * 1024 * 1024;

// URL d'affichage, complétée de ?etablissement_id= pour un SuperAdmin.
export const photoEleveSrc = (eleve) => (eleve?.photo_url ? avecEtablissement(eleve.photo_url) : null);

function chargerImage(fichier) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fichier);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Ce fichier n'est pas une image lisible.")); };
    img.src = url;
  });
}

// Réduit la photo choisie (souvent plusieurs Mo depuis un téléphone) et la
// convertit en JPEG. Lève une erreur lisible si le fichier n'est pas une image.
export async function preparerPhoto(fichier) {
  if (!fichier.type.startsWith('image/')) {
    throw new Error('Choisissez une image (JPEG, PNG ou WEBP).');
  }
  const img = await chargerImage(fichier);
  const echelle = Math.min(1, LARGEUR_MAX / img.naturalWidth, HAUTEUR_MAX / img.naturalHeight);
  const largeur = Math.max(1, Math.round(img.naturalWidth * echelle));
  const hauteur = Math.max(1, Math.round(img.naturalHeight * echelle));
  const canvas = document.createElement('canvas');
  canvas.width = largeur;
  canvas.height = hauteur;
  const ctx = canvas.getContext('2d');
  // Fond blanc : un PNG transparent ne doit pas devenir noir en JPEG.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, largeur, hauteur);
  ctx.drawImage(img, 0, 0, largeur, hauteur);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITE_JPEG));
  if (blob) return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
  // Canvas indisponible : on envoie le fichier tel quel si le serveur l'accepte.
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(fichier.type) || fichier.size > PHOTO_TAILLE_MAX) {
    throw new Error('Photo trop volumineuse ou format non pris en charge (JPEG, PNG ou WEBP, 2 Mo maximum).');
  }
  return fichier;
}

export function envoyerPhotoEleve(eleveId, fichier) {
  const body = new FormData();
  body.append('photo', fichier);
  return apiRequest(`/eleves/${eleveId}/photo`, { method: 'POST', body });
}

export const retirerPhotoEleve = (eleveId) => api.del(`/eleves/${eleveId}/photo`);

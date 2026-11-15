// Liste imprimable des élèves d'UNE classe (page Élèves). Même mécanisme que
// les documents de la page Paiements : le HTML s'ouvre dans une nouvelle
// fenêtre qui lance l'impression, donc aussi « Enregistrer au format PDF »
// depuis le navigateur. Aucune donnée n'est recalculée côté serveur : on
// met en page la sélection déjà chargée par la page.

import { AUTO_PRINT, enteteCommun, escapeHtml, formatDateCourt, STYLES_COMMUNS } from './paiementsImpression';

const nomComplet = (e) => `${(e.nom || '').toUpperCase()} ${e.prenom || ''}`.trim();

const SIGNATURES_LISTE = `
  <div class="signatures">
    <div class="signature-bloc"><div class="signature-ligne">Le Censeur</div></div>
    <div class="signature-bloc"><div class="signature-ligne">Le Chef d'établissement</div></div>
  </div>`;

/**
 * eleves : [{matricule, nom, prenom, sexe, date_naissance, lieu_naissance, statut, parent?: {nom, prenom, telephone}}]
 */
export function construireHtmlListeEleves({ eleves, classeNom, anneeNom, etablissement }) {
  const etab = etablissement || {};
  const garcons = eleves.filter((e) => e.sexe === 'M').length;
  const filles = eleves.filter((e) => e.sexe === 'F').length;
  const edite = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  const rows = eleves.map((e, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(e.matricule || '—')}</td>
      <td class="g">${escapeHtml(nomComplet(e))}${(e.statut || 'Actif') !== 'Actif' ? ` <em>(${escapeHtml(e.statut)})</em>` : ''}</td>
      <td>${escapeHtml(e.sexe || '—')}</td>
      <td>${escapeHtml(formatDateCourt(e.date_naissance))}</td>
      <td class="g">${escapeHtml(e.lieu_naissance || '—')}</td>
      <td class="g">${e.parent ? `${escapeHtml(`${e.parent.nom || ''} ${e.parent.prenom || ''}`.trim())}${e.parent.telephone ? `<br>${escapeHtml(e.parent.telephone)}` : ''}` : '—'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Liste des élèves — ${escapeHtml(classeNom)}</title>
<style>${STYLES_COMMUNS}</style>
</head>
<body>
  <div class="top-row"><span>Édité le ${escapeHtml(edite)}</span><span></span></div>
  ${enteteCommun(etab)}
  <div class="titre-doc"><h2>Liste des élèves</h2></div>
  <div class="sous-titre">Classe : ${escapeHtml(classeNom)} — Année scolaire ${escapeHtml(anneeNom || '')}</div>
  <div class="sous-titre"><strong>Effectif :</strong> ${eleves.length} &nbsp;·&nbsp; <strong>Garçons :</strong> ${garcons} &nbsp;·&nbsp; <strong>Filles :</strong> ${filles}</div>
  <table>
    <thead><tr><th>N°</th><th>Matricule</th><th>Nom et prénoms</th><th>Sexe</th><th>Né(e) le</th><th>Lieu de naissance</th><th>Parent / Téléphone</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">Aucun élève dans cette classe.</td></tr>'}</tbody>
  </table>
  ${SIGNATURES_LISTE}
  ${AUTO_PRINT}
</body>
</html>`;
}

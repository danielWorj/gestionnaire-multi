// Documents imprimables de la page Paiements, repris tels quels de
// server/static/templates/paiements.html : ils s'ouvrent dans une nouvelle
// fenêtre qui lance l'impression (et donc l'export PDF du navigateur).

import { formatMontant } from '../components/ui';

export function escapeHtml(str) {
  return (str == null ? '' : String(str))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatDateCourt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function enteteCommun(etab) {
  const logoHtml = etab.logo_url
    ? `<img src="${escapeHtml(window.location.origin + etab.logo_url)}" alt="Logo" style="max-width:100%; max-height:100%; object-fit:contain;">`
    : '';
  const adresseLigne = [etab.region, etab.bp ? `BP ${etab.bp}` : null, etab.telephone ? `Tél. ${etab.telephone}` : null].filter(Boolean).join(' — ');
  return `
  <div class="entete">
    <div class="logo-box">${logoHtml}</div>
    <div>
      <p class="etab-nom">${escapeHtml(etab.nom || 'Établissement')}</p>
      <div class="etab-adresse">${escapeHtml(adresseLigne)}</div>
    </div>
  </div>`;
}

const dates = () => ({
  longue: new Date().toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  courte: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
});

const SIGNATURES = `
  <div class="signatures">
    <div class="signature-bloc"><div class="signature-ligne">Le Comptable</div></div>
    <div class="signature-bloc"><div class="signature-ligne">Le Chef d'établissement</div></div>
  </div>`;

const AUTO_PRINT = '<script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };<\/script>';

// Liste solvables / insolvables / complète d'une classe.
export function construireHtmlImpression({ titreListe, lignes, etablissement, classeNom, anneeNom }) {
  const etab = etablissement || {};
  const d = dates();
  const nomComplet = (e) => `${e?.nom || ''} ${e?.prenom || ''}`.trim();
  const totalAttendu = lignes.reduce((s, r) => s + Number(r.totalAttendu || 0), 0);
  const totalVerse = lignes.reduce((s, r) => s + Number(r.totalVerse || 0), 0);
  const rowsHtml = lignes.map((r, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(r.eleve.matricule || '—')}</td>
      <td style="text-align:left;">${escapeHtml(nomComplet(r.eleve))}</td>
      <td>${escapeHtml(r.eleve.sexe || '—')}</td>
      <td>${formatMontant(r.totalAttendu)}</td>
      <td>${formatMontant(r.totalVerse)}</td>
      <td style="font-weight:700; color:${r.solde > 0 ? '#c0392b' : '#2e7d32'};">${formatMontant(r.solde)}</td>
      <td style="font-size:10px;">${r.tranchesEnRetard.length ? escapeHtml(r.tranchesEnRetard.join(', ')) : '—'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(titreListe)} — ${escapeHtml(classeNom)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#1f2937; margin:24px 32px; font-size:13px; }
  .top-row { display:flex; justify-content:space-between; font-size:11px; color:#6b7280; margin-bottom:14px; }
  .entete { display:flex; align-items:center; gap:16px; border-bottom:2px solid #1f2937; padding-bottom:14px; margin-bottom:18px; }
  .logo-box { width:64px; height:84px; border:1px solid #cbd5e1; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .etab-nom { font-size:20px; font-weight:800; margin:0; }
  .etab-adresse { font-size:11.5px; color:#6b7280; margin-top:2px; }
  .titre-doc { text-align:center; margin:18px 0 4px; }
  .titre-doc h2 { font-size:17px; font-weight:800; letter-spacing:.03em; margin:0; text-transform:uppercase; }
  .sous-titre { text-align:center; font-size:12px; color:#4b5563; margin-bottom:18px; }
  table { width:100%; border-collapse:collapse; margin-top:10px; }
  th, td { border:1px solid #cbd5e1; padding:6px 8px; text-align:center; font-size:11.5px; }
  th { background:#f1f5f9; font-weight:700; text-transform:uppercase; font-size:10px; letter-spacing:.03em; }
  tbody tr:nth-child(even) { background:#f8fafc; }
  .totaux { display:flex; justify-content:flex-end; gap:26px; margin-top:14px; font-size:12px; }
  .totaux strong { font-size:13px; }
  .signatures { display:flex; justify-content:space-between; margin-top:60px; }
  .signature-bloc { width:220px; text-align:center; font-size:12px; }
  .signature-ligne { border-top:1px solid #1f2937; margin-top:50px; padding-top:4px; }
  @media print { body { margin:14mm 16mm; } .no-print { display:none !important; } }
</style>
</head>
<body>
  <div class="top-row"><span>Imprimé le ${escapeHtml(d.longue)}</span><span>${escapeHtml(titreListe)}</span></div>
  ${enteteCommun(etab)}
  <div class="titre-doc"><h2>${escapeHtml(titreListe)}</h2></div>
  <div class="sous-titre">Classe : ${escapeHtml(classeNom)} — Année scolaire ${escapeHtml(anneeNom)} — Situation au ${escapeHtml(d.courte)}</div>
  <table>
    <thead><tr><th>#</th><th>Matricule</th><th>Nom &amp; prénom</th><th>Sexe</th><th>Attendu</th><th>Versé</th><th>Solde</th><th>Tranche(s) en retard</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="8">Aucun élève</td></tr>'}</tbody>
  </table>
  <div class="totaux">
    <span>Total attendu : <strong>${formatMontant(totalAttendu)}</strong></span>
    <span>Total versé : <strong>${formatMontant(totalVerse)}</strong></span>
    <span>Effectif : <strong>${lignes.length}</strong></span>
  </div>
  ${SIGNATURES}
  ${AUTO_PRINT}
</body>
</html>`;
}

// État de solvabilité de l'établissement (global + par classe + par tranche).
export function construireHtmlRapportSolvabilite({ rapport, etablissement, anneeNom }) {
  const etab = etablissement || {};
  const d = dates();
  const g = rapport.global;
  const syntheseTexte = g.effectif > 0
    ? `Au ${d.courte}, ${escapeHtml(etab.nom || "l'établissement")} comptabilise un effectif total de <strong>${g.effectif} élève(s)</strong> `
      + `actif(s) au titre de l'année scolaire ${escapeHtml(anneeNom)}, répartis sur ${rapport.classes.length} classe(s). `
      + "Le montant global attendu, calculé sur la base de l'échéancier propre à chaque classe rapporté à son effectif, s'élève à "
      + `<strong>${formatMontant(g.totalAttendu)}</strong>. À cette date, un montant de <strong>${formatMontant(g.totalVerse)}</strong> a été `
      + `effectivement recouvré, soit un taux de recouvrement global de <strong>${g.pctPaye.toFixed(2)}%</strong>, laissant un solde restant dû de `
      + `<strong>${formatMontant(g.solde)}</strong>. Sur le plan de la solvabilité, <strong>${g.nbSolvables} élève(s)</strong> (${g.pctSolvable.toFixed(2)}%) `
      + `sont à jour ou dans les délais de leur échéancier, tandis que <strong>${g.nbInsolvables} élève(s)</strong> (${g.pctInsolvable.toFixed(2)}%) n'ont effectué `
      + 'aucun versement, ou présentent au moins une tranche impayée dont la date limite est dépassée, et sont à ce titre considérés comme insolvables.'
      + (g.nbSansEcheancier > 0
        ? ` Enfin, <strong>${g.nbSansEcheancier} élève(s)</strong> appartiennent à des classes sans échéancier défini pour cette année : leur solvabilité ne peut être établie.`
        : '')
    : `Aucune donnée d'inscription active n'a été trouvée pour l'année scolaire ${escapeHtml(anneeNom)} : l'état de solvabilité ne peut être établi.`;

  const couleur = (v) => (v > 0 ? '#c0392b' : '#2e7d32');
  const classesRowsHtml = rapport.classes.map((c) => `
    <tr>
      <td style="text-align:left; font-weight:700;">${escapeHtml(c.nom)}</td>
      <td>${c.effectif}</td>
      <td>${formatMontant(c.totalAttendu)}</td>
      <td>${formatMontant(c.totalVerse)}</td>
      <td style="font-weight:700; color:${couleur(c.solde)};">${formatMontant(c.solde)}</td>
      <td>${c.pctPaye.toFixed(2)}%</td>
      <td>${c.nbSansEcheancier ? '—' : c.nbSolvables}</td>
      <td>${c.nbSansEcheancier ? '—' : c.nbInsolvables}</td>
      <td style="font-weight:700; color:${couleur(c.pctInsolvable)};">${c.pctInsolvable.toFixed(2)}%</td>
    </tr>`).join('');

  const detailClassesHtml = rapport.classes.map((c) => `
    <div class="classe-bloc">
      <div class="classe-entete">
        <span class="classe-titre">${escapeHtml(c.nom)}</span>
        <span class="classe-sous">Effectif : ${c.effectif} · Attendu : ${formatMontant(c.totalAttendu)} · Versé : ${formatMontant(c.totalVerse)} · Solde : ${formatMontant(c.solde)}</span>
      </div>
      <table class="table-tranches">
        <thead><tr><th>Tranche</th><th>Échéance</th><th>Attendu (classe)</th><th>Versé (classe)</th><th>% payé</th><th>% non payé</th></tr></thead>
        <tbody>
          ${c.tranches.length ? c.tranches.map((t) => `
          <tr>
            <td style="text-align:left;">${escapeHtml(t.libelle)}</td>
            <td>${formatDateCourt(t.dateLimite)}</td>
            <td>${formatMontant(t.attenduTotal)}</td>
            <td>${formatMontant(t.verseTotal)}</td>
            <td>${t.pct.toFixed(2)}%</td>
            <td style="font-weight:700; color:${couleur(100 - t.pct)};">${(100 - t.pct).toFixed(2)}%</td>
          </tr>`).join('') : '<tr><td colspan="6">Aucune tranche définie pour cette classe.</td></tr>'}
        </tbody>
      </table>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>État de solvabilité — ${escapeHtml(etab.nom || 'Établissement')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color:#1f2937; margin:24px 32px; font-size:13px; line-height:1.5; }
  .top-row { display:flex; justify-content:space-between; font-size:11px; color:#6b7280; margin-bottom:14px; font-family: Arial, Helvetica, sans-serif; }
  .entete { display:flex; align-items:center; gap:16px; border-bottom:3px double #1f2937; padding-bottom:14px; margin-bottom:18px; }
  .logo-box { width:70px; height:90px; border:1px solid #cbd5e1; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .etab-nom { font-size:21px; font-weight:800; margin:0; font-family: Arial, Helvetica, sans-serif; letter-spacing:.01em; }
  .etab-adresse { font-size:11.5px; color:#6b7280; margin-top:2px; font-family: Arial, Helvetica, sans-serif; }
  .titre-doc { text-align:center; margin:20px 0 4px; }
  .titre-doc h2 { font-size:19px; font-weight:800; letter-spacing:.04em; margin:0; text-transform:uppercase; font-family: Arial, Helvetica, sans-serif; }
  .sous-titre { text-align:center; font-size:12px; color:#4b5563; margin-bottom:20px; font-family: Arial, Helvetica, sans-serif; }
  .synthese { background:#f8fafc; border:1px solid #e2e8f0; border-left:4px solid #1f2937; border-radius:4px; padding:14px 18px; margin-bottom:24px; text-align:justify; font-size:12.5px; }
  .kpi-row { display:flex; justify-content:space-between; gap:10px; margin-bottom:22px; font-family: Arial, Helvetica, sans-serif; }
  .kpi-box { flex:1; border:1px solid #cbd5e1; border-radius:6px; padding:10px 12px; text-align:center; }
  .kpi-box .kpi-label { font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:#6b7280; font-weight:700; }
  .kpi-box .kpi-val { font-size:15px; font-weight:800; margin-top:4px; }
  h3.section-titre { font-size:13.5px; text-transform:uppercase; letter-spacing:.03em; border-bottom:1px solid #cbd5e1; padding-bottom:6px; margin:26px 0 12px; font-family: Arial, Helvetica, sans-serif; }
  table { width:100%; border-collapse:collapse; font-family: Arial, Helvetica, sans-serif; }
  th, td { border:1px solid #cbd5e1; padding:6px 8px; text-align:center; font-size:11px; }
  th { background:#1f2937; color:#fff; font-weight:700; text-transform:uppercase; font-size:9.5px; letter-spacing:.03em; }
  tbody tr:nth-child(even) { background:#f8fafc; }
  .classe-bloc { margin-bottom:18px; page-break-inside: avoid; }
  .classe-entete { display:flex; justify-content:space-between; align-items:baseline; background:#eef2f7; padding:7px 10px; border-radius:4px 4px 0 0; font-family: Arial, Helvetica, sans-serif; }
  .classe-titre { font-weight:800; font-size:12.5px; }
  .classe-sous { font-size:10.5px; color:#4b5563; }
  .table-tranches th { background:#e2e8f0; color:#1f2937; }
  .signatures { display:flex; justify-content:space-between; margin-top:50px; font-family: Arial, Helvetica, sans-serif; }
  .signature-bloc { width:220px; text-align:center; font-size:12px; }
  .signature-ligne { border-top:1px solid #1f2937; margin-top:50px; padding-top:4px; }
  .pied-page { margin-top:30px; font-size:9.5px; color:#9ca3af; text-align:center; font-family: Arial, Helvetica, sans-serif; }
  @media print { body { margin:14mm 16mm; } .no-print { display:none !important; } .classe-bloc { page-break-inside: avoid; } }
</style>
</head>
<body>
  <div class="top-row"><span>Imprimé le ${escapeHtml(d.longue)}</span><span>État de solvabilité — Confidentiel</span></div>
  ${enteteCommun(etab)}
  <div class="titre-doc"><h2>État de solvabilité de l'établissement</h2></div>
  <div class="sous-titre">Année scolaire ${escapeHtml(anneeNom)} — Situation arrêtée au ${escapeHtml(d.courte)}</div>
  <div class="synthese">${syntheseTexte}</div>
  <h3 class="section-titre">1. Situation globale de l'établissement</h3>
  <div class="kpi-row">
    <div class="kpi-box"><div class="kpi-label">Effectif</div><div class="kpi-val">${g.effectif}</div></div>
    <div class="kpi-box"><div class="kpi-label">Montant attendu</div><div class="kpi-val">${formatMontant(g.totalAttendu)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Montant versé</div><div class="kpi-val">${formatMontant(g.totalVerse)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Solde restant</div><div class="kpi-val" style="color:${couleur(g.solde)};">${formatMontant(g.solde)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Taux de recouvrement</div><div class="kpi-val">${g.pctPaye.toFixed(2)}%</div></div>
    <div class="kpi-box"><div class="kpi-label">Taux d'insolvabilité</div><div class="kpi-val" style="color:${couleur(g.pctInsolvable)};">${g.pctInsolvable.toFixed(2)}%</div></div>
  </div>
  <h3 class="section-titre">2. État des paiements par classe</h3>
  <table>
    <thead><tr><th>Classe</th><th>Effectif</th><th>Attendu</th><th>Versé</th><th>Solde</th><th>% payé</th><th>Solvables</th><th>Insolvables</th><th>% insolvabilité</th></tr></thead>
    <tbody>${classesRowsHtml || '<tr><td colspan="9">Aucune classe avec élève(s) actif(s) pour cette année.</td></tr>'}</tbody>
  </table>
  <h3 class="section-titre">3. Détail du pourcentage payé par tranche, classe par classe</h3>
  ${detailClassesHtml || '<p>Aucune donnée disponible.</p>'}
  ${SIGNATURES}
  <div class="pied-page">Document généré automatiquement — les montants attendus intègrent l'effectif réel de chaque classe pour l'année scolaire ${escapeHtml(anneeNom)}.</div>
  ${AUTO_PRINT}
</body>
</html>`;
}

// Ouvre le document dans une nouvelle fenêtre ; false si les pop-ups sont bloqués.
export function ouvrirImpression(html) {
  const fenetre = window.open('', '_blank');
  if (!fenetre) return false;
  fenetre.document.open();
  fenetre.document.write(html);
  fenetre.document.close();
  return true;
}

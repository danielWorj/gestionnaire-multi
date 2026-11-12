// Documents imprimables de la page Paiements : ils s'ouvrent dans une
// nouvelle fenêtre qui lance l'impression (et donc l'export PDF du
// navigateur). Les chiffres viennent TOUS du serveur
// (GET /paiements/solvabilite, cf. server/services/solvabilite_services.py) :
// aucun calcul financier n'est refait ici, seulement de la mise en page.

import { formatMontant } from '../components/ui';

export function escapeHtml(str) {
  return (str == null ? '' : String(str))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const pad = (n) => String(n).padStart(2, '0');

// Date locale 'AAAA-MM-JJ' (new Date().toISOString() donnerait la date UTC).
export function aujourdhuiIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 'AAAA-MM-JJ' est lu comme une date LOCALE (new Date('AAAA-MM-JJ') serait
// minuit UTC, soit la veille dans un fuseau négatif).
function lireDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
}

export function formatDateCourt(iso) {
  if (!iso) return '—';
  const d = lireDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateLongue(iso) {
  if (!iso) return '—';
  const d = lireDate(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatDateHeure(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// null = non applicable (dénominateur nul), à ne jamais afficher « 0 % ».
export function formatPct(v) {
  if (v == null) return '—';
  return `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

const MODES = { ESPECES: 'Espèces', MOBILE_MONEY: 'Mobile Money', VIREMENT: 'Virement bancaire', CHEQUE: 'Chèque' };
const STATUTS_PAIEMENT = { ANNULE: 'Annulé', REJETE: 'Rejeté', REMBOURSE: 'Remboursé' };
const ROUGE = '#c0392b';
const VERT = '#2e7d32';
const GRIS = '#6b7280';

const nomComplet = (s) => `${s?.nom || ''} ${s?.prenom || ''}`.trim();
const tranchesEnRetard = (s) => (s.tranches_en_retard || []).map((t) => t.libelle).join(', ');

export function enteteCommun(etab) {
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

export const SIGNATURES = `
  <div class="signatures">
    <div class="signature-bloc"><div class="signature-ligne">Le Comptable</div></div>
    <div class="signature-bloc"><div class="signature-ligne">Le Chef d'établissement</div></div>
  </div>`;

export const AUTO_PRINT = '<script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };<\/script>';

export const STYLES_COMMUNS = `
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#1f2937; margin:24px 32px; font-size:12.5px; line-height:1.45; }
  .top-row { display:flex; justify-content:space-between; gap:12px; font-size:10.5px; color:${GRIS}; margin-bottom:14px; }
  .entete { display:flex; align-items:center; gap:16px; border-bottom:3px double #1f2937; padding-bottom:14px; margin-bottom:18px; }
  .logo-box { width:66px; height:86px; border:1px solid #cbd5e1; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .etab-nom { font-size:20px; font-weight:800; margin:0; }
  .etab-adresse { font-size:11px; color:${GRIS}; margin-top:2px; }
  .titre-doc { text-align:center; margin:18px 0 4px; }
  .titre-doc h2 { font-size:17px; font-weight:800; letter-spacing:.04em; margin:0; text-transform:uppercase; }
  .sous-titre { text-align:center; font-size:12px; color:#4b5563; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th, td { border:1px solid #cbd5e1; padding:5px 7px; text-align:center; font-size:10.5px; }
  th { background:#1f2937; color:#fff; font-weight:700; text-transform:uppercase; font-size:9px; letter-spacing:.03em; }
  tbody tr:nth-child(even) { background:#f8fafc; }
  tr.total td { font-weight:800; background:#eef2f7; }
  td.g { text-align:left; }
  td.num, th.num { text-align:right; white-space:nowrap; }
  .alerte { border:1px solid #f59e0b; background:#fffbeb; color:#92400e; padding:8px 12px; border-radius:4px; margin-bottom:14px; font-size:11.5px; }
  .signatures { display:flex; justify-content:space-between; margin-top:50px; page-break-inside:avoid; }
  .signature-bloc { width:220px; text-align:center; font-size:12px; }
  .signature-ligne { border-top:1px solid #1f2937; margin-top:50px; padding-top:4px; }
  .pied-page { margin-top:26px; font-size:9px; color:#9ca3af; text-align:center; }
  @page { size: A4; margin: 14mm 14mm 16mm; @bottom-right { content: "Page " counter(page) " / " counter(pages); font-size: 9px; color: #9ca3af; } }
  @media print { body { margin:0; } .no-print { display:none !important; } }
`;

function bandeauDate(rapport) {
  if (rapport.est_date_du_jour) return '';
  return `<div class="alerte"><strong>Situation reconstituée au ${escapeHtml(formatDateLongue(rapport.date_arrete))}</strong> :
    échéances, versements et annulations sont pris tels qu'ils étaient à cette date (un paiement annulé depuis y figure encore).
    Le statut des inscriptions (en cours / sorti) est celui connu à la date d'édition.</div>`;
}

/* ────────────────────────────────────────────────────────────────────────
   Liste solvables / insolvables / complète d'une classe
   ──────────────────────────────────────────────────────────────────────── */
export function construireHtmlImpression({ titreListe, lignes, rapport, etablissement, classeNom }) {
  const etab = etablissement || {};
  const avecContact = lignes.some((r) => r.solvabilite === 'INSOLVABLE');
  const somme = (champ) => lignes.reduce((s, r) => s + Number(r[champ] || 0), 0);
  const rowsHtml = lignes.map((r, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(r.matricule || '—')}</td>
      <td class="g">${escapeHtml(nomComplet(r))}${r.statut_inscription === 'Suspendu' ? ' <em>(suspendu)</em>' : ''}</td>
      <td>${escapeHtml(r.sexe || '—')}</td>
      <td class="num">${formatMontant(r.attendu)}</td>
      <td class="num">${formatMontant(r.exigible)}</td>
      <td class="num">${formatMontant(r.verse)}</td>
      <td class="num" style="font-weight:700; color:${r.impaye_exigible > 0 ? ROUGE : VERT};">${formatMontant(r.impaye_exigible)}</td>
      <td>${r.jours_retard ? `${r.jours_retard} j` : '—'}</td>
      <td style="font-size:9.5px;">${escapeHtml(tranchesEnRetard(r) || '—')}</td>
      ${avecContact ? `<td style="font-size:9.5px;">${r.parent ? `${escapeHtml(r.parent.nom)}<br>${escapeHtml(r.parent.telephone || '')}` : '—'}</td>` : ''}
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(titreListe)} — ${escapeHtml(classeNom)}</title>
<style>${STYLES_COMMUNS}</style>
</head>
<body>
  <div class="top-row"><span>Édité le ${escapeHtml(formatDateHeure(rapport.genere_le))}</span><span>Réf. ${escapeHtml(rapport.reference)}</span></div>
  ${enteteCommun(etab)}
  <div class="titre-doc"><h2>${escapeHtml(titreListe)}</h2></div>
  <div class="sous-titre">Classe : ${escapeHtml(classeNom)} — Année scolaire ${escapeHtml(rapport.annee_scolaire?.libelle || '')} — Situation au ${escapeHtml(formatDateLongue(rapport.date_arrete))}</div>
  ${bandeauDate(rapport)}
  <table>
    <thead><tr><th>#</th><th>Matricule</th><th>Nom &amp; prénom</th><th>Sexe</th><th class="num">Attendu (année)</th><th class="num">Exigible</th><th class="num">Versé</th><th class="num">Impayé exigible</th><th>Retard</th><th>Tranche(s) en retard</th>${avecContact ? '<th>Parent</th>' : ''}</tr></thead>
    <tbody>
      ${rowsHtml || `<tr><td colspan="${avecContact ? 11 : 10}">Aucun élève</td></tr>`}
      <tr class="total"><td colspan="4" class="g">Total — ${lignes.length} élève(s)</td><td class="num">${formatMontant(somme('attendu'))}</td><td class="num">${formatMontant(somme('exigible'))}</td><td class="num">${formatMontant(somme('verse'))}</td><td class="num">${formatMontant(somme('impaye_exigible'))}</td><td colspan="${avecContact ? 3 : 2}"></td></tr>
    </tbody>
  </table>
  <p style="font-size:10px; color:${GRIS}; margin-top:10px;">Exigible : tranches dont la date limite est passée (ou dues dès l'inscription). Impayé exigible : part de l'exigible non réglée — c'est elle qui rend un élève insolvable.</p>
  ${SIGNATURES}
  ${AUTO_PRINT}
</body>
</html>`;
}

/* ────────────────────────────────────────────────────────────────────────
   État de solvabilité de l'établissement
   ──────────────────────────────────────────────────────────────────────── */
function synthese(rapport, etab) {
  const g = rapport.global;
  const nomEtab = escapeHtml(etab.nom || "l'établissement");
  const date = escapeHtml(formatDateLongue(rapport.date_arrete));
  if (!g.effectif) {
    return `Aucun élève inscrit en cours n'a été trouvé au ${date} pour l'année scolaire ${escapeHtml(rapport.annee_scolaire?.libelle || '')} : l'état de solvabilité ne peut être établi.`;
  }
  const parts = [
    `Au ${date}, ${nomEtab} compte <strong>${g.effectif} élève(s)</strong> inscrit(s) en cours`
      + `${g.suspendus ? ` (dont ${g.suspendus} suspendu(s), qui restent redevables)` : ''}, répartis sur ${g.nb_classes} classe(s).`,
    `Sur un montant annuel attendu de <strong>${formatMontant(g.attendu)}</strong>, <strong>${formatMontant(g.exigible)}</strong> sont exigibles à cette date `
      + `(tranches échues ou dues dès l'inscription). Les familles en ont réglé <strong>${formatMontant(g.verse_sur_exigible)}</strong>, `
      + `soit un taux de recouvrement de l'exigible de <strong>${formatPct(g.taux_recouvrement_exigible)}</strong>, `
      + `laissant un <strong>impayé exigible de ${formatMontant(g.impaye_exigible)}</strong>.`,
  ];
  if (g.avance > 0) parts.push(`Par ailleurs, ${formatMontant(g.avance)} ont été versés par anticipation sur des tranches non encore échues.`);
  if (g.effectif_evaluable) {
    parts.push(`Parmi les ${g.effectif_evaluable} élève(s) dont la classe dispose d'un échéancier, <strong>${g.solvables}</strong> (${formatPct(g.pct_solvables)}) `
      + `sont solvables — tout ce qui est exigible est réglé — et <strong>${g.insolvables}</strong> (${formatPct(g.pct_insolvables)}) sont insolvables, `
      + 'avec au moins une tranche exigible impayée.');
  }
  if (g.sans_echeancier) parts.push(`<strong>${g.sans_echeancier} élève(s)</strong> appartiennent à des classes sans échéancier : leur solvabilité ne peut être établie et ils sont exclus des taux.`);
  const vieux = rapport.anciennete.find((b) => b.code === 'plus_90');
  if (vieux?.montant > 0) parts.push(`${formatMontant(vieux.montant)} d'impayés ont plus de 90 jours de retard.`);
  if (rapport.creances_sortis.nb) parts.push(`S'y ajoutent ${formatMontant(rapport.creances_sortis.montant)} de créances sur ${rapport.creances_sortis.nb} élève(s) sorti(s) (radiés ou transférés), présentées à part.`);
  return parts.join(' ');
}

const kpi = (label, valeur, couleur, sous) => `<div class="kpi-box"><div class="kpi-label">${label}</div><div class="kpi-val"${couleur ? ` style="color:${couleur};"` : ''}>${valeur}</div>${sous ? `<div class="kpi-sous">${sous}</div>` : ''}</div>`;

export function construireHtmlRapportSolvabilite({ rapport, etablissement, anneeNom, options = {} }) {
  const { nominatif = true, detailTranches = true } = options;
  const etab = etablissement || {};
  const g = rapport.global;
  const m = rapport.mouvements;
  const rougeSi = (v) => (v > 0 ? ROUGE : VERT);
  let section = 0;
  const titre = (t) => `<h3 class="section-titre">${++section}. ${t}</h3>`;

  // ── Classes ──
  const classesRows = rapport.classes.map((c) => `
    <tr>
      <td class="g" style="font-weight:700;">${escapeHtml(c.classe)}${c.a_echeancier ? '' : ' <em style="font-weight:400; color:#6b7280;">(sans échéancier)</em>'}</td>
      <td>${c.effectif}</td>
      <td class="num">${formatMontant(c.exigible)}</td>
      <td class="num">${formatMontant(c.verse_sur_exigible)}</td>
      <td class="num" style="font-weight:700; color:${rougeSi(c.impaye_exigible)};">${formatMontant(c.impaye_exigible)}</td>
      <td>${formatPct(c.taux_recouvrement_exigible)}</td>
      <td>${c.a_echeancier ? c.solvables : '—'}</td>
      <td>${c.a_echeancier ? c.insolvables : '—'}</td>
      <td style="font-weight:700; color:${c.pct_insolvables == null ? GRIS : rougeSi(c.pct_insolvables)};">${formatPct(c.pct_insolvables)}</td>
    </tr>`).join('');
  const classesTotal = rapport.classes.length ? `
    <tr class="total"><td class="g">Établissement</td><td>${g.effectif}</td><td class="num">${formatMontant(g.exigible)}</td><td class="num">${formatMontant(g.verse_sur_exigible)}</td>
      <td class="num">${formatMontant(g.impaye_exigible)}</td><td>${formatPct(g.taux_recouvrement_exigible)}</td><td>${g.solvables}</td><td>${g.insolvables}</td><td>${formatPct(g.pct_insolvables)}</td></tr>` : '';

  // ── Ancienneté ──
  const totalAnc = rapport.anciennete.reduce((s, b) => s + b.montant, 0);
  const ancienneteRows = rapport.anciennete.map((b) => `
    <tr><td class="g">${escapeHtml(b.libelle)}</td><td>${b.nb_eleves}</td><td class="num">${formatMontant(b.montant)}</td><td>${formatPct(totalAnc ? (b.montant * 100) / totalAnc : null)}</td></tr>`).join('');

  // ── Liste nominative ──
  const insolvablesRows = rapport.insolvables.map((s, i) => `
    <tr>
      <td>${i + 1}</td><td>${escapeHtml(s.matricule || '—')}</td>
      <td class="g">${escapeHtml(nomComplet(s))}${s.statut_inscription === 'Suspendu' ? ' <em>(suspendu)</em>' : ''}</td>
      <td>${escapeHtml(s.classe)}</td>
      <td class="num">${formatMontant(s.exigible)}</td><td class="num">${formatMontant(s.verse_sur_exigible)}</td>
      <td class="num" style="font-weight:700; color:${ROUGE};">${formatMontant(s.impaye_exigible)}</td>
      <td>${s.jours_retard} j</td>
      <td style="font-size:9.5px;">${escapeHtml(tranchesEnRetard(s))}</td>
      <td style="font-size:9.5px;">${s.parent ? `${escapeHtml(s.parent.nom)}<br>${escapeHtml(s.parent.telephone || '')}` : '—'}</td>
    </tr>`).join('');

  // ── Détail par tranche ──
  const detailHtml = rapport.classes.filter((c) => c.a_echeancier).map((c) => `
    <div class="classe-bloc">
      <div class="classe-entete">
        <span class="classe-titre">${escapeHtml(c.classe)}</span>
        <span class="classe-sous">Effectif ${c.effectif} · Exigible ${formatMontant(c.exigible)} · Impayé exigible ${formatMontant(c.impaye_exigible)} · Reste annuel ${formatMontant(c.reste_annuel)}</span>
      </div>
      <table class="table-tranches">
        <thead><tr><th>Tranche</th><th>Échéance</th><th>État</th><th class="num">Unitaire</th><th class="num">Attendu (classe)</th><th class="num">Versé (classe)</th><th>% payé</th><th>Élèves non soldés</th></tr></thead>
        <tbody>${c.tranches.map((t) => `
          <tr>
            <td class="g">${escapeHtml(t.libelle)}</td>
            <td>${t.date_limite ? formatDateCourt(t.date_limite) : 'Dès l’inscription'}</td>
            <td style="font-weight:700; color:${t.echue ? (t.nb_non_soldes ? ROUGE : VERT) : GRIS};">${t.echue ? 'Échue' : 'À venir'}</td>
            <td class="num">${formatMontant(t.montant_unitaire)}</td>
            <td class="num">${formatMontant(t.attendu_total)}</td>
            <td class="num">${formatMontant(t.verse_total)}</td>
            <td>${formatPct(t.pct_paye)}</td>
            <td style="color:${t.echue && t.nb_non_soldes ? ROUGE : 'inherit'};">${t.nb_non_soldes}${t.echue && t.nb_non_soldes ? ' en retard' : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`).join('');

  // ── Élèves sortis ──
  const sortisRows = rapport.creances_sortis.eleves.map((s) => `
    <tr><td>${escapeHtml(s.matricule || '—')}</td><td class="g">${escapeHtml(nomComplet(s))}</td><td>${escapeHtml(s.classe)}</td><td>${escapeHtml(s.statut_inscription)}</td>
      <td class="num" style="font-weight:700; color:${ROUGE};">${formatMontant(s.impaye_exigible)}</td><td>${escapeHtml(tranchesEnRetard(s))}</td>
      <td style="font-size:9.5px;">${s.parent ? `${escapeHtml(s.parent.nom)} — ${escapeHtml(s.parent.telephone || '')}` : '—'}</td></tr>`).join('');

  // ── Mouvements ──
  const periode = m.du ? `du ${formatDateLongue(m.du)} au ${formatDateLongue(m.au)}` : `depuis le début de l'année jusqu'au ${formatDateLongue(m.au)}`;
  const modesRows = m.par_mode.map((x) => `<tr><td class="g">${escapeHtml(MODES[x.mode] || x.mode)}</td><td>${x.nb}</td><td class="num">${formatMontant(x.montant)}</td></tr>`).join('');
  const agentsRows = m.par_agent.map((x) => `<tr><td class="g">${escapeHtml(x.agent)}</td><td>${x.nb}</td><td class="num">${formatMontant(x.montant)}</td></tr>`).join('');
  const annulRows = m.annulations.map((a) => `
    <tr><td>${escapeHtml(a.numero_recu)}</td><td class="g">${escapeHtml(nomComplet(a))}<br><span style="color:${GRIS};">${escapeHtml(a.classe)}</span></td>
      <td class="num">${formatMontant(a.montant)}</td><td>${escapeHtml(STATUTS_PAIEMENT[a.statut] || a.statut)}</td>
      <td>${formatDateHeure(a.date_paiement)}<br><span style="color:${GRIS};">${escapeHtml(a.encaisse_par || '—')}</span></td>
      <td>${a.date_annulation ? formatDateHeure(a.date_annulation) : '<em>inconnue</em>'}<br><span style="color:${GRIS};">${escapeHtml(a.annule_par || '—')}</span></td>
      <td class="g" style="font-size:9.5px;">${escapeHtml(a.motif || '—')}</td></tr>`).join('');

  // ── Anomalies ──
  const anomaliesHtml = rapport.anomalies.length
    ? `<table><thead><tr><th>Élève</th><th>Classe</th><th>Constat</th></tr></thead><tbody>${rapport.anomalies.map((a) => `
        <tr><td class="g">${escapeHtml(nomComplet(a))} ${a.matricule ? `(${escapeHtml(a.matricule)})` : ''}</td><td>${escapeHtml(a.classe)}</td><td class="g">${escapeHtml(a.message)}</td></tr>`).join('')}</tbody></table>`
    : '<p>Aucune anomalie détectée dans les données de paiement.</p>';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>État de solvabilité — ${escapeHtml(etab.nom || 'Établissement')} — ${escapeHtml(rapport.date_arrete)}</title>
<style>
  ${STYLES_COMMUNS}
  .synthese { background:#f8fafc; border:1px solid #e2e8f0; border-left:4px solid #1f2937; border-radius:4px; padding:12px 16px; margin-bottom:20px; text-align:justify; font-family: Georgia, 'Times New Roman', serif; font-size:12.5px; }
  .kpi-row { display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; margin-bottom:10px; }
  .kpi-box { border:1px solid #cbd5e1; border-radius:6px; padding:8px 10px; text-align:center; }
  .kpi-label { font-size:8.5px; text-transform:uppercase; letter-spacing:.04em; color:${GRIS}; font-weight:700; }
  .kpi-val { font-size:14px; font-weight:800; margin-top:3px; }
  .kpi-sous { font-size:9px; color:${GRIS}; margin-top:2px; }
  h3.section-titre { font-size:12.5px; text-transform:uppercase; letter-spacing:.03em; border-bottom:1px solid #cbd5e1; padding-bottom:5px; margin:24px 0 10px; page-break-after:avoid; }
  .deux-col { display:grid; grid-template-columns: 1fr 1fr; gap:14px; }
  h4 { font-size:11px; margin:10px 0 2px; text-transform:uppercase; color:#374151; }
  .classe-bloc { margin-bottom:14px; page-break-inside:avoid; }
  .classe-entete { display:flex; justify-content:space-between; align-items:baseline; gap:10px; background:#eef2f7; padding:6px 10px; border-radius:4px 4px 0 0; }
  .classe-titre { font-weight:800; font-size:12px; }
  .classe-sous { font-size:10px; color:#4b5563; }
  .table-tranches { margin-top:0; }
  .table-tranches th { background:#e2e8f0; color:#1f2937; }
  .definitions { font-size:10px; color:#4b5563; }
  .definitions li { margin-bottom:3px; }
</style>
</head>
<body>
  <div class="top-row"><span>Édité le ${escapeHtml(formatDateHeure(rapport.genere_le))}</span><span>Réf. ${escapeHtml(rapport.reference)} — Confidentiel</span></div>
  ${enteteCommun(etab)}
  <div class="titre-doc"><h2>État de solvabilité de l'établissement</h2></div>
  <div class="sous-titre">Année scolaire ${escapeHtml(anneeNom)} — Situation arrêtée au ${escapeHtml(formatDateLongue(rapport.date_arrete))}</div>
  ${bandeauDate(rapport)}
  <div class="synthese">${synthese(rapport, etab)}</div>

  ${titre("Situation globale")}
  <div class="kpi-row">
    ${kpi('Effectif en cours', g.effectif, null, g.suspendus ? `dont ${g.suspendus} suspendu(s)` : '&nbsp;')}
    ${kpi('Élèves solvables', g.solvables, VERT, formatPct(g.pct_solvables))}
    ${kpi('Élèves insolvables', g.insolvables, rougeSi(g.insolvables), formatPct(g.pct_insolvables))}
    ${kpi('Sans échéancier', g.sans_echeancier, g.sans_echeancier ? GRIS : null, 'hors taux')}
  </div>
  <div class="kpi-row">
    ${kpi('Exigible à date', formatMontant(g.exigible), null, `sur ${formatMontant(g.attendu)} attendus`)}
    ${kpi("Réglé sur l'exigible", formatMontant(g.verse_sur_exigible), null, `recouvrement ${formatPct(g.taux_recouvrement_exigible)}`)}
    ${kpi('Impayé exigible', formatMontant(g.impaye_exigible), rougeSi(g.impaye_exigible), 'arriérés à recouvrer')}
    ${kpi('Reste annuel', formatMontant(g.reste_annuel), null, `avances ${formatMontant(g.avance)} · recouvr. annuel ${formatPct(g.taux_recouvrement_annuel)}`)}
  </div>

  ${titre('Ancienneté des impayés exigibles')}
  <table>
    <thead><tr><th>Retard</th><th>Élèves (selon leur retard le plus ancien)</th><th class="num">Montant impayé</th><th>Part</th></tr></thead>
    <tbody>${ancienneteRows}<tr class="total"><td class="g">Total</td><td>${g.insolvables}</td><td class="num">${formatMontant(totalAnc)}</td><td>${formatPct(totalAnc ? 100 : null)}</td></tr></tbody>
  </table>

  ${titre('Situation par classe')}
  <table>
    <thead><tr><th>Classe</th><th>Effectif</th><th class="num">Exigible</th><th class="num">Réglé</th><th class="num">Impayé exigible</th><th>Recouvr. exigible</th><th>Solvables</th><th>Insolvables</th><th>% insolvabilité</th></tr></thead>
    <tbody>${classesRows || '<tr><td colspan="9">Aucune classe avec élève(s) inscrit(s) en cours.</td></tr>'}${classesTotal}</tbody>
  </table>

  ${nominatif ? `
  ${titre(`Liste nominative des élèves insolvables (${rapport.insolvables.length})`)}
  ${rapport.insolvables.length ? `<table>
    <thead><tr><th>#</th><th>Matricule</th><th>Nom &amp; prénom</th><th>Classe</th><th class="num">Exigible</th><th class="num">Réglé</th><th class="num">Impayé</th><th>Retard</th><th>Tranches en retard</th><th>Parent / contact</th></tr></thead>
    <tbody>${insolvablesRows}</tbody>
  </table>` : '<p>Aucun élève insolvable à cette date.</p>'}` : ''}

  ${detailTranches ? `
  ${titre('Détail par tranche, classe par classe')}
  ${detailHtml || '<p>Aucune classe dotée d’un échéancier.</p>'}` : ''}

  ${titre(`Créances sur élèves sortis (${rapport.creances_sortis.nb})`)}
  ${rapport.creances_sortis.nb ? `<p style="font-size:10.5px; color:${GRIS}; margin:0;">Élèves radiés ou transférés restant redevables de tranches exigibles. Exclus des taux ci-dessus.</p>
  <table>
    <thead><tr><th>Matricule</th><th>Nom &amp; prénom</th><th>Classe</th><th>Statut</th><th class="num">Impayé exigible</th><th>Tranches</th><th>Parent</th></tr></thead>
    <tbody>${sortisRows}<tr class="total"><td colspan="4" class="g">Total</td><td class="num">${formatMontant(rapport.creances_sortis.montant)}</td><td colspan="2"></td></tr></tbody>
  </table>` : '<p>Aucune créance sur des élèves sortis.</p>'}

  ${titre('Mouvements de caisse')}
  <p style="margin:0 0 6px;">Période ${escapeHtml(periode)} : <strong>${m.nb_encaissements} encaissement(s)</strong> valides pour <strong>${formatMontant(m.montant_encaisse)}</strong> ;
    <strong>${m.nb_annulations} annulation(s)</strong> pour ${formatMontant(m.montant_annule)}.</p>
  <div class="deux-col">
    <div><h4>Par mode de paiement</h4><table><thead><tr><th>Mode</th><th>Nombre</th><th class="num">Montant</th></tr></thead><tbody>${modesRows || '<tr><td colspan="3">Aucun encaissement</td></tr>'}</tbody></table></div>
    <div><h4>Par agent encaisseur</h4><table><thead><tr><th>Agent</th><th>Nombre</th><th class="num">Montant</th></tr></thead><tbody>${agentsRows || '<tr><td colspan="3">Aucun encaissement</td></tr>'}</tbody></table></div>
  </div>
  <h4>Paiements annulés, rejetés ou remboursés sur la période</h4>
  ${m.annulations.length ? `<table>
    <thead><tr><th>N° reçu</th><th>Élève</th><th class="num">Montant</th><th>Statut</th><th>Encaissé le / par</th><th>Annulé le / par</th><th>Motif</th></tr></thead>
    <tbody>${annulRows}</tbody>
  </table>` : '<p>Aucune annulation sur la période.</p>'}

  ${titre('Contrôles et anomalies')}
  ${anomaliesHtml}

  ${titre('Définitions')}
  <ul class="definitions">
    <li><strong>Exigible</strong> : somme des tranches dont la date limite est dépassée à la date d'arrêté, ou sans date limite (dues dès l'inscription).</li>
    <li><strong>Impayé exigible</strong> : part de l'exigible non réglée. <strong>Insolvable</strong> : impayé exigible supérieur à zéro. <strong>Solvable</strong> : tout l'exigible est réglé (un élève n'ayant rien versé alors qu'aucune échéance n'est passée est solvable).</li>
    <li><strong>Taux d'insolvabilité</strong> : insolvables ÷ élèves dont la classe a un échéancier. Les élèves sans échéancier sont exclus (« — » = non applicable).</li>
    <li><strong>Recouvrement de l'exigible</strong> : réglé sur les tranches exigibles ÷ exigible. <strong>Avance</strong> : versements sur des tranches pas encore échues.</li>
    <li>Population : inscriptions en cours (actives et suspendues) à la date d'arrêté. Seuls les paiements valides à cette date sont comptés.</li>
  </ul>

  ${SIGNATURES}
  <div class="pied-page">Document généré automatiquement par le serveur — Réf. ${escapeHtml(rapport.reference)} — édité le ${escapeHtml(formatDateHeure(rapport.genere_le))}.</div>
  ${AUTO_PRINT}
</body>
</html>`;
}

/* ────────────────────────────────────────────────────────────────────────
   Fenêtres d'impression
   ──────────────────────────────────────────────────────────────────────── */

// À appeler PENDANT le clic (avant tout await), sinon le navigateur bloque la
// fenêtre comme pop-up ; le contenu est écrit ensuite (ecrireImpression).
export function ouvrirFenetreImpression() {
  const fenetre = window.open('', '_blank');
  if (!fenetre) return null;
  fenetre.document.write('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Génération…</title></head><body style="font-family:Arial,sans-serif;padding:40px;color:#6b7280;">Génération du document en cours…</body></html>');
  return fenetre;
}

export function ecrireImpression(fenetre, html) {
  fenetre.document.open();
  fenetre.document.write(html);
  fenetre.document.close();
}

// Ouvre le document dans une nouvelle fenêtre ; false si les pop-ups sont bloqués.
export function ouvrirImpression(html) {
  const fenetre = window.open('', '_blank');
  if (!fenetre) return false;
  ecrireImpression(fenetre, html);
  return true;
}

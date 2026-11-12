// Documents imprimables de la Trésorerie (état sur une période, journal,
// bon de caisse d'une opération). Mise en page seulement : tous les chiffres
// viennent du serveur (GET /tresorerie/synthese et /journal).

import { formatMontant } from '../components/ui';
import {
  AUTO_PRINT, enteteCommun, escapeHtml, formatDateCourt, formatDateHeure, formatDateLongue, SIGNATURES, STYLES_COMMUNS,
} from './paiementsImpression';
import { SENS, TYPES_COMPTE } from './tresorerie';

const ROUGE = '#c0392b';
const VERT = '#2e7d32';
const GRIS = '#6b7280';

/* ── Montant en lettres (orthographe traditionnelle) ──────────────────── */

const UNITES = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze',
  'treize', 'quatorze', 'quinze', 'seize'];
const DIZAINES = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };

function moinsDeCent(n) {
  if (n <= 16) return UNITES[n];
  if (n < 20) return `dix-${UNITES[n - 10]}`;
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (d === 7 || d === 9) {
    const base = d === 7 ? 'soixante' : 'quatre-vingt';
    if (d === 7 && u === 1) return 'soixante et onze';
    return `${base}-${moinsDeCent(10 + u)}`;
  }
  if (d === 8) return u === 0 ? 'quatre-vingts' : `quatre-vingt-${UNITES[u]}`;
  if (u === 0) return DIZAINES[d];
  if (u === 1) return `${DIZAINES[d]} et un`;
  return `${DIZAINES[d]}-${UNITES[u]}`;
}

// `final` : le nombre termine l'expression (« deux cents » mais « deux cent mille »).
function moinsDeMille(n, final = true) {
  const c = Math.floor(n / 100);
  const r = n % 100;
  let texte = '';
  if (c > 0) {
    texte = c === 1 ? 'cent' : `${UNITES[c]} cent${r === 0 && final ? 's' : ''}`;
  }
  if (r > 0) {
    const reste = moinsDeCent(r);
    // « quatre-vingts » perd son s devant mille.
    texte = texte ? `${texte} ${!final && reste === 'quatre-vingts' ? 'quatre-vingt' : reste}` : (!final && reste === 'quatre-vingts' ? 'quatre-vingt' : reste);
  }
  return texte;
}

export function nombreEnLettres(valeur) {
  let n = Math.floor(Math.abs(Number(valeur) || 0));
  if (n === 0) return 'zéro';
  const parties = [];
  const milliards = Math.floor(n / 1e9); n %= 1e9;
  const millions = Math.floor(n / 1e6); n %= 1e6;
  const milliers = Math.floor(n / 1e3); n %= 1e3;
  if (milliards) parties.push(`${moinsDeMille(milliards)} milliard${milliards > 1 ? 's' : ''}`);
  if (millions) parties.push(`${moinsDeMille(millions)} million${millions > 1 ? 's' : ''}`);
  if (milliers) parties.push(milliers === 1 ? 'mille' : `${moinsDeMille(milliers, false)} mille`);
  if (n) parties.push(moinsDeMille(n));
  return parties.join(' ');
}

export const montantEnLettres = (valeur) => {
  const texte = nombreEnLettres(valeur);
  return `${texte.charAt(0).toUpperCase()}${texte.slice(1)} francs CFA`;
};

/* ── Mise en page commune ─────────────────────────────────────────────── */

const STYLES = `${STYLES_COMMUNS}
  .kpis { display:flex; gap:10px; margin:6px 0 16px; }
  .kpi { flex:1; border:1px solid #cbd5e1; border-radius:4px; padding:8px 10px; }
  .kpi-l { font-size:9.5px; text-transform:uppercase; color:${GRIS}; letter-spacing:.03em; }
  .kpi-v { font-size:15px; font-weight:800; margin-top:2px; }
  h3 { font-size:12.5px; text-transform:uppercase; letter-spacing:.04em; margin:18px 0 4px; border-bottom:1px solid #1f2937; padding-bottom:3px; }
  .deux { display:flex; gap:16px; } .deux > div { flex:1; }
  td.neg { color:${ROUGE}; font-weight:700; }
  tr.annule td { color:#9ca3af; text-decoration:line-through; }
`;

const page = ({ titre, sousTitre, corps, etablissement, avecSignatures = true }) => `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>${escapeHtml(titre)}</title><style>${STYLES}</style></head>
<body>
  <div class="top-row"><span>Édité le ${escapeHtml(formatDateHeure(new Date().toISOString()))}</span><span>Trésorerie</span></div>
  ${enteteCommun(etablissement || {})}
  <div class="titre-doc"><h2>${escapeHtml(titre)}</h2></div>
  ${sousTitre ? `<div class="sous-titre">${sousTitre}</div>` : ''}
  ${corps}
  ${avecSignatures ? SIGNATURES : ''}
  ${AUTO_PRINT}
</body>
</html>`;

const num = (v, signe = false) => `<td class="num${signe && v < 0 ? ' neg' : ''}">${formatMontant(v)}</td>`;
const periodeTexte = (du, au) => `Du ${escapeHtml(formatDateLongue(du))} au ${escapeHtml(formatDateLongue(au))}`;

/* ── État de trésorerie ───────────────────────────────────────────────── */

export function construireHtmlEtat({ synthese: s, etablissement }) {
  const tableau = (titre, lignes, avecScolarite) => `
    <h3>${titre}</h3>
    <table>
      <thead><tr><th>Catégorie</th><th class="num">Montant</th>${avecScolarite ? '<th class="num">dont scolarité</th>' : ''}</tr></thead>
      <tbody>
        ${lignes.map((l) => `<tr><td class="g">${escapeHtml(l.libelle)}</td>${num(l.montant)}${avecScolarite ? `<td class="num">${l.dont_scolarite ? formatMontant(l.dont_scolarite) : '—'}</td>` : ''}</tr>`).join('')
          || `<tr><td colspan="${avecScolarite ? 3 : 2}">Aucune opération</td></tr>`}
        <tr class="total"><td class="g">Total</td>${num(lignes.reduce((t, l) => t + l.montant, 0))}${avecScolarite ? `<td class="num">${formatMontant(lignes.reduce((t, l) => t + (l.dont_scolarite || 0), 0))}</td>` : ''}</tr>
      </tbody>
    </table>`;

  const fonds = s.fonds.filter((f) => f.actif || f.solde || f.entrees_periode || f.depenses_periode);
  const comptes = s.comptes.filter((c) => c.actif || c.solde);
  const corps = `
  <div class="kpis">
    <div class="kpi"><div class="kpi-l">Entrées de la période</div><div class="kpi-v" style="color:${VERT}">${formatMontant(s.total_entrees)}</div></div>
    <div class="kpi"><div class="kpi-l">Sorties de la période</div><div class="kpi-v" style="color:${ROUGE}">${formatMontant(s.total_sorties)}</div></div>
    <div class="kpi"><div class="kpi-l">Résultat</div><div class="kpi-v"${s.resultat < 0 ? ` style="color:${ROUGE}"` : ''}>${formatMontant(s.resultat)}</div></div>
    <div class="kpi"><div class="kpi-l">Trésorerie au ${escapeHtml(formatDateCourt(s.au))}</div><div class="kpi-v">${formatMontant(s.solde_global)}</div></div>
  </div>
  <div class="deux">
    <div>${tableau('Entrées par catégorie', s.entrees_par_categorie, true)}</div>
    <div>${tableau('Sorties par catégorie', s.sorties_par_categorie, false)}</div>
  </div>
  <h3>Situation des fonds au ${escapeHtml(formatDateLongue(s.au))}</h3>
  <table>
    <thead><tr><th>Fonds</th><th class="num">Entrées (période)</th><th class="num">Dépenses (période)</th><th class="num">Total entré</th><th class="num">Total dépensé</th><th class="num">Solde</th></tr></thead>
    <tbody>
      ${fonds.map((f) => `<tr><td class="g">${escapeHtml(f.libelle)}</td>${num(f.entrees_periode)}${num(f.depenses_periode)}${num(f.entrees)}${num(f.depenses)}${num(f.solde, true)}</tr>`).join('')}
      <tr class="total"><td class="g">Total</td>${num(fonds.reduce((t, f) => t + f.entrees_periode, 0))}${num(fonds.reduce((t, f) => t + f.depenses_periode, 0))}${num(fonds.reduce((t, f) => t + f.entrees, 0))}${num(fonds.reduce((t, f) => t + f.depenses, 0))}${num(fonds.reduce((t, f) => t + f.solde, 0), true)}</tr>
    </tbody>
  </table>
  <h3>Situation des comptes au ${escapeHtml(formatDateLongue(s.au))}</h3>
  <table>
    <thead><tr><th>Compte</th><th>Type</th><th class="num">Solde</th></tr></thead>
    <tbody>
      ${comptes.map((c) => `<tr><td class="g">${escapeHtml(c.libelle)}</td><td>${escapeHtml(TYPES_COMPTE[c.type] || c.type)}</td>${num(c.solde, true)}</tr>`).join('')}
      <tr class="total"><td class="g" colspan="2">Trésorerie disponible</td>${num(s.solde_global, true)}</tr>
    </tbody>
  </table>
  <p style="font-size:10px; color:${GRIS}; margin-top:10px;">Les entrées comprennent les paiements de scolarité validés. Solde d'un fonds : tout ce qui y est entré moins les dépenses prises dessus, depuis l'ouverture. La somme des fonds est égale à la trésorerie disponible.</p>`;

  return page({ titre: 'État de trésorerie', sousTitre: periodeTexte(s.du, s.au), corps, etablissement });
}

/* ── Journal des opérations ───────────────────────────────────────────── */

export function construireHtmlJournal({ lignes, du, au, filtresTexte, nomCategorie, nomCompte, etablissement }) {
  const valides = lignes.filter((l) => l.statut !== 'ANNULE');
  const total = (sens) => valides.filter((l) => l.sens === sens).reduce((t, l) => t + l.montant, 0);
  const ordonnees = [...lignes].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rows = ordonnees.map((l, i) => {
    const fonds = l.sens === 'SORTIE' ? l.ventilation.map((v) => `${nomCategorie(v.categorie_id)}${l.ventilation.length > 1 ? ` (${formatMontant(v.montant)})` : ''}`).join(', ') : '';
    const compte = l.sens === 'TRANSFERT' ? `${nomCompte(l.compte_id)} → ${nomCompte(l.compte_destination_id)}` : nomCompte(l.compte_id);
    return `<tr class="${l.statut === 'ANNULE' ? 'annule' : ''}">
      <td>${i + 1}</td><td>${escapeHtml(formatDateCourt(l.date))}</td>
      <td class="g">${escapeHtml(l.libelle)}${l.tiers ? `<br><span style="color:${GRIS}">${escapeHtml(l.tiers)}</span>` : ''}</td>
      <td class="g">${l.sens === 'TRANSFERT' ? 'Transfert' : escapeHtml(nomCategorie(l.categorie_id))}${fonds ? `<br><span style="color:${GRIS}">Pris sur : ${escapeHtml(fonds)}</span>` : ''}</td>
      <td>${escapeHtml(compte)}</td><td>${escapeHtml(l.reference || '')}</td>
      <td class="num">${l.sens === 'ENTREE' ? formatMontant(l.montant) : ''}</td>
      <td class="num">${l.sens === 'SORTIE' ? formatMontant(l.montant) : l.sens === 'TRANSFERT' ? `(${formatMontant(l.montant)})` : ''}</td>
    </tr>`;
  }).join('');
  const annulees = lignes.length - valides.length;
  const corps = `
  <table>
    <thead><tr><th>#</th><th>Date</th><th>Libellé</th><th>Catégorie / fonds</th><th>Compte</th><th>Réf.</th><th class="num">Entrée</th><th class="num">Sortie</th></tr></thead>
    <tbody>
      ${rows || '<tr><td colspan="8">Aucune opération</td></tr>'}
      <tr class="total"><td colspan="6" class="g">Totaux — ${valides.length} opération(s)${annulees ? `, ${annulees} annulée(s) non comptée(s)` : ''}</td><td class="num">${formatMontant(total('ENTREE'))}</td><td class="num">${formatMontant(total('SORTIE'))}</td></tr>
      <tr class="total"><td colspan="6" class="g">Résultat (entrées − sorties)</td><td colspan="2" class="num">${formatMontant(total('ENTREE') - total('SORTIE'))}</td></tr>
    </tbody>
  </table>
  <p style="font-size:10px; color:${GRIS}; margin-top:10px;">Les transferts entre comptes (entre parenthèses) ne sont ni des entrées ni des sorties. Les opérations annulées figurent barrées.</p>`;
  return page({
    titre: 'Journal de trésorerie',
    sousTitre: `${periodeTexte(du, au)}${filtresTexte ? ` — ${escapeHtml(filtresTexte)}` : ''}`,
    corps,
    etablissement,
  });
}

/* ── Bon de caisse d'une opération ────────────────────────────────────── */

const TITRES_BON = { ENTREE: 'Bon de recette', SORTIE: 'Bon de dépense', TRANSFERT: 'Bon de transfert' };

export function construireHtmlBon({ operation: o, nomCategorie, nomCompte, etablissement }) {
  const ligne = (label, valeur) => (valeur ? `<tr><td class="g" style="width:32%; background:#f8fafc; font-weight:700;">${label}</td><td class="g">${valeur}</td></tr>` : '');
  const fonds = o.sens === 'SORTIE'
    ? o.ventilation.map((v) => `${escapeHtml(nomCategorie(v.categorie_id))} : ${formatMontant(v.montant)}`).join('<br>') : '';
  const signatures = o.sens === 'SORTIE'
    ? '<div class="signatures"><div class="signature-bloc"><div class="signature-ligne">Le Bénéficiaire</div></div><div class="signature-bloc"><div class="signature-ligne">Le Comptable</div></div><div class="signature-bloc"><div class="signature-ligne">Le Chef d\'établissement</div></div></div>'
    : SIGNATURES;
  const corps = `
  ${o.statut === 'ANNULE' ? `<div class="alerte"><strong>Opération annulée</strong> — motif : ${escapeHtml(o.motif_annulation || '')}</div>` : ''}
  <table>
    <tbody>
      ${ligne('N° de pièce', escapeHtml(o.reference || `TR-${String(o.id).padStart(6, '0')}`))}
      ${ligne('Date', escapeHtml(formatDateLongue(o.date)))}
      ${ligne('Nature', escapeHtml(SENS[o.sens]?.label || o.sens))}
      ${ligne('Objet', escapeHtml(o.libelle))}
      ${ligne(o.sens === 'SORTIE' ? 'Bénéficiaire' : o.sens === 'ENTREE' ? 'Versé par' : '', escapeHtml(o.tiers || ''))}
      ${o.sens !== 'TRANSFERT' ? ligne('Catégorie', escapeHtml(nomCategorie(o.categorie_id))) : ''}
      ${ligne('Fonds imputé(s)', fonds)}
      ${o.sens === 'TRANSFERT'
    ? ligne('Comptes', `${escapeHtml(nomCompte(o.compte_id))} → ${escapeHtml(nomCompte(o.compte_destination_id))}`)
    : ligne(o.sens === 'SORTIE' ? 'Payé depuis' : 'Reçu sur', escapeHtml(nomCompte(o.compte_id)))}
      <tr class="total"><td class="g">Montant</td><td class="g" style="font-size:15px;">${formatMontant(o.montant)}</td></tr>
    </tbody>
  </table>
  <p style="margin-top:14px;">Arrêté le présent bon à la somme de : <strong>${escapeHtml(montantEnLettres(o.montant))}</strong>.</p>
  ${signatures}`;
  return page({ titre: TITRES_BON[o.sens] || 'Bon de caisse', corps, etablissement, avecSignatures: false });
}

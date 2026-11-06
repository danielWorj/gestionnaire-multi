// Présentation des données de chaque module dans l'écran des conflits de
// synchronisation (components/ConflitsSynchro.jsx) : comment résumer « votre
// saisie » et « ce qui est sur le serveur » en une ligne lisible.
// Chaque module synchronisé hors connexion s'y déclare.

const MODES = { ESPECES: 'Espèces', MOBILE_MONEY: 'Mobile Money', VIREMENT: 'Virement', CHEQUE: 'Chèque' };
const fmtNombre = (v) => String(Number(v)).replace('.', ',');
const fmtDate = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('fr-FR');

export const MODULES_HORS_LIGNE = {
  notes: {
    titre: 'Note',
    icone: 'bx-edit',
    resume: (d) => {
      if (!d) return 'Aucune note';
      if (d.absent) return 'Absent';
      if (d.valeur === null || d.valeur === undefined || d.valeur === '') return 'Non notée';
      return `${fmtNombre(d.valeur)} / 20`;
    },
  },
  discipline: {
    titre: 'Discipline',
    icone: 'bx-shield-quarter',
    resume: (d) => {
      if (!d) return 'Aucune fiche';
      const parts = [
        `${d.absences_justifiees ?? 0} abs. just.`, `${d.absences_non_justifiees ?? 0} abs. injust.`,
        `${d.retards ?? 0} retard(s)`, `${d.exclusions ?? 0} exclusion(s)`,
      ];
      return d.observation ? `${parts.join(' · ')} — « ${d.observation} »` : parts.join(' · ');
    },
  },
  parent: {
    titre: 'Parent',
    icone: 'bx-group',
    resume: (d) => (d ? [`${d.nom || ''} ${d.prenom || ''}`.trim(), d.telephone, d.email].filter(Boolean).join(' · ') : '—'),
  },
  eleve: {
    titre: 'Élève',
    icone: 'bx-face',
    resume: (d) => (d ? [
      `${d.nom || ''} ${d.prenom || ''}`.trim() + (d.matricule ? ` (${d.matricule})` : ''),
      d.sexe, d.date_naissance ? `né(e) le ${fmtDate(d.date_naissance)}` : null, d.lieu_naissance ? `à ${d.lieu_naissance}` : null,
      d.statut,
    ].filter(Boolean).join(' · ') : '—'),
  },
  inscription: {
    titre: 'Inscription',
    icone: 'bx-clipboard',
    resume: (d) => (d ? [
      d.classe_label || (d.classe_id ? `Classe n°${d.classe_id}` : null), d.statut,
      d.date_inscription ? `inscrit(e) le ${fmtDate(d.date_inscription)}` : null,
    ].filter(Boolean).join(' · ') : '—'),
  },
  // Un encaissement ne s'« écrase » pas : on confirme (2e paiement réel) ou
  // on renonce (déjà payé).
  paiement: {
    titre: 'Paiement',
    icone: 'bx-wallet',
    choix: { ecraser: 'Enregistrer quand même (2e paiement)', ignorer: "Ne pas l'enregistrer (déjà payé)" },
    resume: (d) => {
      if (!d) return '—';
      const montant = `${Number(d.montant_total || 0).toLocaleString('fr-FR')} FCFA`;
      return [
        d.eleve_label, montant, MODES[d.mode_paiement] || d.mode_paiement,
        d.date_paiement ? `le ${new Date(d.date_paiement).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : null,
        d.numero_recu ? `reçu ${d.numero_recu}` : null,
      ].filter(Boolean).join(' · ');
    },
  },
  // Dossier complet (parent + élève + inscription, cf. /dossiers-inscription/).
  dossier_inscription: {
    titre: "Dossier d'inscription",
    icone: 'bx-folder-plus',
    resume: (d) => {
      if (!d) return '—';
      const parts = [];
      if (d.eleve) parts.push(MODULES_HORS_LIGNE.eleve.resume(d.eleve));
      else if (d.eleve_label) parts.push(d.eleve_label);
      if (d.parent) parts.push(`parent : ${MODULES_HORS_LIGNE.parent.resume(d.parent)}`);
      if (d.inscription) parts.push(MODULES_HORS_LIGNE.inscription.resume(d.inscription));
      return parts.join(' — ') || '—';
    },
  },
};

export function moduleHorsLigne(nom) {
  return MODULES_HORS_LIGNE[nom] || { titre: 'Donnée', icone: 'bx-data', resume: (d) => (d ? JSON.stringify(d) : '—') };
}

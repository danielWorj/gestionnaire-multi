import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { enregistrer, nouvelleCle, terminerEnregistrement, useApresSynchro, useOperationsEnAttente } from '../lib/offline';
import OperationsEnAttente from '../components/OperationsEnAttente';
import Modal from '../components/Modal';
import ChartCanvas from '../components/ChartCanvas';
import { useAuth } from '../context/AuthContext';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import {
  downloadCsv, formatMontant, IconBtn, PageHeader, StatCard, TableCard, Tabs, TBody, useConfirm, useToast,
} from '../components/ui';
import {
  construireHtmlImpression, construireHtmlRapportSolvabilite, formatDateCourt, ouvrirImpression,
} from '../lib/paiementsImpression';
import Select from '../components/Select';
import { SkelListe } from '../components/Skeleton';

// Portage de server/static/templates/paiements.html (paiements_api.py) :
// échéancier par classe (tranches), paiements (en-tête + lignes),
// situation d'un élève, solvabilité par classe et rapports imprimables.

const MODES_LABELS = { ESPECES: 'Espèces', MOBILE_MONEY: 'Mobile Money', VIREMENT: 'Virement bancaire', CHEQUE: 'Chèque' };
const STATUT_LABELS = { VALIDE: 'Validé', ANNULE: 'Annulé', REJETE: 'Rejeté', REMBOURSE: 'Remboursé' };
const STATUT_BADGES = { VALIDE: 'bg-label-success', ANNULE: 'bg-label-danger', REJETE: 'bg-label-warning', REMBOURSE: 'bg-label-info' };
const TRANCHE_BADGES = { Soldé: 'bg-label-success', Partiel: 'bg-label-warning', Impayé: 'bg-label-danger' };
const SUCCESS = '#71dd37';
const DANGER_LIGHT = '#ffe0db';
const PRIMARY = '#696cff';
const PRIMARY_LIGHT = '#e7e7ff';

function formatDateHeure(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function computeStatutTranche(attendu, verse) {
  if (Number(verse || 0) <= 0) return 'Impayé';
  if (Number(verse) >= Number(attendu || 0)) return 'Soldé';
  return 'Partiel';
}

// Même règle que le serveur (paiements_services : aujourd'hui > date_limite),
// en comparant des dates 'AAAA-MM-JJ' locales : new Date('AAAA-MM-JJ') est
// minuit UTC, ce qui décalait l'échéance d'un jour selon le fuseau.
function aujourdhuiIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Tranche exigible : date limite passée, ou pas de date limite (due dès
// l'inscription) — cf. paiements_services.tranche_exigible.
const estExigible = (dateLimite) => !dateLimite || String(dateLimite).slice(0, 10) < aujourdhuiIso();

const SOLVABILITE = {
  SOLVABLE: { label: 'Solvable', badge: 'bg-label-success' },
  INSOLVABLE: { label: 'Insolvable', badge: 'bg-label-danger' },
  SANS_ECHEANCIER: { label: 'Sans échéancier', badge: 'bg-label-secondary' },
  ERREUR: { label: 'Erreur', badge: 'bg-label-warning' },
};

const StatutPaiement = ({ statut }) => <span className={`badge ${STATUT_BADGES[statut] || 'bg-label-secondary'}`}>{STATUT_LABELS[statut] || statut}</span>;
const EnRetard = () => <span className="badge bg-label-danger ms-1">En retard</span>;
const donutOptions = (cutout) => ({
  cutout,
  plugins: {
    legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
    tooltip: { callbacks: { label: (c) => ` ${c.label} : ${formatMontant(c.raw)}` } },
  },
});

const MODULES_PAIEMENT = ['paiement'];

// Échéancier d'une inscription calculé sur l'appareil (copies locales des
// tranches et des paiements), quand le serveur est injoignable : même
// résultat que GET /paiements/etat/<id> à la dernière synchronisation près.
function etatLocal(insc, tranches, paiements) {
  const lignes = paiements
    .filter((p) => p.inscription_id === insc.id && p.statut === 'VALIDE')
    .flatMap((p) => p.lignes || []);
  return tranches
    .filter((t) => t.classe_id === insc.classe_id && t.annee_scolaire_id === insc.annee_scolaire_id)
    .sort((a, b) => (a.ordre ?? 0) - (b.ordre ?? 0))
    .map((t) => {
      const verse = lignes.filter((l) => l.tranche_classe_id === t.id).reduce((somme, l) => somme + Number(l.montant_verse || 0), 0);
      return {
        tranche_classe_id: t.id, libelle: t.libelle, ordre: t.ordre, montant_attendu: Number(t.montant_attendu),
        date_limite: t.date_limite, montant_verse: verse, reste_du: Math.round((Number(t.montant_attendu) - verse) * 100) / 100, en_retard: false,
      };
    });
}

export default function PaiementsPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { isSuperAdmin, activeEtablissementId } = useAuth();
  const etablissement = useEtablissementCourant();

  const [annees, setAnnees] = useState([]);
  const [annee, setAnnee] = useState('');
  const [ref, setRef] = useState({ classes: [], cycles: [], inscriptions: [], eleves: [], parents: [] });
  const [tranches, setTranches] = useState([]);
  const [paiements, setPaiements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('paiements');
  const [statsClasse, setStatsClasse] = useState('');
  const [filtresPaiements, setFiltresPaiements] = useState({ classe: '', statut: '' });
  const [filtreTrancheClasse, setFiltreTrancheClasse] = useState('');
  const [chartsOpen, setChartsOpen] = useState({ recouvrement: true, tranches: true, situation: true });
  const [situation, setSituation] = useState({ inscription: '', etat: null, loading: false, error: '' });
  const [roster, setRoster] = useState({ classe: '', filtre: '', lignes: [], classeChargee: null, loading: false, message: 'Choisissez une classe puis cliquez sur "Afficher la classe".' });
  const [modal, setModal] = useState(null); // { kind, data }

  /* ── Chargement ── */
  const loadTranchesEtPaiements = useCallback(async () => {
    setTranches(await api.get('/tranches-classe/').catch((e) => { toast(e.message, 'error'); return []; }));
    setPaiements(await api.get('/paiements/').catch((e) => { toast(`Paiements : ${e.message}`, 'error'); return []; }));
  }, [toast]);

  const loadReferentiels = useCallback(async () => {
    try {
      const [inscriptions, eleves, parents] = await Promise.all([api.get('/inscriptions/'), api.get('/eleves/'), api.get('/parents/')]);
      setRef((r) => ({ ...r, inscriptions: inscriptions || [], eleves: eleves || [], parents: parents || [] }));
    } catch (e) {
      toast(`Élèves / inscriptions : ${e.message}`, 'error');
    }
  }, [toast]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.get('/annees-scolaires/') || [];
      if (!list.length) throw new Error('Aucune année scolaire trouvée');
      setAnnees(list);
      // L'année déjà choisie n'est conservée que si elle appartient encore à
      // la liste (le SuperAdmin peut avoir changé d'établissement).
      setAnnee((prev) => (list.some((a) => String(a.id) === String(prev)) ? prev : String((list.find((a) => a.active) || list[0]).id)));
    } catch (e) {
      toast(`Années scolaires : ${e.message}`, 'error');
    }
    try {
      const [classes, cycles] = await Promise.all([api.get('/classes/'), api.get('/cycles/')]);
      setRef((r) => ({ ...r, classes: classes || [], cycles: cycles || [] }));
    } catch (e) {
      toast(`Classes : ${e.message}`, 'error');
    }
    await loadReferentiels();
    await loadTranchesEtPaiements();
    setLoading(false);
  }, [toast, loadReferentiels, loadTranchesEtPaiements]);

  useEffect(() => {
    loadAll();
  }, [loadAll, activeEtablissementId]);
  // Paiements saisis hors connexion, arrivés sur le serveur : listes et soldes à jour.
  useApresSynchro(MODULES_PAIEMENT, loadTranchesEtPaiements);

  const { classes, cycles, inscriptions, eleves, parents } = ref;
  const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
  const classesById = useMemo(() => byId(classes), [classes]);
  const inscriptionsById = useMemo(() => byId(inscriptions), [inscriptions]);
  const elevesById = useMemo(() => byId(eleves), [eleves]);
  const parentsById = useMemo(() => byId(parents), [parents]);
  const tranchesById = useMemo(() => byId(tranches), [tranches]);

  const classeLabel = useCallback((id) => {
    const c = classesById[id];
    if (!c) return `Classe #${id}`;
    return `${cycles.find((cy) => cy.id === c.cycle_id)?.libelle || ''} ${c.option || ''}`.trim() || `Classe #${id}`;
  }, [classesById, cycles]);
  const eleveLabel = useCallback((id) => {
    const el = elevesById[id];
    if (!el) return `Élève #${id}`;
    const nom = `${el.nom || ''} ${el.prenom || ''}`.trim();
    return el.matricule ? `${nom} (Mat. ${el.matricule})` : nom;
  }, [elevesById]);
  const parentLabel = (id) => {
    const p = parentsById[id];
    return p ? `${p.nom || ''} ${p.prenom || ''}`.trim() : '—';
  };
  const anneeLabel = (id) => annees.find((a) => String(a.id) === String(id))?.libelle || '';
  const classesTriees = useMemo(() => [...classes].sort((a, b) => classeLabel(a.id).localeCompare(classeLabel(b.id))), [classes, classeLabel]);

  /* ── Calculs (montant_attendu = montant PAR ÉLÈVE, pondéré par l'effectif) ── */
  const inscriptionsActives = useMemo(() => inscriptions.filter((i) => String(i.annee_scolaire_id) === String(annee) && i.statut === 'Actif'), [inscriptions, annee]);
  const effectifClasse = useCallback((classeId) => inscriptionsActives.filter((i) => String(i.classe_id) === String(classeId)).length, [inscriptionsActives]);

  // { inscription_id: { tranche_classe_id: montant versé } } — paiements VALIDE uniquement.
  const versements = useMemo(() => {
    const parInscription = {};
    paiements.forEach((p) => {
      if (p.statut !== 'VALIDE') return;
      const m = (parInscription[p.inscription_id] ||= {});
      (p.lignes || []).forEach((l) => { m[l.tranche_classe_id] = (m[l.tranche_classe_id] || 0) + Number(l.montant_verse || 0); });
    });
    return parInscription;
  }, [paiements]);

  // Versé par tranche, limité aux inscriptions ACTIVES : le montant attendu
  // n'est calculé que sur l'effectif actif, le versé doit porter sur le même
  // périmètre (sinon les versements d'élèves radiés/transférés gonflent le taux).
  const tranchesTotals = useMemo(() => {
    const totals = {};
    inscriptionsActives.forEach((i) => {
      Object.entries(versements[i.id] || {}).forEach(([trancheId, montant]) => { totals[trancheId] = (totals[trancheId] || 0) + montant; });
    });
    return totals;
  }, [versements, inscriptionsActives]);

  const tranchesDeLAnnee = useCallback((classeFiltre) => tranches
    .filter((t) => String(t.annee_scolaire_id) === String(annee) && (!classeFiltre || String(t.classe_id) === String(classeFiltre)))
    .sort((a, b) => (a.classe_id - b.classe_id) || (a.ordre - b.ordre)), [tranches, annee]);

  const totauxPonderes = useCallback((classeFiltre) => {
    const parClasse = {};
    tranchesDeLAnnee(classeFiltre).forEach((t) => {
      const c = (parClasse[t.classe_id] ||= { attenduUnitaire: 0, verse: 0 });
      c.attenduUnitaire += Number(t.montant_attendu || 0);
      c.verse += Number(tranchesTotals[t.id] || 0);
    });
    let totalAttendu = 0;
    let totalVerse = 0;
    Object.keys(parClasse).forEach((id) => {
      totalAttendu += parClasse[id].attenduUnitaire * effectifClasse(id);
      totalVerse += parClasse[id].verse;
    });
    return { totalAttendu, totalVerse, solde: totalAttendu - totalVerse, taux: totalAttendu > 0 ? Math.round((totalVerse / totalAttendu) * 100) : 0, parClasse };
  }, [tranchesDeLAnnee, tranchesTotals, effectifClasse]);

  const stats = useMemo(() => totauxPonderes(statsClasse), [totauxPonderes, statsClasse]);

  const chartRecouvrement = useMemo(() => (stats.totalAttendu > 0 ? {
    type: 'doughnut',
    data: { labels: ['Montant versé', 'Solde restant'], datasets: [{ data: [stats.totalVerse, Math.max(stats.solde, 0)], backgroundColor: [SUCCESS, DANGER_LIGHT], borderWidth: 2, borderColor: '#FFFFFF' }] },
    options: donutOptions('62%'),
  } : null), [stats]);

  const chartTranches = useMemo(() => {
    const { parClasse } = totauxPonderes(null);
    const ids = Object.keys(parClasse);
    if (!ids.length) return null;
    return {
      type: 'bar',
      data: {
        labels: ids.map((id) => classeLabel(id)),
        datasets: [
          { label: 'Montant attendu', data: ids.map((id) => parClasse[id].attenduUnitaire * effectifClasse(id)), backgroundColor: PRIMARY_LIGHT, borderRadius: 4, maxBarThickness: 30 },
          { label: 'Montant versé', data: ids.map((id) => parClasse[id].verse), backgroundColor: PRIMARY, borderRadius: 4, maxBarThickness: 30 },
        ],
      },
      options: {
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${formatMontant(c.raw)}` } } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => v.toLocaleString('fr-FR') } } },
      },
    };
  }, [totauxPonderes, classeLabel, effectifClasse]);

  /* ── Paiements enregistrés ── */
  const paiementsAffiches = useMemo(() => paiements.filter((p) => {
    const insc = inscriptionsById[p.inscription_id];
    if (String(insc?.annee_scolaire_id) !== String(annee)) return false;
    if (filtresPaiements.classe && String(insc?.classe_id) !== String(filtresPaiements.classe)) return false;
    if (filtresPaiements.statut && p.statut !== filtresPaiements.statut) return false;
    return true;
  }).sort((a, b) => new Date(b.date_paiement) - new Date(a.date_paiement)), [paiements, inscriptionsById, annee, filtresPaiements]);

  const inscriptionOptions = useMemo(() => inscriptionsActives
    .slice()
    .sort((a, b) => eleveLabel(a.eleve_id).localeCompare(eleveLabel(b.eleve_id)))
    .map((i) => <option key={i.id} value={i.id}>{eleveLabel(i.eleve_id)} — {classeLabel(i.classe_id)}</option>),
  [inscriptionsActives, eleveLabel, classeLabel]);

  /* ── Situation d'un élève ── */
  const chargerSituation = async () => {
    if (!situation.inscription) {
      toast('Veuillez choisir un élève.', 'error');
      return;
    }
    setSituation((s) => ({ ...s, loading: true, error: '' }));
    try {
      const etat = await api.get(`/paiements/etat/${situation.inscription}`);
      setSituation((s) => ({ ...s, etat, loading: false }));
    } catch (e) {
      setSituation((s) => ({ ...s, etat: null, loading: false, error: e.message }));
    }
  };
  const situationLignes = situation.etat?.tranches || [];
  const situationAttendu = situationLignes.reduce((s, t) => s + Number(t.montant_attendu || 0), 0);
  const situationVerse = situationLignes.reduce((s, t) => s + Number(t.montant_verse || 0), 0);
  const situationSolde = situation.etat ? Number(situation.etat.solde || 0) : situationAttendu - situationVerse;
  const chartSituation = useMemo(() => (situation.etat && (situationVerse + Math.max(situationSolde, 0) > 0) ? {
    type: 'doughnut',
    data: { labels: ['Versé', 'Solde restant'], datasets: [{ data: [situationVerse, Math.max(situationSolde, 0)], backgroundColor: [SUCCESS, DANGER_LIGHT], borderWidth: 2, borderColor: '#FFFFFF' }] },
    options: donutOptions('65%'),
  } : null), [situation.etat, situationVerse, situationSolde]);

  /* ── Paiements par classe (solvabilité) ── */
  const chargerRoster = async (classeId = roster.classe) => {
    if (!classeId) {
      toast('Veuillez choisir une classe.', 'error');
      return;
    }
    if (!annee) {
      toast('Aucune année scolaire active.', 'error');
      return;
    }
    const inscriptionsClasse = inscriptionsActives.filter((i) => String(i.classe_id) === String(classeId));
    if (!inscriptionsClasse.length) {
      setRoster((r) => ({ ...r, lignes: [], classeChargee: classeId, message: "Aucun élève inscrit (actif) dans cette classe pour l'année sélectionnée." }));
      return;
    }
    setRoster((r) => ({ ...r, loading: true }));
    const resultats = await Promise.all(inscriptionsClasse.map(async (insc) => {
      const eleve = elevesById[insc.eleve_id] || {};
      try {
        const etat = await api.get(`/paiements/etat/${insc.id}`);
        const tr = etat?.tranches || [];
        const totalAttendu = tr.reduce((s, t) => s + Number(t.montant_attendu || 0), 0);
        const totalVerse = tr.reduce((s, t) => s + Number(t.montant_verse || 0), 0);
        return {
          inscriptionId: insc.id,
          eleve,
          totalAttendu,
          totalVerse,
          solde: etat ? Number(etat.solde || 0) : totalAttendu - totalVerse,
          // solvabilite null côté serveur = aucun échéancier défini : ni solvable ni insolvable.
          statut: etat?.solvabilite || 'SANS_ECHEANCIER',
          tranchesEnRetard: tr.filter((t) => t.en_retard).map((t) => t.libelle),
        };
      } catch (err) {
        return { inscriptionId: insc.id, eleve, totalAttendu: 0, totalVerse: 0, solde: 0, statut: 'ERREUR', tranchesEnRetard: [], erreur: err.message };
      }
    }));
    resultats.sort((a, b) => `${a.eleve.nom || ''} ${a.eleve.prenom || ''}`.localeCompare(`${b.eleve.nom || ''} ${b.eleve.prenom || ''}`));
    const erreurs = resultats.filter((r) => r.statut === 'ERREUR').length;
    if (erreurs) toast(`Situation indisponible pour ${erreurs} élève(s).`, 'error');
    setRoster((r) => ({ ...r, lignes: resultats, classeChargee: classeId, loading: false, message: 'Aucune donnée à afficher.' }));
  };

  const rosterAffiche = roster.filtre ? roster.lignes.filter((r) => r.statut === roster.filtre) : roster.lignes;

  const imprimerRoster = (filtreStatut, titre) => {
    if (!roster.lignes.length) {
      toast("Chargez d'abord une classe avant d'imprimer.", 'error');
      return;
    }
    const lignes = filtreStatut ? roster.lignes.filter((r) => r.statut === filtreStatut) : roster.lignes;
    if (!lignes.length) {
      toast('Aucun élève ne correspond à cette liste.', 'error');
      return;
    }
    const ok = ouvrirImpression(construireHtmlImpression({ titreListe: titre, lignes, etablissement, classeNom: classeLabel(roster.classeChargee), anneeNom: anneeLabel(annee) }));
    if (!ok) toast('Veuillez autoriser les pop-ups pour imprimer la liste.', 'error');
  };

  /* ── État de solvabilité de l'établissement ── */
  const imprimerRapportSolvabilite = () => {
    if (!annee) {
      toast('Aucune année scolaire active.', 'error');
      return;
    }
    const pct = (n, d) => (d > 0 ? (n / d) * 100 : 0);
    // Même définition que paiements_services.calculer_solvabilite.
    const classesData = classes.filter((c) => effectifClasse(c.id) > 0).map((c) => {
      const tranchesClasse = tranchesDeLAnnee(c.id);
      const effectif = effectifClasse(c.id);
      const tr = tranchesClasse.map((t) => {
        const attenduTotal = Number(t.montant_attendu || 0) * effectif;
        const verseTotal = Number(tranchesTotals[t.id] || 0);
        return { libelle: t.libelle, attenduTotal, verseTotal, pct: Math.min(100, pct(verseTotal, attenduTotal)), dateLimite: t.date_limite };
      });
      let nbInsolvables = 0;
      let nbSolvables = 0;
      let nbSansEcheancier = 0;
      inscriptionsActives.filter((i) => String(i.classe_id) === String(c.id)).forEach((insc) => {
        if (!tranchesClasse.length) {
          nbSansEcheancier += 1;
          return;
        }
        const v = versements[insc.id] || {};
        const retard = tranchesClasse.some((t) => estExigible(t.date_limite) && Number(v[t.id] || 0) < Number(t.montant_attendu || 0));
        if (retard) nbInsolvables += 1;
        else nbSolvables += 1;
      });
      const totalAttendu = tr.reduce((s, t) => s + t.attenduTotal, 0);
      const totalVerse = tr.reduce((s, t) => s + t.verseTotal, 0);
      return {
        nom: classeLabel(c.id), effectif, totalAttendu, totalVerse, solde: totalAttendu - totalVerse,
        pctPaye: pct(totalVerse, totalAttendu),
        nbInsolvables, nbSolvables, nbSansEcheancier,
        pctInsolvable: pct(nbInsolvables, effectif),
        tranches: tr,
      };
    }).sort((a, b) => a.nom.localeCompare(b.nom));
    const g = classesData.reduce((acc, c) => ({
      effectif: acc.effectif + c.effectif,
      totalAttendu: acc.totalAttendu + c.totalAttendu,
      totalVerse: acc.totalVerse + c.totalVerse,
      nbInsolvables: acc.nbInsolvables + c.nbInsolvables,
      nbSolvables: acc.nbSolvables + c.nbSolvables,
      nbSansEcheancier: acc.nbSansEcheancier + c.nbSansEcheancier,
    }), { effectif: 0, totalAttendu: 0, totalVerse: 0, nbInsolvables: 0, nbSolvables: 0, nbSansEcheancier: 0 });
    g.solde = g.totalAttendu - g.totalVerse;
    g.pctPaye = pct(g.totalVerse, g.totalAttendu);
    g.pctInsolvable = pct(g.nbInsolvables, g.effectif);
    g.pctSolvable = pct(g.nbSolvables, g.effectif);
    const ok = ouvrirImpression(construireHtmlRapportSolvabilite({ rapport: { global: g, classes: classesData }, etablissement, anneeNom: anneeLabel(annee) }));
    if (!ok) toast('Veuillez autoriser les pop-ups pour imprimer le rapport.', 'error');
  };

  /* ── Actions ── */
  const exportCsv = () => {
    if (!paiementsAffiches.length) {
      toast('Aucun paiement à exporter.', 'error');
      return;
    }
    downloadCsv('paiements.csv', [
      ['Élève', 'Classe', 'N° Reçu', 'Montant total', 'Date', 'Mode de paiement', 'Statut'],
      ...paiementsAffiches.map((p) => {
        const insc = inscriptionsById[p.inscription_id];
        return [insc ? eleveLabel(insc.eleve_id) : `Inscription #${p.inscription_id}`, insc ? classeLabel(insc.classe_id) : '', p.numero_recu, p.montant_total, p.date_paiement || '', MODES_LABELS[p.mode_paiement] || p.mode_paiement || '', STATUT_LABELS[p.statut] || p.statut || ''];
      }),
    ]);
    toast('Le fichier CSV a été téléchargé.');
  };

  const supprimerTranche = async (t) => {
    const ok = await confirm("Supprimer cette tranche de paiement ? Impossible si des paiements y sont déjà rattachés (l'historique des versements n'est jamais supprimé silencieusement).");
    if (!ok) return;
    try {
      await api.del(`/tranches-classe/${t.id}`);
      toast('Tranche supprimée avec succès.');
      await loadTranchesEtPaiements();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const changeAnnee = (value) => {
    setAnnee(value);
    setRoster((r) => ({ ...r, lignes: [], classeChargee: null, message: 'Choisissez une classe puis cliquez sur "Afficher la classe".' }));
  };

  const afterSave = async (msg) => {
    setModal(null);
    toast(msg);
    await loadTranchesEtPaiements();
    // Les vues "Situation" et "Paiements par classe" sont chargées à la
    // demande : on les recharge pour ne pas afficher un solde périmé.
    if (situation.etat) chargerSituation();
    if (roster.classeChargee) chargerRoster(roster.classeChargee);
  };

  const tranchesGrid = tranchesDeLAnnee(filtreTrancheClasse);
  const classeOptions = classesTriees.map((c) => <option key={c.id} value={c.id}>{classeLabel(c.id)}</option>);
  const toggleChart = (key) => setChartsOpen((o) => ({ ...o, [key]: !o[key] }));

  return (
    <>
      <PageHeader title="Paiements" subtitle="Suivez l'échéancier par classe, les versements des élèves et leur situation financière.">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={async () => { await loadReferentiels(); await loadTranchesEtPaiements(); toast('Données actualisées.'); }}><i className="bx bx-refresh me-1" /> Actualiser</button>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={exportCsv}><i className="bx bx-export me-1" /> Exporter</button>
        <button type="button" className="btn btn-outline-primary btn-sm" onClick={imprimerRapportSolvabilite}><i className="bx bx-receipt me-1" /> Imprimer l'état de solvabilité</button>
        {/* Le SuperAdmin n'est pas un compte utilisateur d'établissement : il ne peut pas être agent encaisseur (cf. paiements_api.paiement_create). */}
        {!isSuperAdmin && <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'paiement' })}><i className="bx bx-plus me-1" /> Enregistrer un paiement</button>}
      </PageHeader>
      <OperationsEnAttente modules={MODULES_PAIEMENT} titre="Paiements pas encore enregistrés sur le serveur" />

      <div className="card mb-3">
        <div className="card-body py-3">
          <div className="d-flex flex-wrap gap-3">
            <div>
              <label className="form-label" htmlFor="filterAnnee">Année scolaire</label>
              <Select id="filterAnnee" className="form-select form-select-sm" style={{ minWidth: 180 }} value={annee} onChange={(e) => changeAnnee(e.target.value)}>
                {annees.length ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (Active)' : ''}</option>) : <option value="">{loading ? 'Chargement…' : 'Indisponible'}</option>}
              </Select>
            </div>
            <div>
              <label className="form-label" htmlFor="filterStatsClasse">Classe (statistiques)</label>
              <Select id="filterStatsClasse" className="form-select form-select-sm" style={{ minWidth: 200 }} value={statsClasse} onChange={(e) => setStatsClasse(e.target.value)}>
                <option value="">Tout l'établissement</option>
                {classeOptions}
              </Select>
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-4">
        <StatCard label="Montant attendu" loading={loading} value={formatMontant(stats.totalAttendu)} sub={statsClasse ? classeLabel(statsClasse) : "Tout l'établissement"} icon="bx-wallet" color="primary" />
        <StatCard label="Montant versé" loading={loading} value={formatMontant(stats.totalVerse)} sub={`${stats.taux}% de l'attendu`} icon="bx-money" color="success" />
        <StatCard label="Solde restant" loading={loading} value={formatMontant(stats.solde)} sub="À recouvrer" icon="bx-error" color="danger" />
        <StatCard label="Taux de recouvrement" loading={loading} value={`${stats.taux}%`} sub="Sur l'année active" icon="bx-pie-chart-alt" color="info" />
      </div>

      <div className="row g-3 mb-4">
        <div className="col-lg-5">
          <ChartCard open={chartsOpen.recouvrement} onToggle={() => toggleChart('recouvrement')} title="Versé vs solde restant" icon="bx-pie-chart-alt-2">
            {chartRecouvrement ? <ChartCanvas config={chartRecouvrement} height={230} /> : <div className="text-center text-muted py-5"><i className="bx bx-pie-chart-alt-2 bx-md mb-2" /><p className="mb-0 small">Aucune donnée disponible</p></div>}
          </ChartCard>
        </div>
        <div className="col-lg-7">
          <ChartCard open={chartsOpen.tranches} onToggle={() => toggleChart('tranches')} title="Attendu vs versé par classe" icon="bx-bar-chart-alt-2">
            {chartTranches ? <ChartCanvas config={chartTranches} height={230} /> : <div className="text-center text-muted py-5"><i className="bx bx-bar-chart-alt-2 bx-md mb-2" /><p className="mb-0 small">Aucune tranche définie pour cette année</p></div>}
          </ChartCard>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'paiements', icon: 'bx-receipt', label: 'Paiements enregistrés' },
          { key: 'situation', icon: 'bx-user-check', label: "Situation d'un élève" },
          { key: 'classe', icon: 'bx-group', label: 'Paiements par classe' },
          { key: 'tranches', icon: 'bx-layer', label: 'Échéancier (tranches)' },
        ]}
      />

      {tab === 'paiements' && (
        <TableCard
          title="Historique des paiements"
          icon="bx-receipt"
          count={paiementsAffiches.length}
          actions={(
            <>
              <Select className="form-select form-select-sm" style={{ minWidth: 170 }} value={filtresPaiements.classe} onChange={(e) => setFiltresPaiements((f) => ({ ...f, classe: e.target.value }))}><option value="">Toutes les classes</option>{classeOptions}</Select>
              <Select className="form-select form-select-sm" style={{ minWidth: 150 }} value={filtresPaiements.statut} onChange={(e) => setFiltresPaiements((f) => ({ ...f, statut: e.target.value }))}>
                <option value="">Tous les statuts</option>
                {Object.entries(STATUT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </>
          )}
          footer={<small className="text-muted"><i className="bx bx-info-circle me-1" />Un paiement mal saisi ne se corrige pas : il s'annule (motif obligatoire), puis se ressaisit.</small>}
        >
          <table className="table table-hover mb-0">
            <thead><tr><th>Élève</th><th>Classe</th><th>N° Reçu</th><th>Montant total</th><th>Date</th><th>Mode</th><th>Statut</th><th className="text-end">Actions</th></tr></thead>
            <TBody colSpan={8} loading={loading} rows={paiementsAffiches.length} empty="Aucun paiement enregistré pour ce filtre." emptyIcon="bx-archive">
              {paiementsAffiches.map((p) => {
                const insc = inscriptionsById[p.inscription_id];
                const nom = insc ? eleveLabel(insc.eleve_id) : `Inscription #${p.inscription_id}`;
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="d-flex align-items-center gap-2">
                        <span>{nom}</span>
                      </div>
                    </td>
                    <td>{insc ? classeLabel(insc.classe_id) : '—'}</td>
                    <td><code>{p.numero_recu}</code></td>
                    <td><strong>{formatMontant(p.montant_total)}</strong></td>
                    <td>{formatDateHeure(p.date_paiement)}</td>
                    <td>{p.mode_paiement ? <span className="badge bg-label-secondary">{MODES_LABELS[p.mode_paiement] || p.mode_paiement}</span> : <span className="text-muted">—</span>}</td>
                    <td><StatutPaiement statut={p.statut} /></td>
                    <td className="text-end text-nowrap">
                      <IconBtn icon="bx-show" title="Détail" onClick={() => setModal({ kind: 'detail', data: p })} />
                      {p.statut === 'VALIDE' && <IconBtn icon="bx-block" title="Annuler" danger onClick={() => setModal({ kind: 'annuler', data: p })} />}
                    </td>
                  </tr>
                );
              })}
            </TBody>
          </table>
        </TableCard>
      )}

      {tab === 'situation' && (
        <>
          <div className="card mb-3">
            <div className="card-body py-3 d-flex flex-wrap align-items-end gap-3">
              <div style={{ minWidth: 240 }}>
                <label className="form-label">Inscription (élève)</label>
                <Select className="form-select form-select-sm" value={situation.inscription} onChange={(e) => setSituation((s) => ({ ...s, inscription: e.target.value }))}>
                  <option value="">-- Choisir un élève --</option>
                  {inscriptionOptions}
                </Select>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={chargerSituation}><i className="bx bx-search me-1" /> Afficher la situation</button>
            </div>
          </div>
          <div className="row g-3">
            <div className="col-lg-4">
              <ChartCard open={chartsOpen.situation} onToggle={() => toggleChart('situation')} title="Répartition" icon="bx-pie-chart-alt-2">
                {chartSituation ? <ChartCanvas config={chartSituation} height={220} /> : <div className="text-center text-muted py-5"><i className="bx bx-user-check bx-md mb-2" /><p className="mb-0 small">Sélectionnez un élève pour voir sa situation</p></div>}
              </ChartCard>
            </div>
            <div className="col-lg-8">
              <TableCard
                title="Détail par tranche"
                icon="bx-table"
                footer={(
                  <div className="d-flex justify-content-between">
                    <small className="text-muted">Totaux généraux de l'élève sur l'année</small>
                    <small><strong>{situation.etat ? `Attendu ${formatMontant(situationAttendu)} · Versé ${formatMontant(situationVerse)} · Solde ${formatMontant(situationSolde)}` : '—'}</strong></small>
                  </div>
                )}
              >
                <table className="table table-hover mb-0">
                  <thead><tr><th>Tranche</th><th>Échéance</th><th>Attendu</th><th>Versé</th><th>Solde</th><th>Statut</th></tr></thead>
                  <TBody colSpan={6} loading={situation.loading} error={situation.error && `Erreur : ${situation.error}`} rows={situation.etat ? situationLignes.length : 0} empty={situation.etat ? 'Aucune tranche pour cette classe/année scolaire.' : 'Aucune situation chargée'}>
                    {situationLignes.map((t) => {
                      const statut = computeStatutTranche(t.montant_attendu, t.montant_verse);
                      return (
                        <tr key={t.tranche_classe_id} className={t.en_retard ? 'table-danger' : ''}>
                          <td>{t.libelle}</td>
                          <td>{formatDateCourt(t.date_limite)}</td>
                          <td>{formatMontant(t.montant_attendu)}</td>
                          <td>{formatMontant(t.montant_verse)}</td>
                          <td className={t.reste_du > 0 ? 'text-danger fw-semibold' : 'text-success fw-semibold'}>{formatMontant(t.reste_du)}</td>
                          <td><span className={`badge ${TRANCHE_BADGES[statut]}`}>{statut}</span>{t.en_retard && <EnRetard />}</td>
                        </tr>
                      );
                    })}
                  </TBody>
                </table>
              </TableCard>
            </div>
          </div>
        </>
      )}

      {tab === 'classe' && (
        <>
          <div className="card mb-3">
            <div className="card-body py-3 d-flex flex-wrap align-items-end gap-3">
              <div style={{ minWidth: 220 }}>
                <label className="form-label">Classe</label>
                <Select className="form-select form-select-sm" value={roster.classe} onChange={(e) => setRoster((r) => ({ ...r, classe: e.target.value }))}><option value="">-- Choisir une classe --</option>{classeOptions}</Select>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => chargerRoster()}><i className="bx bx-search me-1" /> Afficher la classe</button>
              <div className="ms-auto">
                <label className="form-label">Filtrer</label>
                <Select className="form-select form-select-sm" value={roster.filtre} onChange={(e) => setRoster((r) => ({ ...r, filtre: e.target.value }))}>
                  <option value="">Tous les élèves</option>
                  <option value="SOLVABLE">Solvables uniquement</option>
                  <option value="INSOLVABLE">Insolvables uniquement</option>
                </Select>
              </div>
            </div>
          </div>
          {roster.lignes.length > 0 && (
            <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
              <span className="badge bg-label-primary p-2"><i className="bx bx-group" /> {roster.lignes.length} élève(s)</span>
              <span className="badge bg-label-success p-2"><i className="bx bx-check-circle" /> {roster.lignes.filter((r) => r.statut === 'SOLVABLE').length} solvable(s)</span>
              <span className="badge bg-label-danger p-2"><i className="bx bx-x-circle" /> {roster.lignes.filter((r) => r.statut === 'INSOLVABLE').length} insolvable(s)</span>
              <div className="ms-auto d-flex gap-2">
                <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => imprimerRoster('SOLVABLE', 'Liste des élèves solvables')}><i className="bx bx-printer me-1" /> Imprimer solvables</button>
                <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => imprimerRoster('INSOLVABLE', 'Liste des élèves insolvables')}><i className="bx bx-printer me-1" /> Imprimer insolvables</button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => imprimerRoster(null, 'Situation financière de la classe')}><i className="bx bx-printer me-1" /> Imprimer la liste complète</button>
              </div>
            </div>
          )}
          <TableCard
            title="Situation financière de la classe"
            icon="bx-group"
            count={rosterAffiche.length}
            footer={(
              <small className="text-muted">
                <i className="bx bx-info-circle me-1" />
                <strong>Solvable</strong> : au moins une tranche déjà payée pour cette classe/année, et aucune tranche restante n'a d'échéance dépassée.
                <strong className="ms-2">Insolvable</strong> : aucune tranche payée du tout, OU au moins une tranche impayée dont la date limite est dépassée.
              </small>
            )}
          >
            <table className="table table-hover mb-0">
              <thead><tr><th>#</th><th>Matricule</th><th>Élève</th><th>Sexe</th><th>Attendu</th><th>Versé</th><th>Solde</th><th>Tranches en retard</th><th>Statut</th></tr></thead>
              <TBody colSpan={9} loading={roster.loading} rows={rosterAffiche.length} empty={roster.lignes.length ? 'Aucun élève ne correspond à ce filtre.' : roster.message}>
                {rosterAffiche.map((r, idx) => {
                  const nom = `${r.eleve.nom || ''} ${r.eleve.prenom || ''}`.trim();
                  return (
                    <tr key={r.inscriptionId}>
                      <td>{idx + 1}</td>
                      <td>{r.eleve.matricule || '—'}</td>
                      <td><div className="d-flex align-items-center gap-2"><span>{nom}</span></div></td>
                      <td>{r.eleve.sexe || '—'}</td>
                      <td>{formatMontant(r.totalAttendu)}</td>
                      <td>{formatMontant(r.totalVerse)}</td>
                      <td className={r.solde > 0 ? 'text-danger fw-semibold' : 'text-success fw-semibold'}>{formatMontant(r.solde)}</td>
                      <td>{r.tranchesEnRetard.length ? r.tranchesEnRetard.join(', ') : <span className="text-muted">Aucune</span>}</td>
                      <td><span className={`badge ${SOLVABILITE[r.statut].badge}`} title={r.erreur || ''}>{SOLVABILITE[r.statut].label}</span></td>
                    </tr>
                  );
                })}
              </TBody>
            </table>
          </TableCard>
        </>
      )}

      {tab === 'tranches' && (
        <div className="card">
          <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
            <h5 className="mb-0"><i className="bx bx-layer me-2 text-primary" />Tranches de l'échéancier <span className="badge rounded-pill bg-label-primary ms-2">{tranchesGrid.length}</span></h5>
            <div className="d-flex flex-wrap gap-2 align-items-center">
              <Select className="form-select form-select-sm" style={{ minWidth: 190 }} value={filtreTrancheClasse} onChange={(e) => setFiltreTrancheClasse(e.target.value)}><option value="">Toutes les classes</option>{classeOptions}</Select>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setModal({ kind: 'dupliquer' })}><i className="bx bx-copy me-1" /> Dupliquer l'échéancier</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'tranche', data: null })}><i className="bx bx-plus me-1" /> Nouvelle tranche</button>
            </div>
          </div>
          <div className="card-body">
            <div className="row g-3">
              {loading ? (
                <div className="col-12"><SkelListe lignes={3} label="Chargement des tranches…" /></div>
              ) : !tranchesGrid.length ? (
                <div className="col-12 text-center text-muted py-4"><i className="bx bx-archive me-2" />Aucune tranche définie pour ce filtre.</div>
              ) : tranchesGrid.map((t) => {
                // montant_attendu est un montant PAR ÉLÈVE : l'attendu de la
                // tranche pour la classe = montant × effectif actif.
                const verse = tranchesTotals[t.id] || 0;
                const montantUnitaire = Number(t.montant_attendu) || 0;
                const effectif = effectifClasse(t.classe_id);
                const attendu = montantUnitaire * effectif;
                const pct = attendu > 0 ? Math.min(100, Math.round((verse / attendu) * 100)) : 0;
                const enRetard = estExigible(t.date_limite) && verse < attendu;
                return (
                  <div key={t.id} className="col-md-6 col-xl-4">
                    <div className={`card border shadow-none h-100 ${enRetard ? 'border-danger' : ''}`}>
                      <div className="card-body">
                        <div className="d-flex justify-content-between align-items-start">
                          <div>
                            <div className="fw-semibold">{t.libelle}</div>
                            <small className="text-muted d-block">{classeLabel(t.classe_id)} · ordre {t.ordre}</small>
                            <small className="text-muted">{t.date_limite ? `Échéance : ${formatDateCourt(t.date_limite)}` : 'Due dès l’inscription'}{enRetard && <EnRetard />}</small>
                          </div>
                          <div className="text-nowrap">
                            <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setModal({ kind: 'tranche', data: t })} />
                            <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimerTranche(t)} />
                          </div>
                        </div>
                        <div className="progress mt-3" style={{ height: 6 }}>
                          <div className={`progress-bar ${pct >= 100 ? 'bg-success' : pct >= 50 ? 'bg-warning' : 'bg-danger'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="d-flex justify-content-between small mt-2"><span>Versé : <strong>{formatMontant(verse)}</strong></span><span>{pct}%</span></div>
                        <div className="small text-muted">Attendu : {formatMontant(attendu)} ({formatMontant(montantUnitaire)} × {effectif} élève{effectif > 1 ? 's' : ''})</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="card-footer">
            <small className="text-muted"><i className="bx bx-info-circle me-1" />Chaque tranche est propre à une classe et une année scolaire ; le montant saisi est dû par chaque élève. Attendu et versé portent sur les élèves inscrits actifs (paiements VALIDE uniquement).</small>
          </div>
        </div>
      )}

      {modal?.kind === 'tranche' && (
        <TrancheModal data={modal.data} classes={classesTriees} classeLabel={classeLabel} annee={annee} anneeLabel={anneeLabel(annee)} defaultClasse={filtreTrancheClasse} onClose={() => setModal(null)} onSaved={afterSave} />
      )}
      {modal?.kind === 'dupliquer' && (
        <DupliquerModal classes={classesTriees} classeLabel={classeLabel} annees={annees} defaultClasse={filtreTrancheClasse} defaultCible={annee} onClose={() => setModal(null)} onSaved={afterSave} />
      )}
      {modal?.kind === 'paiement' && (
        <PaiementModal
          inscriptionOptions={inscriptionOptions}
          inscriptionsById={inscriptionsById}
          elevesById={elevesById}
          parentLabel={parentLabel}
          tranches={tranches}
          paiements={paiements}
          eleveLabel={eleveLabel}
          onClose={() => setModal(null)}
          onSaved={afterSave}
        />
      )}
      {modal?.kind === 'detail' && (() => {
        const p = modal.data;
        const insc = inscriptionsById[p.inscription_id];
        return (
          <Modal size="" title={<><i className="bx bx-list-check me-2 text-primary" />Détail du paiement</>} onClose={() => setModal(null)} footer={<button type="button" className="btn btn-outline-secondary" onClick={() => setModal(null)}>Fermer</button>}>
            <div className="row g-2 mb-3 small">
              <div className="col-6"><strong>Élève :</strong> {insc ? eleveLabel(insc.eleve_id) : `Inscription #${p.inscription_id}`}</div>
              <div className="col-6"><strong>Classe :</strong> {insc ? classeLabel(insc.classe_id) : '—'}</div>
              <div className="col-6"><strong>Parent :</strong> {parentLabel(p.parent_id)}</div>
              <div className="col-6"><strong>N° reçu :</strong> {p.numero_recu}</div>
              <div className="col-6"><strong>Mode :</strong> {MODES_LABELS[p.mode_paiement] || p.mode_paiement || '—'}</div>
              <div className="col-6"><strong>Statut :</strong> <StatutPaiement statut={p.statut} /></div>
              {p.reference_transaction && <div className="col-12"><strong>Référence :</strong> {p.reference_transaction}</div>}
              {p.statut === 'ANNULE' && p.motif_annulation && <div className="col-12 text-danger"><strong>Motif d'annulation :</strong> {p.motif_annulation}</div>}
            </div>
            <table className="table table-sm mb-0">
              <thead><tr><th>Tranche</th><th className="text-end">Montant versé</th></tr></thead>
              <tbody>
                {(p.lignes || []).length ? p.lignes.map((l) => (
                  <tr key={l.id ?? l.tranche_classe_id}><td>{tranchesById[l.tranche_classe_id]?.libelle || `Tranche #${l.tranche_classe_id}`}</td><td className="text-end">{formatMontant(l.montant_verse)}</td></tr>
                )) : <tr><td colSpan={2} className="text-muted text-center">Aucune ligne</td></tr>}
              </tbody>
            </table>
          </Modal>
        );
      })()}
      {modal?.kind === 'annuler' && <AnnulerModal paiement={modal.data} onClose={() => setModal(null)} onSaved={afterSave} />}
      {confirmNode}
    </>
  );
}

function ChartCard({ open, onToggle, title, icon, children }) {
  return (
    <div className="card h-100">
      <div className="card-header d-flex align-items-center justify-content-between">
        <h5 className="mb-0"><i className={`bx ${icon} me-2 text-primary`} />{title}</h5>
        <button type="button" className="btn btn-icon btn-sm btn-outline-secondary" title="Réduire / dérouler" onClick={onToggle}>
          <i className={`bx ${open ? 'bx-chevrons-up' : 'bx-chevrons-down'}`} />
        </button>
      </div>
      {open && <div className="card-body">{children}</div>}
    </div>
  );
}

function ErrorBox({ error }) {
  return error ? <div className="alert alert-danger">{error}</div> : null;
}

function TrancheModal({ data, classes, classeLabel, annee, anneeLabel, defaultClasse, onClose, onSaved }) {
  const [form, setForm] = useState({
    classe_id: data ? String(data.classe_id) : defaultClasse || '',
    libelle: data?.libelle || '',
    ordre: data?.ordre ?? '',
    montant_attendu: data?.montant_attendu ?? '',
    date_limite: data?.date_limite || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  const submit = async () => {
    setError('');
    const payload = {
      classe_id: Number(form.classe_id),
      annee_scolaire_id: Number(annee),
      libelle: form.libelle.trim(),
      ordre: form.ordre,
      montant_attendu: form.montant_attendu,
      date_limite: form.date_limite || null,
    };
    if (!payload.classe_id || !payload.libelle || !payload.ordre || !payload.montant_attendu) {
      setError("Veuillez renseigner la classe, le libellé, l'ordre et le montant attendu.");
      return;
    }
    setSaving(true);
    try {
      if (data) await api.put(`/tranches-classe/${data.id}`, payload);
      else await api.post('/tranches-classe/', payload);
      await onSaved(data ? 'Tranche mise à jour avec succès.' : 'Tranche créée avec succès.');
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={<><i className="bx bx-layer me-2 text-primary" />{data ? 'Modifier la tranche' : 'Nouvelle tranche de paiement'}</>} onClose={onClose} onSubmit={submit} footer={<><button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>Annuler</button><button type="submit" className="btn btn-primary" disabled={saving}><i className="bx bx-check me-1" /> Enregistrer</button></>}>
      <ErrorBox error={error} />
      <div className="row g-3">
        <div className="col-md-6"><label className="form-label">Classe *</label><Select className="form-select" value={form.classe_id} onChange={set('classe_id')}><option value="">-- Choisir une classe --</option>{classes.map((c) => <option key={c.id} value={c.id}>{classeLabel(c.id)}</option>)}</Select></div>
        <div className="col-md-6"><label className="form-label">Année scolaire</label><Select className="form-select" disabled><option>{anneeLabel || '—'}</option></Select></div>
        <div className="col-md-8"><label className="form-label">Libellé *</label><input type="text" className="form-control" maxLength={100} placeholder="Ex : 1ère tranche" value={form.libelle} onChange={set('libelle')} /></div>
        <div className="col-md-4"><label className="form-label">Ordre *</label><input type="number" className="form-control" min="1" step="1" placeholder="1" value={form.ordre} onChange={set('ordre')} /></div>
        <div className="col-md-6"><label className="form-label">Montant attendu (FCFA) *</label><input type="number" className="form-control" min="1" step="1" placeholder="Ex : 50000" value={form.montant_attendu} onChange={set('montant_attendu')} /></div>
        <div className="col-md-6"><label className="form-label">Date limite</label><input type="date" className="form-control" value={form.date_limite} onChange={set('date_limite')} /></div>
      </div>
    </Modal>
  );
}

function DupliquerModal({ classes, classeLabel, annees, defaultClasse, defaultCible, onClose, onSaved }) {
  const [form, setForm] = useState({ classe: defaultClasse || '', source: '', cible: defaultCible || '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  const submit = async () => {
    setError('');
    if (!form.classe || !form.source || !form.cible) {
      setError("Veuillez renseigner la classe, l'année source et l'année cible.");
      return;
    }
    if (form.source === form.cible) {
      setError("L'année source et l'année cible doivent être différentes.");
      return;
    }
    setSaving(true);
    try {
      const creees = await api.post('/tranches-classe/dupliquer', { classe_id: Number(form.classe), annee_source_id: Number(form.source), annee_cible_id: Number(form.cible) });
      await onSaved(`${(creees || []).length} tranche(s) dupliquée(s) avec succès.`);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const anneeOptions = annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}</option>);
  return (
    <Modal size="" title={<><i className="bx bx-copy me-2 text-primary" />Dupliquer l'échéancier d'une classe</>} onClose={onClose} onSubmit={submit} footer={<><button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>Annuler</button><button type="submit" className="btn btn-primary" disabled={saving}><i className="bx bx-copy me-1" /> Dupliquer</button></>}>
      <ErrorBox error={error} />
      <p className="text-muted small">Copie toutes les tranches d'une classe depuis une année source vers une année cible (montants et dates limites inclus, modifiables ensuite individuellement).</p>
      <div className="mb-3"><label className="form-label">Classe *</label><Select className="form-select" value={form.classe} onChange={set('classe')}><option value="">-- Choisir une classe --</option>{classes.map((c) => <option key={c.id} value={c.id}>{classeLabel(c.id)}</option>)}</Select></div>
      <div className="row g-3">
        <div className="col-md-6"><label className="form-label">Année source *</label><Select className="form-select" value={form.source} onChange={set('source')}><option value="">--</option>{anneeOptions}</Select></div>
        <div className="col-md-6"><label className="form-label">Année cible *</label><Select className="form-select" value={form.cible} onChange={set('cible')}><option value="">--</option>{anneeOptions}</Select></div>
      </div>
    </Modal>
  );
}

function PaiementModal({ inscriptionOptions, inscriptionsById, elevesById, parentLabel, tranches, paiements, eleveLabel, onClose, onSaved }) {
  const [inscriptionId, setInscriptionId] = useState('');
  const [etat, setEtat] = useState({ loading: false, error: '', tranches: null });
  const [lignes, setLignes] = useState({}); // { trancheId: { checked, montant } }
  // numero_recu vide = généré par le serveur (unique, 20 caractères max).
  const [form, setForm] = useState({ numero_recu: '', mode_paiement: '', reference_transaction: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dateAffichee] = useState(() => new Date().toLocaleString('fr-FR'));

  const insc = inscriptionsById[inscriptionId];
  const parentId = insc ? elevesById[insc.eleve_id]?.parent_id : null;

  // Encaissements de cet élève saisis hors connexion et pas encore envoyés :
  // déduits du reste dû, pour ne jamais encaisser deux fois la même tranche.
  const attente = useOperationsEnAttente('paiement');
  const enAttenteParTranche = useMemo(() => {
    const res = {};
    Object.values(attente).filter((op) => !op.refus && String(op.body.inscription_id) === String(inscriptionId))
      .forEach((op) => (op.body.lignes || []).forEach((l) => { res[l.tranche_classe_id] = (res[l.tranche_classe_id] || 0) + Number(l.montant_verse || 0); }));
    return res;
  }, [attente, inscriptionId]);
  const resteEffectif = (t) => Math.max(Number(t.reste_du || 0) - (enAttenteParTranche[t.tranche_classe_id] || 0), 0);

  const choisirInscription = async (id) => {
    setInscriptionId(id);
    setLignes({});
    setEtat({ loading: Boolean(id), error: '', tranches: null });
    if (!id) return;
    let tr;
    let horsLigne = false;
    try {
      tr = (await api.get(`/paiements/etat/${id}`))?.tranches || [];
    } catch (err) {
      const inscription = inscriptionsById[id];
      if (err.status !== 0 || !inscription) {
        setEtat({ loading: false, error: err.message, tranches: null });
        return;
      }
      tr = etatLocal(inscription, tranches, paiements);
      horsLigne = true;
    }
    setEtat({ loading: false, error: '', tranches: tr, horsLigne });
    setLignes(Object.fromEntries(tr.map((t) => {
      const reste = resteEffectif(t);
      return [t.tranche_classe_id, { checked: false, montant: reste > 0 ? String(reste) : '' }];
    })));
  };

  const montantTotal = Object.values(lignes).reduce((s, l) => s + (l.checked ? Number(l.montant || 0) : 0), 0);
  const setLigne = (id, patch) => setLignes((ls) => ({ ...ls, [id]: { ...ls[id], ...patch } }));
  const resteDu = (trancheId) => {
    const t = etat.tranches?.find((x) => x.tranche_classe_id === trancheId);
    return t ? resteEffectif(t) : 0;
  };

  const submit = async () => {
    setError('');
    const selection = Object.entries(lignes).filter(([, l]) => l.checked).map(([id, l]) => ({ tranche_classe_id: Number(id), montant_verse: Number(l.montant || 0) }));
    if (!inscriptionId) return setError('Veuillez choisir un élève.');
    if (!parentId) return setError("Cet élève n'a pas de parent rattaché : impossible d'enregistrer un paiement.");
    if (!selection.length) return setError('Veuillez cocher au moins une tranche à régler.');
    if (selection.some((l) => !l.montant_verse || l.montant_verse <= 0)) return setError('Chaque tranche cochée doit avoir un montant versé strictement positif.');
    if (selection.some((l) => l.montant_verse > resteDu(l.tranche_classe_id))) return setError('Le montant versé sur une tranche ne peut pas dépasser son reste dû.');
    if (!form.mode_paiement) return setError('Veuillez choisir le mode de paiement.');
    setSaving(true);
    try {
      // Clé d'idempotence : un renvoi (réponse perdue, synchronisation
      // rejouée) ne peut jamais encaisser deux fois ce paiement.
      const cle = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : nouvelleCle('p');
      const nom = insc ? eleveLabel(insc.eleve_id) : `Inscription n°${inscriptionId}`;
      const res = await enregistrer({
        cle: `paiement|${cle}`,
        module: 'paiement',
        methode: 'POST',
        url: '/paiements/',
        body: {
          inscription_id: Number(inscriptionId),
          parent_id: Number(parentId),
          numero_recu: form.numero_recu.trim() || null,
          montant_total: montantTotal,
          mode_paiement: form.mode_paiement,
          reference_transaction: form.reference_transaction.trim() || null,
          lignes: selection,
          cle_idempotence: cle,
          eleve_label: nom,
        },
        // Participe au contrôle des doublons probables (même élève, même
        // montant, même jour) : l'utilisateur confirme ou abandonne.
        versionBase: null,
        libelle: `${nom} — ${formatMontant(montantTotal)} (${MODES_LABELS[form.mode_paiement] || form.mode_paiement})`,
        conserverSiRefus: true,
      });
      await terminerEnregistrement(res, { onSaved, ok: 'Paiement enregistré avec succès.' });
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
    return undefined;
  };

  return (
    <Modal title={<><i className="bx bx-receipt me-2 text-primary" />Enregistrer un paiement</>} onClose={onClose} onSubmit={submit} footer={<><button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>Annuler</button><button type="submit" className="btn btn-primary" disabled={saving}><i className="bx bx-check me-1" /> Enregistrer le paiement</button></>}>
      <ErrorBox error={error} />
      <div className="row g-3">
        <div className="col-md-7"><label className="form-label">Élève (inscription) *</label><Select className="form-select" value={inscriptionId} onChange={(e) => choisirInscription(e.target.value)}><option value="">-- Choisir un élève --</option>{inscriptionOptions}</Select></div>
        <div className="col-md-5"><label className="form-label">Parent payeur</label><input type="text" className="form-control" disabled placeholder="—" value={parentId ? parentLabel(parentId) : ''} /></div>
        <div className="col-12">
          <label className="form-label">Tranches à régler *</label>
          {etat.horsLigne && <div className="small text-warning mb-1"><i className="bx bx-wifi-off me-1" />Hors connexion : échéancier calculé à partir des données enregistrées sur l'appareil (dernière synchronisation).</div>}
          <div className="border rounded p-2" style={{ maxHeight: 220, overflow: 'auto' }}>
            {!inscriptionId ? (
              <div className="text-muted text-center py-3 small">Choisissez d'abord un élève pour voir son échéancier.</div>
            ) : etat.loading ? (
              <SkelListe lignes={3} label="Chargement de l'échéancier…" />
            ) : etat.error ? (
              <div className="text-danger text-center py-3 small">{etat.error}</div>
            ) : !etat.tranches?.length ? (
              <div className="text-muted text-center py-3 small">Aucune tranche définie pour la classe/année de cet élève.</div>
            ) : etat.tranches.map((t) => {
              const reste = resteEffectif(t);
              const enAttente = enAttenteParTranche[t.tranche_classe_id] || 0;
              const l = lignes[t.tranche_classe_id] || {};
              return (
                <div key={t.tranche_classe_id} className="d-flex align-items-center gap-2 py-1">
                  <div className="form-check mb-0" style={{ flex: '0 0 24px' }}>
                    <input className="form-check-input" type="checkbox" disabled={reste <= 0} checked={Boolean(l.checked)} onChange={(e) => setLigne(t.tranche_classe_id, { checked: e.target.checked })} />
                  </div>
                  <div className="flex-grow-1">
                    <div><strong>{t.libelle}</strong>{t.en_retard && <EnRetard />}</div>
                    <small className="text-muted">
                      Attendu {formatMontant(t.montant_attendu)} · Déjà versé {formatMontant(t.montant_verse)}{enAttente > 0 && ` (+ ${formatMontant(enAttente)} en attente d'envoi)`} · Reste dû {formatMontant(reste)}
                      {t.date_limite && ` · Échéance ${formatDateCourt(t.date_limite)}`}
                    </small>
                  </div>
                  <div style={{ width: 140 }}>
                    <input type="number" className="form-control form-control-sm" min="1" max={reste} step="1" placeholder="Montant" disabled={reste <= 0} value={l.montant ?? ''} onChange={(e) => setLigne(t.tranche_classe_id, { montant: e.target.value })} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="col-md-4"><label className="form-label">Montant total (FCFA) *</label><input type="number" className="form-control" readOnly value={montantTotal || ''} /></div>
        <div className="col-md-4"><label className="form-label">N° de reçu</label><input type="text" className="form-control" maxLength={20} placeholder={navigator.onLine === false ? 'Attribué à la synchronisation' : 'Généré automatiquement'} value={form.numero_recu} onChange={(e) => setForm((f) => ({ ...f, numero_recu: e.target.value }))} /></div>
        <div className="col-md-4"><label className="form-label">Date du paiement</label><input type="text" className="form-control" disabled value={dateAffichee} /></div>
        <div className="col-md-6">
          <label className="form-label">Mode de paiement *</label>
          <Select className="form-select" value={form.mode_paiement} onChange={(e) => setForm((f) => ({ ...f, mode_paiement: e.target.value }))}>
            <option value="">-- Choisir --</option>
            {Object.entries(MODES_LABELS).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
          </Select>
        </div>
        <div className="col-md-6"><label className="form-label">Référence de transaction</label><input type="text" className="form-control" maxLength={50} placeholder="Optionnel" value={form.reference_transaction} onChange={(e) => setForm((f) => ({ ...f, reference_transaction: e.target.value }))} /></div>
      </div>
    </Modal>
  );
}

function AnnulerModal({ paiement, onClose, onSaved }) {
  const [motif, setMotif] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    if (!motif.trim()) {
      setError("Le motif d'annulation est obligatoire.");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/paiements/${paiement.id}/annuler`, { motif_annulation: motif.trim() });
      await onSaved('Paiement annulé avec succès.');
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <Modal size="" title={<span className="text-danger"><i className="bx bx-block me-2" />Annuler ce paiement</span>} onClose={onClose} onSubmit={submit} footer={<><button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>Fermer</button><button type="submit" className="btn btn-danger" disabled={saving}><i className="bx bx-block me-1" /> Confirmer l'annulation</button></>}>
      <ErrorBox error={error} />
      <p className="text-muted small">L'annulation neutralise immédiatement ce paiement (et toutes ses lignes) dans les calculs de solde. Cette action est irréversible.</p>
      <label className="form-label">Motif de l'annulation *</label>
      <textarea className="form-control" rows={3} placeholder="Ex : erreur de saisie sur le montant" value={motif} onChange={(e) => setMotif(e.target.value)} />
    </Modal>
  );
}

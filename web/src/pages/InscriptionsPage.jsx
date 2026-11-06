import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { enregistrer, nouvelleCle, terminerEnregistrement, useApresSynchro } from '../lib/offline';
import OperationsEnAttente from '../components/OperationsEnAttente';
import Modal from '../components/Modal';
import ChartCanvas, { ChartEmpty, ChartPanel } from '../components/ChartCanvas';
import { useAuth } from '../context/AuthContext';
import {
  classeLabel as baseClasseLabel, downloadCsv, FilterChips, formatDate, IconBtn, PageHeader, Pager, SortTh, StatCard,
  TableCard, TBody, useConfirm, usePagination, useToast,
} from '../components/ui';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import Select from '../components/Select';
import GenerateurListeClasse from '../components/ListeClasse';

// Portage de server/static/templates/inscription.html : registre des
// inscriptions, analyses, générateur de listes de classe imprimables et
// formulaire (élève existant ou créé à la volée, avec son parent).
// Hors connexion : l'inscription (dossier parent + élève + inscription) est
// gardée sur l'appareil et envoyée au retour du réseau ; un doublon (parent,
// matricule, élève déjà inscrit) est soumis à l'utilisateur.

const PRIMARY = '#696cff';
const INFO = '#03c3ec';
const PINK = '#EC4899';
const MUTED = '#a1acb8';
const GRID = { color: '#eceef1' };
const MOIS_SCOLAIRES = [8, 9, 10, 11, 0, 1, 2, 3, 4, 5, 6, 7];
const MOIS_NOMS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const STATUTS = ['Actif', 'Suspendu', 'Radié', 'Transféré'];
const STATUT_BADGES = { Actif: 'bg-label-success', Suspendu: 'bg-label-warning', Radié: 'bg-label-danger', Transféré: 'bg-label-info' };

const iso = (d) => d.toISOString().slice(0, 10);
const EMPTY_FILTERS = { q: '', cycle: '', classe: '', statut: '', sexe: '', du: '', au: '', raccourci: '' };

function StatutBadge({ statut }) {
  const v = statut || 'Actif';
  return <span className={`badge ${STATUT_BADGES[v] || 'bg-label-secondary'}`}>{v}</span>;
}

const MODULES_INSCRIPTION = ['dossier_inscription', 'inscription', 'eleve', 'parent'];

export default function InscriptionsPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { activeEtablissementId } = useAuth();
  const etablissement = useEtablissementCourant();

  const [data, setData] = useState({ inscriptions: [], eleves: [], parents: [], classes: [], cycles: [], annees: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [annee, setAnnee] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState({ key: 'nom', asc: true });
  const [panels, setPanels] = useState({ classe: true, annee: false, mois: false });
  const [ch, setCh] = useState({ anneeClasse: '', cycleClasse: '', detailClasse: 'total', compareClasse: '', classeAnnee: '', cycleAnnee: '', detailAnnee: 'total', anneeMois: '', classeMois: '', vueMois: 'mois', compareMois: '' });
  const [anneeListe, setAnneeListe] = useState('');
  const [formModal, setFormModal] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [inscriptions, eleves, parents, classes, cycles, annees] = await Promise.all([
        api.get('/inscriptions/'), api.get('/eleves/'), api.get('/parents/'),
        api.get('/classes/'), api.get('/cycles/'), api.get('/annees-scolaires/'),
      ]);
      annees.sort((a, b) => String(b.libelle).localeCompare(String(a.libelle)));
      setData({ inscriptions: inscriptions || [], eleves: eleves || [], parents: parents || [], classes: classes || [], cycles: cycles || [], annees });
      const def = String((annees.find((a) => a.active) || annees[0])?.id ?? '');
      setAnnee((prev) => prev || def);
      setCh((prev) => ({ ...prev, anneeClasse: prev.anneeClasse || def, anneeMois: prev.anneeMois || def }));
      setAnneeListe((prev) => prev || def);
    } catch (err) {
      setError(err.message);
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadAll();
  }, [loadAll, activeEtablissementId]);
  useApresSynchro(MODULES_INSCRIPTION, loadAll);

  const { inscriptions, eleves, parents, classes, cycles, annees } = data;
  const eleveById = useMemo(() => Object.fromEntries(eleves.map((e) => [e.id, e])), [eleves]);
  const parentById = useMemo(() => Object.fromEntries(parents.map((p) => [p.id, p])), [parents]);
  const classeById = useMemo(() => Object.fromEntries(classes.map((c) => [c.id, c])), [classes]);
  const classeLabel = useCallback((c) => (c ? baseClasseLabel(c, cycles, ' · ') : '—'), [cycles]);
  const anneeLabel = useCallback((id) => annees.find((a) => a.id === Number(id))?.libelle || (id ? `Année #${id}` : '—'), [annees]);
  const classesTriees = useMemo(() => [...classes].sort((a, b) => classeLabel(a).localeCompare(classeLabel(b))), [classes, classeLabel]);

  /* ── Chiffres clés ── */
  const stats = useMemo(() => {
    const anneeId = Number(annee) || null;
    const list = inscriptions.filter((i) => !anneeId || i.annee_scolaire_id === anneeId);
    const actives = list.filter((i) => (i.statut || 'Actif') === 'Actif').length;
    const classesOuvertes = new Set(list.map((i) => i.classe_id)).size;
    const now = new Date();
    const ceMois = list.filter((i) => {
      if (!i.date_inscription) return false;
      const d = new Date(i.date_inscription);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    return { total: list.length, distincts: new Set(list.map((i) => i.eleve_id)).size, actives, classesOuvertes, ceMois, moisLabel: `${MOIS_NOMS[now.getMonth()]} ${now.getFullYear()}` };
  }, [inscriptions, annee]);

  /* ── Filtres / tri ── */
  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const anneeId = Number(annee) || null;
    const list = inscriptions.filter((i) => {
      if (anneeId && i.annee_scolaire_id !== anneeId) return false;
      if (filters.classe && i.classe_id !== Number(filters.classe)) return false;
      if (filters.cycle) {
        const c = classeById[i.classe_id];
        if (!c || c.cycle_id !== Number(filters.cycle)) return false;
      }
      if (filters.statut && (i.statut || 'Actif') !== filters.statut) return false;
      const e = eleveById[i.eleve_id];
      if (filters.sexe && (!e || e.sexe !== filters.sexe)) return false;
      if (q && !`${e?.nom || ''} ${e?.prenom || ''} ${e?.matricule || ''}`.toLowerCase().includes(q)) return false;
      if (filters.du && (!i.date_inscription || i.date_inscription < filters.du)) return false;
      if (filters.au && (!i.date_inscription || i.date_inscription > filters.au)) return false;
      return true;
    });
    const val = (i) => {
      if (sort.key === 'classe') return classeLabel(classeById[i.classe_id]).toLowerCase();
      if (sort.key === 'date') return i.date_inscription || '';
      const e = eleveById[i.eleve_id];
      return `${e?.nom || ''} ${e?.prenom || ''}`.toLowerCase();
    };
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return sort.asc ? -1 : 1;
      if (va > vb) return sort.asc ? 1 : -1;
      return 0;
    });
  }, [inscriptions, filters, sort, annee, classeById, eleveById, classeLabel]);

  const pagination = usePagination(filtered, 50);
  const setFilter = (name) => (ev) => { setFilters((f) => ({ ...f, [name]: ev.target.value })); pagination.reset(); };

  const applyRaccourci = (v) => {
    const now = new Date();
    let du = '';
    let au = '';
    if (v === 'mois') {
      du = iso(new Date(now.getFullYear(), now.getMonth(), 1));
      au = iso(now);
    } else if (v === 'rentree') {
      const y = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
      du = iso(new Date(y, 8, 1));
      au = iso(now);
    } else if (v) {
      const d = new Date(now);
      d.setDate(d.getDate() - Number(v));
      du = iso(d);
      au = iso(now);
    }
    setFilters((f) => ({ ...f, raccourci: v, du, au }));
    pagination.reset();
  };

  const chips = [
    filters.q && ['q', `« ${filters.q.trim().toLowerCase()} »`],
    filters.cycle && ['cycle', cycles.find((c) => c.id === Number(filters.cycle))?.libelle || 'Cycle'],
    filters.classe && ['classe', classeLabel(classeById[filters.classe])],
    filters.statut && ['statut', filters.statut],
    filters.sexe && ['sexe', filters.sexe === 'M' ? 'Garçons' : 'Filles'],
    filters.du && ['du', `à partir du ${formatDate(filters.du)}`],
    filters.au && ['au', `jusqu'au ${formatDate(filters.au)}`],
  ].filter(Boolean);
  const clearChip = (key) => {
    setFilters((f) => ({ ...f, [key]: '', ...(key === 'du' || key === 'au' ? { raccourci: '' } : {}) }));
    pagination.reset();
  };

  const changeAnnee = (value) => {
    setAnnee(value);
    setCh((c) => ({ ...c, anneeClasse: value, anneeMois: value }));
    setAnneeListe(value);
    pagination.reset();
  };

  /* ── Graphiques ── */
  const chartClasse = useMemo(() => {
    const anneeId = Number(ch.anneeClasse) || null;
    const compareId = Number(ch.compareClasse) || null;
    const cycleId = Number(ch.cycleClasse) || null;
    const detail = ch.detailClasse;
    const agrege = (aId) => {
      const b = {};
      inscriptions.forEach((i) => {
        if (aId && i.annee_scolaire_id !== aId) return;
        const c = classeById[i.classe_id];
        if (!c || (cycleId && c.cycle_id !== cycleId)) return;
        const k = (b[i.classe_id] ||= { total: 0, M: 0, F: 0, Actif: 0, Autre: 0 });
        k.total++;
        const e = eleveById[i.eleve_id];
        if (e && (e.sexe === 'M' || e.sexe === 'F')) k[e.sexe]++;
        if ((i.statut || 'Actif') === 'Actif') k.Actif++; else k.Autre++;
      });
      return b;
    };
    const base = agrege(anneeId);
    const comp = compareId ? agrege(compareId) : null;
    const ids = Array.from(new Set([...Object.keys(base), ...(comp ? Object.keys(comp) : [])])).map(Number)
      .sort((a, b) => classeLabel(classeById[a]).localeCompare(classeLabel(classeById[b])));
    const totaux = ids.map((id) => base[id]?.total || 0);
    const total = totaux.reduce((s, v) => s + v, 0);
    const meta = `${anneeLabel(anneeId)} · ${total} inscription${total > 1 ? 's' : ''}`;
    if (!ids.length) return { meta, config: null };
    let datasets;
    if (detail === 'sexe') {
      datasets = [
        { label: 'Garçons', data: ids.map((id) => base[id]?.M || 0), backgroundColor: INFO, borderRadius: 3, stack: 's' },
        { label: 'Filles', data: ids.map((id) => base[id]?.F || 0), backgroundColor: PINK, borderRadius: 3, stack: 's' },
      ];
    } else if (detail === 'statut') {
      datasets = [
        { label: 'Actives', data: ids.map((id) => base[id]?.Actif || 0), backgroundColor: '#71dd37', borderRadius: 3, stack: 's' },
        { label: 'Autres statuts', data: ids.map((id) => base[id]?.Autre || 0), backgroundColor: '#ffab00', borderRadius: 3, stack: 's' },
      ];
    } else {
      datasets = [{ label: anneeLabel(anneeId), data: totaux, backgroundColor: PRIMARY, borderRadius: 4, maxBarThickness: 34 }];
    }
    if (comp) datasets.push({ label: anneeLabel(compareId), data: ids.map((id) => comp[id]?.total || 0), backgroundColor: MUTED, borderRadius: 4, maxBarThickness: 34 });
    const stacked = detail !== 'total' && !comp;
    const nonVides = ids.filter((id) => base[id]?.total > 0).sort((a, b) => base[b].total - base[a].total);
    return {
      meta,
      config: {
        type: 'bar',
        data: { labels: ids.map((id) => classeLabel(classeById[id])), datasets },
        options: {
          plugins: { legend: { display: datasets.length > 1, position: 'bottom' } },
          scales: { x: { stacked, grid: { display: false }, ticks: { maxRotation: 60 } }, y: { stacked, beginAtZero: true, grid: GRID, ticks: { precision: 0 } } },
        },
      },
      kpis: nonVides.length ? {
        max: `${classeLabel(classeById[nonVides[0]])} (${base[nonVides[0]].total})`,
        min: `${classeLabel(classeById[nonVides.at(-1)])} (${base[nonVides.at(-1)].total})`,
        moy: `${Math.round(total / nonVides.length)} élèves`,
      } : { max: '—', min: '—', moy: '—' },
    };
  }, [ch.anneeClasse, ch.compareClasse, ch.cycleClasse, ch.detailClasse, inscriptions, classeById, eleveById, classeLabel, anneeLabel]);

  const chartAnnee = useMemo(() => {
    const classeId = Number(ch.classeAnnee) || null;
    const cycleId = Number(ch.cycleAnnee) || null;
    const parSexe = ch.detailAnnee === 'sexe';
    const ordered = [...annees].sort((a, b) => String(a.libelle).localeCompare(String(b.libelle)));
    const labels = ordered.map((a) => a.libelle);
    const compte = (anneeId, sexe) => inscriptions.filter((i) => {
      if (i.annee_scolaire_id !== anneeId) return false;
      if (classeId && i.classe_id !== classeId) return false;
      if (cycleId) {
        const c = classeById[i.classe_id];
        if (!c || c.cycle_id !== cycleId) return false;
      }
      if (sexe) {
        const e = eleveById[i.eleve_id];
        if (!e || e.sexe !== sexe) return false;
      }
      return true;
    }).length;
    const totaux = ordered.map((a) => compte(a.id, null));
    const somme = totaux.reduce((s, v) => s + v, 0);
    if (!somme) return { meta: '', config: null, kpis: { derniere: '—', delta: '—', deltaColor: '', max: '—' } };
    const datasets = parSexe
      ? [
        { label: 'Garçons', data: ordered.map((a) => compte(a.id, 'M')), backgroundColor: INFO, borderColor: INFO, borderRadius: 3, stack: 's' },
        { label: 'Filles', data: ordered.map((a) => compte(a.id, 'F')), backgroundColor: PINK, borderColor: PINK, borderRadius: 3, stack: 's' },
      ]
      : [{ label: 'Inscriptions', data: totaux, borderColor: PRIMARY, backgroundColor: 'rgba(105,108,255,0.12)', fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: PRIMARY, borderWidth: 2 }];
    const dernier = totaux.at(-1);
    const avant = totaux.length > 1 ? totaux.at(-2) : null;
    const delta = avant ? Math.round(((dernier - avant) / avant) * 100) : null;
    const maxIdx = totaux.indexOf(Math.max(...totaux));
    return {
      meta: `${ordered.length} années · ${somme} inscriptions`,
      config: {
        type: parSexe ? 'bar' : 'line',
        data: { labels, datasets },
        options: {
          plugins: { legend: { display: parSexe, position: 'bottom' } },
          scales: { x: { stacked: parSexe, grid: { display: false } }, y: { stacked: parSexe, beginAtZero: true, grid: GRID, ticks: { precision: 0 } } },
        },
      },
      kpis: {
        derniere: `${labels.at(-1)} : ${dernier}`,
        delta: delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta} %`,
        deltaColor: delta == null ? '' : delta >= 0 ? 'text-success' : 'text-danger',
        max: `${labels[maxIdx]} (${totaux[maxIdx]})`,
      },
    };
  }, [ch.classeAnnee, ch.cycleAnnee, ch.detailAnnee, annees, inscriptions, classeById, eleveById]);

  const chartMois = useMemo(() => {
    const anneeId = Number(ch.anneeMois) || null;
    const compareId = Number(ch.compareMois) || null;
    const classeId = Number(ch.classeMois) || null;
    const cumul = ch.vueMois === 'cumul';
    const serie = (aId) => {
      const parMois = new Array(12).fill(0);
      inscriptions.forEach((i) => {
        if (aId && i.annee_scolaire_id !== aId) return;
        if (classeId && i.classe_id !== classeId) return;
        if (!i.date_inscription) return;
        const d = new Date(i.date_inscription);
        if (!Number.isNaN(d.getTime())) parMois[d.getMonth()]++;
      });
      let values = MOIS_SCOLAIRES.map((m) => parMois[m]);
      const total = values.reduce((s, v) => s + v, 0);
      if (cumul) {
        let acc = 0;
        values = values.map((v) => (acc += v));
      }
      return { values, total };
    };
    const base = serie(anneeId);
    const comp = compareId ? serie(compareId) : null;
    const meta = `${anneeLabel(anneeId)} · ${base.total} inscription${base.total > 1 ? 's' : ''}`;
    if (!base.total && (!comp || !comp.total)) return { meta, config: null };
    const datasets = [{ label: anneeLabel(anneeId), data: base.values, borderColor: PRIMARY, backgroundColor: cumul ? 'rgba(105,108,255,0.12)' : PRIMARY, fill: cumul, tension: 0.35, pointRadius: 3, borderWidth: 2, borderRadius: 4, maxBarThickness: 30 }];
    if (comp) datasets.push({ label: anneeLabel(compareId), data: comp.values, borderColor: MUTED, backgroundColor: cumul ? 'rgba(148,163,184,0.15)' : MUTED, fill: cumul, tension: 0.35, pointRadius: 3, borderWidth: 2, borderDash: cumul ? [5, 4] : [], borderRadius: 4, maxBarThickness: 30 });
    return {
      meta,
      config: {
        type: cumul ? 'line' : 'bar',
        data: { labels: MOIS_SCOLAIRES.map((m) => `${MOIS_NOMS[m].slice(0, 4)}.`), datasets },
        options: { plugins: { legend: { display: !!comp, position: 'bottom' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: GRID, ticks: { precision: 0 } } } },
      },
    };
  }, [ch.anneeMois, ch.compareMois, ch.classeMois, ch.vueMois, inscriptions, anneeLabel]);

  const allOpen = Object.values(panels).every(Boolean);
  const togglePanel = (key) => setPanels((p) => ({ ...p, [key]: !p[key] }));
  const setChField = (name) => (e) => setCh((c) => ({ ...c, [name]: e.target.value }));

  /* ── Listes de classe : lignes au format de GET /api/listes-classes/eleves ── */
  const lignesListe = useMemo(() => inscriptions.map((i) => {
    const e = eleveById[i.eleve_id] || {};
    const p = parentById[e.parent_id];
    return {
      id: i.id, classe_id: i.classe_id, annee_scolaire_id: i.annee_scolaire_id, date_inscription: i.date_inscription,
      statut: i.statut || 'Actif', eleve_id: i.eleve_id, matricule: e.matricule, nom: e.nom, prenom: e.prenom, sexe: e.sexe,
      date_naissance: e.date_naissance, lieu_naissance: e.lieu_naissance,
      parent_nom: p ? `${p.nom} ${p.prenom}` : null, parent_telephone: p ? p.telephone : null,
    };
  }), [inscriptions, eleveById, parentById]);

  /* ── Actions ── */
  const supprimer = async (i) => {
    const e = eleveById[i.eleve_id];
    const ok = await confirm(
      <>
        Retirer <strong>{e ? `${e.prenom || ''} ${e.nom || ''}` : 'cet élève'}</strong> de <strong>{classeLabel(classeById[i.classe_id])}</strong> ({anneeLabel(i.annee_scolaire_id)}) ?
        <span className="d-block mt-2 text-muted">L'élève reste au répertoire. Pour garder la trace du passage dans la classe, passez plutôt le statut à « Radié » ou « Transféré ».</span>
      </>,
      { title: "Retirer l'inscription", confirmLabel: 'Retirer' },
    );
    if (!ok) return;
    try {
      await api.del(`/inscriptions/${i.id}`);
      toast('Inscription retirée');
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const exportCsv = () => {
    const rows = [['Matricule', 'Nom', 'Prénom', 'Sexe', 'Classe', 'Année', "Date d'inscription", 'Statut', 'Parent', 'Téléphone']];
    filtered.forEach((i) => {
      const e = eleveById[i.eleve_id] || {};
      const p = parentById[e.parent_id];
      rows.push([e.matricule || '', e.nom || '', e.prenom || '', e.sexe || '', classeLabel(classeById[i.classe_id]), anneeLabel(i.annee_scolaire_id), i.date_inscription || '', i.statut || 'Actif', p ? `${p.nom} ${p.prenom}` : '', p ? p.telephone : '']);
    });
    downloadCsv('inscriptions.csv', rows);
    toast(`${rows.length - 1} inscription(s) exportée(s)`);
  };

  const anneeOptions = annees.length
    ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (en cours)' : ''}</option>)
    : <option value="">Aucune année</option>;
  const compareOptions = annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (en cours)' : ''}</option>);
  const classeOptions = classesTriees.map((c) => <option key={c.id} value={c.id}>{classeLabel(c)}</option>);
  const cycleOptions = cycles.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>);

  return (
    <>
      <PageHeader title="Inscriptions" subtitle="Qui est inscrit, dans quelle classe, à quelle date. Suivez les effectifs et sortez les listes de classe.">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={exportCsv}><i className="bx bx-file me-1" /> Exporter la sélection</button>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={loadAll}><i className="bx bx-refresh me-1" /> Actualiser</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormModal({ data: null })}><i className="bx bx-plus me-1" /> Inscrire un élève</button>
      </PageHeader>
      <OperationsEnAttente modules={MODULES_INSCRIPTION} titre="Inscriptions pas encore enregistrées sur le serveur" />

      <div className="row g-3 mb-4">
        <StatCard label={`Inscriptions ${anneeLabel(annee)}`} loading={loading} value={stats.total} sub={`${stats.distincts} élèves distincts`} icon="bx-clipboard" color="primary" />
        <StatCard label="Inscriptions actives" loading={loading} value={stats.actives} sub={stats.total ? `${Math.round((stats.actives / stats.total) * 100)} % du total` : '—'} icon="bx-user-check" color="success" />
        <StatCard label="Classes ouvertes" loading={loading} value={stats.classesOuvertes} sub={stats.classesOuvertes ? `${Math.round(stats.total / stats.classesOuvertes)} élèves par classe en moyenne` : '—'} icon="bx-building-house" color="info" />
        <StatCard label="Enregistrées ce mois" loading={loading} value={stats.ceMois} sub={stats.moisLabel} icon="bx-calendar-event" color="warning" />
      </div>

      <div className="d-flex align-items-center gap-2 mb-2">
        <h6 className="mb-0">Évolution des inscriptions</h6>
        <small className="text-muted">Par classe, par année, par mois</small>
        <button type="button" className="btn btn-outline-secondary btn-sm ms-auto" onClick={() => setPanels({ classe: !allOpen, annee: !allOpen, mois: !allOpen })}>
          <i className={`bx ${allOpen ? 'bx-chevrons-up' : 'bx-chevrons-down'} me-1`} /> {allOpen ? 'Tout replier' : 'Tout ouvrir'}
        </button>
      </div>

      <ChartPanel
        title="Par classe"
        icon="bx-bar-chart-alt-2"
        meta={chartClasse.meta}
        open={panels.classe}
        onToggle={() => togglePanel('classe')}
        controls={(
          <>
            <div className="col-md-3"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={ch.anneeClasse} onChange={setChField('anneeClasse')}>{anneeOptions}</Select></div>
            <div className="col-md-3"><label className="form-label">Cycle</label><Select className="form-select form-select-sm" value={ch.cycleClasse} onChange={setChField('cycleClasse')}><option value="">Tous les cycles</option>{cycleOptions}</Select></div>
            <div className="col-md-3"><label className="form-label">Détail</label><Select className="form-select form-select-sm" value={ch.detailClasse} onChange={setChField('detailClasse')}><option value="total">Effectif total</option><option value="sexe">Garçons / filles</option><option value="statut">Par statut</option></Select></div>
            <div className="col-md-3"><label className="form-label">Comparer avec</label><Select className="form-select form-select-sm" value={ch.compareClasse} onChange={setChField('compareClasse')}><option value="">Aucune comparaison</option>{compareOptions}</Select></div>
          </>
        )}
      >
        {chartClasse.config ? (
          <>
            <ChartCanvas config={chartClasse.config} height={320} />
            <div className="row g-2 mt-2 text-center">
              {[['Classe la plus chargée', chartClasse.kpis.max], ['Classe la moins chargée', chartClasse.kpis.min], ['Effectif moyen', chartClasse.kpis.moy]].map(([l, v]) => (
                <div key={l} className="col-md-4"><small className="text-muted d-block">{l}</small><span className="fw-semibold">{v}</span></div>
              ))}
            </div>
          </>
        ) : <ChartEmpty>Aucune inscription sur cette année scolaire.</ChartEmpty>}
      </ChartPanel>

      <ChartPanel
        title="Par année scolaire"
        icon="bx-trending-up"
        meta={chartAnnee.meta}
        open={panels.annee}
        onToggle={() => togglePanel('annee')}
        controls={(
          <>
            <div className="col-md-4"><label className="form-label">Classe suivie</label><Select className="form-select form-select-sm" value={ch.classeAnnee} onChange={setChField('classeAnnee')}><option value="">Toutes les classes</option>{classeOptions}</Select></div>
            <div className="col-md-4"><label className="form-label">Cycle</label><Select className="form-select form-select-sm" value={ch.cycleAnnee} onChange={setChField('cycleAnnee')}><option value="">Tous les cycles</option>{cycleOptions}</Select></div>
            <div className="col-md-4"><label className="form-label">Détail</label><Select className="form-select form-select-sm" value={ch.detailAnnee} onChange={setChField('detailAnnee')}><option value="total">Effectif total</option><option value="sexe">Garçons / filles</option></Select></div>
          </>
        )}
      >
        {chartAnnee.config ? <ChartCanvas config={chartAnnee.config} height={260} /> : <ChartEmpty icon="bx-trending-up">Il faut au moins une année scolaire avec des inscriptions.</ChartEmpty>}
        <div className="row g-2 mt-2 text-center">
          <div className="col-md-4"><small className="text-muted d-block">Dernière année</small><span className="fw-semibold">{chartAnnee.kpis?.derniere}</span></div>
          <div className="col-md-4"><small className="text-muted d-block">Variation</small><span className={`fw-semibold ${chartAnnee.kpis?.deltaColor}`}>{chartAnnee.kpis?.delta}</span></div>
          <div className="col-md-4"><small className="text-muted d-block">Meilleure année</small><span className="fw-semibold">{chartAnnee.kpis?.max}</span></div>
        </div>
      </ChartPanel>

      <ChartPanel
        className="mb-4"
        title="Par mois"
        icon="bx-calendar"
        meta={chartMois.meta}
        open={panels.mois}
        onToggle={() => togglePanel('mois')}
        controls={(
          <>
            <div className="col-md-3"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={ch.anneeMois} onChange={setChField('anneeMois')}>{anneeOptions}</Select></div>
            <div className="col-md-3"><label className="form-label">Classe</label><Select className="form-select form-select-sm" value={ch.classeMois} onChange={setChField('classeMois')}><option value="">Toutes les classes</option>{classeOptions}</Select></div>
            <div className="col-md-3"><label className="form-label">Affichage</label><Select className="form-select form-select-sm" value={ch.vueMois} onChange={setChField('vueMois')}><option value="mois">Inscriptions du mois</option><option value="cumul">Effectif cumulé</option></Select></div>
            <div className="col-md-3"><label className="form-label">Comparer avec</label><Select className="form-select form-select-sm" value={ch.compareMois} onChange={setChField('compareMois')}><option value="">Aucune comparaison</option>{compareOptions}</Select></div>
          </>
        )}
      >
        {chartMois.config ? <ChartCanvas config={chartMois.config} height={260} /> : <ChartEmpty icon="bx-calendar-x">Aucune inscription datée sur cette année scolaire.</ChartEmpty>}
        <p className="text-muted mt-3 mb-0 small">Les mois sont rangés dans l'ordre de l'année scolaire, de septembre à août.</p>
      </ChartPanel>

      {/* Liste des élèves inscrits */}
      <GenerateurListeClasse
        lignes={lignesListe} classes={classes} classeLabel={classeLabel} annees={annees}
        annee={anneeListe} onAnneeChange={setAnneeListe} etablissement={etablissement}
      />

      {/* Filtres */}
      <div className="card mb-3">
        <div className="card-body">
          <h6 className="mb-3"><i className="bx bx-filter-alt me-1" /> Filtres {chips.length > 0 && <span className="badge rounded-pill bg-primary ms-1">{chips.length}</span>}</h6>
          <div className="row g-2 align-items-end">
            <div className="col-md-3"><label className="form-label">Rechercher un élève</label><input type="search" className="form-control form-control-sm" placeholder="Nom, prénom, matricule…" value={filters.q} onChange={setFilter('q')} /></div>
            <div className="col-md-2"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={annee} onChange={(e) => changeAnnee(e.target.value)}>{anneeOptions}</Select></div>
            <div className="col-md-2"><label className="form-label">Cycle</label><Select className="form-select form-select-sm" value={filters.cycle} onChange={setFilter('cycle')}><option value="">Tous</option>{cycleOptions}</Select></div>
            <div className="col-md-2"><label className="form-label">Classe</label><Select className="form-select form-select-sm" value={filters.classe} onChange={setFilter('classe')}><option value="">Toutes</option>{classeOptions}</Select></div>
            <div className="col-md-2"><label className="form-label">Statut</label><Select className="form-select form-select-sm" value={filters.statut} onChange={setFilter('statut')}><option value="">Tous</option>{STATUTS.map((s) => <option key={s} value={s}>{s}</option>)}</Select></div>
            <div className="col-md-1"><label className="form-label">Sexe</label><Select className="form-select form-select-sm" value={filters.sexe} onChange={setFilter('sexe')}><option value="">Tous</option><option value="M">G</option><option value="F">F</option></Select></div>
            <div className="col-md-2"><label className="form-label">Inscrit du</label><input type="date" className="form-control form-control-sm" value={filters.du} onChange={setFilter('du')} /></div>
            <div className="col-md-2"><label className="form-label">au</label><input type="date" className="form-control form-control-sm" value={filters.au} onChange={setFilter('au')} /></div>
            <div className="col-md-3">
              <label className="form-label">Raccourci</label>
              <Select className="form-select form-select-sm" value={filters.raccourci} onChange={(e) => applyRaccourci(e.target.value)}>
                <option value="">Aucune période</option><option value="7">7 derniers jours</option><option value="30">30 derniers jours</option><option value="mois">Mois en cours</option><option value="rentree">Depuis la rentrée (1er septembre)</option>
              </Select>
            </div>
            <div className="col-md-2"><button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { setFilters(EMPTY_FILTERS); pagination.reset(); }}><i className="bx bx-reset me-1" /> Réinitialiser</button></div>
          </div>
          <FilterChips chips={chips} onClear={clearChip} />
        </div>
      </div>

      {/* Registre */}
      <TableCard title="Registre des inscriptions" icon="bx-table" count={filtered.length}>
        <table className="table table-hover mb-0">
          <thead>
            <tr>
              <SortTh sortKey="nom" sort={sort} setSort={setSort}>Élève</SortTh>
              <th>Matricule</th>
              <SortTh sortKey="classe" sort={sort} setSort={setSort}>Classe</SortTh>
              <th>Année</th>
              <SortTh sortKey="date" sort={sort} setSort={setSort}>Inscrit le</SortTh>
              <th>Statut</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <TBody colSpan={7} loading={loading} error={error && `Les inscriptions n'ont pas pu être chargées : ${error}`} rows={filtered.length} empty="Aucune inscription ne correspond à ces filtres. Changez d'année scolaire, élargissez la période, ou inscrivez un élève." emptyIcon="bx-clipboard">
            {pagination.slice.map((i) => {
              const e = eleveById[i.eleve_id];
              return (
                <tr key={i.id}>
                  <td>
                    <div className="fw-semibold">{e ? `${e.prenom || ''} ${e.nom || ''}` : `Élève #${i.eleve_id}`}</div>
                    <small className="text-muted">{e?.sexe === 'M' ? 'Garçon' : e?.sexe === 'F' ? 'Fille' : '—'}</small>
                  </td>
                  <td><code className="small">{e ? e.matricule : '—'}</code></td>
                  <td><span className="badge bg-label-primary">{classeLabel(classeById[i.classe_id])}</span></td>
                  <td>{anneeLabel(i.annee_scolaire_id)}</td>
                  <td>{formatDate(i.date_inscription)}</td>
                  <td><StatutBadge statut={i.statut} /></td>
                  <td className="text-end text-nowrap">
                    <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setFormModal({ data: i })} />
                    <IconBtn icon="bx-trash" title="Retirer" danger onClick={() => supprimer(i)} />
                  </td>
                </tr>
              );
            })}
          </TBody>
        </table>
        <Pager pagination={pagination} unit="inscriptions" />
      </TableCard>

      {formModal && (
        <InscriptionModal
          data={formModal.data}
          defaultAnnee={annee}
          eleves={eleves}
          parents={parents}
          classes={classesTriees}
          annees={annees}
          eleveById={eleveById}
          classeLabel={(id) => classeLabel(classeById[id])}
          onClose={() => setFormModal(null)}
          onSaved={async (msg) => { setFormModal(null); toast(msg); await loadAll(); }}
        />
      )}
      {confirmNode}
    </>
  );
}

function InscriptionModal({ data, defaultAnnee, eleves, parents, classes, annees, eleveById, classeLabel, onClose, onSaved }) {
  const isEdit = Boolean(data);
  const eleveEdit = isEdit ? eleveById[data.eleve_id] : null;
  const [form, setForm] = useState({
    classe_id: data ? String(data.classe_id) : '',
    annee_scolaire_id: data ? String(data.annee_scolaire_id) : String(defaultAnnee || ''),
    date_inscription: data ? data.date_inscription || '' : iso(new Date()),
    statut: data?.statut || 'Actif',
  });
  const [eleveMode, setEleveMode] = useState('exist');
  const [eleveSaisie, setEleveSaisie] = useState(eleveEdit ? `${eleveEdit.matricule || ''} — ${eleveEdit.nom || ''} ${eleveEdit.prenom || ''}` : '');
  const [ne, setNe] = useState({ matricule: '', nom: '', prenom: '', sexe: '', date_naissance: '', lieu_naissance: '', statut: 'Actif' });
  const [parentMode, setParentMode] = useState('exist');
  const [parentId, setParentId] = useState('');
  const [np, setNp] = useState({ nom: '', prenom: '', telephone: '', email: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const setNeF = (name) => (e) => setNe((f) => ({ ...f, [name]: e.target.value }));
  const setNpF = (name) => (e) => setNp((f) => ({ ...f, [name]: e.target.value }));

  // Retrouve l'élève à partir de la saisie « matricule — nom prénom ».
  const eleveDepuisSaisie = () => {
    const v = eleveSaisie.trim();
    if (!v) return null;
    const matricule = v.split('—')[0].trim().toLowerCase();
    let found = eleves.find((e) => String(e.matricule || '').toLowerCase() === matricule);
    if (!found) {
      const low = v.toLowerCase();
      found = eleves.find((e) => `${e.nom || ''} ${e.prenom || ''}`.toLowerCase() === low)
        || eleves.find((e) => e.matricule && low.includes(String(e.matricule).toLowerCase()));
    }
    return found || null;
  };
  const eleveReconnu = eleveMode === 'exist' && !isEdit ? eleveDepuisSaisie() : null;

  // Dossier envoyé en une requête (parent + élève + inscription, cf.
  // /dossiers-inscription/) : rien n'a besoin d'exister déjà sur le serveur,
  // ce qui permet de l'enregistrer hors connexion.
  const construireDossier = () => {
    if (eleveMode === 'exist') {
      const e = eleveDepuisSaisie();
      if (!e) throw new Error('Choisissez un élève dans la liste (tapez son matricule ou son nom).');
      const label = `${e.prenom || ''} ${e.nom || ''}`.trim();
      return { dossier: { eleve_id: e.id, eleve_label: `${e.nom || ''} ${e.prenom || ''} (${e.matricule || '—'})` }, label };
    }
    const ep = { matricule: ne.matricule.trim(), nom: ne.nom.trim(), prenom: ne.prenom.trim(), sexe: ne.sexe, lieu_naissance: ne.lieu_naissance.trim(), statut: ne.statut };
    if (ne.date_naissance) ep.date_naissance = ne.date_naissance;
    for (const [k, label] of [['matricule', 'matricule'], ['nom', 'nom'], ['prenom', 'prénom'], ['sexe', 'sexe'], ['lieu_naissance', 'lieu de naissance']]) {
      if (!ep[k]) throw new Error(`Renseignez le ${label} de l'élève.`);
    }
    const dossier = { eleve: ep };
    if (parentMode === 'new') {
      const parent = { nom: np.nom.trim(), prenom: np.prenom.trim(), telephone: np.telephone.trim(), email: np.email.trim() };
      if (!parent.nom || !parent.prenom || !parent.telephone || !parent.email) throw new Error("Le nouveau parent a besoin d'un nom, d'un prénom, d'un téléphone et d'un e-mail.");
      dossier.parent = parent;
    } else {
      dossier.parent_id = Number(parentId) || null;
      if (!dossier.parent_id) throw new Error("Choisissez le parent de l'élève, ou créez-en un nouveau.");
    }
    return { dossier, label: `${ep.prenom} ${ep.nom}` };
  };

  const submit = async () => {
    setError('');
    const payload = {
      classe_id: Number(form.classe_id) || null,
      annee_scolaire_id: Number(form.annee_scolaire_id) || null,
      date_inscription: form.date_inscription || null,
      statut: form.statut,
    };
    if (!payload.classe_id) return setError('Choisissez la classe.');
    if (!payload.annee_scolaire_id) return setError("Choisissez l'année scolaire.");
    if (!payload.date_inscription) return setError("Indiquez la date d'inscription.");
    setSaving(true);
    try {
      const classeTexte = classeLabel(payload.classe_id);
      if (isEdit) {
        const res = await enregistrer({
          cle: `inscription|${data.id}`,
          module: 'inscription',
          methode: 'PUT',
          url: `/inscriptions/${data.id}`,
          body: payload,
          versionBase: data.version ?? undefined,
          libelle: `Inscription de ${eleveEdit ? `${eleveEdit.nom || ''} ${eleveEdit.prenom || ''}`.trim() : `l'élève n°${data.eleve_id}`} — ${classeTexte}`,
        });
        await terminerEnregistrement(res, { onSaved, ok: 'Inscription mise à jour' });
      } else {
        const { dossier, label } = construireDossier();
        const res = await enregistrer({
          cle: nouvelleCle('dossier'),
          module: 'dossier_inscription',
          methode: 'POST',
          url: '/dossiers-inscription/',
          body: { ...dossier, inscription: { ...payload, classe_label: classeTexte } },
          libelle: `${label} → ${classeTexte}`,
        });
        await terminerEnregistrement(res, { onSaved, ok: `${label} inscrit(e) en ${classeTexte}` });
      }
    } catch (err) {
      setError(/unicit/i.test(err.message) ? 'Cet élève est déjà inscrit dans cette classe pour cette année scolaire.' : err.message);
      setSaving(false);
    }
    return undefined;
  };

  const parentsTries = [...parents].sort((a, b) => `${a.nom || ''}${a.prenom || ''}`.localeCompare(`${b.nom || ''}${b.prenom || ''}`));

  return (
    <Modal
      title={isEdit ? <><i className="bx bx-edit-alt me-2 text-primary" />Modifier l'inscription</> : <><i className="bx bx-clipboard me-2 text-primary" />Inscrire un élève</>}
      onClose={onClose}
      onSubmit={submit}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onClose} disabled={saving}>Annuler</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-save me-1" />} Enregistrer</button>
        </>
      )}
    >
      {!isEdit && (
        <div className="d-flex align-items-center gap-3 mb-3">
          <strong className="small">Élève</strong>
          <div className="btn-group btn-group-sm" role="group">
            <input type="radio" className="btn-check" name="eleveMode" id="emExist" checked={eleveMode === 'exist'} onChange={() => setEleveMode('exist')} />
            <label className="btn btn-outline-primary btn-sm" htmlFor="emExist">Élève déjà enregistré</label>
            <input type="radio" className="btn-check" name="eleveMode" id="emNew" checked={eleveMode === 'new'} onChange={() => setEleveMode('new')} />
            <label className="btn btn-outline-primary btn-sm" htmlFor="emNew">Créer un nouvel élève</label>
          </div>
        </div>
      )}

      {eleveMode === 'exist' ? (
        <div className="mb-3">
          <label className="form-label">Élève *</label>
          <input className="form-control" list="listeEleves" placeholder="Tapez un nom ou un matricule…" autoComplete="off" value={eleveSaisie} disabled={isEdit} onChange={(e) => setEleveSaisie(e.target.value)} />
          <datalist id="listeEleves">
            {eleves.map((e) => <option key={e.id} value={`${e.matricule || ''} — ${e.nom || ''} ${e.prenom || ''}`} />)}
          </datalist>
          {!isEdit && (
            <div className={`form-text ${eleveReconnu ? 'text-success' : ''}`}>
              {eleveReconnu ? `Élève reconnu : ${eleveReconnu.prenom || ''} ${eleveReconnu.nom || ''} (matricule ${eleveReconnu.matricule || '—'})` : "L'élève doit déjà exister au répertoire."}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="row g-3">
            <div className="col-md-4"><label className="form-label">Matricule *</label><input type="text" className="form-control" value={ne.matricule} onChange={setNeF('matricule')} /><div className="form-text">Unique au sein de l'établissement.</div></div>
            <div className="col-md-4"><label className="form-label">Nom *</label><input type="text" className="form-control" value={ne.nom} onChange={setNeF('nom')} /></div>
            <div className="col-md-4"><label className="form-label">Prénom(s) *</label><input type="text" className="form-control" value={ne.prenom} onChange={setNeF('prenom')} /></div>
            <div className="col-md-3"><label className="form-label">Sexe *</label><Select className="form-select" value={ne.sexe} onChange={setNeF('sexe')}><option value="">—</option><option value="M">Masculin</option><option value="F">Féminin</option></Select></div>
            <div className="col-md-3"><label className="form-label">Date de naissance</label><input type="date" className="form-control" value={ne.date_naissance} onChange={setNeF('date_naissance')} /></div>
            <div className="col-md-3"><label className="form-label">Lieu de naissance *</label><input type="text" className="form-control" value={ne.lieu_naissance} onChange={setNeF('lieu_naissance')} /></div>
            <div className="col-md-3"><label className="form-label">Statut de l'élève</label><Select className="form-select" value={ne.statut} onChange={setNeF('statut')}><option value="Actif">Actif</option><option value="Inactif">Inactif</option></Select></div>
          </div>
          <hr />
          <div className="d-flex align-items-center gap-3 mb-2">
            <strong className="small">Parent / tuteur</strong>
            <div className="btn-group btn-group-sm" role="group">
              <input type="radio" className="btn-check" name="parentMode" id="pmExist" checked={parentMode === 'exist'} onChange={() => setParentMode('exist')} />
              <label className="btn btn-outline-primary btn-sm" htmlFor="pmExist">Parent déjà enregistré</label>
              <input type="radio" className="btn-check" name="parentMode" id="pmNew" checked={parentMode === 'new'} onChange={() => setParentMode('new')} />
              <label className="btn btn-outline-primary btn-sm" htmlFor="pmNew">Créer un parent</label>
            </div>
          </div>
          {parentMode === 'exist' ? (
            <div className="mb-3">
              <label className="form-label">Parent *</label>
              <Select className="form-select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">— Choisir un parent —</option>
                {parentsTries.map((p) => <option key={p.id} value={p.id}>{`${p.nom || ''} ${p.prenom || ''}${p.telephone ? ` — ${p.telephone}` : ''}`}</option>)}
              </Select>
              <div className="form-text">Un élève ne peut pas être enregistré sans parent rattaché.</div>
            </div>
          ) : (
            <div className="row g-3 mb-3">
              <div className="col-md-3"><label className="form-label">Nom du parent *</label><input type="text" className="form-control" value={np.nom} onChange={setNpF('nom')} /></div>
              <div className="col-md-3"><label className="form-label">Prénom du parent *</label><input type="text" className="form-control" value={np.prenom} onChange={setNpF('prenom')} /></div>
              <div className="col-md-3"><label className="form-label">Téléphone *</label><input type="tel" className="form-control" value={np.telephone} onChange={setNpF('telephone')} /></div>
              <div className="col-md-3"><label className="form-label">E-mail *</label><input type="email" className="form-control" value={np.email} onChange={setNpF('email')} /></div>
              <div className="col-12"><div className="form-text">Le parent est créé en même temps que l'élève, puis rattaché automatiquement.</div></div>
            </div>
          )}
        </>
      )}

      <hr />
      <div className="row g-3">
        <div className="col-md-6"><label className="form-label">Classe *</label><Select className="form-select" value={form.classe_id} onChange={set('classe_id')}><option value="">—</option>{classes.map((c) => <option key={c.id} value={c.id}>{classeLabel(c.id)}</option>)}</Select></div>
        <div className="col-md-6"><label className="form-label">Année scolaire *</label><Select className="form-select" value={form.annee_scolaire_id} onChange={set('annee_scolaire_id')}>{annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (en cours)' : ''}</option>)}</Select></div>
        <div className="col-md-6"><label className="form-label">Date d'inscription *</label><input type="date" className="form-control" value={form.date_inscription} onChange={set('date_inscription')} /></div>
        <div className="col-md-6"><label className="form-label">Statut</label><Select className="form-select" value={form.statut} onChange={set('statut')}>{STATUTS.map((s) => <option key={s} value={s}>{s}</option>)}</Select></div>
      </div>
      {error && <div className="alert alert-danger mt-3 mb-0">{error}</div>}
    </Modal>
  );
}

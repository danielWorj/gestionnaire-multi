import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import ChartCanvas, { ChartEmpty, ChartPanel } from '../components/ChartCanvas';
import { useAuth } from '../context/AuthContext';
import {
  classeLabel as baseClasseLabel, downloadCsv, FilterChips, IconBtn, PageHeader, Pager, SortTh, StatCard, TableCard,
  TBody, useConfirm, usePagination, useToast,
} from '../components/ui';
import Select from '../components/Select';

// Portage de server/static/templates/parent.html : carnet des familles
// (inscription_api.py) avec filtres, analyses, fiche famille et formulaire.

const PRIMARY = '#696cff';
const GRID = { color: '#eceef1' };
const MOIS_SCOLAIRES = [8, 9, 10, 11, 0, 1, 2, 3, 4, 5, 6, 7];
const MOIS_NOMS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

const EMPTY_FILTERS = { q: '', classe: '', enfants: '', contact: '' };
const ENFANTS_LABELS = { 0: 'Aucun enfant rattaché', 1: '1 enfant', 2: '2 enfants', '3+': '3 enfants ou plus' };
const CONTACT_LABELS = { 'tel-ok': 'Téléphone renseigné', 'tel-ko': 'Téléphone manquant', 'mail-ko': 'E-mail manquant' };

const nomComplet = (p) => `${p.nom || ''} ${p.prenom || ''}`.trim();
const initialesParent = (p) => (`${(p.nom || '').charAt(0)}${(p.prenom || '').charAt(0)}` || '?').toUpperCase();
const barOptions = (rotate) => ({
  plugins: { legend: { display: false } },
  scales: { x: { grid: { display: false }, ticks: rotate ? { maxRotation: 60 } : {} }, y: { beginAtZero: true, grid: GRID, ticks: { precision: 0 } } },
});

export default function ParentsPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { activeEtablissementId } = useAuth();

  const [data, setData] = useState({ parents: [], eleves: [], inscriptions: [], classes: [], cycles: [], annees: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [annee, setAnnee] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState({ key: 'nom', asc: true });
  const [panels, setPanels] = useState({ classes: true, fratrie: false, arrivees: false });
  const [ch, setCh] = useState({ anneeClasses: '', cycleClasses: '', anneeFratrie: '', perimFratrie: 'inscrits', anneeArrivees: '', vueArrivees: 'mois' });
  const [formModal, setFormModal] = useState(null);
  const [detail, setDetail] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [parents, eleves, inscriptions, classes, cycles, annees] = await Promise.all([
        api.get('/parents/'), api.get('/eleves/'), api.get('/inscriptions/'),
        api.get('/classes/'), api.get('/cycles/'), api.get('/annees-scolaires/'),
      ]);
      annees.sort((a, b) => String(b.libelle).localeCompare(String(a.libelle)));
      setData({ parents: parents || [], eleves: eleves || [], inscriptions: inscriptions || [], classes: classes || [], cycles: cycles || [], annees });
      const def = String((annees.find((a) => a.active) || annees[0])?.id ?? '');
      setAnnee((prev) => prev || def);
      setCh((prev) => ({
        ...prev,
        anneeClasses: prev.anneeClasses || def,
        anneeFratrie: prev.anneeFratrie || def,
        anneeArrivees: prev.anneeArrivees || def,
      }));
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

  const { parents, eleves, inscriptions, classes, cycles, annees } = data;
  const classeById = useMemo(() => Object.fromEntries(classes.map((c) => [c.id, c])), [classes]);
  const eleveById = useMemo(() => Object.fromEntries(eleves.map((e) => [e.id, e])), [eleves]);
  const classeLabel = useCallback((c) => (c ? baseClasseLabel(c, cycles, ' · ') : '—'), [cycles]);
  const anneeLabel = useCallback((id) => annees.find((a) => a.id === Number(id))?.libelle || (id ? `Année #${id}` : '—'), [annees]);
  const enfantsDe = useMemo(() => {
    const map = {};
    eleves.forEach((e) => { if (e.parent_id) (map[e.parent_id] ||= []).push(e); });
    return map;
  }, [eleves]);

  // Classes d'un parent pour une année donnée (via les inscriptions de ses enfants).
  const classesDuParent = useCallback((parentId, anneeId) => {
    const ids = new Set();
    (enfantsDe[parentId] || []).forEach((e) => {
      inscriptions.forEach((i) => {
        if (i.eleve_id !== e.id) return;
        if (anneeId && i.annee_scolaire_id !== Number(anneeId)) return;
        ids.add(i.classe_id);
      });
    });
    return Array.from(ids);
  }, [enfantsDe, inscriptions]);

  /* ── Chiffres clés ── */
  const stats = useMemo(() => {
    const total = parents.length;
    const avecEnfants = parents.filter((p) => (enfantsDe[p.id] || []).length > 0).length;
    const nbEnfants = eleves.filter((e) => e.parent_id).length;
    const concernes = parents.filter((p) => classesDuParent(p.id, Number(annee) || null).length > 0).length;
    return { total, avecEnfants, nbEnfants, concernes };
  }, [parents, eleves, enfantsDe, classesDuParent, annee]);

  /* ── Filtres / tri ── */
  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const list = parents.filter((p) => {
      if (q && !`${nomComplet(p)} ${p.telephone || ''} ${p.email || ''}`.toLowerCase().includes(q)) return false;
      const n = (enfantsDe[p.id] || []).length;
      if (filters.enfants === '0' && n !== 0) return false;
      if (filters.enfants === '1' && n !== 1) return false;
      if (filters.enfants === '2' && n !== 2) return false;
      if (filters.enfants === '3+' && n < 3) return false;
      if (filters.contact === 'tel-ok' && !p.telephone) return false;
      if (filters.contact === 'tel-ko' && p.telephone) return false;
      if (filters.contact === 'mail-ko' && p.email) return false;
      if (filters.classe && !classesDuParent(p.id, Number(annee) || null).includes(Number(filters.classe))) return false;
      return true;
    });
    const val = (p) => (sort.key === 'enfants' ? (enfantsDe[p.id] || []).length : nomComplet(p).toLowerCase());
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return sort.asc ? -1 : 1;
      if (va > vb) return sort.asc ? 1 : -1;
      return 0;
    });
  }, [parents, filters, sort, enfantsDe, classesDuParent, annee]);

  const pagination = usePagination(filtered, 50);
  const setFilter = (name) => (ev) => { setFilters((f) => ({ ...f, [name]: ev.target.value })); pagination.reset(); };
  const chips = [
    filters.q && ['q', `« ${filters.q.trim().toLowerCase()} »`],
    filters.classe && ['classe', classeLabel(classeById[filters.classe])],
    filters.enfants && ['enfants', ENFANTS_LABELS[filters.enfants]],
    filters.contact && ['contact', CONTACT_LABELS[filters.contact]],
  ].filter(Boolean);

  /* ── Graphiques ── */
  const chartClasses = useMemo(() => {
    const anneeId = Number(ch.anneeClasses) || null;
    const cycleId = Number(ch.cycleClasses) || null;
    const parClasse = {};
    inscriptions.forEach((i) => {
      if (anneeId && i.annee_scolaire_id !== anneeId) return;
      const c = classeById[i.classe_id];
      if (!c || (cycleId && c.cycle_id !== cycleId)) return;
      const el = eleveById[i.eleve_id];
      if (!el || !el.parent_id) return;
      (parClasse[i.classe_id] ||= new Set()).add(el.parent_id);
    });
    const ids = Object.keys(parClasse).map(Number).sort((a, b) => classeLabel(classeById[a]).localeCompare(classeLabel(classeById[b])));
    const familles = new Set();
    Object.values(parClasse).forEach((s) => s.forEach((v) => familles.add(v)));
    return {
      meta: `${anneeLabel(anneeId)} · ${familles.size} famille(s)`,
      config: ids.length ? {
        type: 'bar',
        data: { labels: ids.map((id) => classeLabel(classeById[id])), datasets: [{ label: 'Familles', data: ids.map((id) => parClasse[id].size), backgroundColor: PRIMARY, borderRadius: 4, maxBarThickness: 34 }] },
        options: barOptions(true),
      } : null,
    };
  }, [ch.anneeClasses, ch.cycleClasses, inscriptions, classeById, eleveById, classeLabel, anneeLabel]);

  const chartFratrie = useMemo(() => {
    const anneeId = Number(ch.anneeFratrie) || null;
    const tous = ch.perimFratrie === 'tous';
    const compte = {};
    parents.forEach((p) => {
      const enfants = enfantsDe[p.id] || [];
      const n = tous ? enfants.length : enfants.filter((e) => inscriptions.some((i) => i.eleve_id === e.id && (!anneeId || i.annee_scolaire_id === anneeId))).length;
      const k = n >= 4 ? '4+' : String(n);
      compte[k] = (compte[k] || 0) + 1;
    });
    const sansTel = parents.filter((p) => !p.telephone).length;
    const sansMail = parents.filter((p) => !p.email).length;
    const complets = parents.filter((p) => p.telephone && p.email).length;
    const tailles = parents.map((p) => (enfantsDe[p.id] || []).length);
    return {
      meta: tous ? 'Tous les enfants' : anneeLabel(anneeId),
      fratrie: {
        type: 'bar',
        data: { labels: ['Aucun', '1 enfant', '2 enfants', '3 enfants', '4 et plus'], datasets: [{ label: 'Familles', data: ['0', '1', '2', '3', '4+'].map((k) => compte[k] || 0), backgroundColor: PRIMARY, borderRadius: 4, maxBarThickness: 44 }] },
        options: barOptions(false),
      },
      contacts: {
        type: 'doughnut',
        data: { labels: ['Contact complet', 'Téléphone manquant', 'E-mail manquant'], datasets: [{ data: [complets, sansTel, sansMail], backgroundColor: ['#71dd37', '#ffab00', '#ff3e1d'], borderWidth: 0 }] },
        options: { cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } } } },
      },
      kpis: {
        max: tailles.length ? `${Math.max(...tailles)} enfants` : '—',
        multi: (compte['2'] || 0) + (compte['3'] || 0) + (compte['4+'] || 0),
        sansTel,
        sansMail,
      },
    };
  }, [ch.anneeFratrie, ch.perimFratrie, parents, enfantsDe, inscriptions, anneeLabel]);

  const chartArrivees = useMemo(() => {
    const anneeId = Number(ch.anneeArrivees) || null;
    const cumul = ch.vueArrivees === 'cumul';
    const premier = {};
    inscriptions.forEach((i) => {
      if (anneeId && i.annee_scolaire_id !== anneeId) return;
      if (!i.date_inscription) return;
      const el = eleveById[i.eleve_id];
      if (!el || !el.parent_id) return;
      const t = new Date(i.date_inscription).getTime();
      if (Number.isNaN(t)) return;
      if (premier[el.parent_id] == null || t < premier[el.parent_id]) premier[el.parent_id] = t;
    });
    const parMois = new Array(12).fill(0);
    Object.values(premier).forEach((t) => { parMois[new Date(t).getMonth()]++; });
    let values = MOIS_SCOLAIRES.map((m) => parMois[m]);
    const total = values.reduce((s, v) => s + v, 0);
    if (cumul) {
      let acc = 0;
      values = values.map((v) => (acc += v));
    }
    return {
      meta: `${anneeLabel(anneeId)} · ${total} famille(s)`,
      config: total ? {
        type: cumul ? 'line' : 'bar',
        data: {
          labels: MOIS_SCOLAIRES.map((m) => `${MOIS_NOMS[m].slice(0, 4)}.`),
          datasets: [{ label: cumul ? 'Familles cumulées' : 'Nouvelles familles', data: values, borderColor: PRIMARY, backgroundColor: cumul ? 'rgba(105,108,255,0.12)' : PRIMARY, fill: cumul, tension: 0.35, pointRadius: 3, borderRadius: 4, borderWidth: 2, maxBarThickness: 34 }],
        },
        options: barOptions(false),
      } : null,
    };
  }, [ch.anneeArrivees, ch.vueArrivees, inscriptions, eleveById, anneeLabel]);

  const allOpen = Object.values(panels).every(Boolean);
  const togglePanel = (key) => setPanels((p) => ({ ...p, [key]: !p[key] }));
  const setChField = (name) => (e) => setCh((c) => ({ ...c, [name]: e.target.value }));
  const changeAnnee = (value) => {
    setAnnee(value);
    pagination.reset();
  };

  /* ── Actions ── */
  const supprimer = async (p) => {
    const n = (enfantsDe[p.id] || []).length;
    const ok = await confirm(
      <>
        Vous êtes sur le point de supprimer <strong>{nomComplet(p)}</strong>.
        {n
          ? <span className="alert alert-warning d-block mt-2 mb-0"><i className="bx bx-error me-1" />{n} élève(s) dépendent de cette fiche. Rattachez-les d'abord à un autre parent, sinon la suppression sera refusée par la base.</span>
          : <span className="d-block mt-2 text-muted">Aucun élève ne dépend de cette fiche, la suppression est sans risque.</span>}
      </>,
      { title: 'Supprimer le parent', confirmLabel: 'Supprimer' },
    );
    if (!ok) return;
    try {
      await api.del(`/parents/${p.id}`);
      toast('Parent supprimé');
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const exportCsv = () => {
    const anneeId = Number(annee) || null;
    const rows = [['Nom', 'Prénom', 'Téléphone', 'E-mail', 'Nb enfants', 'Enfants', `Classes ${anneeLabel(anneeId)}`]];
    filtered.forEach((p) => {
      const enfants = enfantsDe[p.id] || [];
      rows.push([p.nom, p.prenom, p.telephone, p.email, enfants.length,
        enfants.map((e) => `${e.prenom || ''} ${e.nom || ''}`).join(' | '),
        classesDuParent(p.id, anneeId).map((id) => classeLabel(classeById[id])).join(' | ')]);
    });
    downloadCsv(`parents-${String(anneeLabel(anneeId)).replace(/[^\w-]/g, '_')}.csv`, rows);
    toast(`${rows.length - 1} famille(s) exportée(s)`);
  };

  const anneeOptions = annees.length
    ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (en cours)' : ''}</option>)
    : <option value="">Aucune année</option>;
  const classesTriees = [...classes].sort((a, b) => classeLabel(a).localeCompare(classeLabel(b)));

  return (
    <>
      <PageHeader title="Parents et tuteurs" subtitle="Le carnet d'adresses des familles. Chaque parent regroupe ses enfants et sert de contact pour les classes où ils sont inscrits.">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={exportCsv}><i className="bx bx-file me-1" /> Exporter la sélection</button>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={loadAll}><i className="bx bx-refresh me-1" /> Actualiser</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormModal({ data: null })}><i className="bx bx-plus me-1" /> Ajouter un parent</button>
      </PageHeader>

      <div className="row g-3 mb-4">
        <StatCard label="Familles enregistrées" value={loading ? null : stats.total} sub={loading ? '—' : `${stats.avecEnfants} avec au moins un enfant`} icon="bx-home-heart" color="primary" />
        <StatCard label="Enfants par famille" value={loading ? null : (stats.avecEnfants ? (stats.nbEnfants / stats.avecEnfants).toFixed(1) : '—')} sub={`${stats.nbEnfants} enfants rattachés`} icon="bx-group" color="success" />
        <StatCard label={`Concernés ${anneeLabel(annee)}`} value={loading ? null : stats.concernes} sub={stats.total ? `${Math.round((stats.concernes / stats.total) * 100)} % du carnet` : '—'} icon="bx-book-bookmark" color="info" />
        <StatCard label="Familles sans enfant" value={loading ? null : stats.total - stats.avecEnfants} sub={stats.total - stats.avecEnfants ? 'fiches à compléter' : 'carnet complet'} icon="bx-user-x" color="warning" />
      </div>

      <div className="d-flex align-items-center gap-2 mb-2">
        <h6 className="mb-0">Analyses</h6>
        <small className="text-muted">Ouvrez un panneau pour charger son graphique</small>
        <button type="button" className="btn btn-outline-secondary btn-sm ms-auto" onClick={() => setPanels({ classes: !allOpen, fratrie: !allOpen, arrivees: !allOpen })}>
          <i className={`bx ${allOpen ? 'bx-chevrons-up' : 'bx-chevrons-down'} me-1`} /> {allOpen ? 'Tout fermer' : 'Tout ouvrir'}
        </button>
      </div>

      <ChartPanel
        title="Familles représentées par classe"
        icon="bx-bar-chart-alt-2"
        meta={chartClasses.meta}
        open={panels.classes}
        onToggle={() => togglePanel('classes')}
        controls={(
          <>
            <div className="col-md-6"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={ch.anneeClasses} onChange={setChField('anneeClasses')}>{anneeOptions}</Select></div>
            <div className="col-md-6"><label className="form-label">Cycle</label><Select className="form-select form-select-sm" value={ch.cycleClasses} onChange={setChField('cycleClasses')}><option value="">Tous les cycles</option>{cycles.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}</Select></div>
          </>
        )}
      >
        {chartClasses.config ? <ChartCanvas config={chartClasses.config} height={320} /> : <ChartEmpty>Aucun enfant inscrit sur cette année scolaire.</ChartEmpty>}
      </ChartPanel>

      <ChartPanel
        title="Taille des fratries"
        icon="bx-group"
        meta={chartFratrie.meta}
        open={panels.fratrie}
        onToggle={() => togglePanel('fratrie')}
        controls={(
          <>
            <div className="col-md-6"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={ch.anneeFratrie} onChange={setChField('anneeFratrie')}>{anneeOptions}</Select></div>
            <div className="col-md-6"><label className="form-label">Enfants comptés</label><Select className="form-select form-select-sm" value={ch.perimFratrie} onChange={setChField('perimFratrie')}><option value="inscrits">Inscrits sur l'année choisie</option><option value="tous">Tous les enfants au répertoire</option></Select></div>
          </>
        )}
      >
        <div className="row g-3">
          <div className="col-md-6"><ChartCanvas config={chartFratrie.fratrie} height={200} /></div>
          <div className="col-md-6"><ChartCanvas config={chartFratrie.contacts} height={200} /></div>
        </div>
        <div className="row g-2 mt-2 text-center">
          {[['Plus grande fratrie', chartFratrie.kpis.max], ['Familles à 2 enfants ou plus', chartFratrie.kpis.multi], ['Téléphone manquant', chartFratrie.kpis.sansTel], ['E-mail manquant', chartFratrie.kpis.sansMail]].map(([l, v]) => (
            <div key={l} className="col-6 col-md-3"><small className="text-muted d-block">{l}</small><span className="fw-semibold">{v}</span></div>
          ))}
        </div>
      </ChartPanel>

      <ChartPanel
        className="mb-4"
        title="Arrivée des familles, mois par mois"
        icon="bx-trending-up"
        meta={chartArrivees.meta}
        open={panels.arrivees}
        onToggle={() => togglePanel('arrivees')}
        controls={(
          <>
            <div className="col-md-6"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={ch.anneeArrivees} onChange={setChField('anneeArrivees')}>{anneeOptions}</Select></div>
            <div className="col-md-6"><label className="form-label">Affichage</label><Select className="form-select form-select-sm" value={ch.vueArrivees} onChange={setChField('vueArrivees')}><option value="mois">Par mois</option><option value="cumul">Cumulé</option></Select></div>
          </>
        )}
      >
        {chartArrivees.config ? <ChartCanvas config={chartArrivees.config} height={260} /> : <ChartEmpty icon="bx-calendar-x">Aucune inscription datée sur cette année scolaire.</ChartEmpty>}
        <p className="text-muted mt-3 mb-0 small">Une famille est comptée le mois où son premier enfant a été inscrit sur l'année choisie.</p>
      </ChartPanel>

      <div className="card mb-3">
        <div className="card-body">
          <h6 className="mb-3"><i className="bx bx-filter-alt me-1" /> Filtres {chips.length > 0 && <span className="badge rounded-pill bg-primary ms-1">{chips.length}</span>}</h6>
          <div className="row g-2 align-items-end">
            <div className="col-md-3"><label className="form-label">Rechercher</label><input type="search" className="form-control form-control-sm" placeholder="Nom, prénom, téléphone, e-mail…" value={filters.q} onChange={setFilter('q')} /></div>
            <div className="col-md-2"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={annee} onChange={(e) => changeAnnee(e.target.value)}>{anneeOptions}</Select></div>
            <div className="col-md-2"><label className="form-label">Classe d'un enfant</label><Select className="form-select form-select-sm" value={filters.classe} onChange={setFilter('classe')}><option value="">Toutes</option>{classesTriees.map((c) => <option key={c.id} value={c.id}>{classeLabel(c)}</option>)}</Select></div>
            <div className="col-md-2"><label className="form-label">Nombre d'enfants</label><Select className="form-select form-select-sm" value={filters.enfants} onChange={setFilter('enfants')}><option value="">Peu importe</option>{Object.entries(ENFANTS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>
            <div className="col-md-2"><label className="form-label">Contact</label><Select className="form-select form-select-sm" value={filters.contact} onChange={setFilter('contact')}><option value="">Tous</option>{Object.entries(CONTACT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>
            <div className="col-md-1"><button type="button" className="btn btn-outline-secondary btn-sm w-100" title="Réinitialiser" onClick={() => { setFilters(EMPTY_FILTERS); pagination.reset(); }}><i className="bx bx-reset" /></button></div>
          </div>
          <FilterChips chips={chips} onClear={(key) => { setFilters((f) => ({ ...f, [key]: '' })); pagination.reset(); }} />
        </div>
      </div>

      <TableCard title="Carnet des familles" icon="bx-book-content" count={filtered.length}>
        <table className="table table-hover mb-0">
          <thead>
            <tr>
              <SortTh sortKey="nom" sort={sort} setSort={setSort}>Parent</SortTh>
              <th>Téléphone</th>
              <th>E-mail</th>
              <SortTh sortKey="enfants" sort={sort} setSort={setSort}>Enfants</SortTh>
              <th>Classes concernées</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <TBody colSpan={6} loading={loading} error={error && `Les parents n'ont pas pu être chargés : ${error}`} rows={filtered.length} empty="Aucune famille ne correspond à ces filtres. Élargissez la recherche ou ajoutez un parent." emptyIcon="bx-book-content">
            {pagination.slice.map((p) => {
              const enfants = enfantsDe[p.id] || [];
              const cls = classesDuParent(p.id, Number(annee) || null);
              return (
                <tr key={p.id}>
                  <td>
                    <div className="d-flex align-items-center gap-2">
                      <div><div className="fw-semibold">{nomComplet(p)}</div><small className="text-muted">Fiche #{p.id}</small></div>
                    </div>
                  </td>
                  <td>{p.telephone ? <a href={`tel:${p.telephone}`}>{p.telephone}</a> : <span className="text-warning">Manquant</span>}</td>
                  <td>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : <span className="text-warning">Manquant</span>}</td>
                  <td>
                    {enfants.length
                      ? <><span className="badge bg-label-primary">{enfants.length}</span> <small className="text-muted">{enfants.slice(0, 2).map((e) => e.prenom).join(', ')}{enfants.length > 2 ? '…' : ''}</small></>
                      : <span className="badge bg-label-secondary">0</span>}
                  </td>
                  <td>{cls.length ? cls.map((id) => <span key={id} className="badge bg-label-info me-1">{classeLabel(classeById[id])}</span>) : <small className="text-muted">—</small>}</td>
                  <td className="text-end text-nowrap">
                    <IconBtn icon="bx-show" title="Voir la famille" onClick={() => setDetail(p)} />
                    <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setFormModal({ data: p })} />
                    <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(p)} />
                  </td>
                </tr>
              );
            })}
          </TBody>
        </table>
        <Pager pagination={pagination} unit="familles" />
      </TableCard>

      {formModal && (
        <ParentModal
          data={formModal.data}
          onClose={() => setFormModal(null)}
          onSaved={async (msg) => { setFormModal(null); toast(msg); await loadAll(); }}
        />
      )}

      {detail && (
        <Modal
          title={<><i className="bx bx-home-heart me-2 text-primary" />Fiche famille</>}
          onClose={() => setDetail(null)}
          footer={(
            <>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setDetail(null)}>Fermer</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => { setFormModal({ data: detail }); setDetail(null); }}><i className="bx bx-edit-alt me-1" /> Modifier</button>
            </>
          )}
        >
          <div className="d-flex align-items-center gap-3 mb-3">
            <div className="avatar avatar-lg"><span className="avatar-initial rounded-circle bg-label-primary">{initialesParent(detail)}</span></div>
            <div>
              <div className="fw-bold fs-6">{nomComplet(detail)}</div>
              <div className="text-muted">{detail.telephone || 'Téléphone manquant'} · {detail.email || 'E-mail manquant'}</div>
            </div>
          </div>
          <h6 className="mb-2">Enfants rattachés <span className="badge bg-label-primary">{(enfantsDe[detail.id] || []).length}</span></h6>
          {(enfantsDe[detail.id] || []).length ? (
            <table className="table mb-0">
              <thead><tr><th>Élève</th><th>Matricule</th><th>Sexe</th><th>Classe</th><th>Statut</th></tr></thead>
              <tbody>
                {enfantsDe[detail.id].map((e) => {
                  const anneeId = Number(annee) || null;
                  const insc = inscriptions.filter((i) => i.eleve_id === e.id && (!anneeId || i.annee_scolaire_id === anneeId)).at(-1);
                  return (
                    <tr key={e.id}>
                      <td className="fw-semibold">{`${e.prenom || ''} ${e.nom || ''}`}</td>
                      <td><code className="small">{e.matricule || '—'}</code></td>
                      <td>{e.sexe === 'M' ? 'Garçon' : e.sexe === 'F' ? 'Fille' : '—'}</td>
                      <td>{insc ? classeLabel(classeById[insc.classe_id]) : <span className="text-muted">Non inscrit</span>}</td>
                      <td><span className={`badge ${(e.statut || 'Actif') === 'Actif' ? 'bg-label-success' : 'bg-label-secondary'}`}>{e.statut || 'Actif'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <p className="text-muted mb-0">Aucun enfant n'est encore rattaché à cette famille. Rattachez-le depuis la fiche de l'élève.</p>}
        </Modal>
      )}
      {confirmNode}
    </>
  );
}

function ParentModal({ data, onClose, onSaved }) {
  const [form, setForm] = useState({ nom: data?.nom || '', prenom: data?.prenom || '', telephone: data?.telephone || '', email: data?.email || '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  const submit = async () => {
    setError('');
    const payload = { nom: form.nom.trim(), prenom: form.prenom.trim(), telephone: form.telephone.trim(), email: form.email.trim() };
    for (const [k, label] of [['nom', 'nom'], ['prenom', 'prénom'], ['telephone', 'téléphone'], ['email', 'e-mail']]) {
      if (!payload[k]) {
        setError(`Renseignez le ${label}.`);
        return;
      }
    }
    setSaving(true);
    try {
      if (data) {
        await api.put(`/parents/${data.id}`, payload);
        await onSaved(`Fiche de ${payload.nom} ${payload.prenom} mise à jour`);
      } else {
        await api.post('/parents/', payload);
        await onSaved(`${payload.nom} ${payload.prenom} a été ajouté au carnet`);
      }
    } catch (err) {
      setError(/unicit/i.test(err.message) ? 'Cet e-mail est déjà utilisé par une autre famille.' : err.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      size=""
      title={data ? <><i className="bx bx-edit-alt me-2 text-primary" />Modifier {nomComplet(data)}</> : <><i className="bx bx-user-plus me-2 text-primary" />Ajouter un parent</>}
      onClose={onClose}
      onSubmit={submit}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onClose} disabled={saving}>Annuler</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-save me-1" />} Enregistrer</button>
        </>
      )}
    >
      <div className="row g-3">
        <div className="col-md-6"><label className="form-label">Nom *</label><input type="text" className="form-control" value={form.nom} onChange={set('nom')} /></div>
        <div className="col-md-6"><label className="form-label">Prénom(s) *</label><input type="text" className="form-control" value={form.prenom} onChange={set('prenom')} /></div>
        <div className="col-md-6"><label className="form-label">Téléphone *</label><input type="tel" className="form-control" placeholder="6 XX XX XX XX" value={form.telephone} onChange={set('telephone')} /></div>
        <div className="col-md-6">
          <label className="form-label">E-mail *</label>
          <input type="email" className="form-control" value={form.email} onChange={set('email')} />
          <div className="form-text">L'e-mail identifie la famille : il ne peut servir qu'une fois.</div>
        </div>
      </div>
      {error && <div className="alert alert-danger mt-3 mb-0">{error}</div>}
    </Modal>
  );
}

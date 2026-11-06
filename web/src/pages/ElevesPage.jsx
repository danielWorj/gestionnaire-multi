import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { enregistrer, nouvelleCle, terminerEnregistrement, useApresSynchro } from '../lib/offline';
import OperationsEnAttente from '../components/OperationsEnAttente';
import Modal from '../components/Modal';
import ChartCanvas, { ChartEmpty, ChartPanel } from '../components/ChartCanvas';
import { useAuth } from '../context/AuthContext';
import {
  age, classeLabel as baseClasseLabel, downloadCsv, FilterChips, formatDate, IconBtn, initiales, PageHeader, Pager,
  SortTh, StatCard, TableCard, TBody, useConfirm, usePagination, useToast,
} from '../components/ui';
import Select from '../components/Select';
import ImportElevesModal from '../components/ImportElevesModal';

// Portage de server/static/templates/eleve.html : répertoire des élèves
// (inscription_api.py) avec filtres, analyses, fiche et formulaire
// (parent existant ou créé à la volée).

const PRIMARY = '#696cff';
const INFO = '#03c3ec';
const PINK = '#EC4899';
const GRID = { color: '#eceef1' };

const EMPTY_FILTERS = { q: '', classe: '', sexe: '', statut: '', scolarite: '', ageMin: '', ageMax: '' };
const SCOLARITE_LABELS = { inscrit: 'Inscrits cette année', 'non-inscrit': 'Non inscrits cette année', 'sans-parent': 'Sans parent rattaché' };

const fullName = (e) => `${e.prenom || ''} ${e.nom || ''}`.trim();

const MODULES_FICHES = ['dossier_inscription', 'eleve', 'parent', 'inscription'];

export default function ElevesPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { activeEtablissementId } = useAuth();

  const [data, setData] = useState({ eleves: [], parents: [], inscriptions: [], classes: [], cycles: [], annees: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [annee, setAnnee] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState({ key: 'nom', asc: true });
  const [panels, setPanels] = useState({ classes: true, annees: false, profil: false });
  const [ch, setCh] = useState({ anneeClasses: '', cycleClasses: '', detailClasses: 'total', classeAnnees: '', sexeAnnees: '', anneeProfil: '', classeProfil: '' });
  const [formModal, setFormModal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [importOuvert, setImportOuvert] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [eleves, parents, inscriptions, classes, cycles, annees] = await Promise.all([
        api.get('/eleves/'), api.get('/parents/'), api.get('/inscriptions/'),
        api.get('/classes/'), api.get('/cycles/'), api.get('/annees-scolaires/'),
      ]);
      annees.sort((a, b) => String(b.libelle).localeCompare(String(a.libelle)));
      setData({ eleves: eleves || [], parents: parents || [], inscriptions: inscriptions || [], classes: classes || [], cycles: cycles || [], annees });
      // Année par défaut : celle marquée active, sinon la plus récente.
      const def = String((annees.find((a) => a.active) || annees[0])?.id ?? '');
      setAnnee((prev) => prev || def);
      setCh((prev) => ({ ...prev, anneeClasses: prev.anneeClasses || def, anneeProfil: prev.anneeProfil || def }));
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
  useApresSynchro(MODULES_FICHES, loadAll);

  const { eleves, parents, inscriptions, classes, cycles, annees } = data;
  const parentById = useMemo(() => Object.fromEntries(parents.map((p) => [p.id, p])), [parents]);
  const classeById = useMemo(() => Object.fromEntries(classes.map((c) => [c.id, c])), [classes]);
  const eleveById = useMemo(() => Object.fromEntries(eleves.map((e) => [e.id, e])), [eleves]);
  const classeLabel = useCallback((c) => (c ? baseClasseLabel(c, cycles, ' · ') : '—'), [cycles]);
  const anneeLabel = useCallback((id) => annees.find((a) => a.id === Number(id))?.libelle || (id ? `Année #${id}` : '—'), [annees]);
  const classesTriees = useMemo(() => [...classes].sort((a, b) => classeLabel(a).localeCompare(classeLabel(b))), [classes, classeLabel]);

  // Inscription d'un élève pour une année donnée (la plus récente si doublon).
  const inscriptionDe = useCallback((eleveId, anneeId) => {
    let found = null;
    for (const i of inscriptions) {
      if (i.eleve_id !== eleveId) continue;
      if (anneeId && i.annee_scolaire_id !== Number(anneeId)) continue;
      if (!found || i.id > found.id) found = i;
    }
    return found;
  }, [inscriptions]);

  /* ── Chiffres clés ── */
  const stats = useMemo(() => {
    const anneeId = Number(annee) || null;
    const total = eleves.length;
    const inscrits = new Set(inscriptions.filter((i) => !anneeId || i.annee_scolaire_id === anneeId).map((i) => i.eleve_id));
    const m = eleves.filter((e) => e.sexe === 'M').length;
    const f = eleves.filter((e) => e.sexe === 'F').length;
    const actifs = eleves.filter((e) => e.statut !== 'Inactif').length;
    const sansClasse = eleves.filter((e) => e.statut !== 'Inactif' && !inscrits.has(e.id)).length;
    return { total, inscrits: inscrits.size, m, f, actifs, sansClasse };
  }, [eleves, inscriptions, annee]);

  /* ── Filtres / tri ── */
  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const ageMin = filters.ageMin === '' ? null : Number(filters.ageMin);
    const ageMax = filters.ageMax === '' ? null : Number(filters.ageMax);
    const list = eleves.filter((e) => {
      if (q && !`${e.nom || ''} ${e.prenom || ''} ${e.matricule || ''}`.toLowerCase().includes(q)) return false;
      if (filters.sexe && e.sexe !== filters.sexe) return false;
      if (filters.statut && (e.statut || 'Actif') !== filters.statut) return false;
      const insc = inscriptionDe(e.id, annee);
      if (filters.classe && (!insc || insc.classe_id !== Number(filters.classe))) return false;
      if (filters.scolarite === 'inscrit' && !insc) return false;
      if (filters.scolarite === 'non-inscrit' && insc) return false;
      if (filters.scolarite === 'sans-parent' && e.parent_id) return false;
      const a = age(e.date_naissance);
      if (ageMin != null && (a == null || a < ageMin)) return false;
      if (ageMax != null && (a == null || a > ageMax)) return false;
      return true;
    });
    const val = (e) => {
      if (sort.key === 'matricule') return (e.matricule || '').toLowerCase();
      if (sort.key === 'age') return age(e.date_naissance) ?? -1;
      return `${e.nom || ''} ${e.prenom || ''}`.toLowerCase();
    };
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return sort.asc ? -1 : 1;
      if (va > vb) return sort.asc ? 1 : -1;
      return 0;
    });
  }, [eleves, filters, sort, annee, inscriptionDe]);

  const pagination = usePagination(filtered, 50);
  const setFilter = (name) => (ev) => { setFilters((f) => ({ ...f, [name]: ev.target.value })); pagination.reset(); };

  const chips = [
    filters.q && ['q', `« ${filters.q.trim().toLowerCase()} »`],
    filters.classe && ['classe', classeLabel(classeById[filters.classe])],
    filters.sexe && ['sexe', filters.sexe === 'M' ? 'Garçons' : 'Filles'],
    filters.statut && ['statut', filters.statut],
    filters.scolarite && ['scolarite', SCOLARITE_LABELS[filters.scolarite]],
    filters.ageMin !== '' && ['ageMin', `≥ ${filters.ageMin} ans`],
    filters.ageMax !== '' && ['ageMax', `≤ ${filters.ageMax} ans`],
  ].filter(Boolean);

  const changeAnnee = (value) => {
    setAnnee(value);
    setCh((c) => ({ ...c, anneeClasses: value, anneeProfil: value }));
    pagination.reset();
  };

  /* ── Graphiques ── */
  const chartClasses = useMemo(() => {
    const anneeId = Number(ch.anneeClasses) || null;
    const cycleId = Number(ch.cycleClasses) || null;
    const parSexe = ch.detailClasses === 'sexe';
    const buckets = {};
    inscriptions.forEach((i) => {
      if (anneeId && i.annee_scolaire_id !== anneeId) return;
      const c = classeById[i.classe_id];
      if (!c || (cycleId && c.cycle_id !== cycleId)) return;
      const b = (buckets[i.classe_id] ||= { total: 0, M: 0, F: 0 });
      b.total++;
      const el = eleveById[i.eleve_id];
      if (el && (el.sexe === 'M' || el.sexe === 'F')) b[el.sexe]++;
    });
    const ids = Object.keys(buckets).map(Number).sort((a, b) => classeLabel(classeById[a]).localeCompare(classeLabel(classeById[b])));
    const total = ids.reduce((s, id) => s + buckets[id].total, 0);
    const meta = `${anneeLabel(anneeId)} · ${total} inscription${total > 1 ? 's' : ''}`;
    if (!ids.length) return { meta, config: null };
    const datasets = parSexe
      ? [
        { label: 'Garçons', data: ids.map((id) => buckets[id].M), backgroundColor: INFO, borderRadius: 3, stack: 's' },
        { label: 'Filles', data: ids.map((id) => buckets[id].F), backgroundColor: PINK, borderRadius: 3, stack: 's' },
      ]
      : [{ label: 'Élèves inscrits', data: ids.map((id) => buckets[id].total), backgroundColor: PRIMARY, borderRadius: 4, maxBarThickness: 34 }];
    return {
      meta,
      config: {
        type: 'bar',
        data: { labels: ids.map((id) => classeLabel(classeById[id])), datasets },
        options: {
          plugins: { legend: { display: parSexe, position: 'bottom' } },
          scales: { x: { stacked: parSexe, grid: { display: false }, ticks: { maxRotation: 60, minRotation: 0 } }, y: { stacked: parSexe, beginAtZero: true, grid: GRID, ticks: { precision: 0 } } },
        },
      },
    };
  }, [ch.anneeClasses, ch.cycleClasses, ch.detailClasses, inscriptions, classeById, eleveById, classeLabel, anneeLabel]);

  const chartAnnees = useMemo(() => {
    const classeId = Number(ch.classeAnnees) || null;
    const ordered = [...annees].sort((a, b) => String(a.libelle).localeCompare(String(b.libelle)));
    const values = ordered.map((a) => inscriptions.filter((i) => {
      if (i.annee_scolaire_id !== a.id) return false;
      if (classeId && i.classe_id !== classeId) return false;
      if (ch.sexeAnnees) {
        const e = eleveById[i.eleve_id];
        if (!e || e.sexe !== ch.sexeAnnees) return false;
      }
      return true;
    }).length);
    const somme = values.reduce((s, v) => s + v, 0);
    const dernier = values.at(-1) ?? 0;
    const avant = values.length > 1 ? values.at(-2) : null;
    const delta = avant ? Math.round(((dernier - avant) / avant) * 100) : null;
    const meta = ordered.length ? (delta == null ? `${somme} inscriptions au total` : `${delta >= 0 ? '+' : ''}${delta} % sur la dernière année`) : '';
    if (!somme) return { meta, config: null };
    return {
      meta,
      config: {
        type: 'line',
        data: { labels: ordered.map((a) => a.libelle), datasets: [{ label: 'Inscriptions', data: values, borderColor: PRIMARY, backgroundColor: 'rgba(105,108,255,0.12)', fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: PRIMARY, borderWidth: 2 }] },
        options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: GRID, ticks: { precision: 0 } } } },
      },
    };
  }, [ch.classeAnnees, ch.sexeAnnees, annees, inscriptions, eleveById]);

  const chartProfil = useMemo(() => {
    const anneeId = Number(ch.anneeProfil) || null;
    const classeId = Number(ch.classeProfil) || null;
    let cible = eleves;
    if (anneeId || classeId) {
      const ids = new Set(inscriptions.filter((i) => (!anneeId || i.annee_scolaire_id === anneeId) && (!classeId || i.classe_id === classeId)).map((i) => i.eleve_id));
      cible = eleves.filter((e) => ids.has(e.id));
    }
    const m = cible.filter((e) => e.sexe === 'M').length;
    const f = cible.filter((e) => e.sexe === 'F').length;
    const ages = cible.map((e) => age(e.date_naissance)).filter((a) => a != null);
    const bornes = [[0, 10, '10 ans et moins'], [11, 12, '11–12 ans'], [13, 14, '13–14 ans'], [15, 16, '15–16 ans'], [17, 18, '17–18 ans'], [19, 99, '19 ans et plus']];
    const moy = ages.length ? ages.reduce((s, a) => s + a, 0) / ages.length : null;
    return {
      meta: `${cible.length} élève${cible.length > 1 ? 's' : ''}`,
      sexe: {
        type: 'doughnut',
        data: { labels: ['Garçons', 'Filles', 'Non renseigné'], datasets: [{ data: [m, f, cible.length - m - f], backgroundColor: [INFO, PINK, '#d9dee3'], borderWidth: 0 }] },
        options: { cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } } } },
      },
      ages: {
        type: 'bar',
        data: { labels: bornes.map((b) => b[2]), datasets: [{ label: 'Élèves', data: bornes.map((b) => ages.filter((a) => a >= b[0] && a <= b[1]).length), backgroundColor: PRIMARY, borderRadius: 4, maxBarThickness: 40 }] },
        options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: GRID, ticks: { precision: 0 } } } },
      },
      kpis: {
        moyen: moy == null ? '—' : `${moy.toFixed(1)} ans`,
        min: ages.length ? `${Math.min(...ages)} ans` : '—',
        max: ages.length ? `${Math.max(...ages)} ans` : '—',
        nr: `${cible.length - ages.length} élève(s)`,
      },
    };
  }, [ch.anneeProfil, ch.classeProfil, eleves, inscriptions]);

  const togglePanel = (key) => setPanels((p) => ({ ...p, [key]: !p[key] }));
  const allOpen = Object.values(panels).every(Boolean);
  const setChField = (name) => (e) => setCh((c) => ({ ...c, [name]: e.target.value }));

  /* ── Actions ── */
  const supprimer = async (e) => {
    const ok = await confirm(
      <>Vous êtes sur le point de supprimer <strong>{fullName(e)}</strong>.<br /><span className="text-muted">Ses inscriptions et son historique disparaîtront aussi. Pour conserver la trace de sa scolarité, passez plutôt son statut à « Inactif ».</span></>,
      { title: "Supprimer l'élève", confirmLabel: 'Supprimer' },
    );
    if (!ok) return;
    try {
      await api.del(`/eleves/${e.id}`);
      toast('Élève supprimé');
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const exportCsv = () => {
    const rows = [['Matricule', 'Nom', 'Prénom', 'Sexe', 'Date de naissance', 'Lieu de naissance', 'Classe', 'Statut', 'Parent', 'Téléphone parent']];
    filtered.forEach((e) => {
      const insc = inscriptionDe(e.id, annee);
      const p = parentById[e.parent_id];
      rows.push([e.matricule, e.nom, e.prenom, e.sexe, e.date_naissance || '', e.lieu_naissance, insc ? classeLabel(classeById[insc.classe_id]) : '', e.statut || 'Actif', p ? `${p.nom} ${p.prenom}` : '', p ? p.telephone : '']);
    });
    downloadCsv(`eleves-${(anneeLabel(annee) || 'tous').replace(/[^\w-]/g, '_')}.csv`, rows);
    toast(`${rows.length - 1} élève(s) exporté(s)`);
  };

  const anneeOptions = annees.length
    ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (en cours)' : ''}</option>)
    : <option value="">Aucune année</option>;
  const classeOptions = classesTriees.map((c) => <option key={c.id} value={c.id}>{classeLabel(c)}</option>);

  return (
    <>
      <PageHeader title="Élèves" subtitle="Le répertoire des élèves de l'établissement. La classe affichée est celle de l'année scolaire choisie dans les filtres.">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={exportCsv}><i className="bx bx-file me-1" /> Exporter la sélection</button>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={loadAll}><i className="bx bx-refresh me-1" /> Actualiser</button>
        <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => setImportOuvert(true)}><i className="bx bx-import me-1" /> Importer (Excel, CSV, Word)</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormModal({ data: null })}><i className="bx bx-plus me-1" /> Ajouter un élève</button>
      </PageHeader>
      <OperationsEnAttente modules={MODULES_FICHES} titre="Fiches pas encore enregistrées sur le serveur" />

      <div className="row g-3 mb-4">
        <StatCard label="Élèves au répertoire" loading={loading} value={stats.total} sub={loading ? '—' : `${stats.actifs} actifs · ${stats.total - stats.actifs} inactifs`} icon="bx-face" color="primary" />
        <StatCard label={`Inscrits ${anneeLabel(annee)}`} loading={loading} value={stats.inscrits} sub={stats.total ? `${Math.round((stats.inscrits / stats.total) * 100)} % du répertoire` : '—'} icon="bx-user-check" color="success" />
        <StatCard label="Garçons / Filles" loading={loading} value={`${stats.m} / ${stats.f}`} sub={stats.total ? `${Math.round((stats.f / stats.total) * 100)} % de filles` : '—'} icon="bx-male-sign" color="info" />
        <StatCard label="Sans classe cette année" loading={loading} value={stats.sansClasse} sub={stats.sansClasse ? 'à inscrire' : 'tout le monde est inscrit'} icon="bx-time" color="warning" />
      </div>

      {/* Analyses */}
      <div className="d-flex align-items-center gap-2 mb-2">
        <h6 className="mb-0">Analyses</h6>
        <small className="text-muted">Ouvrez un panneau pour charger son graphique</small>
        <button type="button" className="btn btn-outline-secondary btn-sm ms-auto" onClick={() => setPanels({ classes: !allOpen, annees: !allOpen, profil: !allOpen })}>
          <i className={`bx ${allOpen ? 'bx-chevrons-up' : 'bx-chevrons-down'} me-1`} /> {allOpen ? 'Tout fermer' : 'Tout ouvrir'}
        </button>
      </div>

      <ChartPanel
        title="Effectifs par classe"
        icon="bx-bar-chart-alt-2"
        meta={chartClasses.meta}
        open={panels.classes}
        onToggle={() => togglePanel('classes')}
        controls={(
          <>
            <div className="col-md-4"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={ch.anneeClasses} onChange={setChField('anneeClasses')}>{anneeOptions}</Select></div>
            <div className="col-md-4"><label className="form-label">Cycle</label><Select className="form-select form-select-sm" value={ch.cycleClasses} onChange={setChField('cycleClasses')}><option value="">Tous les cycles</option>{cycles.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}</Select></div>
            <div className="col-md-4"><label className="form-label">Détail</label><Select className="form-select form-select-sm" value={ch.detailClasses} onChange={setChField('detailClasses')}><option value="total">Effectif total</option><option value="sexe">Réparti par sexe</option></Select></div>
          </>
        )}
      >
        {chartClasses.config ? <ChartCanvas config={chartClasses.config} height={320} /> : <ChartEmpty>Aucune inscription pour cette année scolaire.</ChartEmpty>}
      </ChartPanel>

      <ChartPanel
        title="Évolution des effectifs par année"
        icon="bx-trending-up"
        meta={chartAnnees.meta}
        open={panels.annees}
        onToggle={() => togglePanel('annees')}
        controls={(
          <>
            <div className="col-md-6"><label className="form-label">Classe suivie</label><Select className="form-select form-select-sm" value={ch.classeAnnees} onChange={setChField('classeAnnees')}><option value="">Toutes les classes</option>{classeOptions}</Select></div>
            <div className="col-md-6"><label className="form-label">Sexe</label><Select className="form-select form-select-sm" value={ch.sexeAnnees} onChange={setChField('sexeAnnees')}><option value="">Tous</option><option value="M">Garçons</option><option value="F">Filles</option></Select></div>
          </>
        )}
      >
        {chartAnnees.config ? <ChartCanvas config={chartAnnees.config} height={260} /> : <ChartEmpty icon="bx-trending-up">Il faut au moins une année scolaire avec des inscriptions.</ChartEmpty>}
      </ChartPanel>

      <ChartPanel
        className="mb-4"
        title="Profil des élèves — sexe et âge"
        icon="bx-group"
        meta={chartProfil.meta}
        open={panels.profil}
        onToggle={() => togglePanel('profil')}
        controls={(
          <>
            <div className="col-md-6"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={ch.anneeProfil} onChange={setChField('anneeProfil')}>{anneeOptions}</Select></div>
            <div className="col-md-6"><label className="form-label">Classe</label><Select className="form-select form-select-sm" value={ch.classeProfil} onChange={setChField('classeProfil')}><option value="">Toutes les classes</option>{classeOptions}</Select></div>
          </>
        )}
      >
        <div className="row g-3">
          <div className="col-md-6"><ChartCanvas config={chartProfil.sexe} height={200} /></div>
          <div className="col-md-6"><ChartCanvas config={chartProfil.ages} height={200} /></div>
        </div>
        <div className="row g-2 mt-2 text-center">
          {[['Âge moyen', chartProfil.kpis.moyen], ['Plus jeune', chartProfil.kpis.min], ['Plus âgé', chartProfil.kpis.max], ['Date de naissance manquante', chartProfil.kpis.nr]].map(([l, v]) => (
            <div key={l} className="col-6 col-md-3"><small className="text-muted d-block">{l}</small><span className="fw-semibold">{v}</span></div>
          ))}
        </div>
      </ChartPanel>

      {/* Filtres */}
      <div className="card mb-3">
        <div className="card-body">
          <h6 className="mb-3"><i className="bx bx-filter-alt me-1" /> Filtres {chips.length > 0 && <span className="badge rounded-pill bg-primary ms-1">{chips.length}</span>}</h6>
          <div className="row g-2 align-items-end">
            <div className="col-md-3"><label className="form-label">Rechercher</label><input type="search" className="form-control form-control-sm" placeholder="Nom, prénom, matricule…" value={filters.q} onChange={setFilter('q')} /></div>
            <div className="col-md-2"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={annee} onChange={(e) => changeAnnee(e.target.value)}>{anneeOptions}</Select></div>
            <div className="col-md-2"><label className="form-label">Classe</label><Select className="form-select form-select-sm" value={filters.classe} onChange={setFilter('classe')}><option value="">Toutes</option>{classeOptions}</Select></div>
            <div className="col-md-1"><label className="form-label">Sexe</label><Select className="form-select form-select-sm" value={filters.sexe} onChange={setFilter('sexe')}><option value="">Tous</option><option value="M">Garçons</option><option value="F">Filles</option></Select></div>
            <div className="col-md-2"><label className="form-label">Statut de l'élève</label><Select className="form-select form-select-sm" value={filters.statut} onChange={setFilter('statut')}><option value="">Tous</option><option value="Actif">Actif</option><option value="Inactif">Inactif</option></Select></div>
            <div className="col-md-2"><label className="form-label">Scolarité</label><Select className="form-select form-select-sm" value={filters.scolarite} onChange={setFilter('scolarite')}><option value="">Tous</option>{Object.entries(SCOLARITE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>
            <div className="col-md-2"><label className="form-label">Âge minimum</label><input type="number" min="0" max="40" className="form-control form-control-sm" placeholder="—" value={filters.ageMin} onChange={setFilter('ageMin')} /></div>
            <div className="col-md-2"><label className="form-label">Âge maximum</label><input type="number" min="0" max="40" className="form-control form-control-sm" placeholder="—" value={filters.ageMax} onChange={setFilter('ageMax')} /></div>
            <div className="col-md-2"><button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { setFilters(EMPTY_FILTERS); pagination.reset(); }}><i className="bx bx-reset me-1" /> Réinitialiser</button></div>
          </div>
          <FilterChips chips={chips} onClear={(key) => { setFilters((f) => ({ ...f, [key]: '' })); pagination.reset(); }} />
        </div>
      </div>

      {/* Répertoire */}
      <TableCard title="Répertoire" icon="bx-list-ul" count={filtered.length} footer={null}>
        <table className="table table-hover mb-0">
          <thead>
            <tr>
              <SortTh sortKey="nom" sort={sort} setSort={setSort}>Élève</SortTh>
              <SortTh sortKey="matricule" sort={sort} setSort={setSort}>Matricule</SortTh>
              <th>Sexe</th>
              <SortTh sortKey="age" sort={sort} setSort={setSort}>Âge</SortTh>
              <th>Classe</th>
              <th>Parent</th>
              <th>Statut</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <TBody colSpan={8} loading={loading} error={error && `Les élèves n'ont pas pu être chargés : ${error}`} rows={filtered.length} empty="Aucun élève ne correspond à ces filtres. Élargissez la recherche ou ajoutez un élève." emptyIcon="bx-group">
            {pagination.slice.map((e) => {
              const insc = inscriptionDe(e.id, annee);
              const cls = insc ? classeById[insc.classe_id] : null;
              const p = parentById[e.parent_id];
              const a = age(e.date_naissance);
              return (
                <tr key={e.id}>
                  <td>
                    <div className="d-flex align-items-center gap-2">
                      <div><div className="fw-semibold">{fullName(e)}</div><small className="text-muted">{e.lieu_naissance || '—'}</small></div>
                    </div>
                  </td>
                  <td><code className="small">{e.matricule || '—'}</code></td>
                  <td>{e.sexe === 'M' ? 'Garçon' : e.sexe === 'F' ? 'Fille' : '—'}</td>
                  <td>{a == null ? <span className="text-muted">—</span> : `${a} ans`}</td>
                  <td>{cls ? <span className="badge bg-label-primary">{classeLabel(cls)}</span> : <span className="badge bg-label-secondary">Non inscrit</span>}</td>
                  <td>{p ? <><div className="fw-semibold">{p.nom} {p.prenom}</div><small className="text-muted">{p.telephone}</small></> : <span className="text-danger">Aucun</span>}</td>
                  <td><span className={`badge ${(e.statut || 'Actif') === 'Actif' ? 'bg-label-success' : 'bg-label-secondary'}`}>{e.statut || 'Actif'}</span></td>
                  <td className="text-end text-nowrap">
                    <IconBtn icon="bx-show" title="Voir la fiche" onClick={() => setDetail(e)} />
                    <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setFormModal({ data: e })} />
                    <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(e)} />
                  </td>
                </tr>
              );
            })}
          </TBody>
        </table>
        <Pager pagination={pagination} unit="élèves" />
      </TableCard>

      {formModal && (
        <EleveModal
          data={formModal.data}
          parents={parents}
          onClose={() => setFormModal(null)}
          onSaved={async (msg) => { setFormModal(null); toast(msg); await loadAll(); }}
        />
      )}

      {importOuvert && (
        <ImportElevesModal parents={parents} onClose={() => setImportOuvert(false)} onImported={loadAll} />
      )}

      {detail && (
        <Modal
          title={<><i className="bx bx-id-card me-2 text-primary" />Fiche élève</>}
          onClose={() => setDetail(null)}
          footer={(
            <>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setDetail(null)}>Fermer</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => { setFormModal({ data: detail }); setDetail(null); }}><i className="bx bx-edit-alt me-1" /> Modifier</button>
            </>
          )}
        >
          <FicheEleve e={detail} parent={parentById[detail.parent_id]} inscriptions={inscriptions} classeById={classeById} classeLabel={classeLabel} anneeLabel={anneeLabel} />
        </Modal>
      )}
      {confirmNode}
    </>
  );
}

function InfoLine({ label, value }) {
  return (
    <div className="d-flex justify-content-between border-bottom py-1">
      <span className="text-muted">{label}</span>
      <span className="fw-semibold">{value}</span>
    </div>
  );
}

function FicheEleve({ e, parent: p, inscriptions, classeById, classeLabel, anneeLabel }) {
  const hist = inscriptions.filter((i) => i.eleve_id === e.id).sort((a, b) => anneeLabel(b.annee_scolaire_id).localeCompare(anneeLabel(a.annee_scolaire_id)));
  const a = age(e.date_naissance);
  return (
    <>
      <div className="d-flex align-items-center gap-3 mb-3">
        <div className="avatar avatar-lg"><span className={`avatar-initial rounded-circle ${e.sexe === 'F' ? 'bg-label-danger' : 'bg-label-info'}`}>{initiales(e.nom, e.prenom)}</span></div>
        <div>
          <div className="fw-bold fs-6">{fullName(e)}</div>
          <div className="text-muted">Matricule {e.matricule || '—'} · {e.sexe === 'M' ? 'Garçon' : e.sexe === 'F' ? 'Fille' : 'Sexe non renseigné'}</div>
        </div>
      </div>
      <div className="row g-3 mb-3">
        <div className="col-md-6">
          <InfoLine label="Né(e) le" value={formatDate(e.date_naissance)} />
          <InfoLine label="À" value={e.lieu_naissance || '—'} />
          <InfoLine label="Âge" value={a == null ? '—' : `${a} ans`} />
        </div>
        <div className="col-md-6">
          <InfoLine label="Parent" value={p ? `${p.nom} ${p.prenom}` : 'Aucun'} />
          <InfoLine label="Téléphone" value={p?.telephone || '—'} />
          <InfoLine label="E-mail" value={p?.email || '—'} />
        </div>
      </div>
      <h6 className="mb-2">Parcours scolaire</h6>
      {hist.length ? (
        <table className="table mb-0">
          <thead><tr><th>Année</th><th>Classe</th><th>Inscrit le</th><th>Statut</th></tr></thead>
          <tbody>
            {hist.map((i) => (
              <tr key={i.id}>
                <td>{anneeLabel(i.annee_scolaire_id)}</td>
                <td>{classeLabel(classeById[i.classe_id])}</td>
                <td>{formatDate(i.date_inscription)}</td>
                <td><span className={`badge ${i.statut === 'Actif' ? 'bg-label-success' : 'bg-label-secondary'}`}>{i.statut || '—'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="text-muted mb-0">Aucune inscription enregistrée pour cet élève.</p>}
    </>
  );
}

function EleveModal({ data, parents, onClose, onSaved }) {
  const [form, setForm] = useState({
    matricule: data?.matricule || '',
    nom: data?.nom || '',
    prenom: data?.prenom || '',
    sexe: data?.sexe || '',
    date_naissance: data?.date_naissance || '',
    lieu_naissance: data?.lieu_naissance || '',
    statut: data?.statut || 'Actif',
    parent_id: data?.parent_id ? String(data.parent_id) : '',
  });
  const [parentMode, setParentMode] = useState('exist');
  const [np, setNp] = useState({ nom: '', prenom: '', telephone: '', email: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const setP = (name) => (e) => setNp((f) => ({ ...f, [name]: e.target.value }));

  const submit = async () => {
    setError('');
    const payload = {
      matricule: form.matricule.trim(),
      nom: form.nom.trim(),
      prenom: form.prenom.trim(),
      sexe: form.sexe,
      lieu_naissance: form.lieu_naissance.trim(),
      statut: form.statut,
    };
    if (form.date_naissance) payload.date_naissance = form.date_naissance;
    for (const [k, label] of [['matricule', 'matricule'], ['nom', 'nom'], ['prenom', 'prénom'], ['sexe', 'sexe'], ['lieu_naissance', 'lieu de naissance']]) {
      if (!payload[k]) {
        setError(`Renseignez le ${label}.`);
        return;
      }
    }
    setSaving(true);
    try {
      let nouveauParent = null;
      if (parentMode === 'new') {
        nouveauParent = { nom: np.nom.trim(), prenom: np.prenom.trim(), telephone: np.telephone.trim(), email: np.email.trim() };
        if (!nouveauParent.nom || !nouveauParent.prenom || !nouveauParent.telephone || !nouveauParent.email) {
          throw new Error("Le nouveau parent a besoin d'un nom, d'un prénom, d'un téléphone et d'un e-mail.");
        }
      } else {
        payload.parent_id = Number(form.parent_id) || null;
        if (!payload.parent_id) throw new Error("Choisissez le parent de l'élève.");
      }
      const nomEleve = `${payload.prenom} ${payload.nom}`;
      if (data) {
        // Nouveau parent pour un élève existant : le parent doit d'abord
        // exister sur le serveur (son identifiant est rattaché à la fiche).
        if (nouveauParent) {
          if (navigator.onLine === false) {
            throw new Error('Sans connexion, choisissez un parent déjà enregistré (la création d\'un parent lors de la modification d\'un élève demande la connexion).');
          }
          payload.parent_id = (await api.post('/parents/', nouveauParent)).id;
        }
        const res = await enregistrer({
          cle: `eleve|${data.id}`,
          module: 'eleve',
          methode: 'PUT',
          url: `/eleves/${data.id}`,
          body: payload,
          versionBase: data.version ?? undefined,
          libelle: `Fiche de ${nomEleve}`,
        });
        await terminerEnregistrement(res, { onSaved, ok: `Fiche de ${nomEleve} mise à jour` });
      } else {
        // Création : dossier (parent éventuel + élève) en une requête, ce qui
        // fonctionne aussi hors connexion.
        const { parent_id: parentId, ...eleve } = payload;
        const res = await enregistrer({
          cle: nouvelleCle('dossier'),
          module: 'dossier_inscription',
          methode: 'POST',
          url: '/dossiers-inscription/',
          body: nouveauParent ? { parent: nouveauParent, eleve } : { parent_id: parentId, eleve },
          libelle: `Nouvel élève : ${nomEleve}`,
        });
        await terminerEnregistrement(res, { onSaved, ok: `${nomEleve} a été ajouté` });
      }
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const parentsTries = [...parents].sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));

  return (
    <Modal
      title={data ? <><i className="bx bx-edit-alt me-2 text-primary" />Modifier {fullName(data)}</> : <><i className="bx bx-face me-2 text-primary" />Ajouter un élève</>}
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
        <div className="col-md-4">
          <label className="form-label">Matricule *</label>
          <input type="text" className="form-control" value={form.matricule} onChange={set('matricule')} />
          <div className="form-text">Unique au sein de l'établissement.</div>
        </div>
        <div className="col-md-4"><label className="form-label">Nom *</label><input type="text" className="form-control" value={form.nom} onChange={set('nom')} /></div>
        <div className="col-md-4"><label className="form-label">Prénom(s) *</label><input type="text" className="form-control" value={form.prenom} onChange={set('prenom')} /></div>
        <div className="col-md-3">
          <label className="form-label">Sexe *</label>
          <Select className="form-select" value={form.sexe} onChange={set('sexe')}><option value="">—</option><option value="M">Masculin</option><option value="F">Féminin</option></Select>
        </div>
        <div className="col-md-3"><label className="form-label">Date de naissance</label><input type="date" className="form-control" value={form.date_naissance} onChange={set('date_naissance')} /></div>
        <div className="col-md-3"><label className="form-label">Lieu de naissance *</label><input type="text" className="form-control" value={form.lieu_naissance} onChange={set('lieu_naissance')} /></div>
        <div className="col-md-3">
          <label className="form-label">Statut</label>
          <Select className="form-select" value={form.statut} onChange={set('statut')}><option value="Actif">Actif</option><option value="Inactif">Inactif</option></Select>
        </div>
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
        <div>
          <label className="form-label">Parent *</label>
          <Select className="form-select" value={form.parent_id} onChange={set('parent_id')}>
            <option value="">— Choisir un parent —</option>
            {parentsTries.map((p) => <option key={p.id} value={p.id}>{`${p.nom || ''} ${p.prenom || ''}${p.telephone ? ` — ${p.telephone}` : ''}`}</option>)}
          </Select>
          <div className="form-text">Un élève ne peut pas être enregistré sans parent rattaché.</div>
        </div>
      ) : (
        <div className="row g-3">
          <div className="col-md-3"><label className="form-label">Nom du parent *</label><input type="text" className="form-control" value={np.nom} onChange={setP('nom')} /></div>
          <div className="col-md-3"><label className="form-label">Prénom du parent *</label><input type="text" className="form-control" value={np.prenom} onChange={setP('prenom')} /></div>
          <div className="col-md-3"><label className="form-label">Téléphone *</label><input type="tel" className="form-control" value={np.telephone} onChange={setP('telephone')} /></div>
          <div className="col-md-3"><label className="form-label">E-mail *</label><input type="email" className="form-control" value={np.email} onChange={setP('email')} /></div>
          <div className="col-12"><div className="form-text">Le parent est créé en même temps que l'élève, puis rattaché automatiquement.</div></div>
        </div>
      )}

      {error && <div className="alert alert-danger mt-3 mb-0">{error}</div>}
    </Modal>
  );
}

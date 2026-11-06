import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import ChartCanvas, { colorAt, PIE_OPTIONS } from '../components/ChartCanvas';
import { useAuth } from '../context/AuthContext';
import {
  classeLabel, downloadCsv, Field, FormFooter, IconBtn, IdentifiantsModal, initiales, PageHeader, StatCard, TBody,
  useConfirm, useSave, useToast,
} from '../components/ui';
import Select from '../components/Select';
import ImportModal from '../components/importConfigs';
import { roleDe } from '../components/Layout';

// Portage de server/static/templates/enseignant.html : enseignants,
// départements, grades (pedagogie_api.py) + création du compte de connexion
// (authentification_api.py).

const byLibelle = (a, b) => (a.libelle || '').localeCompare(b.libelle || '');
const fullName = (e) => `${e.prenom || ''} ${e.nom || ''}`.trim();

function anneeActiveId(annees) {
  if (!annees.length) return null;
  const active = annees.find((a) => a.active);
  if (active) return active.id;
  return [...annees].sort(byLibelle).at(-1).id;
}

const EMPTY_FILTERS = { search: '', departement: '', grade: '', sexe: '', statut: '' };

export default function EnseignantsPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { user, activeEtablissementId } = useAuth();

  const [data, setData] = useState({
    enseignants: [], matieresClasse: [], titulaires: [], classes: [], annees: [], matieres: [], departements: [], grades: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [refTab, setRefTab] = useState('enseignants');
  const [evolutionAnnee, setEvolutionAnnee] = useState(null); // null = pas encore initialisé
  const [enseignantRoleId, setEnseignantRoleId] = useState(null);

  const [formModal, setFormModal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [refModal, setRefModal] = useState(null); // { type: 'departement'|'grade', data }
  const [identifiants, setIdentifiants] = useState(null);
  const [importOuvert, setImportOuvert] = useState(false);
  const peutImporter = ['Admin', 'SuperAdmin'].includes(roleDe(user));

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cycles, classesRes, annees] = await Promise.all([
        api.get('/cycles/').catch(() => []),
        api.get('/classes/').catch(() => []),
        api.get('/annees-scolaires/').catch(() => []),
      ]);
      const matieres = await api.get('/matieres/').catch(() => []);
      const [enseignants, matieresClasse, titulaires, departements, grades] = await Promise.all([
        api.get('/enseignants/'),
        api.get('/matieres-classe/').catch(() => []),
        api.get('/titulaires-classe/').catch(() => []),
        api.get('/departements/').catch(() => []),
        api.get('/grades/').catch(() => []),
      ]);
      setData({
        enseignants,
        matieresClasse,
        titulaires,
        annees,
        matieres,
        departements,
        grades,
        classes: classesRes.map((c) => ({ ...c, cycle_libelle: cycles.find((cy) => cy.id === c.cycle_id)?.libelle })),
      });
      setEvolutionAnnee((prev) => (prev === null ? String(anneeActiveId(annees) ?? '') : prev));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll, activeEtablissementId]);

  useEffect(() => {
    api.get('/auth/roles')
      .then((roles) => setEnseignantRoleId(roles.find((r) => r.libelle === 'Enseignant')?.id ?? null))
      .catch(() => setEnseignantRoleId(null));
  }, []);

  const { enseignants, matieresClasse, titulaires, classes, annees, matieres, departements, grades } = data;

  const labels = useMemo(() => ({
    classe: (id) => classeLabel(classes.find((c) => c.id === id)) || `Classe #${id}`,
    annee: (id) => annees.find((a) => a.id === id)?.libelle || `Année #${id}`,
    matiere: (id) => matieres.find((m) => m.id === id)?.libelle || `Matière #${id}`,
    departement: (id) => (id ? departements.find((d) => d.id === id)?.libelle || `Département #${id}` : null),
    grade: (id) => (id ? grades.find((g) => g.id === id)?.libelle || `Grade #${id}` : null),
  }), [classes, annees, matieres, departements, grades]);

  const matieresByEnseignant = useMemo(() => {
    const map = {};
    matieresClasse.forEach((mc) => {
      (map[mc.enseignant_id] ||= []).push({ matiere: labels.matiere(mc.matiere_id), classe: labels.classe(mc.classe_id), coefficient: mc.coefficient });
    });
    return map;
  }, [matieresClasse, labels]);

  const titulairesByEnseignant = useMemo(() => {
    const map = {};
    titulaires.forEach((tc) => {
      (map[tc.enseignant_id] ||= []).push({ classe: labels.classe(tc.classe_id), annee: labels.annee(tc.annee_scolaire_id) });
    });
    return map;
  }, [titulaires, labels]);

  const topGrade = useMemo(() => {
    const counts = {};
    enseignants.forEach((e) => {
      const l = labels.grade(e.grade_id);
      if (l) counts[l] = (counts[l] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
  }, [enseignants, labels]);

  const filtered = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    return enseignants.filter((e) => {
      if (search && !`${e.nom} ${e.prenom} ${e.email || ''} ${e.code_connexion || ''}`.toLowerCase().includes(search)) return false;
      if (filters.departement && e.departement_id !== Number(filters.departement)) return false;
      if (filters.grade && e.grade_id !== Number(filters.grade)) return false;
      if (filters.sexe && e.sexe !== filters.sexe) return false;
      if (filters.statut === 'titulaire' && !e.est_titulaire) return false;
      if (filters.statut === 'non-titulaire' && e.est_titulaire) return false;
      return true;
    });
  }, [enseignants, filters]);

  /* ── Graphiques ── */
  const charts = useMemo(() => {
    if (loading) return null;
    const idsAvecAffectation = new Set([...titulaires.map((t) => t.enseignant_id), ...matieresClasse.map((m) => m.enseignant_id)]);
    const idsSans = new Set(enseignants.filter((e) => !idsAvecAffectation.has(e.id)).map((e) => e.id));
    const countDepAnnee = (depId, anneeId) => {
      const idsAnnee = new Set([
        ...titulaires.filter((t) => t.annee_scolaire_id === anneeId).map((t) => t.enseignant_id),
        ...matieresClasse.filter((m) => m.annee_scolaire_id === anneeId).map((m) => m.enseignant_id),
      ]);
      return enseignants.filter((e) => e.departement_id === depId && (idsAnnee.has(e.id) || idsSans.has(e.id))).length;
    };

    const anneeSel = evolutionAnnee ? Number(evolutionAnnee) : null;
    const sortedDep = [...departements].sort(byLibelle);
    const evolution = anneeSel
      ? {
        type: 'bar',
        data: {
          labels: sortedDep.map((d) => d.libelle),
          datasets: [{ label: labels.annee(anneeSel), data: sortedDep.map((d) => countDepAnnee(d.id, anneeSel)), backgroundColor: sortedDep.map((_, i) => colorAt(i)), borderRadius: 4, maxBarThickness: 40 }],
        },
        options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
      }
      : {
        type: 'bar',
        data: {
          labels: [...annees].sort(byLibelle).map((a) => a.libelle),
          datasets: departements.map((d, i) => ({ label: d.libelle, data: [...annees].sort(byLibelle).map((an) => countDepAnnee(d.id, an.id)), backgroundColor: colorAt(i), borderRadius: 4, maxBarThickness: 28 })),
        },
        options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
      };

    const sexe = { M: 0, F: 0, '': 0 };
    enseignants.forEach((e) => { sexe[e.sexe === 'M' || e.sexe === 'F' ? e.sexe : '']++; });
    const sexeParts = [['Masculin', sexe.M, '#4361ee'], ['Féminin', sexe.F, '#f72585'], ['Non renseigné', sexe[''], '#adb5bd']].filter((p) => p[1]);

    const gradeCounts = {};
    enseignants.forEach((e) => { const l = labels.grade(e.grade_id) || 'Non renseigné'; gradeCounts[l] = (gradeCounts[l] || 0) + 1; });
    const gradeEntries = Object.entries(gradeCounts).sort((a, b) => b[1] - a[1]);

    const avec = enseignants.filter((e) => (matieresByEnseignant[e.id] || []).length > 0).length;

    return {
      evolution,
      sexe: { type: 'pie', data: { labels: sexeParts.map((p) => p[0]), datasets: [{ data: sexeParts.map((p) => p[1]), backgroundColor: sexeParts.map((p) => p[2]) }] }, options: PIE_OPTIONS },
      grade: { type: 'pie', data: { labels: gradeEntries.map((e) => e[0]), datasets: [{ data: gradeEntries.map((e) => e[1]), backgroundColor: gradeEntries.map((_, i) => colorAt(i)) }] }, options: PIE_OPTIONS },
      sansMatiere: { type: 'pie', data: { labels: ['Avec matière(s) affectée(s)', 'Sans matière affectée'], datasets: [{ data: [avec, enseignants.length - avec], backgroundColor: ['#2a9d8f', '#e63946'] }] }, options: PIE_OPTIONS },
    };
  }, [loading, enseignants, titulaires, matieresClasse, departements, annees, evolutionAnnee, labels, matieresByEnseignant]);

  /* ── Compte de connexion ── */
  const etablissementId = user?.etablissement_id || activeEtablissementId;

  // codeExistant : code de connexion d'un compte déjà présent dans
  // l'établissement (ex : l'Admin qui enseigne aussi) auquel ajouter le rôle
  // Enseignant, au lieu de créer un second compte.
  const creerCompteConnexion = async (enseignantId, nom, prenom, email, codeExistant) => {
    if (!enseignantRoleId) {
      toast("Enseignant créé, mais le compte de connexion n'a pas pu être créé automatiquement (rôle « Enseignant » introuvable).", 'error');
      return;
    }
    if (!etablissementId) {
      toast("Enseignant créé, mais le compte de connexion n'a pas pu être créé automatiquement (établissement introuvable). Créez-le depuis la gestion des utilisateurs.", 'error');
      return;
    }
    let result;
    try {
      result = await api.post('/auth/utilisateurs', {
        nom: `${prenom} ${nom}`.trim(), email: email || null, code_existant: codeExistant || undefined,
        role_id: enseignantRoleId, etablissement_id: etablissementId,
      });
    } catch (err) {
      toast(`Enseignant créé, mais le compte de connexion n'a pas pu être créé automatiquement${err.message ? ` (${err.message})` : ''}. Vous pouvez le créer depuis la gestion des utilisateurs.`, 'error');
      return;
    }
    if (enseignantId) {
      try {
        await api.put(`/enseignants/${enseignantId}`, { utilisateur_id: result.id });
      } catch (err) {
        toast(`Compte de connexion créé, mais la liaison avec la fiche enseignant a échoué${err.message ? ` (${err.message})` : ''}. L'enseignant pourra se connecter mais ne verra pas ses classes/matières tant que cette liaison n'est pas faite manuellement (modifier l'enseignant).`, 'error');
      }
    }
    if (result.compte_existant) {
      toast(`Rôle Enseignant ajouté au compte existant (code ${result.code_connexion}) : la personne garde son code et son PIN.`);
      return;
    }
    setIdentifiants({ nom: `${prenom} ${nom}`.trim(), code: result.code_connexion, pin: result.pin_temporaire });
  };

  const reinitialiserPin = async (e) => {
    const ok = await confirm(<>Générer un nouveau PIN pour <strong>{fullName(e)}</strong> ?<br /><small className="text-muted">Son PIN actuel cessera de fonctionner et son compte sera débloqué. Son code de connexion ({e.code_connexion}) ne change pas.</small></>);
    if (!ok) return;
    try {
      const r = await api.post(`/auth/utilisateurs/${e.utilisateur_id}/reset-password`);
      setIdentifiants({ nom: fullName(e), code: r.code_connexion, pin: r.pin_temporaire, titre: 'Nouveau PIN' });
    } catch (err) {
      toast(err.message || 'Impossible de réinitialiser le PIN.', 'error');
    }
  };

  // Enseignants créés avant le correctif de liaison Enseignant.utilisateur_id.
  const reparerLiaisonCompte = async (e) => {
    try {
      const utilisateurs = e.email ? await api.get('/auth/utilisateurs?role=Enseignant') : [];
      const match = (utilisateurs || []).find((u) => u.email && u.email.toLowerCase() === e.email.toLowerCase());
      if (match) {
        await api.put(`/enseignants/${e.id}`, { utilisateur_id: match.id });
        toast('Compte de connexion existant relié avec succès.');
      } else {
        await creerCompteConnexion(e.id, e.nom, e.prenom, e.email);
      }
      await loadAll();
    } catch (err) {
      toast(err.message || 'Impossible de réparer la liaison du compte.', 'error');
    }
  };

  const supprimerEnseignant = async (e) => {
    const ok = await confirm(<>Supprimer l'enseignant <strong>{fullName(e)}</strong> ?<br /><small className="text-muted">Cette action est irréversible. Les affectations liées (classes, matières) pourront être impactées.</small></>);
    if (!ok) return;
    try {
      await api.del(`/enseignants/${e.id}`);
      toast('Enseignant supprimé avec succès.');
      await loadAll();
    } catch (err) {
      toast(err.message || 'Impossible de supprimer cet enseignant.', 'error');
    }
  };

  const supprimerRef = async (type, item) => {
    const ok = await confirm(<>Supprimer {type === 'departement' ? 'le département' : 'le grade'} <strong>{item.libelle}</strong> ?<br /><small className="text-muted">Cette action est irréversible. La suppression sera refusée si des enseignants y sont encore rattachés.</small></>);
    if (!ok) return;
    try {
      await api.del(`/${type === 'departement' ? 'departements' : 'grades'}/${item.id}`);
      toast(type === 'departement' ? 'Département supprimé avec succès.' : 'Grade supprimé avec succès.');
      await loadAll();
    } catch (err) {
      toast(err.message || 'Suppression impossible : des enseignants sont peut-être encore rattachés.', 'error');
    }
  };

  const exportCsv = () => {
    if (!enseignants.length) {
      toast('Aucune donnée à exporter.', 'error');
      return;
    }
    downloadCsv('enseignants.csv', [
      ['Nom', 'Prénom', 'Code de connexion', 'Email', 'Téléphone', 'Sexe', 'Département', 'Grade', 'Titulaire', 'Classes', 'Nb matières'],
      ...enseignants.map((e) => [
        e.nom, e.prenom, e.code_connexion, e.email, e.telephone,
        e.sexe === 'M' ? 'Masculin' : e.sexe === 'F' ? 'Féminin' : '',
        labels.departement(e.departement_id), labels.grade(e.grade_id),
        e.est_titulaire ? 'Oui' : 'Non',
        (titulairesByEnseignant[e.id] || []).map((c) => c.classe).join(' | '),
        (matieresByEnseignant[e.id] || []).length,
      ]),
    ]);
  };

  const setFilter = (name) => (ev) => setFilters((f) => ({ ...f, [name]: ev.target.value }));
  const anneeSelLabel = evolutionAnnee ? labels.annee(Number(evolutionAnnee)) : null;

  return (
    <>
      <PageHeader title="Enseignants" subtitle="Gérez le corps enseignant de votre établissement, leurs classes titularisées et leurs matières enseignées.">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={exportCsv}><i className="bx bx-export me-1" /> Exporter</button>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={loadAll}><i className="bx bx-refresh me-1" /> Actualiser</button>
        {peutImporter && <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => setImportOuvert(true)}><i className="bx bx-import me-1" /> Importer (Excel, CSV, Word)</button>}
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormModal({ data: null })}><i className="bx bx-plus me-1" /> Nouvel enseignant</button>
      </PageHeader>

      <div className="row g-3 mb-4">
        <StatCard label="Enseignants" loading={loading} value={enseignants.length} icon="bx-user-voice" color="primary" />
        <StatCard label="Titulaires de classe" loading={loading} value={enseignants.filter((e) => e.est_titulaire).length} icon="bx-chalkboard" color="success" />
        <StatCard label="Affectations matière-classe" loading={loading} value={matieresClasse.length} icon="bx-book-open" color="info" />
        <StatCard label="Grade le plus représenté" loading={loading} value={<span className="fs-5">{topGrade}</span>} icon="bx-layer" color="warning" />
      </div>

      {/* Graphiques */}
      {charts && (
        <div className="row g-3 mb-4">
          <div className="col-xl-6">
            <div className="card h-100">
              <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
                <h6 className="mb-0"><i className="bx bx-bar-chart-alt-2 me-2 text-primary" />Évolution des enseignants par département</h6>
                <Select className="form-select form-select-sm" style={{ maxWidth: 200 }} value={evolutionAnnee ?? ''} onChange={(e) => setEvolutionAnnee(e.target.value)}>
                  <option value="">Toutes les années</option>
                  {[...annees].sort(byLibelle).map((a) => <option key={a.id} value={a.id}>{a.libelle}</option>)}
                </Select>
              </div>
              <div className="card-body">
                <p className="text-muted mb-2 small">
                  {anneeSelLabel
                    ? `Enseignants par département pour l'année ${anneeSelLabel} — titulaires d'une classe, affectés à une matière, ou nouvellement créés sans affectation.`
                    : "Tous les enseignants du département par année scolaire — titulaires d'une classe, affectés à une matière, ou nouvellement créés sans affectation."}
                </p>
                <ChartCanvas config={charts.evolution} height={280} fallback="Évolution par département indisponible." />
              </div>
            </div>
          </div>
          <div className="col-xl-6">
            <div className="row g-3">
              <div className="col-md-6">
                <div className="card h-100">
                  <div className="card-header"><h6 className="mb-0"><i className="bx bx-male-sign me-2 text-primary" />Répartition par sexe</h6></div>
                  <div className="card-body"><ChartCanvas config={charts.sexe} height={190} fallback="Répartition par sexe indisponible." /></div>
                </div>
              </div>
              <div className="col-md-6">
                <div className="card h-100">
                  <div className="card-header"><h6 className="mb-0"><i className="bx bx-medal me-2 text-primary" />Répartition par grade</h6></div>
                  <div className="card-body"><ChartCanvas config={charts.grade} height={190} fallback="Répartition par grade indisponible." /></div>
                </div>
              </div>
              <div className="col-md-12">
                <div className="card">
                  <div className="card-header"><h6 className="mb-0"><i className="bx bx-book-open me-2 text-primary" />Enseignants sans matière affectée</h6></div>
                  <div className="card-body"><ChartCanvas config={charts.sansMatiere} height={160} fallback="Répartition sans matière indisponible." /></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filtres */}
      <div className="card mb-3">
        <div className="card-body py-3">
          <div className="row g-2 align-items-end">
            <div className="col-md-3">
              <label className="form-label">Rechercher</label>
              <input type="search" className="form-control form-control-sm" placeholder="Nom, prénom, code, email…" value={filters.search} onChange={setFilter('search')} />
            </div>
            <div className="col-md-2">
              <label className="form-label">Département</label>
              <Select className="form-select form-select-sm" value={filters.departement} onChange={setFilter('departement')}>
                <option value="">Tous les départements</option>
                {[...departements].sort(byLibelle).map((d) => <option key={d.id} value={d.id}>{d.libelle}</option>)}
              </Select>
            </div>
            <div className="col-md-2">
              <label className="form-label">Grade</label>
              <Select className="form-select form-select-sm" value={filters.grade} onChange={setFilter('grade')}>
                <option value="">Tous les grades</option>
                {[...grades].sort(byLibelle).map((g) => <option key={g.id} value={g.id}>{g.libelle}</option>)}
              </Select>
            </div>
            <div className="col-md-2">
              <label className="form-label">Sexe</label>
              <Select className="form-select form-select-sm" value={filters.sexe} onChange={setFilter('sexe')}>
                <option value="">Tous</option>
                <option value="M">Masculin</option>
                <option value="F">Féminin</option>
              </Select>
            </div>
            <div className="col-md-2">
              <label className="form-label">Statut</label>
              <Select className="form-select form-select-sm" value={filters.statut} onChange={setFilter('statut')}>
                <option value="">Tous les statuts</option>
                <option value="titulaire">Titulaire de classe</option>
                <option value="non-titulaire">Sans classe titularisée</option>
              </Select>
            </div>
            <div className="col-md-1">
              <button type="button" className="btn btn-outline-secondary btn-sm w-100" title="Réinitialiser" onClick={() => setFilters(EMPTY_FILTERS)}><i className="bx bx-reset" /></button>
            </div>
          </div>
        </div>
      </div>

      {/* Enseignants & référentiels */}
      <div className="card">
        <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
          <h5 className="mb-0"><i className="bx bx-user-voice me-2 text-primary" />Enseignants &amp; référentiels</h5>
          <ul className="nav nav-pills">
            {[
              ['enseignants', 'bx-user-voice', 'Enseignants', enseignants.length],
              ['departements', 'bx-buildings', 'Départements'],
              ['grades', 'bx-medal', 'Grades'],
            ].map(([key, icon, label, count]) => (
              <li key={key} className="nav-item">
                <button type="button" className={`nav-link btn-sm ${refTab === key ? 'active' : ''}`} onClick={() => setRefTab(key)}>
                  <i className={`bx ${icon} me-1`} />{label}
                  {count !== undefined && <span className="badge rounded-pill bg-label-primary ms-1">{count}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {refTab === 'enseignants' && (
          <>
            <div className="table-responsive">
              <table className="table table-hover mb-0">
                <thead>
                  <tr><th>Enseignant</th><th>Contact</th><th>Département</th><th>Grade</th><th>Statut</th><th>Matières enseignées</th><th className="text-end">Actions</th></tr>
                </thead>
                <TBody colSpan={7} loading={loading} error={error} rows={filtered.length} empty="Aucun enseignant trouvé" emptyIcon="bx-user-voice">
                  {filtered.map((e) => {
                    const mats = matieresByEnseignant[e.id] || [];
                    return (
                      <tr key={e.id}>
                        <td>
                          <div className="d-flex align-items-center gap-2">
                            <button type="button" className="btn btn-link p-0 fw-semibold text-body" onClick={() => setDetail(e)}>
                              {fullName(e)}
                              {e.sexe === 'M' && <i className="bx bx-male-sign text-primary ms-1" title="Masculin" />}
                              {e.sexe === 'F' && <i className="bx bx-female-sign ms-1" style={{ color: '#f72585' }} title="Féminin" />}
                            </button>
                          </div>
                        </td>
                        <td>
                          {e.code_connexion && <div className="small">Code <span className="font-monospace fw-semibold">{e.code_connexion}</span></div>}
                          <div className="text-muted small">{[e.telephone, e.email].filter(Boolean).join(' · ') || '—'}</div>
                        </td>
                        <td>{labels.departement(e.departement_id) || '—'}</td>
                        <td>{labels.grade(e.grade_id) || '—'}</td>
                        <td>{e.est_titulaire ? <span className="badge bg-label-success"><i className="bx bx-chalkboard me-1" />Titulaire</span> : <span className="badge bg-label-secondary">Non titulaire</span>}</td>
                        <td>
                          {mats.length ? (
                            <div className="d-flex flex-wrap gap-1">
                              {mats.slice(0, 3).map((m, i) => (
                                <span key={i} className="badge bg-label-info">{m.matiere}{m.coefficient != null && <span className="ms-1 opacity-75">×{m.coefficient}</span>}</span>
                              ))}
                              {mats.length > 3 && <span className="badge bg-label-secondary">+{mats.length - 3}</span>}
                            </div>
                          ) : <span className="text-muted">—</span>}
                        </td>
                        <td className="text-end text-nowrap">
                          {!e.utilisateur_id && (
                            <button type="button" className="btn btn-icon btn-sm btn-warning ms-1" title="Compte de connexion non lié : cet enseignant ne peut pas accéder à ses classes/matières/notes. Cliquer pour réparer." onClick={() => reparerLiaisonCompte(e)}>
                              <i className="bx bx-unlink" />
                            </button>
                          )}
                          <IconBtn icon="bx-show" title="Détails" onClick={() => setDetail(e)} />
                          {e.utilisateur_id && <IconBtn icon="bx-key" title="Réinitialiser le PIN (PIN oublié ou compte bloqué)" onClick={() => reinitialiserPin(e)} />}
                          <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setFormModal({ data: e })} />
                          <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimerEnseignant(e)} />
                        </td>
                      </tr>
                    );
                  })}
                </TBody>
              </table>
            </div>
            <div className="px-3 py-2 border-top">
              <small className="text-muted">{loading ? '—' : `${filtered.length} enseignant(s) affiché(s) sur ${enseignants.length}`}</small>
            </div>
          </>
        )}

        {(refTab === 'departements' || refTab === 'grades') && (() => {
          const type = refTab === 'departements' ? 'departement' : 'grade';
          const list = [...(type === 'departement' ? departements : grades)].sort(byLibelle);
          const key = type === 'departement' ? 'departement_id' : 'grade_id';
          return (
            <>
              <div className="d-flex justify-content-end p-3 pb-2">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setRefModal({ type, data: null })}>
                  <i className="bx bx-plus me-1" /> {type === 'departement' ? 'Nouveau département' : 'Nouveau grade'}
                </button>
              </div>
              <div className="table-responsive">
                <table className="table table-hover mb-0">
                  <thead><tr><th>Libellé</th><th>Enseignants rattachés</th><th className="text-end">Actions</th></tr></thead>
                  <TBody colSpan={3} loading={loading} rows={list.length} empty={type === 'departement' ? 'Aucun département enregistré' : 'Aucun grade enregistré'}>
                    {list.map((item) => (
                      <tr key={item.id}>
                        <td className="fw-semibold">{item.libelle}</td>
                        <td><span className="badge bg-label-secondary">{enseignants.filter((e) => e[key] === item.id).length}</span></td>
                        <td className="text-end">
                          <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setRefModal({ type, data: item })} />
                          <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimerRef(type, item)} />
                        </td>
                      </tr>
                    ))}
                  </TBody>
                </table>
              </div>
            </>
          );
        })()}
      </div>

      {formModal && (
        <EnseignantModal
          data={formModal.data}
          departements={[...departements].sort(byLibelle)}
          grades={[...grades].sort(byLibelle)}
          onClose={() => setFormModal(null)}
          onManageRef={(tab) => { setFormModal(null); setRefTab(tab); }}
          onSaved={async (msg, created, codeExistant) => {
            setFormModal(null);
            toast(msg);
            await loadAll();
            if (created && !formModal.data) {
              await creerCompteConnexion(created.id, created.nom, created.prenom, created.email, codeExistant);
              await loadAll();
            }
          }}
        />
      )}

      {detail && (
        <DetailModal
          e={detail}
          labels={labels}
          classesTitu={titulairesByEnseignant[detail.id] || []}
          matieres={matieresByEnseignant[detail.id] || []}
          onClose={() => setDetail(null)}
        />
      )}

      {refModal && (
        <RefModal
          type={refModal.type}
          data={refModal.data}
          onClose={() => setRefModal(null)}
          onSaved={async (msg) => { setRefModal(null); toast(msg); await loadAll(); }}
        />
      )}

      {identifiants && <IdentifiantsModal {...identifiants} destinataire="l'enseignant" onClose={() => setIdentifiants(null)} />}
      {importOuvert && <ImportModal module="enseignants" onClose={() => setImportOuvert(false)} onImported={loadAll} />}
      {confirmNode}
    </>
  );
}

function EnseignantModal({ data, departements, grades, onClose, onSaved, onManageRef }) {
  const [form, setForm] = useState({
    nom: data?.nom || '',
    prenom: data?.prenom || '',
    email: data?.email || '',
    telephone: data?.telephone || '',
    sexe: data?.sexe || '',
    departement_id: data?.departement_id ? String(data.departement_id) : '',
    grade_id: data?.grade_id ? String(data.grade_id) : '',
    codeExistant: '',
  });
  const [validated, setValidated] = useState(false);
  const [save, saving] = useSave((msg, created) => onSaved(msg, created, form.codeExistant));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  // Email facultatif : seulement vérifié s'il est renseigné.
  const emailOk = !form.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
  const codeOk = !form.codeExistant || form.codeExistant.length === 4;
  const bad = (name) => validated && (name === 'email' ? !emailOk : name === 'codeExistant' ? !codeOk : !String(form[name]).trim());
  const cls = (base, name) => `${base} ${bad(name) ? 'is-invalid' : ''}`;

  const submit = () => {
    if (['nom', 'prenom', 'sexe', 'departement_id', 'grade_id'].some((n) => !String(form[n]).trim()) || !emailOk || !codeOk) return setValidated(true);
    return save('/enseignants/', data?.id, {
      nom: form.nom.trim(),
      prenom: form.prenom.trim(),
      email: form.email.trim() || null,
      telephone: form.telephone.trim() || null,
      sexe: form.sexe,
      departement_id: parseInt(form.departement_id, 10),
      grade_id: parseInt(form.grade_id, 10),
    }, ['Enseignant créé avec succès.', 'Enseignant mis à jour avec succès.']);
  };

  return (
    <Modal
      title={data ? <><i className="bx bx-edit-alt me-2 text-primary" />Modifier l'enseignant</> : <><i className="bx bx-user-voice me-2 text-primary" />Nouvel enseignant</>}
      onClose={onClose}
      onSubmit={submit}
      footer={<FormFooter onCancel={onClose} saving={saving} label={data ? 'Enregistrer les modifications' : "Créer l'enseignant"} />}
    >
      {!data && (
        <div className="alert alert-info d-flex align-items-start gap-2 py-2 small">
          <i className="bx bx-info-circle mt-1" />
          <div>Un compte de connexion sera automatiquement créé pour cet enseignant : son <strong>code de connexion</strong> et un <strong>PIN</strong> vous seront présentés juste après la création, sur une fiche à imprimer ou recopier pour l'enseignant.</div>
        </div>
      )}
      <div className="row g-3">
        <Field className="col-md-6" label="Nom" required invalid={bad('nom') && 'Le nom est requis.'}>
          <input type="text" className={cls('form-control', 'nom')} placeholder="Ex : Fouda" value={form.nom} onChange={set('nom')} />
        </Field>
        <Field className="col-md-6" label="Prénom" required invalid={bad('prenom') && 'Le prénom est requis.'}>
          <input type="text" className={cls('form-control', 'prenom')} placeholder="Ex : Marie" value={form.prenom} onChange={set('prenom')} />
        </Field>
        <Field className="col-md-6" label="Email (facultatif)" invalid={bad('email') && 'Email invalide : corrigez-le ou laissez le champ vide.'} hint="Inutile pour se connecter (code + PIN).">
          <input type="email" className={cls('form-control', 'email')} placeholder="Ex : marie.fouda@ecole.cm" value={form.email} onChange={set('email')} />
        </Field>
        <Field className="col-md-6" label="Téléphone">
          <input type="tel" className="form-control" placeholder="Ex : 6 90 00 00 00" value={form.telephone} onChange={set('telephone')} />
        </Field>
        <Field className="col-md-4" label="Sexe" required invalid={bad('sexe') && 'Le sexe est requis.'}>
          <Select className={cls('form-select', 'sexe')} value={form.sexe} onChange={set('sexe')}>
            <option value="">Sélectionner…</option>
            <option value="M">Masculin</option>
            <option value="F">Féminin</option>
          </Select>
        </Field>
        <Field className="col-md-4" label="Département" required invalid={bad('departement_id') && 'Le département est requis.'} hint={<button type="button" className="btn btn-link btn-sm p-0" onClick={() => onManageRef('departements')}>Gérer les départements</button>}>
          <Select className={cls('form-select', 'departement_id')} value={form.departement_id} onChange={set('departement_id')}>
            <option value="">Sélectionner…</option>
            {departements.map((d) => <option key={d.id} value={d.id}>{d.libelle}</option>)}
          </Select>
        </Field>
        <Field className="col-md-4" label="Grade" required invalid={bad('grade_id') && 'Le grade est requis.'} hint={<button type="button" className="btn btn-link btn-sm p-0" onClick={() => onManageRef('grades')}>Gérer les grades</button>}>
          <Select className={cls('form-select', 'grade_id')} value={form.grade_id} onChange={set('grade_id')}>
            <option value="">Sélectionner…</option>
            {grades.map((g) => <option key={g.id} value={g.id}>{g.libelle}</option>)}
          </Select>
        </Field>
        {!data && (
          <Field className="col-12" label="A déjà un compte dans l'établissement ? (facultatif)" invalid={bad('codeExistant') && 'Le code comporte 4 caractères.'} hint="Ex : l'administrateur ou le censeur qui enseigne aussi. Indiquez son code de connexion : il garde son code et son PIN, et reçoit en plus l'espace Enseignant.">
            <input
              type="text"
              className={cls('form-control font-monospace text-uppercase', 'codeExistant')}
              placeholder="Son code de connexion, ex : K7TB"
              maxLength={4}
              value={form.codeExistant}
              onChange={(e) => setForm((f) => ({ ...f, codeExistant: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) }))}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function DetailModal({ e, labels, classesTitu, matieres, onClose }) {
  return (
    <Modal
      title={<><i className="bx bx-user-circle me-2 text-primary" />Fiche enseignant</>}
      onClose={onClose}
      footer={<button type="button" className="btn btn-outline-secondary" onClick={onClose}>Fermer</button>}
    >
      <div className="d-flex align-items-center gap-3 mb-3">
        <div className="avatar avatar-lg"><span className="avatar-initial rounded-circle bg-label-primary">{initiales(e.nom, e.prenom)}</span></div>
        <div>
          <div className="fw-bold fs-6">{fullName(e)}</div>
          <div className="text-muted">{[labels.departement(e.departement_id), labels.grade(e.grade_id)].filter(Boolean).join(' · ') || 'Département / grade non renseignés'}</div>
        </div>
        {e.est_titulaire && <span className="badge bg-label-success ms-auto"><i className="bx bx-chalkboard me-1" />Titulaire</span>}
      </div>
      <div className="row g-3 mb-3">
        <div className="col-md-4"><label className="form-label">Code de connexion</label><div className="font-monospace fw-semibold">{e.code_connexion || '—'}</div></div>
        <div className="col-md-4"><label className="form-label">Email</label><div>{e.email || '—'}</div></div>
        <div className="col-md-4"><label className="form-label">Téléphone</label><div>{e.telephone || '—'}</div></div>
        <div className="col-md-4"><label className="form-label">Sexe</label><div>{e.sexe === 'M' ? 'Masculin' : e.sexe === 'F' ? 'Féminin' : '—'}</div></div>
      </div>
      <hr />
      <h6 className="mb-2"><i className="bx bx-chalkboard me-1 text-primary" />Classe(s) titularisée(s)</h6>
      <div className="mb-3">
        {classesTitu.length
          ? classesTitu.map((c, i) => <span key={i} className="badge bg-label-primary me-1 mb-1">{c.classe} <span className="text-muted">({c.annee})</span></span>)
          : <span className="text-muted">Aucune classe titularisée</span>}
      </div>
      <h6 className="mb-2"><i className="bx bx-book-open me-1 text-primary" />Matières enseignées</h6>
      <div className="table-responsive">
        <table className="table table-hover mb-0">
          <thead><tr><th>Matière</th><th>Classe</th><th>Coefficient</th></tr></thead>
          <TBody colSpan={3} rows={matieres.length} empty="Aucune matière affectée">
            {matieres.map((m, i) => <tr key={i}><td>{m.matiere}</td><td>{m.classe}</td><td>{m.coefficient ?? '—'}</td></tr>)}
          </TBody>
        </table>
      </div>
    </Modal>
  );
}

const GRADES_SUGGESTIONS = ['Certifié', 'PLEG', 'PLET', 'Instituteur', 'Contractuel', 'Vacataire'];

function RefModal({ type, data, onClose, onSaved }) {
  const isDep = type === 'departement';
  const [libelle, setLibelle] = useState(data?.libelle || '');
  const [validated, setValidated] = useState(false);
  const [save, saving] = useSave(onSaved);

  const submit = () => {
    if (!libelle.trim()) return setValidated(true);
    return save(isDep ? '/departements/' : '/grades/', data?.id, { libelle: libelle.trim() }, isDep
      ? ['Département créé avec succès.', 'Département mis à jour avec succès.']
      : ['Grade créé avec succès.', 'Grade mis à jour avec succès.']);
  };

  const title = data
    ? (isDep ? 'Modifier le département' : 'Modifier le grade')
    : (isDep ? 'Nouveau département' : 'Nouveau grade');

  return (
    <Modal
      size=""
      title={<><i className={`bx ${data ? 'bx-edit-alt' : isDep ? 'bx-buildings' : 'bx-medal'} me-2 text-primary`} />{title}</>}
      onClose={onClose}
      onSubmit={submit}
      footer={<FormFooter onCancel={onClose} saving={saving} label={data ? 'Enregistrer les modifications' : isDep ? 'Créer le département' : 'Créer le grade'} />}
    >
      <Field label="Libellé" required className="mb-1" invalid={validated && !libelle.trim() && 'Le libellé est requis.'}>
        <input
          autoFocus
          type="text"
          className={`form-control ${validated && !libelle.trim() ? 'is-invalid' : ''}`}
          list={isDep ? undefined : 'gradesSuggestions'}
          placeholder={isDep ? 'Ex : Lettres et sciences humaines' : 'Ex : Certifié, PLEG, Vacataire…'}
          value={libelle}
          onChange={(e) => setLibelle(e.target.value)}
        />
        {!isDep && <datalist id="gradesSuggestions">{GRADES_SUGGESTIONS.map((g) => <option key={g} value={g} />)}</datalist>}
      </Field>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import ChartCanvas, { PIE_OPTIONS, colorAt } from '../components/ChartCanvas';
import { fmtHorodatage } from '../components/Historique';
import { PageHeader, StatCard, formatMontant } from '../components/ui';
import { roleInfo } from '../lib/espaces';
import Select from '../components/Select';
import { SkelCartes, SkelGraphique, SkelListe } from '../components/Skeleton';

// Tableau de bord du SuperAdmin : vue de TOUT le réseau d'établissements
// (cf. GET /api/superadmin/vue-reseau) — effectifs, recouvrement, avancement
// des notes de la séquence en cours, comptes, activité et alertes de
// configuration. « Piloter » ouvre un établissement dans les pages de gestion
// (sélecteur de la barre du haut).

const fmtNombre = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));
const fmtTaux = (t) => (t === null || t === undefined ? '—' : `${t.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);

const NIVEAUX = {
  danger: { cls: 'danger', icon: 'bx-error-circle', ordre: 0 },
  warning: { cls: 'warning', icon: 'bx-error', ordre: 1 },
  info: { cls: 'info', icon: 'bx-info-circle', ordre: 2 },
};

// Où corriger chaque alerte (l'établissement est sélectionné avant).
const CORRIGER = {
  sans_admin: { to: '/etablissements', label: 'Gérer les administrateurs' },
  sans_annee: { to: '/configuration', label: 'Configurer' },
  annee_inactive: { to: '/configuration', label: 'Configurer' },
  sans_classe: { to: '/configuration', label: 'Configurer' },
  sans_echeancier: { to: '/paiements', label: 'Paiements' },
  comptes_bloques: { to: (id) => `/utilisateurs?etablissement=${id}&statut=bloque`, label: 'Voir les comptes' },
  inactif: { to: (id) => `/journal?etablissement=${id}`, label: 'Journal' },
};

const TRIS = {
  nom: { label: 'Nom', cle: (l) => l.nom.toLocaleLowerCase('fr'), asc: true },
  inscrits: { label: 'Effectif', cle: (l) => l.effectifs.inscrits },
  recouvrement: { label: 'Recouvrement', cle: (l) => l.finances.taux ?? -1 },
  notes: { label: 'Notes saisies', cle: (l) => l.notes.taux ?? -1 },
  alertes: { label: 'Alertes', cle: (l) => l.alertes.filter((a) => a.niveau !== 'info').length },
};

function couleurTaux(t) {
  if (t === null || t === undefined) return 'secondary';
  if (t >= 75) return 'success';
  if (t >= 40) return 'warning';
  return 'danger';
}

function Barre({ taux, sous }) {
  return (
    <div style={{ minWidth: 130 }}>
      <div className="d-flex justify-content-between small">
        <span className="fw-semibold">{fmtTaux(taux)}</span>
        {sous && <span className="text-muted ms-2">{sous}</span>}
      </div>
      <div className="progress mt-1" style={{ height: 6 }}>
        <div className={`progress-bar bg-${couleurTaux(taux)}`} role="progressbar" style={{ width: `${Math.min(taux || 0, 100)}%` }} aria-valuenow={taux || 0} aria-valuemin="0" aria-valuemax="100" />
      </div>
    </div>
  );
}

function Vide({ icon, children }) {
  return <div className="text-center text-muted py-4 small"><i className={`bx ${icon} bx-sm d-block mb-1`} />{children}</div>;
}

export default function DashboardPage() {
  const { user, selectEtablissement } = useAuth();
  const navigate = useNavigate();
  const [vue, setVue] = useState(null);
  const [erreur, setErreur] = useState('');
  const [chargement, setChargement] = useState(true);
  const [tri, setTri] = useState('nom');
  const [recherche, setRecherche] = useState('');

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur('');
    try {
      setVue(await api.get('/superadmin/vue-reseau'));
    } catch (e) {
      setErreur(e.message);
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => { charger(); }, [charger]);

  const ouvrir = (etabId, to) => {
    selectEtablissement(etabId);
    navigate(typeof to === 'function' ? to(etabId) : to);
  };

  const lignes = useMemo(() => {
    if (!vue) return [];
    const q = recherche.trim().toLocaleLowerCase('fr');
    const t = TRIS[tri];
    return vue.etablissements
      .filter((l) => !q || [l.nom, l.code, l.region].some((v) => v && v.toLocaleLowerCase('fr').includes(q)))
      .sort((a, b) => {
        const [x, y] = [t.cle(a), t.cle(b)];
        const r = x < y ? -1 : x > y ? 1 : 0;
        return t.asc ? r : -r;
      });
  }, [vue, tri, recherche]);

  const alertes = useMemo(() => (vue ? vue.etablissements.flatMap((l) => l.alertes.map((a) => ({ ...a, etab: l })))
    .sort((a, b) => NIVEAUX[a.niveau].ordre - NIVEAUX[b.niveau].ordre || a.etab.nom.localeCompare(b.etab.nom, 'fr')) : []), [vue]);

  const graphiques = useMemo(() => {
    if (!vue) return {};
    const activite = {
      type: 'bar',
      data: {
        labels: vue.activite.map((j) => new Date(`${j.jour}T00:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })),
        datasets: [{ label: 'Modifications', data: vue.activite.map((j) => j.modifications), backgroundColor: '#696cff', borderRadius: 4 }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
    };
    const roles = Object.entries(vue.totaux.comptes_par_role).sort((a, b) => b[1] - a[1]);
    const comptes = roles.length ? {
      type: 'doughnut',
      data: {
        labels: roles.map(([r]) => (r === 'Admin' ? 'Administrateur' : roleInfo(r).label)),
        datasets: [{ data: roles.map(([, n]) => n), backgroundColor: roles.map((_, i) => colorAt(i)) }],
      },
      options: PIE_OPTIONS,
    } : null;
    const comparaison = vue.etablissements.length ? {
      type: 'bar',
      data: {
        labels: vue.etablissements.map((l) => l.code || l.nom),
        datasets: [
          { label: 'Recouvrement (%)', data: vue.etablissements.map((l) => l.finances.taux ?? 0), backgroundColor: '#71dd37', borderRadius: 4 },
          { label: 'Notes saisies (%)', data: vue.etablissements.map((l) => l.notes.taux ?? 0), backgroundColor: '#03c3ec', borderRadius: 4 },
        ],
      },
      options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } }, scales: { y: { beginAtZero: true, max: 100 } } },
    } : null;
    return { activite, comptes, comparaison };
  }, [vue]);

  const prenom = (user?.nom || '').split(' ')[0];
  const t = vue?.totaux;

  return (
    <>
      <PageHeader
        title={`Bonjour ${prenom}`}
        subtitle={vue ? `Vue d'ensemble du réseau · mise à jour ${fmtHorodatage(vue.genere_le)}` : "Vue d'ensemble du réseau"}
      >
        <Link to="/etablissements" className="btn btn-outline-primary btn-sm"><i className="bx bx-buildings me-1" />Établissements</Link>
        <button type="button" className="btn btn-primary btn-sm" onClick={charger} disabled={chargement}>
          {chargement ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-refresh me-1" />}Actualiser
        </button>
      </PageHeader>

      {erreur && <div className="alert alert-danger">{erreur}</div>}
      {!vue && chargement && (
        <>
          <SkelCartes nombre={8} label="Calcul des indicateurs du réseau…" />
          <div className="row g-3 mb-4">
            <div className="col-lg-5"><div className="card h-100"><div className="card-body"><SkelListe lignes={5} /></div></div></div>
            <div className="col-lg-7"><div className="card h-100"><div className="card-body"><SkelGraphique hauteur={260} /></div></div></div>
          </div>
        </>
      )}

      {t && (
        <>
          <div className="row g-3 mb-4">
            <StatCard className="col-sm-6 col-xl-3" label="Établissements" value={fmtNombre(t.etablissements)} icon="bx-buildings" color="primary"
              sub={t.alertes ? `${t.alertes} alerte${t.alertes > 1 ? 's' : ''} à traiter` : 'Aucune alerte'} />
            <StatCard className="col-sm-6 col-xl-3" label="Élèves inscrits" value={fmtNombre(t.inscrits)} icon="bx-user" color="info"
              sub={`${fmtNombre(t.classes)} classes · ${t.inscrits ? Math.round((100 * t.filles) / t.inscrits) : 0} % de filles`} />
            <StatCard className="col-sm-6 col-xl-3" label="Recouvrement" value={fmtTaux(t.taux_recouvrement)} icon="bx-wallet" color={couleurTaux(t.taux_recouvrement)}
              sub={`${formatMontant(t.encaisse)} sur ${formatMontant(t.attendu)}`} />
            <StatCard className="col-sm-6 col-xl-3" label="Notes de la séquence" value={fmtTaux(t.taux_notes)} icon="bx-spreadsheet" color={couleurTaux(t.taux_notes)}
              sub={`${fmtNombre(t.notes_saisies)} saisies sur ${fmtNombre(t.notes_attendues)}`} />
            <StatCard className="col-sm-6 col-xl-3" label="Enseignants" value={fmtNombre(t.enseignants)} icon="bx-user-voice" color="success"
              sub={`${t.inscrits && t.enseignants ? Math.round(t.inscrits / t.enseignants) : '—'} élèves par enseignant`} />
            <StatCard className="col-sm-6 col-xl-3" label="Comptes actifs" value={fmtNombre(t.comptes_actifs)} icon="bx-id-card" color="secondary"
              sub={t.comptes_bloques ? `${t.comptes_bloques} bloqué${t.comptes_bloques > 1 ? 's' : ''} (PIN faux)` : 'Aucun compte bloqué'} />
            <StatCard className="col-sm-6 col-xl-3" label={`Activité (${vue.jours_activite} j)`} value={fmtNombre(t.modifications)} icon="bx-history" color="warning"
              sub="créations, modifications, suppressions" />
            <StatCard className="col-sm-6 col-xl-3" label="Saisies hors connexion" value={fmtNombre(t.hors_ligne)} icon="bx-wifi-off" color="dark"
              sub={`synchronisées sur ${vue.jours_activite} jours`} />
          </div>

          <div className="row g-3 mb-4">
            <div className="col-lg-5">
              <div className="card h-100">
                <div className="card-header d-flex justify-content-between align-items-center">
                  <h5 className="mb-0"><i className="bx bx-bell me-2 text-primary" />Alertes</h5>
                  <span className="badge rounded-pill bg-label-danger">{alertes.filter((a) => a.niveau !== 'info').length}</span>
                </div>
                <div className="card-body pt-0" style={{ maxHeight: 340, overflowY: 'auto' }}>
                  {alertes.length === 0 ? <Vide icon="bx-check-shield">Tout est en ordre dans le réseau.</Vide> : (
                    <ul className="list-unstyled mb-0">
                      {alertes.map((a, i) => {
                        const n = NIVEAUX[a.niveau];
                        const action = CORRIGER[a.code];
                        return (
                          <li key={`${a.etab.id}-${a.code}-${i}`} className="d-flex align-items-start gap-2 py-2 border-bottom">
                            <i className={`bx ${n.icon} text-${n.cls} mt-1`} />
                            <div className="flex-grow-1 small">
                              <div className="fw-semibold">{a.etab.nom}</div>
                              <div className="text-muted">{a.message}</div>
                            </div>
                            {action && (
                              <button type="button" className="btn btn-sm btn-outline-secondary text-nowrap" onClick={() => ouvrir(a.etab.id, action.to)}>
                                {action.label}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </div>
            <div className="col-lg-7">
              <div className="card h-100">
                <div className="card-header">
                  <h5 className="mb-0"><i className="bx bx-bar-chart-alt-2 me-2 text-primary" />Activité du réseau</h5>
                  <small className="text-muted">Modifications enregistrées par jour, tous établissements</small>
                </div>
                <div className="card-body"><ChartCanvas config={graphiques.activite} height={260} /></div>
              </div>
            </div>
          </div>

          <div className="row g-3 mb-4">
            <div className="col-lg-8">
              <div className="card h-100">
                <div className="card-header">
                  <h5 className="mb-0"><i className="bx bx-git-compare me-2 text-primary" />Comparaison des établissements</h5>
                  <small className="text-muted">Recouvrement de l'année et notes de la séquence en cours</small>
                </div>
                <div className="card-body">
                  {graphiques.comparaison ? <ChartCanvas config={graphiques.comparaison} height={260} /> : <Vide icon="bx-buildings">Aucun établissement.</Vide>}
                </div>
              </div>
            </div>
            <div className="col-lg-4">
              <div className="card h-100">
                <div className="card-header">
                  <h5 className="mb-0"><i className="bx bx-id-card me-2 text-primary" />Comptes par rôle</h5>
                  <small className="text-muted">Comptes actifs (un compte peut cumuler plusieurs rôles)</small>
                </div>
                <div className="card-body">
                  {graphiques.comptes ? <ChartCanvas config={graphiques.comptes} height={240} /> : <Vide icon="bx-id-card">Aucun compte actif.</Vide>}
                  <div className="text-center mt-2"><Link to="/utilisateurs" className="btn btn-sm btn-outline-primary">Gérer les comptes</Link></div>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
              <h5 className="mb-0"><i className="bx bx-table me-2 text-primary" />Établissements <span className="badge rounded-pill bg-label-primary ms-1">{lignes.length}</span></h5>
              <div className="d-flex flex-wrap gap-2">
                <input type="search" className="form-control form-control-sm" style={{ width: 200 }} placeholder="Rechercher…" value={recherche} onChange={(e) => setRecherche(e.target.value)} />
                <Select className="form-select form-select-sm" style={{ width: 170 }} value={tri} onChange={(e) => setTri(e.target.value)} aria-label="Trier par">
                  {Object.entries(TRIS).map(([k, v]) => <option key={k} value={k}>Trier : {v.label}</option>)}
                </Select>
              </div>
            </div>
            <div className="table-responsive text-nowrap">
              <table className="table table-hover align-middle mb-0">
                <thead>
                  <tr>
                    <th>Établissement</th>
                    <th>Année</th>
                    <th className="text-end">Inscrits</th>
                    <th className="text-end">Classes</th>
                    <th className="text-end">Enseignants</th>
                    <th>Recouvrement</th>
                    <th>Notes (séquence)</th>
                    <th>Comptes</th>
                    <th>Dernière activité</th>
                    <th className="text-end">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.length === 0 && (
                    <tr><td colSpan={10} className="text-center text-muted py-4">{vue.etablissements.length ? 'Aucun établissement ne correspond.' : 'Aucun établissement : créez-en un depuis la page Établissements.'}</td></tr>
                  )}
                  {lignes.map((l) => {
                    const graves = l.alertes.filter((a) => a.niveau === 'danger').length;
                    return (
                      <tr key={l.id}>
                        <td>
                          <div className="fw-semibold">{l.nom}</div>
                          <small className="text-muted">
                            <span className="font-monospace">{l.code}</span>{l.region && <> · {l.region}</>}
                            {graves > 0 && <span className="badge bg-label-danger ms-2">{graves} alerte{graves > 1 ? 's' : ''}</span>}
                          </small>
                        </td>
                        <td>{l.annee ? <>{l.annee.libelle}{!l.annee.active && <span className="badge bg-label-warning ms-1">inactive</span>}</> : <span className="text-muted">—</span>}</td>
                        <td className="text-end">{fmtNombre(l.effectifs.inscrits)}</td>
                        <td className="text-end">{fmtNombre(l.effectifs.classes)}</td>
                        <td className="text-end">{fmtNombre(l.effectifs.enseignants)}</td>
                        <td title={`${formatMontant(l.finances.encaisse)} encaissés sur ${formatMontant(l.finances.attendu)}`}>
                          <Barre taux={l.finances.taux} sous={l.finances.attendu ? formatMontant(l.finances.encaisse) : 'pas d\'échéancier'} />
                        </td>
                        <td title={l.sequence ? `Séquence ${l.sequence.libelle}` : 'Aucune séquence'}>
                          <Barre taux={l.notes.taux} sous={l.sequence ? `${l.sequence.libelle} · ${fmtNombre(l.notes.saisies)}/${fmtNombre(l.notes.attendues)}` : 'aucune séquence'} />
                        </td>
                        <td className="small">
                          {fmtNombre(l.comptes.actifs)} actif{l.comptes.actifs > 1 ? 's' : ''}
                          <div className={l.comptes.admins_actifs ? 'text-muted' : 'text-danger'}>{l.comptes.admins_actifs} admin{l.comptes.admins_actifs > 1 ? 's' : ''}</div>
                        </td>
                        <td className="small">
                          {l.activite.derniere ? fmtHorodatage(l.activite.derniere) : <span className="text-muted">Jamais</span>}
                          <div className="text-muted">{fmtNombre(l.activite.modifications)} modif. / {vue.jours_activite} j</div>
                        </td>
                        <td className="text-end">
                          <button type="button" className="btn btn-sm btn-primary" title="Ouvrir le tableau de bord de cet établissement" onClick={() => ouvrir(l.id, '/etablissement')}>
                            <i className="bx bx-log-in-circle me-1" />Piloter
                          </button>
                          <button type="button" className="btn btn-sm btn-icon btn-outline-secondary ms-1" title="Comptes de l'établissement" onClick={() => navigate(`/utilisateurs?etablissement=${l.id}`)}>
                            <i className="bx bx-id-card" />
                          </button>
                          <button type="button" className="btn btn-sm btn-icon btn-outline-secondary ms-1" title="Journal de l'établissement" onClick={() => navigate(`/journal?etablissement=${l.id}`)}>
                            <i className="bx bx-history" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

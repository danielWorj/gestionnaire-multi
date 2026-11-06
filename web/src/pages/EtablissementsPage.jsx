import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';
import Modal from '../components/Modal';
import AdministrateursModal from '../components/AdministrateursModal';
import { IdentifiantsModal, useConfirm, useToast } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import Select from '../components/Select';
import { Skel, SkelListe } from '../components/Skeleton';

// Page SuperAdmin « Établissements » : portage React de l'ancienne page Flask
// (static/templates/admin/etablissements.html + static/js/etablissements.js).
// Ne modélise QUE les champs réels de structure_models.py et
// authentification_models.py :
//   - /etablissements/            CRUD non cloisonné (multipart, logo)
//   - /cycles/, /classes/, /annees-scolaires/, /trimestres/, /sequences/
//     cloisonnés : le SuperAdmin passe etablissement_id en query (GET/PUT/
//     DELETE) ou dans le corps (POST)
//   - /auth/roles + /auth/utilisateurs pour le compte Admin de l'établissement

const REGIONS = ['Centre', 'Littoral', 'Ouest', 'Nord-Ouest', 'Sud-Ouest', 'Est', 'Sud', 'Adamaoua', 'Nord', 'Extrême-Nord'];

function initiales(nom) {
  if (!nom) return '??';
  const parts = nom.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const pluriel = (n, singulier, plurielForm = `${singulier}s`) => (n > 1 ? plurielForm : singulier);

const byLibelle = (a, b) => a.libelle.localeCompare(b.libelle);

function sortTrimestres(a, b) {
  if (a.date_debut && b.date_debut) return a.date_debut.localeCompare(b.date_debut);
  if (a.date_debut) return -1;
  if (b.date_debut) return 1;
  return a.id - b.id;
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export default function EtablissementsPage() {
  const { reloadEtablissements } = useAuth();
  const toast = useToast();

  const [etablissements, setEtablissements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterRegion, setFilterRegion] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  // Résumé par établissement : { cycles, classes, anneeActive, admin } | { error: true }
  const [summaries, setSummaries] = useState({});

  const [formModal, setFormModal] = useState(null); // { etab } (null = création)
  const [identifiants, setIdentifiants] = useState(null); // { nom, code, pin }
  const [toDelete, setToDelete] = useState(null);
  const [structureEtab, setStructureEtab] = useState(null);
  const [adminsEtab, setAdminsEtab] = useState(null);

  const loadSummaries = useCallback(async (list) => {
    setSummaries({});
    await Promise.all(list.map(async (etab) => {
      try {
        const [cycles, classes, annees, admins] = await Promise.all([
          apiRequest(`/cycles/?etablissement_id=${etab.id}`),
          apiRequest(`/classes/?etablissement_id=${etab.id}`),
          apiRequest(`/annees-scolaires/?etablissement_id=${etab.id}`),
          apiRequest(`/auth/utilisateurs?etablissement_id=${etab.id}&role=Admin`),
        ]);
        setSummaries((prev) => ({
          ...prev,
          [etab.id]: {
            cycles: cycles.length,
            classes: classes.length,
            anneeActive: annees.find((a) => a.active) || null,
            admins: admins.filter((a) => a.actif),
          },
        }));
      } catch {
        setSummaries((prev) => ({ ...prev, [etab.id]: { error: true } }));
      }
    }));
  }, []);

  const loadEtablissements = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest('/etablissements/');
      const list = Array.isArray(data) ? data : [];
      setEtablissements(list);
      loadSummaries(list);
    } catch (err) {
      setError(`Impossible de charger les établissements : ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [loadSummaries]);

  useEffect(() => {
    loadEtablissements();
  }, [loadEtablissements]);

  const afterChange = useCallback(async () => {
    await loadEtablissements();
    await reloadEtablissements();
  }, [loadEtablissements, reloadEtablissements]);

  const filtered = useMemo(() => {
    const region = filterRegion.trim().toLowerCase();
    const search = filterSearch.trim().toLowerCase();
    return etablissements.filter((e) => {
      if (region && (e.region || '').toLowerCase() !== region) return false;
      if (search) {
        const haystack = [e.code, e.nom, e.nom_bilingue, e.adresse, e.bp, e.region].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }, [etablissements, filterRegion, filterSearch]);

  // KPIs : calculés une fois tous les résumés chargés (comme l'ancienne page).
  const kpis = useMemo(() => {
    if (loading || !etablissements.every((e) => summaries[e.id])) return null;
    const ok = Object.values(summaries).filter((s) => !s.error);
    const totalCycles = ok.reduce((sum, s) => sum + s.cycles, 0);
    const totalClasses = ok.reduce((sum, s) => sum + s.classes, 0);
    const anneesActives = ok.filter((s) => s.anneeActive).length;
    const nb = etablissements.length || 1;
    return { totalCycles, totalClasses, anneesActives, moyCycles: (totalCycles / nb).toFixed(1) };
  }, [loading, etablissements, summaries]);

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-center mb-4 gap-3">
        <div>
          <h4 className="fw-bold mb-1"><span className="text-muted fw-light">Super Admin /</span> Établissements</h4>
          <p className="mb-0 text-muted small">Gérez les établissements clients et leur structure scolaire (Cycles, Classes, Années).</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormModal({ etab: null })}>
          <i className="bx bx-plus me-1" /> Nouvel établissement
        </button>
      </div>

      {/* KPIs Contexte Structure Scolaire */}
      <div className="row g-3 mb-4">
        <KpiCard label="Total Établissements" loading={loading} value={etablissements.length} sub="Tous établissements de la plateforme" icon="bx-buildings" color="primary" />
        <KpiCard label="Cycles Configurés" loading={!kpis} value={kpis?.totalCycles} sub={kpis ? `Moy. ${kpis.moyCycles} / établissement` : ''} icon="bx-layer" color="info" />
        <KpiCard label="Classes Actives" loading={!kpis} value={kpis?.totalClasses} sub={kpis ? `Réparties sur ${etablissements.length} établissement(s)` : ''} icon="bx-chalkboard" color="success" />
        <KpiCard label="Années Scolaires Actives" loading={!kpis} value={kpis?.anneesActives} sub={kpis ? `Sur ${etablissements.length} établissement(s)` : ''} icon="bx-calendar-check" color="warning" />
      </div>

      {/* Filtres */}
      <div className="card mb-4">
        <div className="card-body py-3">
          <div className="row g-2 align-items-end">
            <div className="col-md-4">
              <label className="form-label small text-muted mb-1" htmlFor="filterRegion">Région</label>
              <Select id="filterRegion" className="form-select form-select-sm" value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)}>
                <option value="">Toutes les régions</option>
                {REGIONS.map((r) => <option key={r}>{r}</option>)}
              </Select>
            </div>
            <div className="col-md-5">
              <label className="form-label small text-muted mb-1" htmlFor="filterSearch">Recherche</label>
              <input id="filterSearch" type="text" className="form-control form-control-sm" placeholder="Code, nom, ville, BP..." value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)} />
            </div>
            <div className="col-md-3">
              <button type="button" className="btn btn-outline-secondary btn-sm w-100" onClick={() => { setFilterRegion(''); setFilterSearch(''); }}>
                <i className="bx bx-reset me-1" /> Réinitialiser
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Liste des établissements */}
      <div className="card">
        <h5 className="card-header">
          Liste des établissements{' '}
          <span className="text-muted fw-normal ms-1">
            ({filtered.length}{filtered.length !== etablissements.length ? ` / ${etablissements.length}` : ''})
          </span>
        </h5>
        {loading ? (
          <SkelListe lignes={4} avatar label="Chargement des établissements…" className="px-3" />
        ) : error ? (
          <div className="alert alert-danger m-3">{error}</div>
        ) : (
          <>
            <div className="table-responsive text-nowrap">
              <table className="table table-hover mb-0">
                <thead>
                  <tr>
                    <th>Établissement</th>
                    <th>Région</th>
                    <th>Structure Scolaire</th>
                    <th>Administrateur</th>
                    <th className="text-end">Actions</th>
                  </tr>
                </thead>
                <tbody className="table-border-bottom-0">
                  {filtered.length === 0 ? (
                    <tr><td colSpan="5" className="text-center text-muted py-4">Aucun établissement ne correspond à ces critères.</td></tr>
                  ) : filtered.map((etab) => (
                    <EtablissementRow
                      key={etab.id}
                      etab={etab}
                      summary={summaries[etab.id]}
                      onStructure={() => setStructureEtab(etab)}
                      onAdmins={() => setAdminsEtab(etab)}
                      onEdit={() => setFormModal({ etab })}
                      onDelete={() => setToDelete(etab)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-footer">
              <span className="text-muted small">Affichage de {filtered.length} établissement(s) sur {etablissements.length}</span>
            </div>
          </>
        )}
      </div>

      {formModal && (
        <EtablissementFormModal
          etab={formModal.etab}
          onClose={() => setFormModal(null)}
          onSaved={async ({ created, ids, adminError }) => {
            setFormModal(null);
            toast(created ? 'Établissement créé avec succès.' : 'Établissement modifié avec succès.');
            if (adminError) toast(`Établissement créé, mais le compte Admin n'a pas pu être créé : ${adminError}`, 'error');
            if (ids) setIdentifiants(ids);
            await afterChange();
          }}
        />
      )}

      {identifiants && <IdentifiantsModal {...identifiants} titre="Administrateur créé" destinataire="l'administrateur de l'établissement" onClose={() => setIdentifiants(null)} />}

      {toDelete && (
        <DeleteEtablissementModal
          etab={toDelete}
          onClose={() => setToDelete(null)}
          onDeleted={async () => {
            setToDelete(null);
            toast('Établissement supprimé.');
            await afterChange();
          }}
        />
      )}

      {structureEtab && (
        <StructureModal
          etab={structureEtab}
          toast={toast}
          onClose={() => {
            setStructureEtab(null);
            loadSummaries(etablissements);
          }}
        />
      )}

      {adminsEtab && (
        <AdministrateursModal
          etab={adminsEtab}
          onClose={(modifie) => {
            setAdminsEtab(null);
            if (modifie) loadSummaries(etablissements);
          }}
        />
      )}

    </>
  );
}

function KpiCard({ label, value, sub, icon, color, loading = false }) {
  return (
    <div className="stat-col col-xl-3 col-md-6">
      <div className="card h-100">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-start">
            <div>
              <span className="fw-semibold d-block mb-1">{label}</span>
              <h3 className="card-title mb-0">{loading ? <Skel w="3.5rem" h="1.6rem" className="my-1" /> : (value ?? '—')}</h3>
            </div>
            <div className="avatar flex-shrink-0">
              <span className={`avatar-initial rounded bg-label-${color}`}><i className={`bx ${icon}`} /></span>
            </div>
          </div>
          {loading ? <Skel w="65%" h="0.7rem" className="mt-3" /> : <small className="text-muted d-block mt-2">{sub || ' '}</small>}
        </div>
      </div>
    </div>
  );
}

function EtablissementRow({ etab, summary, onStructure, onAdmins, onEdit, onDelete }) {
  const loadingCell = <div className="skel-pile" style={{ minWidth: 140 }}><Skel w="80%" h="0.7rem" /><Skel w="60%" h="0.7rem" /></div>;
  return (
    <tr>
      <td>
        <div className="d-flex align-items-center gap-2">
          <div className="avatar avatar-sm flex-shrink-0">
            {etab.logo_url
              ? <img src={etab.logo_url} alt="" className="rounded" style={{ objectFit: 'contain' }} />
              : <span className="avatar-initial rounded bg-label-primary">{initiales(etab.nom)}</span>}
          </div>
          <div>
            <div className="fw-semibold">
              {etab.nom}
              {etab.code && <span className="badge bg-label-dark font-monospace ms-2" title="Code de l'établissement">{etab.code}</span>}
            </div>
            {etab.nom_bilingue && <div className="text-muted small">{etab.nom_bilingue}</div>}
          </div>
        </div>
      </td>
      <td>{etab.region ? <span className="badge bg-label-secondary">{etab.region}</span> : <span className="text-muted">—</span>}</td>
      <td>
        {!summary ? loadingCell : summary.error ? <span className="text-danger small">Erreur de chargement</span> : (
          <div className="d-flex flex-column gap-1 small">
            <div className="d-flex align-items-center gap-2">
              <i className="bx bx-layer text-info" />
              <span>{summary.cycles} cycle(s)</span>
              <span className="text-muted">·</span>
              <span>{summary.classes} classe(s)</span>
            </div>
            <div className="d-flex align-items-center gap-2">
              <i className="bx bx-calendar-check text-warning" />
              <span>{summary.anneeActive ? `${summary.anneeActive.libelle} (Active)` : 'Aucune année active'}</span>
            </div>
          </div>
        )}
      </td>
      <td>
        {!summary ? loadingCell : summary.error ? <span className="text-danger small">—</span> : (
          <div className="small admin-cellule" role="button" tabIndex={0} title="Gérer les administrateurs" onClick={onAdmins} onKeyDown={(e) => { if (e.key === 'Enter') onAdmins(); }}>
            {summary.admins.length ? (
              <>
                <div className="fw-medium">{summary.admins[0].nom}{summary.admins.length > 1 && <span className="badge bg-label-primary ms-1">+{summary.admins.length - 1}</span>}</div>
                <div className="text-muted">Code <span className="font-monospace">{summary.admins[0].code_connexion}</span></div>
              </>
            ) : <span className="text-warning"><i className="bx bx-error me-1" />Aucun admin actif — en ajouter</span>}
          </div>
        )}
      </td>
      <td className="text-end">
        <RowMenu
          actions={[
            { label: 'Administrateurs', icon: 'bx-shield-quarter', onClick: onAdmins },
            { label: 'Gérer structure', icon: 'bx-sitemap', onClick: onStructure },
            { label: 'Modifier', icon: 'bx-edit-alt', onClick: onEdit },
            { divider: true },
            { label: 'Supprimer', icon: 'bx-trash', onClick: onDelete, danger: true },
          ]}
        />
      </td>
    </tr>
  );
}

// Menu « ⋮ » en position fixed pour ne pas être rogné par .table-responsive.
function RowMenu({ actions }) {
  const [position, setPosition] = useState(null);
  const ref = useRef(null);
  const open = position !== null;

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setPosition(null);
    const handleClick = (event) => {
      if (ref.current && !ref.current.contains(event.target)) close();
    };
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = (event) => {
    if (open) {
      setPosition(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };

  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="btn p-0 dropdown-toggle hide-arrow" onClick={toggle} aria-expanded={open}>
        <i className="bx bx-dots-vertical-rounded" />
      </button>
      <div
        className={`dropdown-menu dropdown-menu-end ${open ? 'show' : ''}`}
        style={open ? { position: 'fixed', top: position.top, right: position.right, left: 'auto' } : undefined}
      >
        {actions.map((action, index) => (action.divider ? <div key={index} className="dropdown-divider" /> : (
          <button
            key={action.label}
            type="button"
            className={`dropdown-item ${action.danger ? 'text-danger' : ''}`}
            onClick={() => { setPosition(null); action.onClick(); }}
          >
            <i className={`bx ${action.icon} me-1`} /> {action.label}
          </button>
        )))}
      </div>
    </div>
  );
}

/* ── Modale création / édition d'un établissement ─────────────────────── */

function EtablissementFormModal({ etab, onClose, onSaved }) {
  const isEdit = Boolean(etab);
  const [form, setForm] = useState({
    nom: etab?.nom || '',
    nom_bilingue: etab?.nom_bilingue || '',
    region: etab?.region || '',
    telephone: etab?.telephone || '',
    adresse: etab?.adresse || '',
    bp: etab?.bp || '',
    adminNom: '',
  });
  const [logo, setLogo] = useState(null);
  const [preview, setPreview] = useState(etab?.logo_url || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => () => {
    if (preview.startsWith('blob:')) URL.revokeObjectURL(preview);
  }, [preview]);

  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));

  const handleLogo = (event) => {
    const file = event.target.files?.[0] || null;
    setLogo(file);
    if (file) setPreview(URL.createObjectURL(file));
  };

  const submit = async () => {
    setError('');
    const nom = form.nom.trim();
    if (!nom || !form.region) {
      setError('Le nom et la région sont obligatoires.');
      return;
    }

    // multipart/form-data : nécessaire pour joindre le fichier logo.
    const body = new FormData();
    body.append('nom', nom);
    body.append('nom_bilingue', form.nom_bilingue.trim());
    body.append('region', form.region);
    body.append('telephone', form.telephone.trim());
    body.append('adresse', form.adresse.trim());
    body.append('bp', form.bp.trim());
    if (logo) body.append('logo', logo);

    setSaving(true);
    try {
      const saved = await apiRequest(isEdit ? `/etablissements/${etab.id}` : '/etablissements/', {
        method: isEdit ? 'PUT' : 'POST',
        body,
      });

      // Compte Admin optionnel, uniquement à la création.
      let ids = null;
      let adminError = null;
      const adminNom = form.adminNom.trim();
      if (!isEdit && adminNom) {
        try {
          const roles = await apiRequest('/auth/roles');
          const adminRole = roles.find((r) => r.libelle === 'Admin');
          if (!adminRole) throw new Error("Le rôle 'Admin' n'existe pas côté serveur");
          const result = await apiRequest('/auth/utilisateurs', {
            method: 'POST',
            body: JSON.stringify({ nom: adminNom, role_id: adminRole.id, etablissement_id: saved.id }),
          });
          if (result?.pin_temporaire) {
            ids = { nom: adminNom, code: result.code_connexion, pin: result.pin_temporaire };
          }
        } catch (adminErr) {
          adminError = adminErr.message;
        }
      }

      await onSaved({ created: !isEdit, ids, adminError });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit
        ? <><i className="bx bx-edit-alt me-2 text-primary" />Modifier l'établissement</>
        : <><i className="bx bx-plus me-2 text-primary" />Nouvel établissement</>}
      onClose={onClose}
      onSubmit={submit}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving
              ? <><span className="spinner-border spinner-border-sm me-1" /> Enregistrement...</>
              : <><i className="bx bx-check me-1" /> Enregistrer</>}
          </button>
        </>
      )}
    >
      {error && <div className="alert alert-danger">{error}</div>}
      <div className="row g-3">
        <div className="col-md-6">
          <label className="form-label" htmlFor="etabNom">Nom (français) *</label>
          <input id="etabNom" type="text" className="form-control" placeholder="Ex: Lycée Bilingue de Yaoundé" value={form.nom} onChange={set('nom')} required />
        </div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="etabNomBilingue">Nom bilingue / anglais</label>
          <input id="etabNomBilingue" type="text" className="form-control" placeholder="Ex: Yaoundé Bilingual High School" value={form.nom_bilingue} onChange={set('nom_bilingue')} />
        </div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="etabRegion">Région *</label>
          <Select id="etabRegion" className="form-select" value={form.region} onChange={set('region')} required>
            <option value="">-- Choisir --</option>
            {REGIONS.map((r) => <option key={r}>{r}</option>)}
            {form.region && !REGIONS.includes(form.region) && <option>{form.region}</option>}
          </Select>
        </div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="etabTelephone">Téléphone</label>
          <input id="etabTelephone" type="tel" className="form-control" placeholder="+237 6XX XXX XXX" value={form.telephone} onChange={set('telephone')} />
        </div>
        <div className="col-md-8">
          <label className="form-label" htmlFor="etabAdresse">Adresse</label>
          <input id="etabAdresse" type="text" className="form-control" placeholder="Rue, quartier..." value={form.adresse} onChange={set('adresse')} />
        </div>
        <div className="col-md-4">
          <label className="form-label" htmlFor="etabBp">Boîte postale</label>
          <input id="etabBp" type="text" className="form-control" placeholder="BP ..." value={form.bp} onChange={set('bp')} />
        </div>
        <div className="col-12">
          <label className="form-label" htmlFor="etabLogo">Logo de l'établissement</label>
          <input id="etabLogo" type="file" className="form-control" accept=".png,.jpg,.jpeg,.gif,.svg,.webp" onChange={handleLogo} />
          <div className="form-text">PNG, JPG, GIF, SVG ou WEBP. Le fichier sera automatiquement renommé d'après le nom de l'établissement.</div>
          {preview && (
            <div className="mt-2">
              <img src={preview} alt="Logo actuel" className="border rounded p-1" style={{ maxHeight: 64, maxWidth: 160, objectFit: 'contain' }} />
            </div>
          )}
        </div>

        {/* La création du compte Admin ne se fait qu'à la création de l'établissement. */}
        {!isEdit && (
          <>
            <div className="col-12"><hr className="my-0" /></div>
            <div className="col-12">
              <h6 className="mb-1"><i className="bx bx-shield-quarter me-2 text-primary" />Compte administrateur de l'établissement</h6>
              <p className="text-muted small mb-0">Optionnel : renseignez le nom pour créer immédiatement le compte Admin de cet établissement. Son code de connexion et un PIN seront générés et affichés une seule fois, sur une fiche à imprimer.</p>
            </div>
            <div className="col-12">
              <label className="form-label" htmlFor="adminNom">Nom complet de l'admin</label>
              <input id="adminNom" type="text" className="form-control" value={form.adminNom} onChange={set('adminNom')} />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function DeleteEtablissementModal({ etab, onClose, onDeleted }) {
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const confirmer = async () => {
    setError('');
    setDeleting(true);
    try {
      await apiRequest(`/etablissements/${etab.id}`, { method: 'DELETE' });
      await onDeleted();
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <Modal
      size=""
      headerClassName="border-danger-subtle"
      title={<span className="text-danger"><i className="bx bx-error me-2" />Confirmer la suppression</span>}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={deleting}>Annuler</button>
          <button type="button" className="btn btn-danger" onClick={confirmer} disabled={deleting}>
            <i className="bx bx-trash me-1" /> Oui, supprimer
          </button>
        </>
      )}
    >
      <p className="mb-2">Vous êtes sur le point de supprimer :</p>
      <p className="fw-semibold fs-5 mb-3">{etab.nom}</p>
      <div className="alert alert-danger d-flex gap-2 mb-3">
        <i className="bx bx-error-circle" />
        <div>Cette action est irréversible. Toutes les données associées seront définitivement effacées côté serveur (cycles, classes, années scolaires, trimestres, séquences rattachés à cet établissement).</div>
      </div>
      <p className="small text-muted fst-italic">Pensez à exporter les données avant confirmation.</p>
      {error && <div className="alert alert-danger mb-0">{error}</div>}
    </Modal>
  );
}

/* ── Modale « Gérer la structure scolaire » ───────────────────────────── */

const EMPTY_STRUCTURE = { cycles: [], classes: [], annees: [], trimestres: [], sequences: [] };

function StructureModal({ etab, toast, onClose }) {
  const etabId = etab.id;
  const [confirm, confirmNode] = useConfirm();
  const [tab, setTab] = useState('cycles');
  const [structure, setStructure] = useState(EMPTY_STRUCTURE);
  const [loading, setLoading] = useState(true);
  const [anneeSel, setAnneeSel] = useState(null);

  // Formulaires inline (null = fermé ; id vide = création)
  const [cycleForm, setCycleForm] = useState(null);
  const [classeForm, setClasseForm] = useState(null);
  const [anneeForm, setAnneeForm] = useState(null);
  const [trimestreForm, setTrimestreForm] = useState(null);
  const [seqForms, setSeqForms] = useState({}); // { [trimestreId]: {...} }

  const scoped = (path) => `${path}?etablissement_id=${etabId}`;

  const charger = useCallback(async () => {
    try {
      const [cycles, classes, annees, trimestres, sequences] = await Promise.all([
        apiRequest(`/cycles/?etablissement_id=${etabId}`),
        apiRequest(`/classes/?etablissement_id=${etabId}`),
        apiRequest(`/annees-scolaires/?etablissement_id=${etabId}`),
        apiRequest(`/trimestres/?etablissement_id=${etabId}`),
        apiRequest(`/sequences/?etablissement_id=${etabId}`),
      ]);
      setStructure({ cycles, classes, annees, trimestres, sequences });
      setAnneeSel((previous) => {
        if (annees.some((a) => a.id === previous)) return previous;
        return (annees.find((a) => a.active) || annees[0])?.id ?? null;
      });
    } catch (err) {
      toast(`Impossible de charger la structure : ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [etabId, toast]);

  useEffect(() => {
    charger();
  }, [charger]);

  const { cycles, classes, annees, trimestres, sequences } = structure;
  const nomCycle = (cycleId) => cycles.find((c) => c.id === cycleId)?.libelle || `#${cycleId}`;
  const cyclesTries = useMemo(() => cycles.slice().sort(byLibelle), [cycles]);

  /* Exécute une écriture, affiche le toast et recharge ; renvoie l'erreur éventuelle. */
  const ecrire = async (path, method, body, successMessage) => {
    try {
      await apiRequest(path, { method, body: body ? JSON.stringify(body) : undefined });
      if (successMessage) toast(successMessage);
      await charger();
      return null;
    } catch (err) {
      return err.message;
    }
  };

  const supprimer = async (path, message, details, successMessage) => {
    if (!(await confirm(message, { details, confirmLabel: 'Confirmer' }))) return;
    const err = await ecrire(path, 'DELETE', null, successMessage);
    if (err) toast(err, 'error');
  };

  /* ── Cycle ── */
  const soumettreCycle = async () => {
    const libelle = cycleForm.libelle.trim();
    if (!libelle) return setCycleForm((f) => ({ ...f, error: 'Le libellé est requis.' }));
    const err = cycleForm.id
      ? await ecrire(scoped(`/cycles/${cycleForm.id}`), 'PUT', { libelle }, 'Cycle modifié.')
      : await ecrire('/cycles/', 'POST', { libelle, etablissement_id: etabId }, 'Cycle ajouté.');
    if (err) setCycleForm((f) => ({ ...f, error: err }));
    else setCycleForm(null);
  };

  const supprimerCycle = (c) => {
    const n = classes.filter((cl) => cl.cycle_id === c.id).length;
    const details = n > 0
      ? `Ce cycle est rattaché à ${n} ${pluriel(n, 'classe')}. ${n > 1 ? 'Elles seront' : 'Elle sera'} définitivement ${pluriel(n, 'supprimée')} en même temps que le cycle.`
      : null;
    supprimer(scoped(`/cycles/${c.id}`), 'Supprimer ce cycle ?', details, 'Cycle supprimé.');
  };

  /* ── Classe ── */
  const ouvrirClasse = (classe) => setClasseForm({
    id: classe?.id || '',
    cycle_id: String(classe?.cycle_id ?? cyclesTries[0]?.id ?? ''),
    option: classe?.option || '',
    error: cycles.length === 0 ? "Créez d'abord au moins un cycle pour cet établissement." : '',
  });

  const soumettreClasse = async () => {
    const cycleId = parseInt(classeForm.cycle_id, 10);
    const option = classeForm.option.trim() || null;
    if (Number.isNaN(cycleId)) return setClasseForm((f) => ({ ...f, error: 'Sélectionnez un cycle valide.' }));
    const err = classeForm.id
      ? await ecrire(scoped(`/classes/${classeForm.id}`), 'PUT', { cycle_id: cycleId, option }, 'Classe modifiée.')
      : await ecrire('/classes/', 'POST', { cycle_id: cycleId, option, etablissement_id: etabId }, 'Classe ajoutée.');
    if (err) setClasseForm((f) => ({ ...f, error: err }));
    else setClasseForm(null);
  };

  /* ── Année scolaire ── */
  const soumettreAnnee = async () => {
    const libelle = anneeForm.libelle.trim();
    if (!libelle) return setAnneeForm((f) => ({ ...f, error: 'Le libellé est requis.' }));
    const err = anneeForm.id
      ? await ecrire(scoped(`/annees-scolaires/${anneeForm.id}`), 'PUT', { libelle }, 'Année scolaire modifiée.')
      : await ecrire('/annees-scolaires/', 'POST', { libelle, active: anneeForm.active, etablissement_id: etabId }, 'Année scolaire ajoutée.');
    if (err) setAnneeForm((f) => ({ ...f, error: err }));
    else setAnneeForm(null);
  };

  const toggleAnnee = async (a) => {
    const err = await ecrire(scoped(`/annees-scolaires/${a.id}`), 'PUT', { active: !a.active });
    if (err) toast(err, 'error');
  };

  const supprimerAnnee = (a) => {
    const lies = trimestres.filter((t) => t.annee_scolaire_id === a.id);
    const nbT = lies.length;
    const nbS = sequences.filter((s) => lies.some((t) => t.id === s.trimestre_id)).length;
    const details = nbT > 0
      ? `Cette année scolaire contient ${nbT} ${pluriel(nbT, 'trimestre')}${nbS > 0 ? ` et ${nbS} ${pluriel(nbS, 'séquence')}` : ''}. Ils seront tous définitivement supprimés en même temps qu'elle.`
      : null;
    supprimer(scoped(`/annees-scolaires/${a.id}`), 'Supprimer cette année scolaire ?', details, 'Année scolaire supprimée.');
  };

  /* ── Trimestre ── */
  const soumettreTrimestre = async () => {
    const libelle = trimestreForm.libelle.trim();
    const date_debut = trimestreForm.date_debut || null;
    const date_fin = trimestreForm.date_fin || null;
    if (!libelle) return setTrimestreForm((f) => ({ ...f, error: 'Le libellé est requis.' }));
    let err;
    if (trimestreForm.id) {
      err = await ecrire(scoped(`/trimestres/${trimestreForm.id}`), 'PUT', { libelle, date_debut, date_fin }, 'Trimestre modifié.');
    } else {
      if (!anneeSel) return setTrimestreForm((f) => ({ ...f, error: "Sélectionnez d'abord une année scolaire." }));
      err = await ecrire('/trimestres/', 'POST', { annee_scolaire_id: anneeSel, libelle, date_debut, date_fin, etablissement_id: etabId }, 'Trimestre ajouté.');
    }
    if (err) setTrimestreForm((f) => ({ ...f, error: err }));
    else setTrimestreForm(null);
  };

  const supprimerTrimestre = (t) => {
    const n = sequences.filter((s) => s.trimestre_id === t.id).length;
    const details = n > 0
      ? `Ce trimestre contient ${n} ${pluriel(n, 'séquence')}. ${n > 1 ? 'Elles seront' : 'Elle sera'} définitivement ${pluriel(n, 'supprimée')} en même temps que lui.`
      : null;
    supprimer(scoped(`/trimestres/${t.id}`), 'Supprimer ce trimestre ?', details, 'Trimestre supprimé.');
  };

  /* ── Séquence (un formulaire inline par carte de trimestre) ── */
  const setSeqForm = (trimestreId, value) => setSeqForms((forms) => {
    const next = { ...forms };
    if (value === null) delete next[trimestreId];
    else next[trimestreId] = typeof value === 'function' ? value(forms[trimestreId]) : value;
    return next;
  });

  const ouvrirSequence = (trimestreId, s) => setSeqForm(trimestreId, {
    id: s?.id || '', libelle: s?.libelle || '', date_debut: s?.date_debut || '', date_fin: s?.date_fin || '', error: '',
  });

  const soumettreSequence = async (trimestreId) => {
    const f = seqForms[trimestreId];
    const libelle = f.libelle.trim();
    const date_debut = f.date_debut || null;
    const date_fin = f.date_fin || null;
    if (!libelle) return setSeqForm(trimestreId, (cur) => ({ ...cur, error: 'Le libellé est requis.' }));
    const err = f.id
      ? await ecrire(scoped(`/sequences/${f.id}`), 'PUT', { libelle, date_debut, date_fin }, 'Séquence modifiée.')
      : await ecrire('/sequences/', 'POST', { trimestre_id: trimestreId, libelle, date_debut, date_fin, etablissement_id: etabId }, 'Séquence ajoutée.');
    if (err) setSeqForm(trimestreId, (cur) => ({ ...cur, error: err }));
    else setSeqForm(trimestreId, null);
  };

  const trimestresAnnee = trimestres.filter((t) => t.annee_scolaire_id === anneeSel).sort(sortTrimestres);

  const tabs = [
    { key: 'cycles', icon: 'bx-layer', label: `Cycles (${cycles.length})` },
    { key: 'classes', icon: 'bx-chalkboard', label: `Classes (${classes.length})` },
    { key: 'annees', icon: 'bx-calendar', label: `Années scolaires (${annees.length})` },
    { key: 'trimestres', icon: 'bx-calendar-week', label: 'Trimestres & Séquences' },
  ];

  const actionBtn = (icon, onClick, { danger, title } = {}) => (
    <button type="button" className={`btn btn-icon btn-sm btn-outline-${danger ? 'danger' : 'secondary'} ms-1`} onClick={onClick} title={title}>
      <i className={`bx ${icon}`} />
    </button>
  );

  return (
    <>
      <Modal
        size="modal-xl"
        title={<><i className="bx bx-sitemap me-2 text-primary" />Gérer la structure scolaire</>}
        subtitle={`${etab.nom}${etab.region ? ` · ${etab.region}` : ''}`}
        onClose={onClose}
        bodyClassName="p-0"
        footer={<button type="button" className="btn btn-outline-secondary" onClick={onClose}>Fermer</button>}
      >
        <ul className="nav nav-tabs px-3 pt-3" role="tablist">
          {tabs.map((t) => (
            <li key={t.key} className="nav-item">
              <button type="button" className={`nav-link ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
                <i className={`bx ${t.icon} me-1`} /> {t.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="p-3">
          {loading ? (
            <SkelListe lignes={4} label="Chargement de la structure…" />
          ) : (
            <>
              {/* TAB : CYCLES */}
              {tab === 'cycles' && (
                <>
                  <TabHeader text="Définissez les cycles pédagogiques de l'établissement (Primaire, Secondaire, etc.)" button="Ajouter un cycle" onClick={() => setCycleForm({ id: '', libelle: '', error: '' })} />
                  {cycleForm && (
                    <InlinePanel title={cycleForm.id ? 'Modifier le cycle' : 'Nouveau cycle'} edit={Boolean(cycleForm.id)} error={cycleForm.error} onSubmit={soumettreCycle} onCancel={() => setCycleForm(null)}>
                      <div className="col-md-6">
                        <label className="form-label small mb-1">Libellé *</label>
                        <input autoFocus type="text" className="form-control form-control-sm" placeholder="Ex: Cycle Primaire" value={cycleForm.libelle} onChange={(e) => setCycleForm((f) => ({ ...f, libelle: e.target.value }))} />
                      </div>
                    </InlinePanel>
                  )}
                  <StructureTable headers={['Libellé', 'Classes associées']} colSpan={3} empty="Aucun cycle défini.">
                    {cyclesTries.map((c) => (
                      <tr key={c.id}>
                        <td className="fw-semibold">{c.libelle}</td>
                        <td>{classes.filter((cl) => cl.cycle_id === c.id).length} classe(s)</td>
                        <td className="text-end">
                          {actionBtn('bx-edit-alt', () => setCycleForm({ id: c.id, libelle: c.libelle, error: '' }))}
                          {actionBtn('bx-trash', () => supprimerCycle(c), { danger: true })}
                        </td>
                      </tr>
                    ))}
                  </StructureTable>
                </>
              )}

              {/* TAB : CLASSES */}
              {tab === 'classes' && (
                <>
                  <TabHeader text="Gérez les classes rattachées aux cycles définis ci-dessus." button="Ajouter une classe" onClick={() => ouvrirClasse(null)} />
                  {classeForm && (
                    <InlinePanel title={classeForm.id ? 'Modifier la classe' : 'Nouvelle classe'} edit={Boolean(classeForm.id)} error={classeForm.error} onSubmit={soumettreClasse} onCancel={() => setClasseForm(null)} actionsCol="col-md-4">
                      <div className="col-md-4">
                        <label className="form-label small mb-1">Cycle *</label>
                        <Select className="form-select form-select-sm" value={classeForm.cycle_id} onChange={(e) => setClasseForm((f) => ({ ...f, cycle_id: e.target.value }))}>
                          {cyclesTries.length === 0
                            ? <option value="">Aucun cycle disponible</option>
                            : cyclesTries.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
                        </Select>
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small mb-1">Option</label>
                        <input type="text" className="form-control form-control-sm" placeholder="Ex: Scientifique" value={classeForm.option} onChange={(e) => setClasseForm((f) => ({ ...f, option: e.target.value }))} />
                      </div>
                    </InlinePanel>
                  )}
                  <StructureTable headers={['Cycle', 'Option', 'Effectif']} colSpan={4} empty="Aucune classe définie.">
                    {classes.map((cl) => (
                      <tr key={cl.id}>
                        <td><span className="badge bg-label-secondary">{nomCycle(cl.cycle_id)}</span></td>
                        <td>{cl.option || '-'}</td>
                        <td>{cl.effectif}</td>
                        <td className="text-end">
                          {actionBtn('bx-edit-alt', () => ouvrirClasse(cl))}
                          {actionBtn('bx-trash', () => supprimer(scoped(`/classes/${cl.id}`), 'Supprimer cette classe ?', null, 'Classe supprimée.'), { danger: true })}
                        </td>
                      </tr>
                    ))}
                  </StructureTable>
                </>
              )}

              {/* TAB : ANNÉES SCOLAIRES */}
              {tab === 'annees' && (
                <>
                  <TabHeader text="Configurez les années scolaires et leur état d'activation." button="Nouvelle année" onClick={() => setAnneeForm({ id: '', libelle: '', active: false, error: '' })} />
                  {anneeForm && (
                    <InlinePanel title={anneeForm.id ? "Modifier l'année scolaire" : 'Nouvelle année scolaire'} edit={Boolean(anneeForm.id)} error={anneeForm.error} onSubmit={soumettreAnnee} onCancel={() => setAnneeForm(null)} actionsCol="col-md-4">
                      <div className="col-md-4">
                        <label className="form-label small mb-1">Libellé *</label>
                        <input autoFocus type="text" className="form-control form-control-sm" placeholder="Ex: 2025-2026" value={anneeForm.libelle} onChange={(e) => setAnneeForm((f) => ({ ...f, libelle: e.target.value }))} />
                      </div>
                      {/* En édition, l'activation se gère via le bouton bascule du tableau. */}
                      <div className="col-md-4">
                        {!anneeForm.id && (
                          <div className="form-check mb-1">
                            <input id="anneeFormActive" className="form-check-input" type="checkbox" checked={anneeForm.active} onChange={(e) => setAnneeForm((f) => ({ ...f, active: e.target.checked }))} />
                            <label className="form-check-label small" htmlFor="anneeFormActive">Activer immédiatement</label>
                          </div>
                        )}
                      </div>
                    </InlinePanel>
                  )}
                  <StructureTable headers={['Libellé', 'État']} colSpan={3} empty="Aucune année scolaire définie.">
                    {annees.map((a) => (
                      <tr key={a.id}>
                        <td className="fw-semibold">{a.libelle}</td>
                        <td>{a.active ? <span className="badge bg-label-success">Active</span> : <span className="badge bg-label-secondary">Inactive</span>}</td>
                        <td className="text-end">
                          {actionBtn(a.active ? 'bx-toggle-right' : 'bx-toggle-left', () => toggleAnnee(a), { title: a.active ? 'Désactiver' : 'Activer' })}
                          {actionBtn('bx-edit-alt', () => setAnneeForm({ id: a.id, libelle: a.libelle, active: a.active, error: '' }))}
                          {actionBtn('bx-trash', () => supprimerAnnee(a), { danger: true })}
                        </td>
                      </tr>
                    ))}
                  </StructureTable>
                </>
              )}

              {/* TAB : TRIMESTRES & SÉQUENCES */}
              {tab === 'trimestres' && (
                <>
                  <div className="mb-3 d-flex align-items-center gap-2">
                    <label className="form-label small text-muted mb-0" htmlFor="selectAnneeTrimestres">Année scolaire :</label>
                    <Select
                      id="selectAnneeTrimestres"
                      className="form-select form-select-sm"
                      style={{ maxWidth: 220 }}
                      value={anneeSel ?? ''}
                      onChange={(e) => { setTrimestreForm(null); setAnneeSel(e.target.value ? Number(e.target.value) : null); }}
                    >
                      {annees.length === 0
                        ? <option value="">Aucune année scolaire</option>
                        : annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (Active)' : ''}</option>)}
                    </Select>
                    <button type="button" className="btn btn-primary btn-sm ms-auto" onClick={() => setTrimestreForm({ id: '', libelle: '', date_debut: '', date_fin: '', error: '' })}>
                      <i className="bx bx-plus me-1" /> Ajouter un trimestre
                    </button>
                  </div>

                  {trimestreForm && (
                    <InlinePanel title={trimestreForm.id ? 'Modifier le trimestre' : 'Nouveau trimestre'} edit={Boolean(trimestreForm.id)} error={trimestreForm.error} onSubmit={soumettreTrimestre} onCancel={() => setTrimestreForm(null)} actionsCol="col-md-3">
                      <div className="col-md-3">
                        <label className="form-label small mb-1">Libellé *</label>
                        <input autoFocus type="text" className="form-control form-control-sm" placeholder="Ex: 1er Trimestre" value={trimestreForm.libelle} onChange={(e) => setTrimestreForm((f) => ({ ...f, libelle: e.target.value }))} />
                      </div>
                      <div className="col-md-2">
                        <label className="form-label small mb-1">Début</label>
                        <input type="date" className="form-control form-control-sm" value={trimestreForm.date_debut} onChange={(e) => setTrimestreForm((f) => ({ ...f, date_debut: e.target.value }))} />
                      </div>
                      <div className="col-md-2">
                        <label className="form-label small mb-1">Fin</label>
                        <input type="date" className="form-control form-control-sm" value={trimestreForm.date_fin} onChange={(e) => setTrimestreForm((f) => ({ ...f, date_fin: e.target.value }))} />
                      </div>
                    </InlinePanel>
                  )}

                  <div className="row g-3">
                    {!anneeSel ? (
                      <div className="col-12 text-center text-muted py-3">Sélectionnez une année scolaire.</div>
                    ) : trimestresAnnee.length === 0 ? (
                      <div className="col-12 text-center text-muted py-3">Aucun trimestre pour cette année scolaire.</div>
                    ) : trimestresAnnee.map((t) => {
                      const seqs = sequences.filter((s) => s.trimestre_id === t.id);
                      const seqForm = seqForms[t.id];
                      return (
                        <div key={t.id} className="col-md-4">
                          <div className="card h-100 border">
                            <div className="card-header d-flex justify-content-between align-items-center py-2">
                              <h6 className="card-title mb-0">{t.libelle}</h6>
                              <div>
                                {actionBtn('bx-edit-alt', () => setTrimestreForm({ id: t.id, libelle: t.libelle, date_debut: t.date_debut || '', date_fin: t.date_fin || '', error: '' }))}
                                {actionBtn('bx-trash', () => supprimerTrimestre(t), { danger: true })}
                              </div>
                            </div>
                            <div className="card-body">
                              <p className="small text-muted mb-2">{t.date_debut || '?'} → {t.date_fin || '?'}</p>
                              <hr className="my-2" />
                              <div className="small fw-semibold mb-2">Séquences :</div>

                              {seqForm && (
                                <div className="p-2 mb-2 border rounded bg-lighter">
                                  <div className="row g-1">
                                    <div className="col-12">
                                      <input autoFocus type="text" className="form-control form-control-sm" placeholder="Libellé (ex: Séquence 1)" value={seqForm.libelle} onChange={(e) => setSeqForm(t.id, (f) => ({ ...f, libelle: e.target.value }))} />
                                    </div>
                                    <div className="col-6">
                                      <input type="date" className="form-control form-control-sm" title="Date de début" value={seqForm.date_debut} onChange={(e) => setSeqForm(t.id, (f) => ({ ...f, date_debut: e.target.value }))} />
                                    </div>
                                    <div className="col-6">
                                      <input type="date" className="form-control form-control-sm" title="Date de fin" value={seqForm.date_fin} onChange={(e) => setSeqForm(t.id, (f) => ({ ...f, date_fin: e.target.value }))} />
                                    </div>
                                    <div className="col-12 d-flex gap-1 mt-1">
                                      <button type="button" className="btn btn-primary btn-sm flex-fill" onClick={() => soumettreSequence(t.id)}>
                                        <i className="bx bx-check me-1" />{seqForm.id ? 'Enregistrer' : 'Ajouter'}
                                      </button>
                                      <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setSeqForm(t.id, null)}>Annuler</button>
                                    </div>
                                  </div>
                                  {seqForm.error && <div className="alert alert-danger py-1 px-2 small mt-1 mb-0">{seqForm.error}</div>}
                                </div>
                              )}

                              <div className="d-flex flex-column gap-1">
                                {seqs.length === 0 ? <span className="text-muted small">Aucune séquence</span> : seqs.map((s) => (
                                  <div key={s.id} className="d-flex justify-content-between align-items-center small">
                                    <span>{s.libelle}</span>
                                    <span className="text-muted">{s.date_debut || '?'} → {s.date_fin || '?'}</span>
                                    <span className="text-nowrap">
                                      {actionBtn('bx-edit-alt', () => ouvrirSequence(t.id, s))}
                                      {actionBtn('bx-trash', () => supprimer(scoped(`/sequences/${s.id}`), 'Supprimer cette séquence ?', null, 'Séquence supprimée.'), { danger: true })}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="card-footer py-2">
                              <button type="button" className="btn btn-outline-primary btn-sm w-100" onClick={() => (seqForm ? setSeqForm(t.id, null) : ouvrirSequence(t.id, null))}>
                                <i className="bx bx-plus me-1" /> Ajouter une séquence
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Modal>
      {confirmNode}
    </>
  );
}

function TabHeader({ text, button, onClick }) {
  return (
    <div className="d-flex justify-content-between align-items-center mb-3 gap-2">
      <p className="mb-0 text-muted small">{text}</p>
      <button type="button" className="btn btn-primary btn-sm text-nowrap" onClick={onClick}>
        <i className="bx bx-plus me-1" /> {button}
      </button>
    </div>
  );
}

function InlinePanel({ title, edit, error, onSubmit, onCancel, actionsCol = 'col-md-6', children }) {
  return (
    <div className="card border border-primary mb-3 shadow-none">
      <div className="card-body">
        <h6 className="mb-3"><i className={`bx ${edit ? 'bx-edit-alt' : 'bx-plus'} me-1 text-primary`} />{title}</h6>
        <div className="row g-2 align-items-end">
          {children}
          <div className={`${actionsCol} d-flex gap-2`}>
            <button type="button" className="btn btn-primary btn-sm flex-fill" onClick={onSubmit}>
              <i className="bx bx-check me-1" />{edit ? 'Enregistrer' : 'Ajouter'}
            </button>
            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onCancel}>Annuler</button>
          </div>
        </div>
        {error && <div className="alert alert-danger py-1 px-2 small mt-2 mb-0">{error}</div>}
      </div>
    </div>
  );
}

function StructureTable({ headers, colSpan, empty, children }) {
  const rows = Array.isArray(children) ? children : [children];
  return (
    <div className="table-responsive border rounded">
      <table className="table table-hover mb-0">
        <thead>
          <tr>
            {headers.map((h) => <th key={h}>{h}</th>)}
            <th className="text-end">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0
            ? <tr><td colSpan={colSpan} className="text-center text-muted py-3">{empty}</td></tr>
            : children}
        </tbody>
      </table>
    </div>
  );
}

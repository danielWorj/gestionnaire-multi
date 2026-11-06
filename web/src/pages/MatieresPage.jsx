import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import {
  classeLabel, Field, FormFooter, IconBtn, PageHeader, StatCard, TableCard, Tabs, TBody, useConfirm, useSave, useToast,
} from '../components/ui';
import Select from '../components/Select';
import ImportModal from '../components/importConfigs';
import { roleDe } from '../components/Layout';

// Portage de server/static/templates/matiere.html : groupes de matières,
// matières et affectations matière → classe (pedagogie_api.py, cloisonné
// par établissement).

export default function MatieresPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { user, activeEtablissementId } = useAuth();
  const peutImporter = ['Admin', 'SuperAdmin'].includes(roleDe(user));
  const [importOuvert, setImportOuvert] = useState(false);

  const [tab, setTab] = useState('groupes');
  const [groupes, setGroupes] = useState([]);
  const [matieres, setMatieres] = useState([]);
  const [affectations, setAffectations] = useState([]);
  const [classes, setClasses] = useState([]);
  const [enseignants, setEnseignants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState({});
  // false uniquement si le rôle connecté n'a pas accès au référentiel (403).
  const [referentielAccessible, setReferentielAccessible] = useState(true);

  const [groupeModal, setGroupeModal] = useState(null);
  const [matiereModal, setMatiereModal] = useState(null);
  const [affectationModal, setAffectationModal] = useState(null);

  const loadGroupes = useCallback(async () => {
    try {
      setGroupes(await api.get('/groupes-matieres/'));
      setReferentielAccessible(true);
      setErrors((e) => ({ ...e, groupes: null }));
    } catch (err) {
      setGroupes([]);
      if (err.status === 403) {
        setReferentielAccessible(false);
        setErrors((e) => ({ ...e, groupes: 'Accès non autorisé avec votre compte' }));
      } else {
        setErrors((e) => ({ ...e, groupes: err.message }));
      }
    }
  }, []);

  const loadMatieres = useCallback(async () => {
    try {
      setMatieres(await api.get('/matieres/'));
      setErrors((e) => ({ ...e, matieres: null }));
    } catch (err) {
      setMatieres([]);
      setErrors((e) => ({ ...e, matieres: err.status === 403 ? 'Accès non autorisé avec votre compte' : err.message }));
    }
  }, []);

  const loadAffectations = useCallback(async () => {
    try {
      setAffectations(await api.get('/matieres-classe/'));
      setErrors((e) => ({ ...e, affectations: null }));
    } catch (err) {
      setErrors((e) => ({ ...e, affectations: err.message }));
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    // Données de référence (non bloquantes)
    try {
      const [classesBrutes, cycles] = await Promise.all([api.get('/classes/'), api.get('/cycles/').catch(() => [])]);
      setClasses(classesBrutes.map((c) => ({ ...c, cycle_libelle: cycles.find((cy) => cy.id === c.cycle_id)?.libelle })));
    } catch {
      setClasses([]);
    }
    setEnseignants(await api.get('/enseignants/').catch(() => []));
    await loadGroupes();
    await loadMatieres();
    await loadAffectations();
    setLoading(false);
  }, [loadGroupes, loadMatieres, loadAffectations]);

  useEffect(() => {
    loadAll();
  }, [loadAll, activeEtablissementId]);

  const groupesTries = useMemo(() => [...groupes].sort((a, b) => (a.ordre ?? 0) - (b.ordre ?? 0) || a.libelle.localeCompare(b.libelle, 'fr')), [groupes]);
  const groupeLibelle = (id) => groupes.find((g) => g.id === id)?.libelle || `Groupe #${id}`;
  const matiereLabel = (id) => matieres.find((m) => m.id === id)?.libelle || `Matière #${id}`;
  const enseignantLabel = (id) => {
    const en = enseignants.find((x) => x.id === id);
    return en ? `${en.prenom} ${en.nom}` : `Enseignant #${id}`;
  };
  const labelClasse = (id) => classeLabel(classes.find((c) => c.id === id)) || `Classe #${id}`;

  const supprimer = async (path, label, reload) => {
    if (!(await confirm(`Supprimer « ${label} » ? Cette action est irréversible.`))) return;
    try {
      await api.del(path);
      toast('Élément supprimé.');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const openMatiere = (data) => {
    if (!groupes.length) {
      toast("Créez d'abord un groupe de matières.", 'error');
      return;
    }
    setMatiereModal({ data });
  };

  const openAffectation = (data) => {
    if (!classes.length) {
      toast('Aucune classe disponible. Créez-en une dans Configuration.', 'error');
      return;
    }
    if (!enseignants.length) {
      toast('Aucun enseignant disponible. Créez-en un dans Enseignants.', 'error');
      return;
    }
    if (!matieres.length) {
      toast("Aucune matière disponible : créez-en une dans l'onglet « Matières » avant de faire une affectation.", 'error');
    }
    setAffectationModal({ data });
  };

  return (
    <>
      <PageHeader title="Gestion des Matières" subtitle="Groupes de matières, matières et leurs affectations aux classes.">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={loadAll}>
          <i className="bx bx-refresh me-1" /> Actualiser
        </button>
        {peutImporter && (
          <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => setImportOuvert(true)}>
            <i className="bx bx-import me-1" /> Importer (Excel, CSV, Word)
          </button>
        )}
      </PageHeader>

      <div className="row g-3 mb-4">
        <StatCard className="col-sm-6 col-xl-4" label="Groupes de matières" loading={loading} value={!referentielAccessible ? null : groupes.length} icon="bx-layer" color="primary" />
        <StatCard className="col-sm-6 col-xl-4" label="Matières" loading={loading} value={!referentielAccessible ? null : matieres.length} icon="bx-book-open" color="info" />
        <StatCard className="col-sm-6 col-xl-4" label="Affectations classe" loading={loading} value={affectations.length} icon="bx-link" color="success" />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'groupes', icon: 'bx-layer', label: 'Groupes de matières' },
          { key: 'matieres', icon: 'bx-book-open', label: 'Matières' },
          { key: 'affectations', icon: 'bx-link', label: 'Affectations Classe' },
        ]}
      />

      {tab === 'groupes' && (
        <TableCard
          title="Groupes de matières"
          icon="bx-layer"
          count={groupes.length}
          actions={referentielAccessible && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setGroupeModal({ data: null })}>
              <i className="bx bx-plus me-1" /> Nouveau groupe
            </button>
          )}
        >
          <table className="table table-hover mb-0">
            <thead><tr><th style={{ width: 90 }}>Ordre</th><th>Libellé</th><th>Matières</th><th className="text-end">Actions</th></tr></thead>
            <TBody colSpan={4} loading={loading} error={errors.groupes} rows={groupes.length} empty="Aucun groupe de matières">
              {groupesTries.map((g) => (
                <tr key={g.id}>
                  <td><span className="badge bg-label-primary">{g.ordre ?? 0}</span></td>
                  <td><strong>{g.libelle}</strong></td>
                  <td>{matieres.filter((m) => m.groupe_id === g.id).length} matière(s)</td>
                  <td className="text-end">
                    <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setGroupeModal({ data: g })} />
                    <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(`/groupes-matieres/${g.id}`, g.libelle, loadGroupes)} />
                  </td>
                </tr>
              ))}
            </TBody>
          </table>
        </TableCard>
      )}

      {tab === 'matieres' && (
        <TableCard
          title="Matières"
          icon="bx-book-open"
          count={matieres.length}
          actions={referentielAccessible && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => openMatiere(null)}>
              <i className="bx bx-plus me-1" /> Nouvelle matière
            </button>
          )}
        >
          <table className="table table-hover mb-0">
            <thead><tr><th>Libellé</th><th>Groupe</th><th className="text-end">Actions</th></tr></thead>
            <TBody colSpan={3} loading={loading} error={errors.matieres} rows={matieres.length} empty="Aucune matière">
              {matieres.map((m) => (
                <tr key={m.id}>
                  <td><strong>{m.libelle}</strong></td>
                  <td>{groupeLibelle(m.groupe_id)}</td>
                  <td className="text-end">
                    <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => openMatiere(m)} />
                    <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(`/matieres/${m.id}`, m.libelle, loadMatieres)} />
                  </td>
                </tr>
              ))}
            </TBody>
          </table>
        </TableCard>
      )}

      {tab === 'affectations' && (
        <TableCard
          title="Affectations Matière → Classe"
          icon="bx-link"
          count={affectations.length}
          actions={(
            <button type="button" className="btn btn-primary btn-sm" onClick={() => openAffectation(null)}>
              <i className="bx bx-plus me-1" /> Nouvelle affectation
            </button>
          )}
        >
          <table className="table table-hover mb-0">
            <thead><tr><th>Classe</th><th>Matière</th><th>Enseignant</th><th>Coefficient</th><th className="text-end">Actions</th></tr></thead>
            <TBody colSpan={5} loading={loading} error={errors.affectations} rows={affectations.length} empty="Aucune affectation" emptyIcon="bx-link">
              {affectations.map((a) => (
                <tr key={a.id}>
                  <td><strong>{labelClasse(a.classe_id)}</strong></td>
                  <td>{matiereLabel(a.matiere_id)}</td>
                  <td>{enseignantLabel(a.enseignant_id)}</td>
                  <td><span className="badge bg-label-warning">{a.coefficient}</span></td>
                  <td className="text-end">
                    <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => openAffectation(a)} />
                    <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(`/matieres-classe/${a.id}`, `${labelClasse(a.classe_id)} — ${matiereLabel(a.matiere_id)}`, loadAffectations)} />
                  </td>
                </tr>
              ))}
            </TBody>
          </table>
        </TableCard>
      )}

      {groupeModal && (
        <GroupeModal
          data={groupeModal.data}
          ordreSuivant={groupes.reduce((max, g) => Math.max(max, g.ordre ?? 0), 0) + 1}
          onClose={() => setGroupeModal(null)}
          onSaved={async (msg) => { setGroupeModal(null); toast(msg); await loadGroupes(); }}
        />
      )}
      {matiereModal && (
        <MatiereModal
          data={matiereModal.data}
          groupes={groupes}
          onClose={() => setMatiereModal(null)}
          onSaved={async (msg) => { setMatiereModal(null); toast(msg); await loadMatieres(); }}
        />
      )}
      {affectationModal && (
        <AffectationModal
          data={affectationModal.data}
          classes={classes}
          matieres={matieres}
          enseignants={enseignants}
          onClose={() => setAffectationModal(null)}
          onSaved={async (msg) => { setAffectationModal(null); toast(msg); await loadAffectations(); }}
        />
      )}
      {importOuvert && <ImportModal module="matieres" onClose={() => setImportOuvert(false)} onImported={loadAll} />}
      {confirmNode}
    </>
  );
}

function GroupeModal({ data, ordreSuivant, onClose, onSaved }) {
  const [libelle, setLibelle] = useState(data?.libelle || '');
  const [ordre, setOrdre] = useState(String(data ? data.ordre ?? 0 : ordreSuivant));
  const [validated, setValidated] = useState(false);
  const [save, saving] = useSave(onSaved);
  const ordreValide = /^\d+$/.test(ordre.trim());

  const submit = () => {
    if (!libelle.trim() || !ordreValide) return setValidated(true);
    return save('/groupes-matieres/', data?.id, { libelle: libelle.trim(), ordre: Number(ordre) }, ['Groupe créé.', 'Groupe mis à jour.']);
  };

  return (
    <Modal size="" title={<><i className="bx bx-layer me-2 text-primary" />{data ? 'Modifier le groupe' : 'Nouveau groupe'}</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} />}>
      <Field label="Libellé" required className="mb-1" invalid={validated && !libelle.trim() && 'Le libellé est requis.'}>
        <input autoFocus type="text" className={`form-control ${validated && !libelle.trim() ? 'is-invalid' : ''}`} placeholder="Ex : Sciences, Lettres…" value={libelle} onChange={(e) => setLibelle(e.target.value)} />
      </Field>
      <Field label="Ordre d'affichage sur le bulletin" required className="mt-3 mb-1" invalid={validated && !ordreValide && "L'ordre doit être un entier positif."}>
        <input type="number" min="0" step="1" className={`form-control ${validated && !ordreValide ? 'is-invalid' : ''}`} value={ordre} onChange={(e) => setOrdre(e.target.value)} />
      </Field>
    </Modal>
  );
}

function MatiereModal({ data, groupes, onClose, onSaved }) {
  const [form, setForm] = useState({ libelle: data?.libelle || '', groupe_id: data?.groupe_id ? String(data.groupe_id) : '' });
  const [validated, setValidated] = useState(false);
  const [save, saving] = useSave(onSaved);
  const inv = (cond) => (validated && cond ? 'is-invalid' : '');

  const submit = () => {
    if (!form.libelle.trim() || !form.groupe_id) return setValidated(true);
    return save('/matieres/', data?.id, { libelle: form.libelle.trim(), groupe_id: parseInt(form.groupe_id, 10) }, ['Matière créée.', 'Matière mise à jour.']);
  };

  return (
    <Modal size="" title={<><i className="bx bx-book-open me-2 text-primary" />{data ? 'Modifier la matière' : 'Nouvelle matière'}</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} />}>
      <Field label="Libellé" required invalid={validated && !form.libelle.trim() && 'Le libellé est requis.'}>
        <input autoFocus type="text" className={`form-control ${inv(!form.libelle.trim())}`} placeholder="Ex : Mathématiques" value={form.libelle} onChange={(e) => setForm((f) => ({ ...f, libelle: e.target.value }))} />
      </Field>
      <Field label="Groupe" required className="mb-1" invalid={validated && !form.groupe_id && 'Le groupe est requis.'}>
        <Select className={`form-select ${inv(!form.groupe_id)}`} value={form.groupe_id} onChange={(e) => setForm((f) => ({ ...f, groupe_id: e.target.value }))}>
          <option value="">-- Choisir --</option>
          {groupes.map((g) => <option key={g.id} value={g.id}>{g.libelle}</option>)}
        </Select>
      </Field>
    </Modal>
  );
}

function AffectationModal({ data, classes, matieres, enseignants, onClose, onSaved }) {
  const [form, setForm] = useState({
    classe_id: data ? String(data.classe_id) : '',
    matiere_id: data ? String(data.matiere_id) : '',
    enseignant_id: data ? String(data.enseignant_id) : '',
    coefficient: data ? String(data.coefficient) : '1',
  });
  const [validated, setValidated] = useState(false);
  const [save, saving] = useSave(onSaved);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const missing = (name) => validated && !form[name];

  const submit = () => {
    if (!form.classe_id || !form.matiere_id || !form.enseignant_id || !form.coefficient || Number(form.coefficient) < 1) return setValidated(true);
    return save('/matieres-classe/', data?.id, {
      classe_id: parseInt(form.classe_id, 10),
      matiere_id: parseInt(form.matiere_id, 10),
      enseignant_id: parseInt(form.enseignant_id, 10),
      coefficient: parseInt(form.coefficient, 10) || 1,
    }, ['Affectation créée.', 'Affectation mise à jour.']);
  };

  return (
    <Modal size="" title={<><i className="bx bx-link me-2 text-primary" />{data ? "Modifier l'affectation" : 'Nouvelle affectation'}</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} />}>
      <Field label="Classe" required invalid={missing('classe_id') && 'La classe est requise.'}>
        <Select className={`form-select ${missing('classe_id') ? 'is-invalid' : ''}`} value={form.classe_id} onChange={set('classe_id')}>
          <option value="">-- Choisir --</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{classeLabel(c) || `Classe #${c.id}`}</option>)}
        </Select>
      </Field>
      <Field label="Matière" required invalid={missing('matiere_id') && 'La matière est requise.'}>
        <Select className={`form-select ${missing('matiere_id') ? 'is-invalid' : ''}`} value={form.matiere_id} onChange={set('matiere_id')}>
          <option value="">-- Choisir --</option>
          {matieres.map((m) => <option key={m.id} value={m.id}>{m.libelle}</option>)}
        </Select>
      </Field>
      <Field label="Enseignant" required invalid={missing('enseignant_id') && "L'enseignant est requis."}>
        <Select className={`form-select ${missing('enseignant_id') ? 'is-invalid' : ''}`} value={form.enseignant_id} onChange={set('enseignant_id')}>
          <option value="">-- Choisir --</option>
          {enseignants.map((en) => <option key={en.id} value={en.id}>{en.prenom} {en.nom}</option>)}
        </Select>
      </Field>
      <Field label="Coefficient" required className="mb-1" invalid={missing('coefficient') && 'Le coefficient est requis.'}>
        <input type="number" min="1" className={`form-control ${missing('coefficient') ? 'is-invalid' : ''}`} value={form.coefficient} onChange={set('coefficient')} />
      </Field>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { Field, IconBtn, PageHeader, StatCard, useConfirm, useToast } from '../components/ui';
import { AvecChoixClasse } from '../components/Espace';
import './notes.css';
import Select from '../components/Select';
import { SkelListe } from '../components/Skeleton';

// Portage de server/static/templates/pedagogie.html (Censeur / Surveillant) :
// affectations matière / enseignant des classes assignées. /classes/ et
// /matieres-classe/ sont déjà restreints côté serveur aux classes de la
// personne connectée.

// Choix de la classe sur des cartes, puis ses affectations.
export default function PedagogiePage() {
  return (
    <AvecChoixClasse titre="Pédagogie" icon="bx-git-branch" avecAvancement={false}>
      {({ classeId }) => <PedagogieContenu key={classeId} classeImposee={classeId} />}
    </AvecChoixClasse>
  );
}

function PedagogieContenu({ classeImposee = null }) {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { activeEtablissementId } = useAuth();

  const [data, setData] = useState({ classes: [], cycles: [], matieres: [], enseignants: [], matieresClasse: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterCycle, setFilterCycle] = useState('');
  const [filterClasse, setFilterClasse] = useState(classeImposee ? String(classeImposee) : '');
  const [modal, setModal] = useState(null); // { data, classeId }

  const loadMatieresClasse = useCallback(async () => {
    const matieresClasse = await api.get('/matieres-classe/').catch((e) => { toast(`Affectations : ${e.message}`, 'error'); return []; });
    setData((d) => ({ ...d, matieresClasse }));
  }, [toast]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    const [cycles, classes, matieres, enseignants] = await Promise.all([
      api.get('/cycles/').catch(() => []),
      api.get('/classes/').catch((e) => { setError(e.message); return []; }),
      api.get('/matieres/').catch((e) => { toast(`Matières : ${e.message}`, 'error'); return []; }),
      api.get('/enseignants/').catch((e) => { toast(`Enseignants : ${e.message}`, 'error'); return []; }),
    ]);
    setData((d) => ({ ...d, cycles, classes, matieres, enseignants }));
    await loadMatieresClasse();
    setLoading(false);
  }, [toast, loadMatieresClasse]);

  useEffect(() => {
    loadAll();
  }, [loadAll, activeEtablissementId]);

  const { classes, cycles, matieres, enseignants, matieresClasse } = data;
  const cycleLibelle = useCallback((id) => cycles.find((c) => c.id === id)?.libelle || `Cycle #${id}`, [cycles]);
  const classeLabel = useCallback((id) => {
    const c = classes.find((x) => x.id === id);
    return c ? [cycleLibelle(c.cycle_id), c.option].filter(Boolean).join(' ') || `Classe #${c.id}` : `Classe #${id}`;
  }, [classes, cycleLibelle]);
  const matiereNom = useCallback((id) => {
    const m = matieres.find((x) => x.id === id);
    return m ? (m.libelle || m.nom) : 'Matière';
  }, [matieres]);
  const enseignantNom = useCallback((id) => {
    const e = enseignants.find((x) => x.id === id);
    return e ? `${e.prenom || ''} ${e.nom || ''}`.trim() : 'Enseignant';
  }, [enseignants]);

  const classesTriees = useMemo(() => [...classes].sort((a, b) => classeLabel(a.id).localeCompare(classeLabel(b.id))), [classes, classeLabel]);
  const cyclesPresents = useMemo(() => [...new Set(classes.map((c) => c.cycle_id))].map((id) => ({ id, libelle: cycleLibelle(id) })).sort((a, b) => a.libelle.localeCompare(b.libelle)), [classes, cycleLibelle]);
  const classesAffichees = classesTriees.filter((c) => (!filterCycle || String(c.cycle_id) === filterCycle) && (!filterClasse || String(c.id) === filterClasse));

  const supprimer = async (mc) => {
    const ok = await confirm(`Retirer « ${matiereNom(mc.matiere_id)} » de cette classe ? Les cours déjà programmés sur cette affectation seront également supprimés de l'emploi du temps.`);
    if (!ok) return;
    try {
      await api.del(`/matieres-classe/${mc.id}`);
      toast('Affectation supprimée.');
      await loadMatieresClasse();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  let zone;
  if (loading) {
    zone = <div className="card"><div className="card-body"><SkelListe lignes={5} /></div></div>;
  } else if (error) {
    zone = <div className="card"><div className="card-body text-center text-danger py-4">{error}</div></div>;
  } else if (!classes.length) {
    zone = (
      <div className="card"><div className="card-body text-center text-muted py-5">
        <i className="bx bx-chalkboard bx-md d-block mb-2" />
        <div><strong>Aucune classe ne vous a été assignée pour le moment.</strong></div>
        <div className="small">Contactez l'administrateur de votre établissement pour qu'il vous assigne une ou plusieurs classes.</div>
      </div></div>
    );
  } else if (!classesAffichees.length) {
    zone = <div className="card"><div className="card-body text-center text-muted py-5"><i className="bx bx-filter-alt bx-md d-block mb-2" />Aucune classe ne correspond à ce filtre.</div></div>;
  } else {
    zone = classesAffichees.map((c) => {
      const affectations = matieresClasse.filter((mc) => mc.classe_id === c.id).sort((a, b) => matiereNom(a.matiere_id).localeCompare(matiereNom(b.matiere_id)));
      return (
        <div key={c.id} className="mb-4">
          <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
            {classeImposee
              ? <h6 className="esp-groupe-titre mb-0">Matières affectées <span>{affectations.length}</span></h6>
              : <h5 className="mb-0"><i className="bx bx-chalkboard me-2 text-primary" />{classeLabel(c.id)} <small className="text-muted fw-normal ms-2">{affectations.length} matière(s) affectée(s)</small></h5>}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ data: null, classeId: c.id })}><i className="bx bx-plus me-1" /> Ajouter une matière</button>
          </div>
          <div className="saisie-liste">
            {!affectations.length && <div className="saisie-vide">Aucune matière affectée à cette classe.</div>}
            {affectations.map((mc) => (
              <div key={mc.id} className="saisie-ligne affectation-ligne">
                <span className="badge bg-label-primary" title="Coefficient">×{mc.coefficient}</span>
                <div className="min-w-0">
                  <div className="fw-semibold text-truncate">{matiereNom(mc.matiere_id)}</div>
                  <small className="text-muted d-block text-truncate"><i className="bx bx-user me-1" />{enseignantNom(mc.enseignant_id)}</small>
                </div>
                <div className="text-nowrap">
                  <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setModal({ data: mc })} />
                  <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(mc)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    });
  }

  const modalNode = modal && (
    <AffectationModal
      data={modal.data}
      defaultClasse={modal.classeId ?? (classeImposee ? Number(classeImposee) : undefined)}
      classes={classesTriees}
      classeLabel={classeLabel}
      matieres={[...matieres].sort((a, b) => matiereNom(a.id).localeCompare(matiereNom(b.id)))}
      matiereNom={matiereNom}
      enseignants={[...enseignants].sort((a, b) => enseignantNom(a.id).localeCompare(enseignantNom(b.id)))}
      enseignantNom={enseignantNom}
      onClose={() => setModal(null)}
      onSaved={async (msg) => { setModal(null); toast(msg); await loadMatieresClasse(); }}
    />
  );

  if (classeImposee) {
    return (
      <>
        {zone}
        {modalNode}
        {confirmNode}
      </>
    );
  }

  return (
    <>
      <PageHeader title="Pédagogie" subtitle="Gérez les affectations matière / enseignant pour les classes dont vous avez la charge.">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => (classes.length ? setModal({ data: null }) : toast('Aucune classe ne vous a été assignée.', 'error'))}>
          <i className="bx bx-plus me-1" /> Nouvelle affectation
        </button>
      </PageHeader>

      <div className="row g-3 mb-4">
        <StatCard label="Classes sous ma responsabilité" loading={loading} value={classes.length} icon="bx-chalkboard" color="primary" />
        <StatCard label="Affectations matière/enseignant" loading={loading} value={matieresClasse.length} icon="bx-git-branch" color="info" />
        <StatCard label="Enseignants distincts" loading={loading} value={new Set(matieresClasse.map((mc) => mc.enseignant_id)).size} icon="bx-user-voice" color="success" />
        <StatCard label="Matières couvertes" loading={loading} value={new Set(matieresClasse.map((mc) => mc.matiere_id)).size} icon="bx-book-open" color="warning" />
      </div>

      <div className="card mb-3">
        <div className="card-body py-3 d-flex flex-wrap align-items-end gap-3">
          <div>
            <label className="form-label">Cycle</label>
            <Select className="form-select form-select-sm" style={{ minWidth: 160 }} value={filterCycle} onChange={(e) => setFilterCycle(e.target.value)}>
              <option value="">Tous mes cycles</option>
              {cyclesPresents.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
            </Select>
          </div>
          <div>
            <label className="form-label">Classe</label>
            <Select className="form-select form-select-sm" style={{ minWidth: 180 }} value={filterClasse} onChange={(e) => setFilterClasse(e.target.value)}>
              <option value="">Toutes mes classes</option>
              {classesTriees.map((c) => <option key={c.id} value={c.id}>{classeLabel(c.id)}</option>)}
            </Select>
          </div>
        </div>
      </div>

      {zone}

      {modalNode}
      {confirmNode}
    </>
  );
}

function AffectationModal({ data, defaultClasse, classes, classeLabel, matieres, matiereNom, enseignants, enseignantNom, onClose, onSaved }) {
  const [form, setForm] = useState({
    classe_id: data ? String(data.classe_id) : String(defaultClasse ?? ''),
    matiere_id: data ? String(data.matiere_id) : '',
    enseignant_id: data ? String(data.enseignant_id) : '',
    coefficient: data ? String(data.coefficient) : '',
  });
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const bad = (name) => validated && (!form[name] || (name === 'coefficient' && Number(form.coefficient) < 1));

  const submit = async () => {
    setError('');
    if (['classe_id', 'matiere_id', 'enseignant_id', 'coefficient'].some((n) => !form[n]) || Number(form.coefficient) < 1) {
      setValidated(true);
      return;
    }
    const payload = {
      classe_id: parseInt(form.classe_id, 10),
      matiere_id: parseInt(form.matiere_id, 10),
      enseignant_id: parseInt(form.enseignant_id, 10),
      coefficient: parseInt(form.coefficient, 10),
    };
    setSaving(true);
    try {
      if (data) await api.put(`/matieres-classe/${data.id}`, payload);
      else await api.post('/matieres-classe/', payload);
      await onSaved(data ? 'Affectation mise à jour.' : 'Affectation créée.');
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const select = (name, label, items, getLabel, invalid) => (
    <Field label={label} required invalid={bad(name) && invalid}>
      <Select className={`form-select ${bad(name) ? 'is-invalid' : ''}`} value={form[name]} onChange={set(name)}>
        <option value="">-- Choisir --</option>
        {items.map((x) => <option key={x.id} value={x.id}>{getLabel(x.id)}</option>)}
      </Select>
    </Field>
  );

  return (
    <Modal size="" title={<><i className={`bx ${data ? 'bx-edit-alt' : 'bx-git-branch'} me-2 text-primary`} />{data ? "Modifier l'affectation" : 'Nouvelle affectation'}</>} onClose={onClose} onSubmit={submit} footer={<><button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>Annuler</button><button type="submit" className="btn btn-primary" disabled={saving}><i className="bx bx-check me-1" /> Enregistrer</button></>}>
      {error && <div className="alert alert-danger">{error}</div>}
      {select('classe_id', 'Classe', classes, classeLabel, 'La classe est requise.')}
      {select('matiere_id', 'Matière', matieres, matiereNom, 'La matière est requise.')}
      {select('enseignant_id', 'Enseignant', enseignants, enseignantNom, "L'enseignant est requis.")}
      <Field label="Coefficient" required className="mb-1" invalid={bad('coefficient') && 'Le coefficient est requis.'}>
        <input type="number" className={`form-control ${bad('coefficient') ? 'is-invalid' : ''}`} min="1" step="1" value={form.coefficient} onChange={set('coefficient')} />
      </Field>
    </Modal>
  );
}

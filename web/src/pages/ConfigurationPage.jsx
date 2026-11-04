import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import {
  Field, formatDate, FormFooter, IconBtn, IdentifiantsModal, PageHeader, StatCard, TableCard, Tabs, TBody, useConfirm, useSave,
  useToast,
} from '../components/ui';
import Select from '../components/Select';
import ImportModal from '../components/importConfigs';
import { roleDe } from '../components/Layout';

// Portage de server/static/templates/configuration.html : années scolaires,
// trimestres, séquences, cycles, classes (structure_api.py) et
// responsables Censeurs/Surveillants (pedagogie_api.py).

export default function ConfigurationPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { user, activeEtablissementId } = useAuth();
  const peutImporter = ['Admin', 'SuperAdmin'].includes(roleDe(user));
  const [importOuvert, setImportOuvert] = useState(false);

  const [tab, setTab] = useState('annees');
  const [data, setData] = useState({ annees: [], trimestres: [], sequences: [], cycles: [], classes: [], censeurs: [], surveillants: [], censeursClasses: [], surveillantsClasses: [], roles: [] });
  const [loading, setLoading] = useState(true);
  const [anneeSel, setAnneeSel] = useState(null); // { id, libelle } — trimestres affichés
  const [trimestreSel, setTrimestreSel] = useState(null); // { id, libelle } — séquences affichées
  const [filterCycle, setFilterCycle] = useState('');
  const [modal, setModal] = useState(null); // { kind, data }
  const [identifiants, setIdentifiants] = useState(null); // { nom, code, pin, titre? }

  const loadAll = useCallback(async () => {
    setLoading(true);
    const safe = (p, onError) => api.get(p).catch((e) => { onError?.(e); return []; });
    const [annees, trimestres, sequences, cycles, classes, roles, censeurs, surveillants, censeursClasses, surveillantsClasses] = await Promise.all([
      safe('/annees-scolaires/'), safe('/trimestres/'), safe('/sequences/'), safe('/cycles/'), safe('/classes/'), safe('/auth/roles'),
      safe('/censeurs/', (e) => toast(e.message, 'error')), safe('/surveillants/', (e) => toast(e.message, 'error')),
      safe('/censeurs-classes/'), safe('/surveillants-classes/'),
    ]);
    setData({ annees, trimestres, sequences, cycles, classes, roles, censeurs, surveillants, censeursClasses, surveillantsClasses });
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    loadAll();
  }, [loadAll, activeEtablissementId]);

  const { annees, trimestres, sequences, cycles, classes, censeurs, surveillants, censeursClasses, surveillantsClasses, roles } = data;
  const cycleLibelle = (id) => cycles.find((c) => c.id === id)?.libelle || `Cycle #${id}`;
  const classeLabelCourt = (id) => {
    const c = classes.find((x) => x.id === id);
    return c ? [cycleLibelle(c.cycle_id), c.option].filter(Boolean).join(' ') : `Classe #${id}`;
  };
  const classesTriees = [...classes].sort((a, b) => classeLabelCourt(a.id).localeCompare(classeLabelCourt(b.id)));
  const anneeActive = annees.find((a) => a.active);
  const totalEffectif = classes.reduce((s, c) => s + (c.effectif || 0), 0);

  const supprimer = async (path, label) => {
    if (!(await confirm(`Supprimer « ${label} » ? Cette action est irréversible.`))) return;
    try {
      await api.del(path);
      toast('Élément supprimé.');
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // Une seule année active : le serveur désactive les autres dans la même
  // transaction (cf. structure_services._desactiver_autres_annees).
  const activerAnnee = async (a) => {
    try {
      await api.put(`/annees-scolaires/${a.id}`, { libelle: a.libelle, active: true });
      toast('Année activée.');
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  /* ── Responsables ── */
  const responsables = useMemo(() => [
    ...censeurs.map((c) => ({ ...c, _type: 'censeur' })),
    ...surveillants.map((s) => ({ ...s, _type: 'surveillant' })),
  ].sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`)), [censeurs, surveillants]);

  const liaisonsDe = (r) => (r._type === 'censeur'
    ? censeursClasses.filter((cc) => cc.censeur_id === r.id)
    : surveillantsClasses.filter((sc) => sc.surveillant_id === r.id));

  // Profil « Non relié » : crée le compte de connexion manquant puis le relie.
  const creerCompteResponsable = async (r) => {
    const roleLibelle = r._type === 'censeur' ? 'Censeur' : 'Surveillant';
    const role = roles.find((x) => x.libelle === roleLibelle);
    if (!role) {
      toast(`Rôle '${roleLibelle}' introuvable (GET /api/auth/roles).`, 'error');
      return;
    }
    const nomComplet = `${r.prenom} ${r.nom}`;
    try {
      const compte = await api.post('/auth/utilisateurs', { nom: nomComplet, email: r.email || null, role_id: role.id, etablissement_id: r.etablissement_id });
      await api.put(`/${r._type === 'censeur' ? 'censeurs' : 'surveillants'}/${r.id}`, { utilisateur_id: compte.id });
      if (compte.compte_existant) {
        toast(`Compte existant relié (code ${compte.code_connexion}) : la personne garde son code et son PIN.`);
      } else {
        setIdentifiants({ nom: nomComplet, code: compte.code_connexion, pin: compte.pin_temporaire });
        toast('Compte de connexion créé et relié.');
      }
      await loadAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const reinitialiserPin = async (r) => {
    const nomComplet = `${r.prenom} ${r.nom}`;
    const ok = await confirm(`Générer un nouveau PIN temporaire pour ${nomComplet} ? Son PIN actuel cessera de fonctionner et son compte sera débloqué. Son code de connexion (${r.code_connexion}) ne change pas.`);
    if (!ok) return;
    try {
      const compte = await api.post(`/auth/utilisateurs/${r.utilisateur_id}/reset-password`);
      setIdentifiants({ nom: nomComplet, code: compte.code_connexion, pin: compte.pin_temporaire, titre: 'Nouveau PIN temporaire' });
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const openAssignation = (r) => {
    if (!classes.length) {
      toast("Créez d'abord au moins une classe.", 'error');
      return;
    }
    setModal({ kind: 'assignation', data: r });
  };

  const openCreationResponsable = () => {
    if (!classes.length) {
      toast("Créez d'abord au moins une classe.", 'error');
      return;
    }
    setModal({ kind: 'responsable' });
  };

  const onSaved = async (msg) => {
    setModal(null);
    toast(msg);
    await loadAll();
  };

  const trimestresAnnee = anneeSel ? trimestres.filter((t) => t.annee_scolaire_id === anneeSel.id) : [];
  const sequencesTrimestre = trimestreSel ? sequences.filter((s) => s.trimestre_id === trimestreSel.id) : [];
  const classesFiltrees = filterCycle ? classes.filter((c) => String(c.cycle_id) === filterCycle) : classes;
  const addBtn = (label, onClick) => (
    <button type="button" className="btn btn-primary btn-sm" onClick={onClick}><i className="bx bx-plus me-1" /> {label}</button>
  );

  return (
    <>
      <PageHeader title="Configuration" subtitle="Paramétrez les années scolaires, trimestres, séquences, cycles et classes de votre établissement.">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={loadAll}><i className="bx bx-refresh me-1" /> Actualiser</button>
        {peutImporter && <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => setImportOuvert(true)}><i className="bx bx-import me-1" /> Importer des classes</button>}
      </PageHeader>

      <div className="row g-3 mb-4">
        <StatCard label="Années scolaires" value={loading ? null : annees.length} sub={anneeActive ? `Active : ${anneeActive.libelle}` : 'Aucune année active'} icon="bx-calendar" color="primary" />
        <StatCard label="Trimestres" value={loading ? null : trimestres.length} sub={`${sequences.length} séquence(s)`} icon="bx-calendar-week" color="info" />
        <StatCard label="Cycles" value={loading ? null : cycles.length} sub="Référentiel propre à l'établissement" icon="bx-layer" color="success" />
        <StatCard label="Classes" value={loading ? null : classes.length} sub={`${totalEffectif} élève(s) inscrit(s)`} icon="bx-chalkboard" color="warning" />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'annees', icon: 'bx-calendar', label: 'Années scolaires & Séquences' },
          { key: 'classes', icon: 'bx-chalkboard', label: 'Cycles & Classes' },
          { key: 'responsables', icon: 'bx-shield-quarter', label: 'Responsables' },
        ]}
      />

      {tab === 'annees' && (
        <>
          <div className="mb-3">
            <TableCard title="Années scolaires" icon="bx-calendar" count={annees.length} actions={addBtn('Nouvelle année', () => setModal({ kind: 'annee', data: null }))}>
              <table className="table table-hover mb-0">
                <thead><tr><th>Année scolaire</th><th>Statut</th><th>Trimestres</th><th className="text-end">Actions</th></tr></thead>
                <TBody colSpan={4} loading={loading} rows={annees.length} empty="Aucune année scolaire. Créez-en une pour commencer.">
                  {annees.map((a) => (
                    <tr key={a.id}>
                      <td><strong>{a.libelle}</strong></td>
                      <td>{a.active ? <span className="badge bg-label-success">Active</span> : <span className="badge bg-label-secondary">Inactive</span>}</td>
                      <td>{trimestres.filter((t) => t.annee_scolaire_id === a.id).length} trimestre(s)</td>
                      <td className="text-end text-nowrap">
                        <IconBtn icon="bx-calendar-week" title="Voir les trimestres" onClick={() => { setAnneeSel({ id: a.id, libelle: a.libelle }); setTrimestreSel(null); }} />
                        {!a.active && <IconBtn icon="bx-check-circle" title="Activer" onClick={() => activerAnnee(a)} />}
                        <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setModal({ kind: 'annee', data: a })} />
                        <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(`/annees-scolaires/${a.id}`, a.libelle)} />
                      </td>
                    </tr>
                  ))}
                </TBody>
              </table>
            </TableCard>
          </div>

          {anneeSel && (
            <div className="mb-3">
              <TableCard
                title={<>Trimestres — {anneeSel.libelle}</>}
                icon="bx-calendar-week"
                count={trimestresAnnee.length}
                actions={addBtn('Nouveau trimestre', () => setModal({ kind: 'trimestre', data: null }))}
              >
                <table className="table table-hover mb-0">
                  <thead><tr><th>Trimestre</th><th>Date de début</th><th>Date de fin</th><th>Séquences</th><th className="text-end">Actions</th></tr></thead>
                  <TBody colSpan={5} rows={trimestresAnnee.length} empty="Aucun trimestre pour cette année.">
                    {trimestresAnnee.map((t) => (
                      <tr key={t.id}>
                        <td><strong>{t.libelle}</strong></td>
                        <td>{formatDate(t.date_debut)}</td>
                        <td>{formatDate(t.date_fin)}</td>
                        <td>{sequences.filter((s) => s.trimestre_id === t.id).length} séquence(s)</td>
                        <td className="text-end text-nowrap">
                          <IconBtn icon="bx-list-check" title="Voir les séquences" onClick={() => setTrimestreSel({ id: t.id, libelle: t.libelle })} />
                          <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setModal({ kind: 'trimestre', data: t })} />
                          <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(`/trimestres/${t.id}`, t.libelle)} />
                        </td>
                      </tr>
                    ))}
                  </TBody>
                </table>
              </TableCard>
            </div>
          )}

          {trimestreSel && (
            <TableCard
              title={<>Séquences — {trimestreSel.libelle}</>}
              icon="bx-list-check"
              count={sequencesTrimestre.length}
              actions={addBtn('Nouvelle séquence', () => setModal({ kind: 'sequence', data: null }))}
            >
              <table className="table table-hover mb-0">
                <thead><tr><th>Séquence</th><th>Date de début</th><th>Date de fin</th><th className="text-end">Actions</th></tr></thead>
                <TBody colSpan={4} rows={sequencesTrimestre.length} empty="Aucune séquence pour ce trimestre.">
                  {sequencesTrimestre.map((s) => (
                    <tr key={s.id}>
                      <td><strong>{s.libelle}</strong></td>
                      <td>{formatDate(s.date_debut)}</td>
                      <td>{formatDate(s.date_fin)}</td>
                      <td className="text-end text-nowrap">
                        <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setModal({ kind: 'sequence', data: s })} />
                        <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(`/sequences/${s.id}`, s.libelle)} />
                      </td>
                    </tr>
                  ))}
                </TBody>
              </table>
            </TableCard>
          )}
        </>
      )}

      {tab === 'classes' && (
        <>
          <div className="mb-3">
            <TableCard title="Cycles" icon="bx-layer" count={cycles.length} actions={addBtn('Nouveau cycle', () => setModal({ kind: 'cycle', data: null }))}>
              <table className="table table-hover mb-0">
                <thead><tr><th>Libellé</th><th>Classes rattachées</th><th className="text-end">Actions</th></tr></thead>
                <TBody colSpan={3} loading={loading} rows={cycles.length} empty="Aucun cycle. Créez-en un pour pouvoir créer des classes.">
                  {cycles.map((c) => (
                    <tr key={c.id}>
                      <td><strong>{c.libelle}</strong></td>
                      <td>{classes.filter((cl) => cl.cycle_id === c.id).length} classe(s)</td>
                      <td className="text-end text-nowrap">
                        <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setModal({ kind: 'cycle', data: c })} />
                        <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(`/cycles/${c.id}`, c.libelle)} />
                      </td>
                    </tr>
                  ))}
                </TBody>
              </table>
            </TableCard>
          </div>
          <TableCard
            title="Classes"
            icon="bx-chalkboard"
            count={classes.length}
            actions={(
              <>
                <Select className="form-select form-select-sm" style={{ width: 'auto' }} value={filterCycle} onChange={(e) => setFilterCycle(e.target.value)}>
                  <option value="">Tous les cycles</option>
                  {cycles.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
                </Select>
                {addBtn('Nouvelle classe', () => (cycles.length ? setModal({ kind: 'classe', data: null }) : toast("Créez d'abord un cycle.", 'error')))}
              </>
            )}
          >
            <table className="table table-hover mb-0">
              <thead><tr><th>Cycle</th><th>Option</th><th>Effectif</th><th className="text-end">Actions</th></tr></thead>
              <TBody colSpan={4} loading={loading} rows={classesFiltrees.length} empty="Aucune classe.">
                {classesFiltrees.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{cycleLibelle(c.cycle_id)}</strong></td>
                    <td>{c.option || '—'}</td>
                    <td><span className="badge bg-label-primary">{c.effectif || 0}</span></td>
                    <td className="text-end text-nowrap">
                      <IconBtn icon="bx-edit-alt" title="Modifier" onClick={() => setModal({ kind: 'classe', data: c })} />
                      <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(`/classes/${c.id}`, `${cycleLibelle(c.cycle_id)} ${c.option || ''}`)} />
                    </td>
                  </tr>
                ))}
              </TBody>
            </table>
          </TableCard>
        </>
      )}

      {tab === 'responsables' && (
        <>
          <div className="alert alert-info mb-3 small">
            <i className="bx bx-info-circle me-1" />
            Un Censeur/Surveillant n'accède (pédagogie, emploi du temps) qu'aux classes qui lui ont été assignées ici.
            La création crée en même temps le compte de connexion : un code de connexion et un PIN temporaire sont générés et affichés une seule fois — la personne devra changer ce PIN dès sa première connexion.
            Une classe ne peut avoir qu'un seul Censeur (une classe déjà prise ne peut pas lui être réassignée tant qu'elle n'a pas été retirée d'abord), mais peut être suivie par plusieurs Surveillants.
            Un profil marqué <strong>Non relié</strong> (ex : créé avant l'existence du compte de connexion) peut être relié à tout moment via <i className="bx bx-lock-alt" />.
          </div>
          <TableCard title="Responsables" icon="bx-shield-quarter" count={responsables.length} actions={addBtn('Nouveau responsable', openCreationResponsable)}>
            <table className="table table-hover mb-0">
              <thead><tr><th>Nom</th><th>Profil</th><th>Code / email</th><th>Compte de connexion</th><th>Classes assignées</th><th className="text-end">Actions</th></tr></thead>
              <TBody colSpan={6} loading={loading} rows={responsables.length} empty="Aucun responsable (Censeur ou Surveillant) pour cet établissement.">
                {responsables.map((r) => {
                  const liaisons = liaisonsDe(r);
                  return (
                    <tr key={`${r._type}-${r.id}`}>
                      <td><strong>{r.prenom} {r.nom}</strong></td>
                      <td>{r._type === 'censeur'
                        ? <span className="badge bg-label-primary"><i className="bx bx-shield-quarter me-1" />Censeur</span>
                        : <span className="badge bg-label-secondary"><i className="bx bx-show me-1" />Surveillant</span>}</td>
                      <td>
                        {r.code_connexion && <div className="font-monospace fw-semibold">{r.code_connexion}</div>}
                        {r.email && <small className="text-muted">{r.email}</small>}
                        {!r.code_connexion && !r.email && '—'}
                      </td>
                      <td>{r.utilisateur_id
                        ? <span className="badge bg-label-success"><i className="bx bx-link" /> Relié</span>
                        : <span className="badge bg-label-warning" title="Ce profil n'est relié à aucun compte de connexion : les classes assignées ci-dessous ne seront pas encore effectives pour cette personne."><i className="bx bx-error" /> Non relié</span>}</td>
                      <td className="text-wrap">
                        {liaisons.length
                          ? liaisons.map((l) => <span key={l.id} className="badge bg-label-secondary me-1 mb-1">{classeLabelCourt(l.classe_id)}</span>)
                          : <small className="text-muted">Aucune classe assignée</small>}
                      </td>
                      <td className="text-end text-nowrap">
                        <IconBtn icon="bx-chalkboard" title="Gérer les classes" onClick={() => openAssignation(r)} />
                        {r.utilisateur_id && <IconBtn icon="bx-key" title="Réinitialiser le PIN (PIN oublié ou compte bloqué)" onClick={() => reinitialiserPin(r)} />}
                        {!r.utilisateur_id && <IconBtn icon="bx-lock-alt" title="Créer le compte de connexion" onClick={() => creerCompteResponsable(r)} />}
                      </td>
                    </tr>
                  );
                })}
              </TBody>
            </table>
          </TableCard>
        </>
      )}

      {modal?.kind === 'annee' && (
        <AnneeModal data={modal.data} onClose={() => setModal(null)} onSaved={onSaved} />
      )}
      {modal?.kind === 'trimestre' && (
        <PeriodeModal
          kind="trimestre"
          data={modal.data}
          parent={{ annee_scolaire_id: anneeSel?.id }}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
      {modal?.kind === 'sequence' && (
        <PeriodeModal
          kind="sequence"
          data={modal.data}
          parent={{ trimestre_id: trimestreSel?.id }}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
      {modal?.kind === 'cycle' && <CycleModal data={modal.data} onClose={() => setModal(null)} onSaved={onSaved} />}
      {modal?.kind === 'classe' && <ClasseModal data={modal.data} cycles={cycles} onClose={() => setModal(null)} onSaved={onSaved} />}
      {modal?.kind === 'assignation' && (
        <AssignationModal
          responsable={modal.data}
          liaisons={liaisonsDe(modal.data)}
          classes={classesTriees}
          classeLabel={classeLabelCourt}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
      {modal?.kind === 'responsable' && (
        <ResponsableModal
          classes={classesTriees}
          classeLabel={classeLabelCourt}
          classesPrisesCenseur={new Set(censeursClasses.map((cc) => cc.classe_id))}
          onClose={() => setModal(null)}
          onCreated={async (nom, result, msg) => {
            setModal(null);
            if (result.pin_temporaire) setIdentifiants({ nom, code: result.code_connexion, pin: result.pin_temporaire });
            toast(msg);
            await loadAll();
          }}
        />
      )}
      {identifiants && <IdentifiantsModal {...identifiants} destinataire="cette personne" onClose={() => setIdentifiants(null)} />}
      {importOuvert && <ImportModal module="classes" onClose={() => setImportOuvert(false)} onImported={loadAll} />}
      {confirmNode}
    </>
  );
}

function LibelleInput({ value, onChange, validated, placeholder, message = 'Le libellé est requis.', className = 'mb-3' }) {
  const bad = validated && !value.trim();
  return (
    <Field label="Libellé" required className={className} invalid={bad && message}>
      <input autoFocus type="text" className={`form-control ${bad ? 'is-invalid' : ''}`} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function AnneeModal({ data, onClose, onSaved }) {
  const [libelle, setLibelle] = useState(data?.libelle || '');
  const [active, setActive] = useState(Boolean(data?.active));
  const [validated, setValidated] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const submit = async () => {
    if (!libelle.trim()) return setValidated(true);
    setSaving(true);
    try {
      const payload = { libelle: libelle.trim(), active };
      if (data) await api.put(`/annees-scolaires/${data.id}`, payload);
      else await api.post('/annees-scolaires/', payload);
      await onSaved(data ? 'Année scolaire mise à jour.' : 'Année scolaire créée.');
    } catch (err) {
      toast(err.message, 'error');
      setSaving(false);
    }
    return undefined;
  };

  return (
    <Modal size="" title={<><i className="bx bx-calendar me-2 text-primary" />{data ? "Modifier l'année scolaire" : 'Nouvelle année scolaire'}</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} />}>
      <LibelleInput value={libelle} onChange={setLibelle} validated={validated} placeholder="Ex : 2025-2026" message="Le libellé est requis (ex : 2025-2026)." />
      <div className="form-check">
        <input className="form-check-input" type="checkbox" id="anneeActive" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <label className="form-check-label" htmlFor="anneeActive">Définir comme année active</label>
      </div>
      <p className="text-muted mb-0 mt-2 small">Activer cette année désactivera automatiquement les autres années actives de l'établissement.</p>
    </Modal>
  );
}

function PeriodeModal({ kind, data, parent, onClose, onSaved }) {
  const isTrimestre = kind === 'trimestre';
  const [form, setForm] = useState({ libelle: data?.libelle || '', date_debut: data?.date_debut || '', date_fin: data?.date_fin || '' });
  const [validated, setValidated] = useState(false);
  const [save, saving] = useSave(onSaved);

  const submit = () => {
    if (!form.libelle.trim()) return setValidated(true);
    return save(isTrimestre ? '/trimestres/' : '/sequences/', data?.id, {
      ...parent,
      libelle: form.libelle.trim(),
      date_debut: form.date_debut || null,
      date_fin: form.date_fin || null,
    }, isTrimestre ? ['Trimestre créé.', 'Trimestre mis à jour.'] : ['Séquence créée.', 'Séquence mise à jour.']);
  };

  const title = isTrimestre ? (data ? 'Modifier le trimestre' : 'Nouveau trimestre') : (data ? 'Modifier la séquence' : 'Nouvelle séquence');
  return (
    <Modal size="" title={<><i className={`bx ${isTrimestre ? 'bx-calendar-week' : 'bx-list-check'} me-2 text-primary`} />{title}</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} />}>
      <LibelleInput value={form.libelle} onChange={(v) => setForm((f) => ({ ...f, libelle: v }))} validated={validated} placeholder={isTrimestre ? 'Ex : 1er trimestre' : 'Ex : Séquence 1'} />
      <div className="row g-3">
        <div className="col-md-6"><label className="form-label">Date de début</label><input type="date" className="form-control" value={form.date_debut} onChange={(e) => setForm((f) => ({ ...f, date_debut: e.target.value }))} /></div>
        <div className="col-md-6"><label className="form-label">Date de fin</label><input type="date" className="form-control" value={form.date_fin} onChange={(e) => setForm((f) => ({ ...f, date_fin: e.target.value }))} /></div>
      </div>
    </Modal>
  );
}

function CycleModal({ data, onClose, onSaved }) {
  const [libelle, setLibelle] = useState(data?.libelle || '');
  const [validated, setValidated] = useState(false);
  const [save, saving] = useSave(onSaved);
  const submit = () => (libelle.trim() ? save('/cycles/', data?.id, { libelle: libelle.trim() }, ['Cycle créé.', 'Cycle mis à jour.']) : setValidated(true));
  return (
    <Modal size="" title={<><i className="bx bx-layer me-2 text-primary" />{data ? 'Modifier le cycle' : 'Nouveau cycle'}</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} />}>
      <LibelleInput className="mb-1" value={libelle} onChange={setLibelle} validated={validated} placeholder="Ex : 1er cycle" />
    </Modal>
  );
}

function ClasseModal({ data, cycles, onClose, onSaved }) {
  const [cycleId, setCycleId] = useState(data ? String(data.cycle_id) : '');
  const [option, setOption] = useState(data?.option || '');
  const [validated, setValidated] = useState(false);
  const [save, saving] = useSave(onSaved);
  const submit = () => (cycleId
    ? save('/classes/', data?.id, { cycle_id: parseInt(cycleId, 10), option: option.trim() || null }, ['Classe créée.', 'Classe mise à jour.'])
    : setValidated(true));
  return (
    <Modal size="" title={<><i className="bx bx-chalkboard me-2 text-primary" />{data ? 'Modifier la classe' : 'Nouvelle classe'}</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} />}>
      <Field label="Cycle" required invalid={validated && !cycleId && 'Le cycle est requis.'}>
        <Select className={`form-select ${validated && !cycleId ? 'is-invalid' : ''}`} value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
          <option value="">-- Choisir --</option>
          {cycles.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
        </Select>
      </Field>
      <Field label="Option" className="mb-1">
        <input type="text" className="form-control" placeholder="Ex : 6ème A, Terminale C…" value={option} onChange={(e) => setOption(e.target.value)} />
      </Field>
      <p className="text-muted mb-0 mt-2 small">L'effectif est calculé automatiquement à partir des inscriptions actives ; il n'est pas modifiable ici.</p>
    </Modal>
  );
}

function AssignationModal({ responsable: r, liaisons, classes, classeLabel, onClose, onSaved }) {
  const toast = useToast();
  const actuelles = new Map(liaisons.map((l) => [l.classe_id, l.id]));
  const [cochees, setCochees] = useState(() => new Set(actuelles.keys()));
  const [saving, setSaving] = useState(false);
  const isCenseur = r._type === 'censeur';

  const toggle = (id) => setCochees((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    const basePath = isCenseur ? '/censeurs-classes/' : '/surveillants-classes/';
    const cle = isCenseur ? 'censeur_id' : 'surveillant_id';
    setSaving(true);
    try {
      for (const classeId of [...cochees].filter((id) => !actuelles.has(id))) {
        await api.post(basePath, { [cle]: r.id, classe_id: classeId });
      }
      for (const [classeId, liaisonId] of actuelles.entries()) {
        if (!cochees.has(classeId)) await api.del(`${basePath}${liaisonId}`);
      }
      await onSaved('Classes mises à jour.');
    } catch (err) {
      toast(err.message, 'error');
      setSaving(false);
    }
  };

  return (
    <Modal size="" title={<><i className="bx bx-chalkboard me-2 text-primary" />Classes de {r.prenom} {r.nom}</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} />}>
      <p className="text-muted mb-2 small">Cochez les classes dont cette personne a la charge. Elle n'aura accès (pédagogie, emploi du temps) qu'aux classes cochées ici.</p>
      <div className="border rounded p-2" style={{ maxHeight: 320, overflowY: 'auto' }}>
        {classes.map((c) => (
          <div key={c.id} className="form-check">
            <input className="form-check-input" type="checkbox" id={`assignClasse${c.id}`} checked={cochees.has(c.id)} onChange={() => toggle(c.id)} />
            <label className="form-check-label" htmlFor={`assignClasse${c.id}`}>{classeLabel(c.id)}</label>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ResponsableModal({ classes, classeLabel, classesPrisesCenseur, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ type: 'censeur', prenom: '', nom: '', email: '', telephone: '', codeExistant: '' });
  const [cochees, setCochees] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  // Une classe = un seul censeur : les classes déjà prises sont désactivées.
  const prises = form.type === 'censeur' ? classesPrisesCenseur : new Set();

  const toggle = (id) => setCochees((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    if (!form.prenom.trim() || !form.nom.trim()) {
      toast('Le prénom et le nom sont requis.', 'error');
      return;
    }
    if (form.codeExistant && form.codeExistant.length !== 4) {
      toast('Le code de connexion comporte 4 caractères.', 'error');
      return;
    }
    const payload = {
      prenom: form.prenom.trim(),
      nom: form.nom.trim(),
      email: form.email.trim() || null,
      code_existant: form.codeExistant || undefined,
      telephone: form.telephone.trim() || null,
      classe_ids: [...cochees].filter((id) => !prises.has(id)),
    };
    setSaving(true);
    try {
      const result = await api.post(form.type === 'censeur' ? '/censeurs/creer-avec-compte' : '/surveillants/creer-avec-compte', payload);
      const libelle = `${form.type === 'censeur' ? 'Censeur' : 'Surveillant'} créé.`;
      await onCreated(`${payload.prenom} ${payload.nom}`, result, result.compte_existant ? `${libelle} Rôle ajouté au compte existant : la personne garde son code et son PIN.` : libelle);
    } catch (err) {
      toast(err.message, 'error');
      setSaving(false);
    }
  };

  return (
    <Modal size="" title={<><i className="bx bx-user-plus me-2 text-primary" />Nouveau responsable</>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} label="Créer" />}>
      <div className="mb-3">
        <label className="form-label">Profil *</label>
        <Select className="form-select" value={form.type} onChange={set('type')}>
          <option value="censeur">Censeur</option>
          <option value="surveillant">Surveillant</option>
        </Select>
        <p className="text-muted mb-0 mt-1 small">Une classe ne peut avoir qu'un seul Censeur, mais peut être suivie par plusieurs Surveillants.</p>
      </div>
      <div className="row g-3">
        <div className="col-md-6"><label className="form-label">Prénom</label><input type="text" className="form-control" value={form.prenom} onChange={set('prenom')} required /></div>
        <div className="col-md-6"><label className="form-label">Nom</label><input type="text" className="form-control" value={form.nom} onChange={set('nom')} required /></div>
        <div className="col-md-6"><label className="form-label">Email <span className="text-muted small">(facultatif)</span></label><input type="email" className="form-control" value={form.email} onChange={set('email')} /></div>
        <div className="col-md-6"><label className="form-label">Téléphone</label><input type="text" className="form-control" value={form.telephone} onChange={set('telephone')} /></div>
        <div className="col-12">
          <label className="form-label">A déjà un compte dans l'établissement ? <span className="text-muted small">(facultatif)</span></label>
          <input
            type="text"
            className="form-control font-monospace text-uppercase"
            placeholder="Son code de connexion, ex : K7TB"
            maxLength={4}
            value={form.codeExistant}
            onChange={(e) => setForm((f) => ({ ...f, codeExistant: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) }))}
          />
          <p className="text-muted mb-0 mt-1 small">Ex : un enseignant nommé censeur. Il garde son code et son PIN, et reçoit en plus ce nouvel espace.</p>
        </div>
      </div>
      <label className="form-label mt-3 mb-1">Classes à assigner <span className="text-muted small">(optionnel, modifiable plus tard)</span></label>
      <div className="border rounded p-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
        {classes.map((c) => {
          const prise = prises.has(c.id);
          return (
            <div key={c.id} className="form-check">
              <input className="form-check-input" type="checkbox" id={`creationClasse${c.id}`} disabled={prise} checked={!prise && cochees.has(c.id)} onChange={() => toggle(c.id)} />
              <label className={`form-check-label ${prise ? 'text-muted' : ''}`} htmlFor={`creationClasse${c.id}`}>
                {classeLabel(c.id)} {prise && <small>(déjà un censeur)</small>}
              </label>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

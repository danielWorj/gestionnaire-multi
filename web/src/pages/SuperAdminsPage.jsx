import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';
import { fmtHorodatage } from '../components/Historique';
import { PageHeader, TBody, TableCard, copyText, initiales, useConfirm, useToast } from '../components/ui';

// Comptes d'administration de la plateforme (cf. /api/superadmin/comptes).
// Le mot de passe est généré par le serveur et affiché une seule fois ; le
// SuperAdmin le change ensuite lui-même (« Changer le mot de passe »).
// Garde-fous serveur : pas de désactivation de soi-même, toujours au moins
// un compte actif, réinitialisation réservée aux AUTRES comptes.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SuperAdminsPage() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [comptes, setComptes] = useState(null);
  const [erreur, setErreur] = useState('');
  const [formulaire, setFormulaire] = useState(null); // { compte } (null = création)
  const [acces, setAcces] = useState(null); // { nom, email, mot_de_passe, titre }
  const [occupe, setOccupe] = useState(null);

  const charger = useCallback(async () => {
    setErreur('');
    try {
      setComptes(await api.get('/superadmin/comptes'));
    } catch (e) {
      setErreur(e.message);
      setComptes([]);
    }
  }, []);

  useEffect(() => { charger(); }, [charger]);

  const actifs = (comptes || []).filter((c) => c.actif).length;
  const estMoi = (c) => c.id === user?.id;

  const action = async (c, travail) => {
    setOccupe(c.id);
    try {
      await travail();
      await charger();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setOccupe(null);
    }
  };

  const reinitialiser = async (c) => {
    const ok = await confirm(<>Générer un nouveau mot de passe pour <strong>{c.nom}</strong> ?</>, {
      title: 'Réinitialiser le mot de passe', icon: 'bx-key', danger: false, confirmLabel: 'Réinitialiser', confirmIcon: 'bx-refresh',
      details: 'Son mot de passe actuel cessera de fonctionner et toutes ses sessions sont fermées.',
    });
    if (!ok) return;
    await action(c, async () => {
      const r = await api.post(`/superadmin/comptes/${c.id}/reinitialiser`);
      setAcces({ nom: r.nom, email: r.email, mot_de_passe: r.mot_de_passe, titre: 'Nouveau mot de passe' });
    });
  };

  const basculerActif = async (c) => {
    if (c.actif) {
      const ok = await confirm(<>Désactiver le compte SuperAdmin de <strong>{c.nom}</strong> ?</>, {
        title: 'Désactiver un SuperAdmin', icon: 'bx-block', confirmLabel: 'Désactiver', confirmIcon: 'bx-block',
        details: "Il perd immédiatement l'accès à la plateforme. Le compte est conservé et pourra être réactivé.",
      });
      if (!ok) return;
    }
    await action(c, async () => {
      await api.put(`/superadmin/comptes/${c.id}`, { actif: !c.actif });
      toast(`${c.nom} a été ${c.actif ? 'désactivé' : 'réactivé'}.`);
    });
  };

  return (
    <>
      <PageHeader title="Comptes SuperAdmin" subtitle="Personnes qui administrent l'ensemble de la plateforme">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormulaire({ compte: null })}>
          <i className="bx bx-plus me-1" />Nouveau SuperAdmin
        </button>
      </PageHeader>

      <div className="alert alert-info d-flex gap-2 small">
        <i className="bx bx-shield-quarter mt-1" />
        <div>
          Un SuperAdmin voit et modifie <strong>tous les établissements</strong>. Ne créez ce type de compte que pour les responsables de la plateforme.
          Il doit toujours rester au moins un SuperAdmin actif.
        </div>
      </div>

      <TableCard title="SuperAdmins" icon="bx-shield-quarter" count={comptes ? `${actifs} actif${actifs > 1 ? 's' : ''}` : undefined}>
        <table className="table table-hover align-middle mb-0">
          <thead>
            <tr><th>Compte</th><th>Email</th><th>Statut</th><th>Dernière connexion</th><th className="text-end">Actions</th></tr>
          </thead>
          <TBody colSpan={5} loading={comptes === null} error={erreur} rows={comptes?.length} empty="Aucun compte.">
            {(comptes || []).map((c) => (
              <tr key={c.id} className={c.actif ? '' : 'text-muted'}>
                <td>
                  <div className="d-flex align-items-center gap-2">
                    <div className="avatar avatar-sm flex-shrink-0"><span className={`avatar-initial rounded-circle ${c.actif ? 'bg-label-primary' : 'bg-label-secondary'}`}>{initiales(c.nom)}</span></div>
                    <span className="fw-semibold">{c.nom}</span>
                    {estMoi(c) && <span className="badge bg-label-info">Vous</span>}
                  </div>
                </td>
                <td>{c.email}</td>
                <td><span className={`badge ${c.actif ? 'bg-label-success' : 'bg-label-secondary'}`}>{c.actif ? 'Actif' : 'Désactivé'}</span></td>
                <td className="small">{c.dernier_login ? fmtHorodatage(c.dernier_login) : <span className="text-warning">Jamais</span>}</td>
                <td className="text-end">
                  {occupe === c.id ? <span className="spinner-border spinner-border-sm text-primary" /> : (
                    <>
                      <button type="button" className="btn btn-sm btn-icon btn-outline-secondary" title="Modifier" onClick={() => setFormulaire({ compte: c })}><i className="bx bx-edit-alt" /></button>
                      <button type="button" className="btn btn-sm btn-icon btn-outline-secondary ms-1" title={estMoi(c) ? 'Utilisez « Changer le mot de passe » dans votre menu' : 'Réinitialiser le mot de passe'} onClick={() => reinitialiser(c)} disabled={estMoi(c) || !c.actif}><i className="bx bx-key" /></button>
                      {c.actif
                        ? <button type="button" className="btn btn-sm btn-icon btn-outline-danger ms-1" title={estMoi(c) ? 'Vous ne pouvez pas désactiver votre propre compte' : 'Désactiver'} onClick={() => basculerActif(c)} disabled={estMoi(c) || actifs <= 1}><i className="bx bx-block" /></button>
                        : <button type="button" className="btn btn-sm btn-outline-success ms-1" onClick={() => basculerActif(c)}><i className="bx bx-check-circle me-1" />Réactiver</button>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </TBody>
        </table>
      </TableCard>

      {formulaire && (
        <SuperAdminFormModal
          compte={formulaire.compte}
          onClose={() => setFormulaire(null)}
          onSaved={async (r) => {
            setFormulaire(null);
            if (r.mot_de_passe) setAcces({ nom: r.nom, email: r.email, mot_de_passe: r.mot_de_passe, titre: 'SuperAdmin créé' });
            else toast('Compte modifié.');
            // Son propre compte : nom et email à jour tout de suite dans l'en-tête.
            if (r.id === user?.id) await refreshUser();
            await charger();
          }}
        />
      )}
      {acces && <AccesModal {...acces} onClose={() => setAcces(null)} />}
      {confirmNode}
    </>
  );
}

function SuperAdminFormModal({ compte, onClose, onSaved }) {
  const toast = useToast();
  const creation = !compte;
  const [form, setForm] = useState({ nom: compte?.nom || '', email: compte?.email || '' });
  const [erreurs, setErreurs] = useState({});
  const [enregistrement, setEnregistrement] = useState(false);

  const enregistrer = async () => {
    const e = {};
    if (!form.nom.trim()) e.nom = 'Le nom est requis.';
    if (!EMAIL_RE.test(form.email.trim())) e.email = 'Saisissez un email valide.';
    setErreurs(e);
    if (Object.keys(e).length) return;
    setEnregistrement(true);
    const payload = { nom: form.nom.trim(), email: form.email.trim() };
    try {
      const r = creation ? await api.post('/superadmin/comptes', payload) : await api.put(`/superadmin/comptes/${compte.id}`, payload);
      await onSaved(r);
    } catch (err) {
      if (err.status === 409) setErreurs({ email: err.message });
      else toast(err.message, 'error');
      setEnregistrement(false);
    }
  };

  return (
    <Modal
      size=""
      title={creation ? 'Nouveau SuperAdmin' : 'Modifier le SuperAdmin'}
      onClose={onClose}
      onSubmit={enregistrer}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={enregistrement}>
            {enregistrement ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-check me-1" />}
            {creation ? 'Créer' : 'Enregistrer'}
          </button>
        </>
      )}
    >
      <div className="mb-3">
        <label className="form-label" htmlFor="sa-nom">Nom complet *</label>
        <input id="sa-nom" type="text" className={`form-control ${erreurs.nom ? 'is-invalid' : ''}`} value={form.nom} onChange={(e) => setForm((f) => ({ ...f, nom: e.target.value }))} autoFocus />
        {erreurs.nom && <div className="invalid-feedback">{erreurs.nom}</div>}
      </div>
      <div className="mb-1">
        <label className="form-label" htmlFor="sa-email">Email (identifiant de connexion) *</label>
        <input id="sa-email" type="email" className={`form-control ${erreurs.email ? 'is-invalid' : ''}`} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} autoComplete="off" />
        {erreurs.email && <div className="invalid-feedback">{erreurs.email}</div>}
      </div>
      {creation && <div className="form-text">Un mot de passe est généré automatiquement et affiché une seule fois après la création.</div>}
    </Modal>
  );
}

function AccesModal({ nom, email, mot_de_passe: motDePasse, titre, onClose }) {
  const toast = useToast();
  return (
    <Modal
      size=""
      title={<><i className="bx bx-key me-2 text-primary" />{titre}</>}
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary btn-sm" onClick={onClose}><i className="bx bx-check me-1" /> J'ai noté, fermer</button>}
    >
      <div className="alert alert-warning d-flex align-items-start gap-2 py-2 mb-3 small">
        <i className="bx bx-error mt-1" />
        <div>Ce mot de passe ne sera plus affiché après la fermeture de cette fenêtre. Transmettez-le à {nom} par un canal sûr ; il pourra le changer depuis son menu.</div>
      </div>
      <div className="fiche-acces">
        <div className="fw-semibold mb-2">{nom}</div>
        <div className="fiche-acces-ligne"><span className="fiche-acces-etiquette">Email</span><span className="fiche-acces-valeur">{email}</span></div>
        <div className="fiche-acces-ligne"><span className="fiche-acces-etiquette">Mot de passe</span><span className="fiche-acces-valeur font-monospace">{motDePasse}</span></div>
        <div className="small text-muted mt-2">Connexion par la page d'accès SuperAdmin (/superadmin/login).</div>
      </div>
      <button type="button" className="btn btn-outline-primary btn-sm w-100 mt-3" onClick={() => copyText(`Email : ${email}\nMot de passe : ${motDePasse}`, 'Les identifiants', toast)}>
        <i className="bx bx-copy me-1" /> Copier les identifiants
      </button>
    </Modal>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';
import { ROLES_SANS_ESPACE, roleInfo } from '../lib/espaces';
import Modal from './Modal';
import { IdentifiantsModal, useConfirm, useToast } from './ui';

// Gestion des administrateurs d'un établissement (SuperAdmin uniquement, cf.
// /api/auth/utilisateurs) : liste, ajout, modification (nom, email
// facultatif, rôles cumulés), réinitialisation du PIN, désactivation /
// réactivation. Chaque compte se connecte avec son code + son PIN.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rôles qui ouvrent un espace lié à une fiche métier : la fiche se crée côté
// établissement (en indiquant le code de ce compte), sinon l'espace reste vide.
const ROLES_AVEC_FICHE = {
  Enseignant: 'la fiche enseignant (page Enseignants)',
  Censeur: 'la fiche censeur (page Configuration)',
  Surveillant: 'la fiche surveillant (page Configuration)',
};

function formatDateHeure(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statutAdmin(a) {
  if (!a.actif) return { label: 'Désactivé', cls: 'bg-label-secondary' };
  if (a.verrouille) return { label: 'Bloqué (PIN faux)', cls: 'bg-label-danger' };
  return { label: 'Actif', cls: 'bg-label-success' };
}

function initiales(nom) {
  const parts = (nom || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export default function AdministrateursModal({ etab, onClose }) {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [admins, setAdmins] = useState(null);
  const [roles, setRoles] = useState([]);
  const [erreur, setErreur] = useState('');
  const [formulaire, setFormulaire] = useState(null); // { admin } (admin null = ajout)
  const [identifiants, setIdentifiants] = useState(null); // { nom, code, pin, titre }
  const [occupe, setOccupe] = useState(null); // id de l'admin en cours d'action
  const modifie = useRef(false);

  const charger = useCallback(async () => {
    setErreur('');
    try {
      const [liste, tousRoles] = await Promise.all([
        apiRequest(`/auth/utilisateurs?etablissement_id=${etab.id}&role=Admin`),
        apiRequest('/auth/roles'),
      ]);
      setAdmins([...liste].sort((a, b) => Number(b.actif) - Number(a.actif) || a.nom.localeCompare(b.nom, 'fr')));
      setRoles(tousRoles);
    } catch (e) {
      setErreur(e.message);
      setAdmins([]);
    }
  }, [etab.id]);

  useEffect(() => { charger(); }, [charger]);

  const apresChangement = async (message) => {
    modifie.current = true;
    if (message) toast(message);
    await charger();
  };

  const actifs = (admins || []).filter((a) => a.actif);
  const dernierActif = (a) => a.actif && actifs.length === 1;

  const reinitialiser = async (a) => {
    const ok = await confirm(<>Générer un nouveau PIN pour <strong>{a.nom}</strong> ?</>, {
      title: 'Réinitialiser le PIN', icon: 'bx-key', danger: false, confirmLabel: 'Réinitialiser', confirmIcon: 'bx-refresh',
      details: "Son PIN actuel cessera de fonctionner, son compte est débloqué et sa session en cours fermée. Son code de connexion ne change pas. Il pourra ensuite changer ce PIN depuis son espace s'il le souhaite.",
    });
    if (!ok) return;
    setOccupe(a.id);
    try {
      const r = await apiRequest(`/auth/utilisateurs/${a.id}/reset-password`, { method: 'POST' });
      setIdentifiants({ nom: r.nom, code: r.code_connexion, pin: r.pin_temporaire, titre: 'Nouveau PIN' });
      await apresChangement();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setOccupe(null);
    }
  };

  const basculerActif = async (a) => {
    if (a.actif) {
      const ok = await confirm(<>Désactiver le compte de <strong>{a.nom}</strong> ?</>, {
        title: 'Désactiver un administrateur', icon: 'bx-block', confirmLabel: 'Désactiver', confirmIcon: 'bx-block',
        details: dernierActif(a)
          ? "C'est le dernier administrateur actif de cet établissement : plus personne ne pourra le gérer sur place tant qu'un autre administrateur n'est pas ajouté ou réactivé."
          : 'Sa session est fermée immédiatement. Le compte est conservé et pourra être réactivé.',
      });
      if (!ok) return;
    }
    setOccupe(a.id);
    try {
      if (a.actif) {
        await apiRequest(`/auth/utilisateurs/${a.id}`, { method: 'DELETE' });
        await apresChangement(`${a.nom} a été désactivé.`);
      } else {
        await apiRequest(`/auth/utilisateurs/${a.id}`, { method: 'PUT', body: JSON.stringify({ actif: true }) });
        await apresChangement(`${a.nom} a été réactivé.`);
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setOccupe(null);
    }
  };

  return (
    <>
      <Modal
        size="modal-lg"
        title={<><i className="bx bx-shield-quarter me-2 text-primary" />Administrateurs</>}
        subtitle={etab.nom}
        onClose={() => onClose(modifie.current)}
        footer={(
          <>
            <button type="button" className="btn btn-outline-secondary" onClick={() => onClose(modifie.current)}>Fermer</button>
            <button type="button" className="btn btn-primary" onClick={() => setFormulaire({ admin: null })} disabled={admins === null}>
              <i className="bx bx-plus me-1" /> Ajouter un administrateur
            </button>
          </>
        )}
      >
        {erreur && <div className="alert alert-danger">{erreur}</div>}
        {admins !== null && !erreur && actifs.length === 0 && (
          <div className="alert alert-warning d-flex gap-2"><i className="bx bx-error mt-1" /><div>Cet établissement n'a <strong>aucun administrateur actif</strong> : personne ne peut le gérer sur place.</div></div>
        )}

        {admins === null ? (
          <div className="text-center text-muted py-4"><span className="spinner-border spinner-border-sm me-2" />Chargement…</div>
        ) : admins.length === 0 ? (
          <div className="text-center text-muted py-4">
            <i className="bx bx-user-plus bx-md d-block mb-2" />
            Aucun administrateur pour cet établissement.
          </div>
        ) : (
          <div className="list-group">
            {admins.map((a) => {
              const statut = statutAdmin(a);
              const autresRoles = a.roles.filter((r) => r.libelle !== 'Admin');
              const connexion = formatDateHeure(a.dernier_login);
              return (
                <div key={a.id} className={`list-group-item admin-ligne ${a.actif ? '' : 'admin-inactif'}`}>
                  <div className="avatar flex-shrink-0">
                    <span className={`avatar-initial rounded-circle ${a.actif ? 'bg-label-primary' : 'bg-label-secondary'}`}>{initiales(a.nom)}</span>
                  </div>
                  <div className="admin-infos">
                    <div className="d-flex flex-wrap align-items-center gap-2">
                      <span className="fw-semibold">{a.nom}</span>
                      <span className={`badge ${statut.cls}`}>{statut.label}</span>
                    </div>
                    <div className="text-muted small text-truncate">
                      Code <span className="font-monospace fw-semibold text-body">{a.code_connexion}</span>{a.email && <> · {a.email}</>}
                    </div>
                    <div className="d-flex flex-wrap gap-1 mt-1">
                      {autresRoles.map((r) => (
                        <span key={r.id} className={`badge bg-label-${roleInfo(r.libelle).color}`} title="Rôle cumulé">
                          <i className={`bx ${roleInfo(r.libelle).icon} me-1`} />{roleInfo(r.libelle).label}
                        </span>
                      ))}
                      <small className="text-muted">
                        <i className="bx bx-time-five me-1" />{connexion ? `Dernière connexion : ${connexion}` : 'Jamais connecté'}
                      </small>
                    </div>
                  </div>
                  <div className="admin-actions">
                    {occupe === a.id ? <span className="spinner-border spinner-border-sm text-primary" /> : (
                      <>
                        <button type="button" className="btn btn-sm btn-icon btn-outline-secondary" title="Modifier" aria-label={`Modifier ${a.nom}`} onClick={() => setFormulaire({ admin: a })}><i className="bx bx-edit-alt" /></button>
                        <button type="button" className="btn btn-sm btn-icon btn-outline-secondary" title="Réinitialiser le PIN" aria-label={`Réinitialiser le PIN de ${a.nom}`} onClick={() => reinitialiser(a)} disabled={!a.actif}><i className="bx bx-key" /></button>
                        {a.actif
                          ? <button type="button" className="btn btn-sm btn-icon btn-outline-danger" title="Désactiver" aria-label={`Désactiver ${a.nom}`} onClick={() => basculerActif(a)}><i className="bx bx-block" /></button>
                          : <button type="button" className="btn btn-sm btn-outline-success" onClick={() => basculerActif(a)}><i className="bx bx-check-circle me-1" />Réactiver</button>}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="small text-muted mt-3 mb-0">
          <i className="bx bx-info-circle me-1" />Un administrateur peut aussi avoir d'autres rôles (ex : Enseignant) : il choisit alors son espace à la connexion.
        </p>
      </Modal>

      {formulaire && (
        <AdminFormModal
          etab={etab}
          admin={formulaire.admin}
          roles={roles}
          estDernierActif={formulaire.admin ? dernierActif(formulaire.admin) : false}
          onClose={() => setFormulaire(null)}
          onSaved={async ({ message, identifiants: ids }) => {
            setFormulaire(null);
            if (ids) setIdentifiants(ids);
            await apresChangement(message);
          }}
        />
      )}

      {identifiants && (
        <IdentifiantsModal
          nom={identifiants.nom}
          code={identifiants.code}
          pin={identifiants.pin}
          titre={identifiants.titre}
          destinataire="l'administrateur"
          onClose={() => setIdentifiants(null)}
        />
      )}
      {confirmNode}
    </>
  );
}

function AdminFormModal({ etab, admin, roles, estDernierActif, onClose, onSaved }) {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const creation = !admin;
  const roleAdmin = roles.find((r) => r.libelle === 'Admin');
  const [form, setForm] = useState(() => ({
    nom: admin?.nom || '',
    email: admin?.email || '',
    codeExistant: '',
    roleIds: new Set(admin ? admin.roles.map((r) => r.id) : roleAdmin ? [roleAdmin.id] : []),
  }));
  const [erreurs, setErreurs] = useState({});
  const [enregistrement, setEnregistrement] = useState(false);

  const basculerRole = (id) => setForm((f) => {
    const roleIds = new Set(f.roleIds);
    if (roleIds.has(id)) roleIds.delete(id);
    else roleIds.add(id);
    return { ...f, roleIds };
  });

  const rolesCoches = roles.filter((r) => form.roleIds.has(r.id));
  const ficheRequise = rolesCoches.filter((r) => ROLES_AVEC_FICHE[r.libelle] && !admin?.roles.some((x) => x.id === r.id));
  const retireAdmin = !creation && roleAdmin && !form.roleIds.has(roleAdmin.id);

  const valider = () => {
    const e = {};
    if (!form.nom.trim() && !form.codeExistant) e.nom = 'Le nom est requis.';
    if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) e.email = 'Saisissez un email valide, ou laissez le champ vide.';
    if (form.codeExistant && form.codeExistant.length !== 4) e.codeExistant = 'Le code comporte 4 caractères.';
    if (!form.roleIds.size) e.roles = 'Au moins un rôle est requis.';
    setErreurs(e);
    return !Object.keys(e).length;
  };

  const enregistrer = async () => {
    if (!valider()) return;
    if (retireAdmin) {
      const ok = await confirm(<>Retirer le rôle Administrateur à <strong>{admin.nom}</strong> ?</>, {
        title: 'Retirer le rôle Administrateur', icon: 'bx-shield-x', confirmLabel: 'Retirer', confirmIcon: 'bx-shield-x',
        details: estDernierActif
          ? "C'est le dernier administrateur actif de cet établissement. Il disparaîtra de cette liste et gardera seulement ses autres rôles."
          : 'Il disparaîtra de cette liste et gardera seulement ses autres rôles.',
      });
      if (!ok) return;
    }
    setEnregistrement(true);
    const payload = { nom: form.nom.trim(), email: form.email.trim() || null, role_ids: [...form.roleIds] };
    try {
      if (creation) {
        const r = await apiRequest('/auth/utilisateurs', {
          method: 'POST',
          body: JSON.stringify({ ...payload, etablissement_id: etab.id, code_existant: form.codeExistant || undefined }),
        });
        if (r.compte_existant) {
          await onSaved({ message: `${r.nom} avait déjà un compte dans cet établissement : il devient administrateur et garde son code et son PIN.` });
        } else {
          await onSaved({ message: 'Administrateur ajouté.', identifiants: { nom: r.nom, code: r.code_connexion, pin: r.pin_temporaire, titre: 'Administrateur créé' } });
        }
      } else {
        await apiRequest(`/auth/utilisateurs/${admin.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        await onSaved({ message: 'Administrateur modifié.' });
      }
    } catch (e) {
      if (e.status === 409) setErreurs({ email: e.message });
      else if (form.codeExistant && e.status === 400) setErreurs({ codeExistant: e.message });
      else toast(e.message, 'error');
      setEnregistrement(false);
    }
  };

  return (
    <>
      <Modal
        size=""
        title={creation ? 'Ajouter un administrateur' : "Modifier l'administrateur"}
        subtitle={etab.nom}
        onClose={onClose}
        onSubmit={enregistrer}
        footer={(
          <>
            <button type="button" className="btn btn-outline-secondary" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn btn-primary" disabled={enregistrement}>
              {enregistrement ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-check me-1" />}
              {creation ? 'Ajouter' : 'Enregistrer'}
            </button>
          </>
        )}
      >
        {creation && (
          <div className="mb-3">
            <label className="form-label" htmlFor="admin-code">A déjà un compte dans l'établissement ? <span className="text-muted fw-normal">(facultatif)</span></label>
            <input
              id="admin-code"
              type="text"
              className={`form-control font-monospace text-uppercase ${erreurs.codeExistant ? 'is-invalid' : ''}`}
              placeholder="Son code de connexion, ex : K7TB"
              maxLength={4}
              value={form.codeExistant}
              onChange={(e) => setForm((f) => ({ ...f, codeExistant: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) }))}
              autoComplete="off"
            />
            {erreurs.codeExistant && <div className="invalid-feedback">{erreurs.codeExistant}</div>}
            <div className="form-text">Ex : un enseignant que l'on nomme administrateur. Son compte reçoit le rôle et il garde son code et son PIN.</div>
          </div>
        )}
        <div className="mb-3">
          <label className="form-label" htmlFor="admin-nom">Nom complet {form.codeExistant ? '' : '*'}</label>
          <input id="admin-nom" type="text" className={`form-control ${erreurs.nom ? 'is-invalid' : ''}`} value={form.nom} onChange={(e) => setForm((f) => ({ ...f, nom: e.target.value }))} autoFocus />
          {erreurs.nom && <div className="invalid-feedback">{erreurs.nom}</div>}
        </div>
        <div className="mb-3">
          <label className="form-label" htmlFor="admin-email">Email <span className="text-muted fw-normal">(facultatif)</span></label>
          <input id="admin-email" type="email" className={`form-control ${erreurs.email ? 'is-invalid' : ''}`} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} autoComplete="off" />
          {erreurs.email && <div className="invalid-feedback">{erreurs.email}</div>}
          <div className="form-text">{creation ? 'La connexion se fait par code + PIN, générés automatiquement.' : 'La connexion se fait par code + PIN : l\'email est seulement informatif.'}</div>
        </div>

        <label className="form-label d-block">Rôles</label>
        <div className="admin-roles">
          {roles.filter((r) => !ROLES_SANS_ESPACE.includes(r.libelle) || form.roleIds.has(r.id)).map((r) => {
            const info = roleInfo(r.libelle);
            const verrouille = creation && r.libelle === 'Admin';
            return (
              <label key={r.id} className={`admin-role ${form.roleIds.has(r.id) ? 'coche' : ''} ${verrouille ? 'verrouille' : ''}`}>
                <input type="checkbox" className="form-check-input" checked={form.roleIds.has(r.id)} disabled={verrouille} onChange={() => basculerRole(r.id)} />
                <i className={`bx ${info.icon}`} />
                <span>{r.libelle === 'Admin' ? 'Administrateur' : info.label}</span>
              </label>
            );
          })}
        </div>
        {erreurs.roles && <div className="text-danger small mt-1">{erreurs.roles}</div>}

        {ficheRequise.length > 0 && (
          <div className="alert alert-info d-flex gap-2 small mt-3 mb-0">
            <i className="bx bx-info-circle mt-1" />
            <div>
              {ficheRequise.map((r) => roleInfo(r.libelle).label).join(', ')} : le rôle donne accès à l'espace, mais il restera vide tant que {ficheRequise.map((r) => ROLES_AVEC_FICHE[r.libelle]).join(' et ')} n'est pas créée pour ce compte.
              {' '}Plus simple : créer directement cette fiche depuis l'établissement en indiquant le code de connexion de ce compte, le rôle est alors ajouté automatiquement.
            </div>
          </div>
        )}
        {retireAdmin && (
          <div className="alert alert-warning d-flex gap-2 small mt-3 mb-0">
            <i className="bx bx-error mt-1" />
            <div>Le rôle Administrateur sera retiré : ce compte ne pourra plus gérer l'établissement.</div>
          </div>
        )}
      </Modal>
      {confirmNode}
    </>
  );
}

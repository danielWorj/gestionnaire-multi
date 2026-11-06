import { useState } from 'react';
import { apiRequest } from '../lib/api';
import { ROLES_SANS_ESPACE, roleInfo } from '../lib/espaces';
import Modal from './Modal';
import Select from './Select';
import { useConfirm, useToast } from './ui';

// Formulaire d'un compte d'établissement (cf. /api/auth/utilisateurs) :
// création ou modification (nom, email facultatif, rôles cumulés). Partagé
// par la modale « Administrateurs » d'un établissement (rôle Admin imposé à
// la création) et la page « Comptes utilisateurs » du SuperAdmin (tous rôles,
// établissement à choisir).
//
// - etab          établissement imposé, ou null : liste `etablissements`
//                 proposée à la création ;
// - roleImpose    libellé coché et verrouillé à la création (ex. 'Admin') ;
// - libelles      textes propres à l'appelant (cf. LIBELLES_COMPTE).
// onSaved({ message, identifiants? }) : identifiants = { nom, code, pin, titre }
// d'un compte nouvellement créé (PIN affiché une seule fois).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rôles qui ouvrent un espace lié à une fiche métier : la fiche se crée côté
// établissement (en indiquant le code de ce compte), sinon l'espace reste vide.
const ROLES_AVEC_FICHE = {
  Enseignant: 'la fiche enseignant (page Enseignants)',
  Censeur: 'la fiche censeur (page Configuration)',
  Surveillant: 'la fiche surveillant (page Configuration)',
};

export const LIBELLES_COMPTE = {
  ajout: 'Ajouter un compte',
  modification: 'Modifier le compte',
  ajoute: 'Compte créé.',
  modifie: 'Compte modifié.',
  titreIdentifiants: 'Compte créé',
  existant: (nom) => `${nom} avait déjà un compte dans cet établissement : les rôles lui sont ajoutés, il garde son code et son PIN.`,
  exempleCode: 'Ex : un enseignant à qui l\'on ajoute le rôle de censeur. Son compte reçoit les rôles et il garde son code et son PIN.',
};

export const libelleRole = (libelle) => (libelle === 'Admin' ? 'Administrateur' : roleInfo(libelle).label);

export default function CompteFormModal({
  etab = null, etablissements = [], compte = null, roles, roleImpose = null, estDernierAdminActif = false,
  libelles = LIBELLES_COMPTE, onClose, onSaved,
}) {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const creation = !compte;
  const roleAdmin = roles.find((r) => r.libelle === 'Admin');
  const roleParDefaut = roleImpose ? roles.find((r) => r.libelle === roleImpose) : null;
  const [form, setForm] = useState(() => ({
    etablissementId: etab?.id ? String(etab.id) : '',
    nom: compte?.nom || '',
    email: compte?.email || '',
    codeExistant: '',
    roleIds: new Set(compte ? compte.roles.map((r) => r.id) : roleParDefaut ? [roleParDefaut.id] : []),
  }));
  const [erreurs, setErreurs] = useState({});
  const [enregistrement, setEnregistrement] = useState(false);

  const etabNom = etab?.nom || compte?.etablissement_nom
    || etablissements.find((e) => String(e.id) === form.etablissementId)?.nom || '';

  const basculerRole = (id) => setForm((f) => {
    const roleIds = new Set(f.roleIds);
    if (roleIds.has(id)) roleIds.delete(id);
    else roleIds.add(id);
    return { ...f, roleIds };
  });

  const rolesCoches = roles.filter((r) => form.roleIds.has(r.id));
  const ficheRequise = rolesCoches.filter((r) => ROLES_AVEC_FICHE[r.libelle] && !compte?.roles.some((x) => x.id === r.id));
  const avaitAdmin = Boolean(compte && roleAdmin && compte.roles.some((r) => r.id === roleAdmin.id));
  const retireAdmin = avaitAdmin && !form.roleIds.has(roleAdmin.id);

  const valider = () => {
    const e = {};
    if (creation && !etab && !form.etablissementId) e.etablissement = "Choisissez l'établissement.";
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
      const ok = await confirm(<>Retirer le rôle Administrateur à <strong>{compte.nom}</strong> ?</>, {
        title: 'Retirer le rôle Administrateur', icon: 'bx-shield-x', confirmLabel: 'Retirer', confirmIcon: 'bx-shield-x',
        details: estDernierAdminActif
          ? "C'est le dernier administrateur actif de cet établissement : plus personne ne pourra le gérer sur place. Le compte garde ses autres rôles."
          : 'Le compte garde seulement ses autres rôles.',
      });
      if (!ok) return;
    }
    setEnregistrement(true);
    const payload = { nom: form.nom.trim(), email: form.email.trim() || null, role_ids: [...form.roleIds] };
    try {
      if (creation) {
        const r = await apiRequest('/auth/utilisateurs', {
          method: 'POST',
          body: JSON.stringify({ ...payload, etablissement_id: Number(etab?.id || form.etablissementId), code_existant: form.codeExistant || undefined }),
        });
        if (r.compte_existant) {
          await onSaved({ message: libelles.existant(r.nom) });
        } else {
          await onSaved({ message: libelles.ajoute, identifiants: { nom: r.nom, code: r.code_connexion, pin: r.pin_temporaire, titre: libelles.titreIdentifiants } });
        }
      } else {
        await apiRequest(`/auth/utilisateurs/${compte.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        await onSaved({ message: libelles.modifie });
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
        title={creation ? libelles.ajout : libelles.modification}
        subtitle={etabNom || undefined}
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
        {creation && !etab && (
          <div className="mb-3">
            <label className="form-label" htmlFor="compte-etab">Établissement *</label>
            <Select id="compte-etab" className={`form-select ${erreurs.etablissement ? 'is-invalid' : ''}`} value={form.etablissementId} onChange={(e) => setForm((f) => ({ ...f, etablissementId: e.target.value }))}>
              <option value="">Choisir…</option>
              {etablissements.map((e) => <option key={e.id} value={e.id}>{e.nom}</option>)}
            </Select>
            {erreurs.etablissement && <div className="invalid-feedback d-block">{erreurs.etablissement}</div>}
          </div>
        )}
        {creation && (
          <div className="mb-3">
            <label className="form-label" htmlFor="compte-code">A déjà un compte dans l'établissement ? <span className="text-muted fw-normal">(facultatif)</span></label>
            <input
              id="compte-code"
              type="text"
              className={`form-control font-monospace text-uppercase ${erreurs.codeExistant ? 'is-invalid' : ''}`}
              placeholder="Son code de connexion, ex : K7TB"
              maxLength={4}
              value={form.codeExistant}
              onChange={(e) => setForm((f) => ({ ...f, codeExistant: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) }))}
              autoComplete="off"
            />
            {erreurs.codeExistant && <div className="invalid-feedback">{erreurs.codeExistant}</div>}
            <div className="form-text">{libelles.exempleCode}</div>
          </div>
        )}
        <div className="mb-3">
          <label className="form-label" htmlFor="compte-nom">Nom complet {form.codeExistant ? '' : '*'}</label>
          <input id="compte-nom" type="text" className={`form-control ${erreurs.nom ? 'is-invalid' : ''}`} value={form.nom} onChange={(e) => setForm((f) => ({ ...f, nom: e.target.value }))} autoFocus />
          {erreurs.nom && <div className="invalid-feedback">{erreurs.nom}</div>}
        </div>
        <div className="mb-3">
          <label className="form-label" htmlFor="compte-email">Email <span className="text-muted fw-normal">(facultatif)</span></label>
          <input id="compte-email" type="email" className={`form-control ${erreurs.email ? 'is-invalid' : ''}`} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} autoComplete="off" />
          {erreurs.email && <div className="invalid-feedback">{erreurs.email}</div>}
          <div className="form-text">{creation ? 'La connexion se fait par code + PIN, générés automatiquement.' : 'La connexion se fait par code + PIN : l\'email est seulement informatif.'}</div>
        </div>

        <label className="form-label d-block">Rôles</label>
        <div className="admin-roles">
          {roles.filter((r) => !ROLES_SANS_ESPACE.includes(r.libelle) || form.roleIds.has(r.id)).map((r) => {
            const info = roleInfo(r.libelle);
            const verrouille = creation && r.libelle === roleImpose;
            return (
              <label key={r.id} className={`admin-role ${form.roleIds.has(r.id) ? 'coche' : ''} ${verrouille ? 'verrouille' : ''}`}>
                <input type="checkbox" className="form-check-input" checked={form.roleIds.has(r.id)} disabled={verrouille} onChange={() => basculerRole(r.id)} />
                <i className={`bx ${info.icon}`} />
                <span>{libelleRole(r.libelle)}</span>
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

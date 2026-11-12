import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { statutPaiement } from '../lib/espaceParent';
import { Pastille } from './EspaceParent';
import Select from './Select';
import { formatMontant, IdentifiantsModal, useConfirm, useToast } from './ui';

// Fiche famille (page Parents) : accès de la famille à l'espace parent, ses
// enfants avec leur situation (frais, bulletin) et le rattachement d'un
// enfant. Données : GET /api/parents/<id>/suivi (cf. server/api/espace_parent_api.py).

const nomEleve = (e) => `${e.prenom || ''} ${e.nom || ''}`.trim();
const fmtDateHeure = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);

function EtatBulletin({ bulletin }) {
  if (!bulletin) return <span className="text-muted">—</span>;
  if (bulletin.bloque) return <Pastille ton="danger" icon="bx-lock-alt">Suspendu</Pastille>;
  if (bulletin.debloque_par_admin) return <Pastille ton="warning" icon="bx-lock-open-alt">Débloqué</Pastille>;
  return <Pastille ton="success" icon="bx-check">Visible</Pastille>;
}

export default function FicheFamilleAcces({ parent, eleves, parents, peutDebloquer, onChange }) {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [suivi, setSuivi] = useState(null);
  const [erreur, setErreur] = useState('');
  const [occupe, setOccupe] = useState('');
  const [identifiants, setIdentifiants] = useState(null);
  const [aRattacher, setARattacher] = useState('');

  const charger = useCallback(async () => {
    setErreur('');
    try {
      setSuivi(await api.get(`/parents/${parent.id}/suivi`, { sansCopieLocale: true }));
    } catch (e) {
      setErreur(e.message);
    }
  }, [parent.id]);

  useEffect(() => { charger(); }, [charger]);

  const action = async (cle, requete, succes) => {
    setOccupe(cle);
    try {
      const res = await requete();
      await charger();
      if (succes) succes(res);
      return res;
    } catch (e) {
      toast(e.message, 'error');
      return null;
    } finally {
      setOccupe('');
    }
  };

  const nomFamille = `${parent.prenom || ''} ${parent.nom || ''}`.trim();
  const afficherIdentifiants = (res) => {
    if (res?.pin) {
      setIdentifiants({ nom: nomFamille, code: res.code_connexion, pin: res.pin });
    } else if (res?.compte_existant) {
      toast(`Accès ouvert sur le compte existant (code ${res.code_connexion}) : la personne se connecte avec son code et son PIN habituels, puis choisit l'espace Parent.`);
    }
  };

  const ouvrir = () => action('ouvrir', () => api.post(`/parents/${parent.id}/acces`), (res) => { afficherIdentifiants(res); onChange?.(); });
  const nouveauPin = async () => {
    const ok = await confirm(`Un nouveau PIN va remplacer l'actuel : ${nomFamille} sera déconnecté de tous ses appareils et devra utiliser le nouveau.`,
      { title: 'Générer un nouveau PIN', confirmLabel: 'Générer', confirmIcon: 'bx-key', danger: false, icon: 'bx-key' });
    if (ok) action('pin', () => api.post(`/parents/${parent.id}/acces/nouveau-pin`), afficherIdentifiants);
  };
  const retirer = async () => {
    const ok = await confirm(`${nomFamille} ne pourra plus ouvrir l'espace parent. Vous pourrez rouvrir l'accès plus tard (même code, nouveau PIN).`,
      { title: "Retirer l'accès à l'espace parent", confirmLabel: "Retirer l'accès", confirmIcon: 'bx-block' });
    if (ok) action('retirer', () => api.del(`/parents/${parent.id}/acces`), () => { toast("Accès à l'espace parent retiré"); onChange?.(); });
  };

  const basculerBulletin = (enfant) => {
    const debloque = !enfant.inscription.bulletin_debloque;
    return action(`bulletin-${enfant.inscription.id}`,
      () => api.put(`/parents/${parent.id}/bulletins/${enfant.inscription.id}`, { debloque }),
      () => toast(debloque ? `Bulletin de ${enfant.eleve.prenom} débloqué malgré les frais en retard` : `Blocage du bulletin de ${enfant.eleve.prenom} rétabli`));
  };

  // Élèves rattachables : ceux des autres familles, triés par nom.
  const parentById = useMemo(() => Object.fromEntries(parents.map((p) => [p.id, p])), [parents]);
  const candidats = useMemo(() => eleves
    .filter((e) => e.parent_id !== parent.id)
    .sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr')), [eleves, parent.id]);

  const rattacher = async () => {
    const eleve = candidats.find((e) => String(e.id) === aRattacher);
    if (!eleve) return;
    const actuel = parentById[eleve.parent_id];
    if (actuel) {
      const ok = await confirm(
        `${nomEleve(eleve)} est actuellement rattaché(e) à ${actuel.prenom} ${actuel.nom}. Le rattacher à ${nomFamille} ? Il quittera sa famille actuelle (un élève a un seul parent référent).`,
        { title: 'Rattacher un enfant', confirmLabel: 'Rattacher', confirmIcon: 'bx-link', danger: false, icon: 'bx-link' },
      );
      if (!ok) return;
    }
    await action('rattacher', () => api.post(`/parents/${parent.id}/enfants`, { eleve_id: eleve.id }), () => {
      toast(`${nomEleve(eleve)} est rattaché(e) à ${nomFamille}`);
      setARattacher('');
      onChange?.();
    });
  };

  if (erreur && !suivi) return <div className="alert alert-warning mb-0"><i className="bx bx-error me-1" />{erreur}</div>;
  if (!suivi) return <div className="text-center py-4"><span className="spinner-border spinner-border-sm" /></div>;

  const { acces, enfants } = suivi;
  return (
    <>
      <h6 className="mb-2"><i className="bx bx-mobile-alt me-1" />Accès à l'espace parent</h6>
      <div className="border rounded p-3 mb-4">
        {acces.actif ? (
          <div className="d-flex flex-wrap align-items-center gap-3">
            <div className="flex-grow-1">
              <div><Pastille ton="success" icon="bx-check-circle">Accès ouvert</Pastille> <span className="ms-1">Code de connexion : <strong className="font-monospace">{acces.code_connexion}</strong></span></div>
              <small className="text-muted d-block mt-1">
                {acces.dernier_login ? `Dernière connexion : ${fmtDateHeure(acces.dernier_login)}` : 'Jamais connecté pour le moment'}
                {acces.verrouille && ' · Compte bloqué après trop de PIN incorrects : générez un nouveau PIN.'}
              </small>
              {acces.autres_roles.length > 0 && (
                <small className="text-muted d-block">Ce compte sert aussi : {acces.autres_roles.join(', ')}. Son PIN se gère depuis les comptes du personnel.</small>
              )}
            </div>
            <div className="d-flex gap-2">
              {acces.autres_roles.length === 0 && (
                <button type="button" className="btn btn-outline-primary btn-sm" onClick={nouveauPin} disabled={Boolean(occupe)}>
                  {occupe === 'pin' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-key me-1" />}Nouveau PIN
                </button>
              )}
              <button type="button" className="btn btn-outline-danger btn-sm" onClick={retirer} disabled={Boolean(occupe)}><i className="bx bx-block me-1" />Retirer</button>
            </div>
          </div>
        ) : (
          <div className="d-flex flex-wrap align-items-center gap-3">
            <p className="mb-0 flex-grow-1 small">
              {acces.existe
                ? "L'accès de cette famille a été retiré. Rouvrez-le pour lui remettre une fiche d'accès (même code, nouveau PIN)."
                : 'Ouvrez un accès pour que la famille suive ses enfants depuis son téléphone : frais de scolarité, échéances et bulletins. Un seul code pour tous ses enfants.'}
            </p>
            <button type="button" className="btn btn-primary btn-sm" onClick={ouvrir} disabled={Boolean(occupe)}>
              {occupe === 'ouvrir' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-key me-1" />}
              {acces.existe ? "Rouvrir l'accès" : "Ouvrir l'accès"}
            </button>
          </div>
        )}
      </div>

      <h6 className="mb-2">Enfants rattachés <span className="badge bg-label-primary">{enfants.length}</span></h6>
      {enfants.length ? (
        <div className="table-responsive mb-3">
          <table className="table mb-0">
            <thead><tr><th>Élève</th><th>Classe</th><th>Frais</th><th>Bulletin (espace parent)</th></tr></thead>
            <tbody>
              {enfants.map((e) => {
                const statut = statutPaiement(e.paiements);
                const impaye = e.paiements?.en_retard;
                return (
                  <tr key={e.eleve.id}>
                    <td><div className="fw-semibold">{nomEleve(e.eleve)}</div><code className="small">{e.eleve.matricule}</code></td>
                    <td>{e.inscription ? e.inscription.classe : <span className="text-muted">Non inscrit cette année</span>}</td>
                    <td>
                      {e.inscription ? <Pastille ton={statut.ton} icon={statut.icon}>{statut.libelle}</Pastille> : '—'}
                      {impaye && <small className="d-block text-danger mt-1">{formatMontant(e.paiements.impaye_exigible)} échus</small>}
                    </td>
                    <td>
                      <EtatBulletin bulletin={e.bulletin} />
                      {peutDebloquer && impaye && (
                        <button type="button" className="btn btn-link btn-sm p-0 d-block mt-1" onClick={() => basculerBulletin(e)} disabled={Boolean(occupe)}>
                          {e.inscription.bulletin_debloque ? 'Rétablir le blocage' : 'Débloquer quand même'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="text-muted">Aucun enfant n'est encore rattaché à cette famille.</p>}

      <div className="row g-2 align-items-end">
        <div className="col">
          <label className="form-label" htmlFor={`rattacher-${parent.id}`}>Rattacher un enfant</label>
          <Select id={`rattacher-${parent.id}`} className="form-select form-select-sm" value={aRattacher} onChange={(ev) => setARattacher(ev.target.value)}>
            <option value="">Choisir un élève…</option>
            {candidats.map((e) => (
              <option key={e.id} value={e.id}>{`${e.nom} ${e.prenom} — ${e.matricule}`}</option>
            ))}
          </Select>
        </div>
        <div className="col-auto">
          <button type="button" className="btn btn-outline-primary btn-sm" onClick={rattacher} disabled={!aRattacher || Boolean(occupe)}>
            {occupe === 'rattacher' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-link me-1" />}Rattacher
          </button>
        </div>
      </div>
      <small className="text-muted d-block mt-1">Le bulletin d'un enfant est suspendu dans l'espace parent tant qu'une échéance passée reste impayée{peutDebloquer ? ' ; vous pouvez lever ce blocage au cas par cas.' : ' ; seule l\'administration peut lever ce blocage.'}</small>

      {identifiants && (
        <IdentifiantsModal {...identifiants} titre="Accès à l'espace parent" destinataire="la famille" onClose={() => setIdentifiants(null)} />
      )}
      {confirmNode}
    </>
  );
}

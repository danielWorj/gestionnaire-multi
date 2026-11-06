import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiRequest } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { roleInfo } from '../lib/espaces';
import CompteFormModal, { libelleRole } from '../components/CompteFormModal';
import { fmtHorodatage } from '../components/Historique';
import Select from '../components/Select';
import {
  FilterChips, IdentifiantsModal, PageHeader, Pager, SortTh, StatCard, TBody, TableCard, downloadCsv, initiales,
  useConfirm, usePagination, useToast,
} from '../components/ui';

// Comptes de connexion de TOUS les établissements (SuperAdmin) : recherche,
// filtres (établissement, rôle, statut), création, modification des rôles,
// réinitialisation du PIN (débloque aussi le compte), désactivation /
// réactivation, export CSV. Filtres initiaux possibles par l'URL :
// /utilisateurs?etablissement=3&statut=bloque (liens du tableau de bord).

const STATUTS = {
  actif: { label: 'Actif', cls: 'bg-label-success', test: (u) => u.actif && !u.verrouille },
  bloque: { label: 'Bloqué (PIN faux)', cls: 'bg-label-danger', test: (u) => u.actif && u.verrouille },
  desactive: { label: 'Désactivé', cls: 'bg-label-secondary', test: (u) => !u.actif },
  jamais: { label: 'Jamais connecté', cls: 'bg-label-warning', test: (u) => u.actif && !u.dernier_login },
};

const statutDe = (u) => (!u.actif ? STATUTS.desactive : u.verrouille ? STATUTS.bloque : STATUTS.actif);

const CLES_TRI = {
  nom: (u) => u.nom.toLocaleLowerCase('fr'),
  etablissement: (u) => (u.etablissement_nom || '').toLocaleLowerCase('fr'),
  connexion: (u) => u.dernier_login || '',
};

export default function UtilisateursPage() {
  const { etablissements } = useAuth();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [params, setParams] = useSearchParams();
  const [comptes, setComptes] = useState(null);
  const [roles, setRoles] = useState([]);
  const [erreur, setErreur] = useState('');
  const [formulaire, setFormulaire] = useState(null); // { compte } (null = création)
  const [identifiants, setIdentifiants] = useState(null);
  const [occupe, setOccupe] = useState(null);
  const [recherche, setRecherche] = useState('');
  const [tri, setTri] = useState({ key: 'nom', asc: true });

  const filtres = {
    etablissement: params.get('etablissement') || '',
    role: params.get('role') || '',
    statut: params.get('statut') || '',
  };
  // (appelé seulement depuis des gestionnaires d'événements : `pagination`,
  // déclarée plus bas, est alors disponible)
  const majFiltre = (cle, valeur) => {
    setParams((p) => {
      const suivant = new URLSearchParams(p);
      if (valeur) suivant.set(cle, valeur); else suivant.delete(cle);
      return suivant;
    }, { replace: true });
    pagination.reset();
  };

  const charger = useCallback(async () => {
    setErreur('');
    try {
      const [liste, tousRoles] = await Promise.all([apiRequest('/auth/utilisateurs'), apiRequest('/auth/roles')]);
      setComptes(liste);
      setRoles(tousRoles);
    } catch (e) {
      setErreur(e.message);
      setComptes([]);
    }
  }, []);

  useEffect(() => { charger(); }, [charger]);

  const visibles = useMemo(() => {
    const q = recherche.trim().toLocaleLowerCase('fr');
    const cle = CLES_TRI[tri.key];
    return (comptes || [])
      .filter((u) => !filtres.etablissement || String(u.etablissement_id) === filtres.etablissement)
      .filter((u) => !filtres.role || u.roles.some((r) => r.libelle === filtres.role))
      .filter((u) => !filtres.statut || STATUTS[filtres.statut]?.test(u))
      .filter((u) => !q || [u.nom, u.code_connexion, u.email, u.etablissement_nom].some((v) => v && v.toLocaleLowerCase('fr').includes(q)))
      .sort((a, b) => {
        const [x, y] = [cle(a), cle(b)];
        const r = x < y ? -1 : x > y ? 1 : 0;
        return tri.asc ? r : -r;
      });
  }, [comptes, filtres.etablissement, filtres.role, filtres.statut, recherche, tri]);

  const pagination = usePagination(visibles, 50);

  const stats = useMemo(() => {
    const l = comptes || [];
    return {
      total: l.length,
      actifs: l.filter(STATUTS.actif.test).length,
      bloques: l.filter(STATUTS.bloque.test).length,
      desactives: l.filter(STATUTS.desactive.test).length,
      jamais: l.filter(STATUTS.jamais.test).length,
    };
  }, [comptes]);

  // Administrateurs actifs par établissement : alerte avant de retirer le dernier.
  const adminsActifs = useMemo(() => {
    const m = new Map();
    (comptes || []).filter((u) => u.actif && u.roles.some((r) => r.libelle === 'Admin'))
      .forEach((u) => m.set(u.etablissement_id, (m.get(u.etablissement_id) || 0) + 1));
    return m;
  }, [comptes]);
  const estDernierAdmin = (u) => u.actif && u.roles.some((r) => r.libelle === 'Admin') && adminsActifs.get(u.etablissement_id) === 1;

  const action = async (u, travail) => {
    setOccupe(u.id);
    try {
      await travail();
      await charger();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setOccupe(null);
    }
  };

  const reinitialiser = async (u) => {
    const ok = await confirm(<>Générer un nouveau PIN pour <strong>{u.nom}</strong> ?</>, {
      title: 'Réinitialiser le PIN', icon: 'bx-key', danger: false, confirmLabel: 'Réinitialiser', confirmIcon: 'bx-refresh',
      details: 'Son PIN actuel cessera de fonctionner, son compte est débloqué et ses sessions en cours fermées. Son code de connexion ne change pas.',
    });
    if (!ok) return;
    await action(u, async () => {
      const r = await apiRequest(`/auth/utilisateurs/${u.id}/reset-password`, { method: 'POST' });
      setIdentifiants({ nom: r.nom, code: r.code_connexion, pin: r.pin_temporaire, titre: 'Nouveau PIN' });
    });
  };

  const basculerActif = async (u) => {
    if (u.actif) {
      const ok = await confirm(<>Désactiver le compte de <strong>{u.nom}</strong> ?</>, {
        title: 'Désactiver un compte', icon: 'bx-block', confirmLabel: 'Désactiver', confirmIcon: 'bx-block',
        details: estDernierAdmin(u)
          ? `C'est le dernier administrateur actif de ${u.etablissement_nom} : plus personne ne pourra le gérer sur place.`
          : 'Ses sessions sont fermées immédiatement. Le compte est conservé et pourra être réactivé.',
      });
      if (!ok) return;
    }
    await action(u, async () => {
      if (u.actif) await apiRequest(`/auth/utilisateurs/${u.id}`, { method: 'DELETE' });
      else await apiRequest(`/auth/utilisateurs/${u.id}`, { method: 'PUT', body: JSON.stringify({ actif: true }) });
      toast(`${u.nom} a été ${u.actif ? 'désactivé' : 'réactivé'}.`);
    });
  };

  const exporter = () => {
    downloadCsv('comptes-utilisateurs.csv', [
      ['Nom', 'Code de connexion', 'Email', 'Établissement', 'Rôles', 'Statut', 'Dernière connexion'],
      ...visibles.map((u) => [u.nom, u.code_connexion, u.email || '', u.etablissement_nom || '', u.roles.map((r) => libelleRole(r.libelle)).join(', '),
        statutDe(u).label, u.dernier_login ? fmtHorodatage(u.dernier_login) : 'Jamais']),
    ]);
  };

  const etabNom = (id) => etablissements.find((e) => String(e.id) === String(id))?.nom || `Établissement n°${id}`;
  const chips = [
    filtres.etablissement && ['etablissement', etabNom(filtres.etablissement)],
    filtres.role && ['role', libelleRole(filtres.role)],
    filtres.statut && ['statut', STATUTS[filtres.statut]?.label || filtres.statut],
  ].filter(Boolean);

  const carteStatut = (cle, label, value, icon, color) => (
    <div className="col-6 col-xl" role="button" tabIndex={0} onClick={() => majFiltre('statut', filtres.statut === cle ? '' : cle)}
      onKeyDown={(e) => { if (e.key === 'Enter') majFiltre('statut', filtres.statut === cle ? '' : cle); }}>
      <StatCard className="h-100" label={label} value={comptes ? value : '…'} icon={icon} color={filtres.statut === cle ? 'primary' : color} />
    </div>
  );

  return (
    <>
      <PageHeader title="Comptes utilisateurs" subtitle="Tous les comptes de connexion du réseau, établissement par établissement">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={exporter} disabled={!visibles.length}><i className="bx bx-download me-1" />Exporter</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setFormulaire({ compte: null })} disabled={!roles.length || !etablissements.length}>
          <i className="bx bx-plus me-1" />Nouveau compte
        </button>
      </PageHeader>

      <div className="row g-3 mb-4">
        {carteStatut('', 'Comptes', stats.total, 'bx-id-card', 'secondary')}
        {carteStatut('actif', 'Actifs', stats.actifs, 'bx-check-circle', 'success')}
        {carteStatut('bloque', 'Bloqués', stats.bloques, 'bx-lock', 'danger')}
        {carteStatut('jamais', 'Jamais connectés', stats.jamais, 'bx-time', 'warning')}
        {carteStatut('desactive', 'Désactivés', stats.desactives, 'bx-block', 'secondary')}
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-4">
              <label className="form-label" htmlFor="u-recherche">Rechercher</label>
              <input id="u-recherche" type="search" className="form-control" placeholder="Nom, code, email…" value={recherche} onChange={(e) => { setRecherche(e.target.value); pagination.reset(); }} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Établissement</label>
              <Select className="form-select" value={filtres.etablissement} onChange={(e) => majFiltre('etablissement', e.target.value)}>
                <option value="">Tous</option>
                {etablissements.map((e) => <option key={e.id} value={e.id}>{e.nom}</option>)}
              </Select>
            </div>
            <div className="col-md-3">
              <label className="form-label">Rôle</label>
              <Select className="form-select" value={filtres.role} onChange={(e) => majFiltre('role', e.target.value)}>
                <option value="">Tous</option>
                {roles.map((r) => <option key={r.id} value={r.libelle}>{libelleRole(r.libelle)}</option>)}
              </Select>
            </div>
            <div className="col-md-2">
              <label className="form-label">Statut</label>
              <Select className="form-select" value={filtres.statut} onChange={(e) => majFiltre('statut', e.target.value)}>
                <option value="">Tous</option>
                {Object.entries(STATUTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            </div>
          </div>
          <FilterChips chips={chips} onClear={(cle) => majFiltre(cle, '')} />
        </div>
      </div>

      <TableCard title="Comptes" icon="bx-id-card" count={visibles.length} footer={<Pager pagination={pagination} unit="comptes" />}>
        <table className="table table-hover align-middle mb-0">
          <thead>
            <tr>
              <SortTh sortKey="nom" sort={tri} setSort={setTri}>Compte</SortTh>
              <SortTh sortKey="etablissement" sort={tri} setSort={setTri}>Établissement</SortTh>
              <th>Rôles</th>
              <th>Statut</th>
              <SortTh sortKey="connexion" sort={tri} setSort={setTri}>Dernière connexion</SortTh>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <TBody colSpan={6} loading={comptes === null} error={erreur} rows={visibles.length} empty="Aucun compte ne correspond." emptyIcon="bx-search">
            {pagination.slice.map((u) => {
              const statut = statutDe(u);
              return (
                <tr key={u.id} className={u.actif ? '' : 'text-muted'}>
                  <td>
                    <div className="d-flex align-items-center gap-2">
                      <div className="avatar avatar-sm flex-shrink-0">
                        <span className={`avatar-initial rounded-circle ${u.actif ? 'bg-label-primary' : 'bg-label-secondary'}`}>{initiales(u.nom)}</span>
                      </div>
                      <div>
                        <div className="fw-semibold">{u.nom}</div>
                        <small className="text-muted"><span className="font-monospace fw-semibold">{u.code_connexion}</span>{u.email && <> · {u.email}</>}</small>
                      </div>
                    </div>
                  </td>
                  <td className="small">{u.etablissement_nom || etabNom(u.etablissement_id)}</td>
                  <td>
                    <div className="d-flex flex-wrap gap-1">
                      {u.roles.map((r) => (
                        <span key={r.id} className={`badge bg-label-${r.libelle === 'Admin' ? 'primary' : roleInfo(r.libelle).color}`}>
                          <i className={`bx ${roleInfo(r.libelle).icon} me-1`} />{libelleRole(r.libelle)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td><span className={`badge ${statut.cls}`}>{statut.label}</span></td>
                  <td className="small">{u.dernier_login ? fmtHorodatage(u.dernier_login) : <span className="text-warning">Jamais</span>}</td>
                  <td className="text-end">
                    {occupe === u.id ? <span className="spinner-border spinner-border-sm text-primary" /> : (
                      <>
                        <button type="button" className="btn btn-sm btn-icon btn-outline-secondary" title="Modifier" aria-label={`Modifier ${u.nom}`} onClick={() => setFormulaire({ compte: u })}><i className="bx bx-edit-alt" /></button>
                        <button type="button" className={`btn btn-sm btn-icon ms-1 ${u.verrouille ? 'btn-outline-danger' : 'btn-outline-secondary'}`} title={u.verrouille ? 'Débloquer (nouveau PIN)' : 'Réinitialiser le PIN'} aria-label={`Réinitialiser le PIN de ${u.nom}`} onClick={() => reinitialiser(u)} disabled={!u.actif}><i className={`bx ${u.verrouille ? 'bx-lock-open' : 'bx-key'}`} /></button>
                        {u.actif
                          ? <button type="button" className="btn btn-sm btn-icon btn-outline-danger ms-1" title="Désactiver" aria-label={`Désactiver ${u.nom}`} onClick={() => basculerActif(u)}><i className="bx bx-block" /></button>
                          : <button type="button" className="btn btn-sm btn-outline-success ms-1" onClick={() => basculerActif(u)}><i className="bx bx-check-circle me-1" />Réactiver</button>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </TBody>
        </table>
      </TableCard>

      {formulaire && (
        <CompteFormModal
          etab={formulaire.compte ? { id: formulaire.compte.etablissement_id, nom: formulaire.compte.etablissement_nom } : (filtres.etablissement ? { id: Number(filtres.etablissement), nom: etabNom(filtres.etablissement) } : null)}
          etablissements={etablissements}
          compte={formulaire.compte}
          roles={roles}
          estDernierAdminActif={formulaire.compte ? estDernierAdmin(formulaire.compte) : false}
          onClose={() => setFormulaire(null)}
          onSaved={async ({ message, identifiants: ids }) => {
            setFormulaire(null);
            if (ids) setIdentifiants(ids);
            if (message) toast(message);
            await charger();
          }}
        />
      )}
      {identifiants && (
        <IdentifiantsModal nom={identifiants.nom} code={identifiants.code} pin={identifiants.pin} titre={identifiants.titre} onClose={() => setIdentifiants(null)} />
      )}
      {confirmNode}
    </>
  );
}

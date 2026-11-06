import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ListeAudit, TABLES_AUDIT } from '../components/Historique';
import { useAuth } from '../context/AuthContext';
import { roleDe } from '../components/Layout';
import { PageHeader } from '../components/ui';
import Select from '../components/Select';
import { SkelListe } from '../components/Skeleton';

// Journal des modifications (Admin : son établissement ; Censeur : le volet
// pédagogique — notes, discipline, emploi du temps — filtrage fait par le
// serveur ; SuperAdmin : tout le réseau ou un établissement au choix,
// ?etablissement=<id> dans l'URL pour arriver déjà filtré).

const TABLES_CENSEUR = ['note', 'discipline', 'horaire'];
const LIMITE = 50;

export default function JournalPage() {
  const { user, isSuperAdmin, etablissements } = useAuth();
  const censeur = roleDe(user) === 'Censeur';
  const [urlParams] = useSearchParams();
  const [filtres, setFiltres] = useState(() => ({ table: '', action: '', depuis: '', jusqua: '', etablissement: urlParams.get('etablissement') || '' }));
  const [page, setPage] = useState(1);
  const [etat, setEtat] = useState({ chargement: true, items: [], total: 0, erreur: null });

  useEffect(() => {
    let annule = false;
    const params = new URLSearchParams({ page: String(page), limite: String(LIMITE) });
    const { etablissement, ...autres } = filtres;
    Object.entries(autres).forEach(([k, v]) => { if (v) params.set(k, v); });
    // Toujours explicite pour le SuperAdmin : sinon l'établissement du
    // sélecteur de la barre du haut serait appliqué d'office (cf. api.js).
    if (isSuperAdmin) params.set('etablissement_id', etablissement || 'tous');
    setEtat((e) => ({ ...e, chargement: true }));
    api.get(`/audit/?${params.toString()}`)
      .then((d) => { if (!annule) setEtat({ chargement: false, items: d.items || [], total: d.total || 0, erreur: null }); })
      .catch((e) => { if (!annule) setEtat({ chargement: false, items: [], total: 0, erreur: e.message }); });
    return () => { annule = true; };
  }, [filtres, page, isSuperAdmin]);

  const maj = (cle) => (e) => { setPage(1); setFiltres((f) => ({ ...f, [cle]: e.target.value })); };
  const pages = Math.max(1, Math.ceil(etat.total / LIMITE));
  const nomEtablissement = (id) => etablissements.find((e) => e.id === id)?.nom || `Établissement n°${id}`;
  const tables = Object.entries(TABLES_AUDIT).filter(([k]) => !censeur || TABLES_CENSEUR.includes(k))
    .sort((a, b) => a[1].localeCompare(b[1], 'fr'));

  return (
    <>
      <PageHeader title="Journal des modifications" subtitle={isSuperAdmin ? 'Qui a créé, modifié ou supprimé quoi, et quand — sur tout le réseau' : 'Qui a créé, modifié ou supprimé quoi, et quand'} />
      <div className="card mb-3">
        <div className="card-body row g-3">
          {isSuperAdmin && (
            <div className="col-12 col-lg-4">
              <label className="form-label">Établissement</label>
              <Select className="form-select" value={filtres.etablissement} onChange={maj('etablissement')}>
                <option value="">Tout le réseau</option>
                {etablissements.map((e) => <option key={e.id} value={e.id}>{e.nom}</option>)}
              </Select>
            </div>
          )}
          <div className={isSuperAdmin ? 'col-sm-6 col-lg-2' : 'col-sm-6 col-lg-3'}>
            <label className="form-label">Donnée</label>
            <Select className="form-select" value={filtres.table} onChange={maj('table')}>
              <option value="">Toutes</option>
              {tables.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </Select>
          </div>
          <div className={isSuperAdmin ? 'col-sm-6 col-lg-2' : 'col-sm-6 col-lg-3'}>
            <label className="form-label">Action</label>
            <Select className="form-select" value={filtres.action} onChange={maj('action')}>
              <option value="">Toutes</option>
              <option value="creation">Création</option>
              <option value="modification">Modification</option>
              <option value="suppression">Suppression</option>
            </Select>
          </div>
          <div className={isSuperAdmin ? 'col-sm-6 col-lg-2' : 'col-sm-6 col-lg-3'}>
            <label className="form-label">Du</label>
            <input type="date" className="form-control" value={filtres.depuis} onChange={maj('depuis')} />
          </div>
          <div className={isSuperAdmin ? 'col-sm-6 col-lg-2' : 'col-sm-6 col-lg-3'}>
            <label className="form-label">Au</label>
            <input type="date" className="form-control" value={filtres.jusqua} onChange={maj('jusqua')} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header d-flex align-items-center justify-content-between">
          <h6 className="mb-0"><i className="bx bx-history me-2 text-primary" />{etat.total} entrée{etat.total > 1 ? 's' : ''}</h6>
          {pages > 1 && (
            <div className="btn-group btn-group-sm">
              <button type="button" className="btn btn-outline-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><i className="bx bx-chevron-left" /></button>
              <span className="btn btn-outline-secondary disabled">{page} / {pages}</span>
              <button type="button" className="btn btn-outline-secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><i className="bx bx-chevron-right" /></button>
            </div>
          )}
        </div>
        <div className="card-body">
          {etat.chargement ? <SkelListe lignes={6} label="Chargement du journal…" />
            : etat.erreur ? <div className="alert alert-danger mb-0">{etat.erreur}</div>
              : etat.items.length ? <ListeAudit items={etat.items} avecCible nomEtablissement={isSuperAdmin && !filtres.etablissement ? nomEtablissement : null} />
                : <div className="text-center text-muted py-4"><i className="bx bx-history bx-md d-block mb-2" />Aucune modification pour ces critères.</div>}
        </div>
      </div>
    </>
  );
}

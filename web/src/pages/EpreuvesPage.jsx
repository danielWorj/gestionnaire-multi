import { useMemo, useState } from 'react';
import EpreuveModal from '../components/EpreuveModal';
import PagerServeur from '../components/PagerServeur';
import Select from '../components/Select';
import { IconBtn, PageHeader, TBody, TableCard, formatDate, useConfirm, useToast } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import {
  EPREUVES_PAR_PAGE_ADMIN, classesDe, enseignantsDe, formaterTaille, listerEpreuves, matieresDe,
  styleEpreuve, supprimerEpreuve, telechargerEpreuve, useAffectationsAdmin,
} from '../lib/epreuves';
import { usePaginationServeur } from '../lib/paginationServeur';

const FILTRES_VIDES = { classe: '', matiere: '', enseignant: '' };

// Épreuves de l'établissement (Admin / SuperAdmin) : 10 par page (pagination
// côté serveur), filtres classe / matière / enseignant, ajout (l'enseignant
// est celui de l'affectation) et téléchargement du fichier d'origine.
export default function EpreuvesPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { activeEtablissementId } = useAuth();
  const { mcs, loading: chargementAffectations, error: erreurAffectations } = useAffectationsAdmin(activeEtablissementId);
  const [filtres, setFiltres] = useState(FILTRES_VIDES);
  const [modal, setModal] = useState(false);
  const [telechargement, setTelechargement] = useState(null);

  const classes = useMemo(() => classesDe(mcs), [mcs]);
  const matieres = useMemo(() => matieresDe(mcs, filtres.classe), [mcs, filtres.classe]);
  const enseignants = useMemo(() => enseignantsDe(mcs), [mcs]);
  const filtre = Object.values(filtres).some(Boolean);

  // L'établissement consulté (SuperAdmin) fait partie des filtres : en
  // changer recharge la liste depuis la page 1.
  const pagination = usePaginationServeur({
    perPage: EPREUVES_PAR_PAGE_ADMIN,
    filtres: { ...filtres, etablissement: activeEtablissementId },
    charger: ({ page, perPage }) => listerEpreuves('admin', {
      page, perPage, classeId: filtres.classe, matiereId: filtres.matiere, enseignantId: filtres.enseignant,
    }),
  });
  const { items, loading, error } = pagination;

  const changerClasse = (classe) => setFiltres((f) => ({
    ...f,
    classe,
    matiere: classe && f.matiere && !matieresDe(mcs, classe).some((m) => String(m.id) === f.matiere) ? '' : f.matiere,
  }));

  const telecharger = async (epreuve) => {
    setTelechargement(epreuve.id);
    try {
      await telechargerEpreuve(epreuve);
    } catch (e) {
      toast(`Téléchargement : ${e.message}`, 'error');
    } finally {
      setTelechargement(null);
    }
  };

  const supprimer = async (epreuve) => {
    const ok = await confirm(`Supprimer l'épreuve « ${epreuve.titre} » ?`, {
      details: 'Le fichier sera définitivement supprimé.',
    });
    if (!ok) return;
    try {
      await supprimerEpreuve('admin', epreuve.id);
      toast('Épreuve supprimée.');
      pagination.recharger();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const apresAjout = () => {
    setModal(false);
    pagination.setPage(1); // les plus récentes d'abord
    pagination.recharger();
  };

  return (
    <>
      <PageHeader title="Épreuves" subtitle="Épreuves déposées par les enseignants de l'établissement : consultez-les, filtrez-les et téléchargez-les.">
        <button type="button" className="btn btn-primary" onClick={() => setModal(true)} disabled={chargementAffectations || !mcs.length}>
          <i className="bx bx-plus me-1" /> Ajouter une épreuve
        </button>
      </PageHeader>

      {erreurAffectations && <div className="alert alert-warning"><i className="bx bx-error me-2" />Classes et matières : {erreurAffectations}</div>}

      <div className="card mb-3">
        <div className="card-body py-3">
          <div className="row g-2 align-items-end">
            <div className="col-md-3">
              <label className="form-label">Classe</label>
              <Select className="form-select form-select-sm" value={filtres.classe} onChange={(e) => changerClasse(e.target.value)}>
                <option value="">Toutes les classes</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select>
            </div>
            <div className="col-md-3">
              <label className="form-label">Matière</label>
              <Select className="form-select form-select-sm" value={filtres.matiere} onChange={(e) => setFiltres((f) => ({ ...f, matiere: e.target.value }))}>
                <option value="">Toutes les matières</option>
                {matieres.map((m) => <option key={m.id} value={m.id}>{m.libelle}</option>)}
              </Select>
            </div>
            <div className="col-md-4">
              <label className="form-label">Enseignant</label>
              <Select className="form-select form-select-sm" value={filtres.enseignant} onChange={(e) => setFiltres((f) => ({ ...f, enseignant: e.target.value }))}>
                <option value="">Tous les enseignants</option>
                {enseignants.map((e) => <option key={e.id} value={e.id}>{e.nom}</option>)}
              </Select>
            </div>
            <div className="col-md-2">
              <button type="button" className="btn btn-outline-secondary btn-sm w-100" title="Réinitialiser les filtres" onClick={() => setFiltres(FILTRES_VIDES)} disabled={!filtre}>
                <i className="bx bx-reset me-1" />Réinitialiser
              </button>
            </div>
          </div>
        </div>
      </div>

      <TableCard
        title="Épreuves"
        icon="bx-file"
        count={error ? undefined : pagination.total}
        footer={<PagerServeur pagination={pagination} bordure={false} />}
      >
        <table className={`table table-hover mb-0${loading && items.length ? ' opacity-50' : ''}`}>
          <thead>
            <tr><th>Épreuve</th><th>Classe</th><th>Matière</th><th>Enseignant</th><th>Déposée le</th><th>Taille</th><th className="text-end">Actions</th></tr>
          </thead>
          <TBody
            colSpan={7}
            loading={loading && !items.length}
            error={error}
            rows={items.length}
            empty={filtre ? 'Aucune épreuve ne correspond à ces filtres' : "Aucune épreuve n'a encore été déposée"}
            emptyIcon="bx-file-blank"
            skeletonRows={EPREUVES_PAR_PAGE_ADMIN}
          >
            {items.map((epreuve) => {
              const { icone, ton } = styleEpreuve(epreuve.mime);
              return (
                <tr key={epreuve.id}>
                  <td>
                    <div className="d-flex align-items-center gap-2">
                      <span className={`avatar-initial rounded bg-label-${ton} flex-shrink-0 d-inline-flex align-items-center justify-content-center`} style={{ width: 32, height: 32 }}><i className={`bx ${icone}`} /></span>
                      <div className="min-w-0">
                        <div className="fw-semibold text-truncate" style={{ maxWidth: 280 }} title={epreuve.titre}>{epreuve.titre}</div>
                        <small className="text-muted text-truncate d-block" style={{ maxWidth: 280 }} title={epreuve.nom_original}>{epreuve.nom_original}</small>
                      </div>
                    </div>
                  </td>
                  <td>{epreuve.classe_label}</td>
                  <td>{epreuve.matiere_libelle}</td>
                  <td>{epreuve.enseignant_nom}</td>
                  <td>{formatDate(epreuve.created_at)}</td>
                  <td>{formaterTaille(epreuve.taille)}</td>
                  <td className="text-end">
                    <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => telecharger(epreuve)} disabled={telechargement === epreuve.id}>
                      {telechargement === epreuve.id
                        ? <><span className="spinner-border spinner-border-sm me-1" />Téléchargement…</>
                        : <><i className="bx bx-download me-1" />Télécharger</>}
                    </button>
                    <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(epreuve)} />
                  </td>
                </tr>
              );
            })}
          </TBody>
        </table>
      </TableCard>

      {modal && <EpreuveModal espace="admin" mcs={mcs} onClose={() => setModal(false)} onSaved={apresAjout} />}
      {confirmNode}
    </>
  );
}

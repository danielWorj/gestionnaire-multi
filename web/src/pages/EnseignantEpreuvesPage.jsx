import { useMemo, useState } from 'react';
import { EspaceTitre, useMonEspace } from '../components/Espace';
import EpreuveModal from '../components/EpreuveModal';
import PagerServeur from '../components/PagerServeur';
import Select from '../components/Select';
import { SkelListe } from '../components/Skeleton';
import { IconBtn, formatDate, useConfirm, useToast } from '../components/ui';
import {
  EPREUVES_PAR_PAGE_ENSEIGNANT, classesDe, formaterTaille, listerEpreuves, matieresDe,
  styleEpreuve, supprimerEpreuve,
} from '../lib/epreuves';
import { usePaginationServeur } from '../lib/paginationServeur';

// « Épreuves » de l'enseignant : ses épreuves, 6 par page (pagination côté
// serveur), filtrables par classe et matière, et ajout d'une épreuve dans
// l'une de ses classes. Les classes et matières viennent de /mon-espace.
export default function EnseignantEpreuvesPage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const espace = useMonEspace('/enseignant');
  const mcs = useMemo(() => espace.data?.matieres_classe || [], [espace.data]);
  const [filtres, setFiltres] = useState({ classe: '', matiere: '' });
  const [modal, setModal] = useState(false);

  const classes = useMemo(() => classesDe(mcs), [mcs]);
  const matieres = useMemo(() => matieresDe(mcs, filtres.classe), [mcs, filtres.classe]);
  const filtre = Boolean(filtres.classe || filtres.matiere);

  const pagination = usePaginationServeur({
    perPage: EPREUVES_PAR_PAGE_ENSEIGNANT,
    filtres,
    charger: ({ page, perPage }) => listerEpreuves('enseignant', {
      page, perPage, classeId: filtres.classe, matiereId: filtres.matiere,
    }),
  });
  const { items, loading, error } = pagination;

  // Changer de classe retire le filtre matière s'il n'y est pas enseigné.
  const changerClasse = (classe) => setFiltres((f) => ({
    classe,
    matiere: classe && f.matiere && !matieresDe(mcs, classe).some((m) => String(m.id) === f.matiere) ? '' : f.matiere,
  }));

  const supprimer = async (epreuve) => {
    const ok = await confirm(`Supprimer l'épreuve « ${epreuve.titre} » ?`, { details: 'Le fichier sera définitivement supprimé.' });
    if (!ok) return;
    try {
      await supprimerEpreuve('enseignant', epreuve.id);
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
      <EspaceTitre titre="Épreuves" sousTitre="Déposez vos épreuves, classe par classe" icon="bx-file">
        <button type="button" className="btn btn-primary" onClick={() => setModal(true)} disabled={!mcs.length}>
          <i className="bx bx-plus me-1" />Ajouter<span className="d-none d-sm-inline">&nbsp;une épreuve</span>
        </button>
      </EspaceTitre>

      {espace.error && !espace.data && <div className="alert alert-warning"><i className="bx bx-error me-2" />{espace.error.message}</div>}

      {mcs.length > 0 && (
        <div className="esp-filtres">
          <div className="flex-fill min-w-0">
            <Select className="form-select" value={filtres.classe} onChange={(e) => changerClasse(e.target.value)} aria-label="Filtrer par classe">
              <option value="">Toutes les classes</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </div>
          <div className="flex-fill min-w-0">
            <Select className="form-select" value={filtres.matiere} onChange={(e) => setFiltres((f) => ({ ...f, matiere: e.target.value }))} aria-label="Filtrer par matière">
              <option value="">Toutes les matières</option>
              {matieres.map((m) => <option key={m.id} value={m.id}>{m.libelle}</option>)}
            </Select>
          </div>
          {filtre && (
            <button type="button" className="btn btn-outline-secondary flex-shrink-0" onClick={() => setFiltres({ classe: '', matiere: '' })}>
              <i className="bx bx-reset me-1" />Réinitialiser
            </button>
          )}
        </div>
      )}

      {loading && !items.length ? (
        <SkelListe lignes={4} label="Chargement des épreuves…" />
      ) : error ? (
        <div className="alert alert-danger"><i className="bx bx-error-circle me-2" />{error}</div>
      ) : !items.length ? (
        <div className="esp-vide">
          <i className="bx bx-file-blank" />
          {filtre ? 'Aucune épreuve ne correspond à ces filtres.' : "Vous n'avez pas encore déposé d'épreuve."}
        </div>
      ) : (
        <>
          <div className={`esp-liste-rapide${loading ? ' opacity-50' : ''}`} aria-busy={loading || undefined}>
            {items.map((epreuve) => {
              const { icone, ton } = styleEpreuve(epreuve.mime);
              return (
                <div key={epreuve.id} className="esp-ligne-rapide">
                  <div className="avatar flex-shrink-0">
                    <span className={`avatar-initial rounded bg-label-${ton}`}><i className={`bx ${icone}`} /></span>
                  </div>
                  <div className="esp-ligne-rapide-texte">
                    <div className="esp-ligne-rapide-titre" title={epreuve.titre}>{epreuve.titre}</div>
                    <small className="text-muted d-block text-truncate">{epreuve.matiere_libelle} · {epreuve.classe_label}</small>
                    <small className="text-muted d-block text-truncate">{formatDate(epreuve.created_at)} · {formaterTaille(epreuve.taille)}</small>
                  </div>
                  <IconBtn icon="bx-trash" title="Supprimer" danger onClick={() => supprimer(epreuve)} disabled={loading} />
                </div>
              );
            })}
          </div>
          <PagerServeur pagination={pagination} bordure={false} />
        </>
      )}

      {modal && <EpreuveModal espace="enseignant" mcs={mcs} onClose={() => setModal(false)} onSaved={apresAjout} />}
      {confirmNode}
    </>
  );
}

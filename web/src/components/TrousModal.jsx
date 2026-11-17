import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import Modal from './Modal';
import { parseSaisie } from './SaisieNote';
import { SkelListe } from './Skeleton';
import { useToast } from './ui';

// Notes manquantes avant de générer un bulletin ou un procès-verbal (cf.
// server/services/trous_services.py). Pour chaque trou : saisir la note
// (« abs » = absent) ou dispenser l'élève (coefficient annulé pour lui sur
// cette séquence). Titulaire, censeur, Admin et SuperAdmin.

const cleTrou = (eleve, t) => `${eleve.inscription_id}|${t.matiere_classe_id}|${t.sequence_id}|${t.composante || ''}`;

// Avant une génération : liste les trous de la période ; s'il y en a, ouvre
// la fenêtre, sinon lance l'action tout de suite. Un compte sans droit sur
// les trous (Surveillant…) génère directement.
export function useVerificationTrous({ classeId, annee, periode, onModifie }) {
  const [etat, setEtat] = useState(null); // { donnees, action }
  const verifierPuis = useCallback(async (action) => {
    try {
      const donnees = await api.get(`/trous/?${new URLSearchParams({ classe_id: classeId, annee_scolaire_id: annee, periode })}`);
      if (!donnees.nb_trous) return action();
      setEtat({ donnees, action });
    } catch {
      return action();
    }
    return undefined;
  }, [classeId, annee, periode]);
  const fenetre = etat && (
    <TrousModal
      donneesInitiales={etat.donnees}
      requete={{ classe_id: classeId, annee_scolaire_id: annee, periode }}
      onModifie={onModifie}
      onClose={() => setEtat(null)}
      onContinuer={() => { const { action } = etat; setEtat(null); action(); }}
    />
  );
  return { verifierPuis, fenetre };
}

export default function TrousModal({ donneesInitiales, requete, onClose, onContinuer, onModifie }) {
  const toast = useToast();
  const [donnees, setDonnees] = useState(donneesInitiales);
  const [chargement, setChargement] = useState(!donneesInitiales);
  const [saisies, setSaisies] = useState({});
  const [occupe, setOccupe] = useState(null);
  const [modifie, setModifie] = useState(false);

  const recharger = useCallback(async () => {
    setChargement(true);
    try {
      setDonnees(await api.get(`/trous/?${new URLSearchParams(requete)}`));
    } catch (e) {
      toast(`Notes manquantes : ${e.message}`, 'error');
    } finally {
      setChargement(false);
    }
  }, [requete, toast]);

  useEffect(() => {
    if (!donneesInitiales) recharger();
  }, [donneesInitiales, recharger]);

  // Retire un trou traité de la liste (sans tout recharger).
  const retirer = (eleve, trou) => setDonnees((d) => {
    const cle = cleTrou(eleve, trou);
    const eleves = d.eleves
      .map((e) => (e.inscription_id === eleve.inscription_id ? { ...e, trous: e.trous.filter((t) => cleTrou(e, t) !== cle) } : e))
      .filter((e) => e.trous.length);
    return { ...d, eleves, nb_trous: d.nb_trous - 1 };
  });

  const cible = (eleve, t) => ({ inscription_id: eleve.inscription_id, matiere_classe_id: t.matiere_classe_id, sequence_id: t.sequence_id });

  const enregistrer = async (eleve, t) => {
    const cle = cleTrou(eleve, t);
    const p = parseSaisie(saisies[cle] ?? '');
    if (!p.ok || (p.valeur === null && !p.absent)) {
      toast('Saisissez une note entre 0 et 20 (ex : 12,5), ou « abs » pour absent.', 'error');
      return;
    }
    setOccupe(cle);
    try {
      await api.post('/trous/note', { ...cible(eleve, t), ...(t.composante ? { composante: t.composante } : {}), valeur: p.valeur, absent: p.absent });
      retirer(eleve, t);
      setModifie(true);
      onModifie?.();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setOccupe(null);
    }
  };

  const dispenser = async (eleve, t) => {
    const cle = cleTrou(eleve, t);
    setOccupe(cle);
    try {
      await api.post('/trous/dispense', cible(eleve, t));
      // Une dispense couvre toute la séquence de la matière (toutes ses évaluations).
      setDonnees((d) => {
        const eleves = d.eleves.map((e) => (e.inscription_id === eleve.inscription_id
          ? { ...e, trous: e.trous.filter((x) => !(x.matiere_classe_id === t.matiere_classe_id && x.sequence_id === t.sequence_id)) }
          : e)).filter((e) => e.trous.length);
        return { ...d, eleves, nb_trous: eleves.reduce((n, e) => n + e.trous.length, 0) };
      });
      setModifie(true);
      onModifie?.();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setOccupe(null);
    }
  };

  const reste = donnees?.nb_trous || 0;

  return (
    <Modal
      size="modal-xl"
      title={<><i className="bx bx-error-circle text-warning me-2" />Notes manquantes</>}
      subtitle={donnees ? `${donnees.titre} — ${reste} note${reste > 1 ? 's' : ''} manquante${reste > 1 ? 's' : ''} pour ${donnees.eleves.length} élève${donnees.eleves.length > 1 ? 's' : ''}` : ''}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose}>Annuler</button>
          <button type="button" className={`btn ${reste ? 'btn-warning' : 'btn-primary'}`} onClick={onContinuer} disabled={chargement}>
            <i className="bx bx-right-arrow-alt me-1" />{reste ? `Générer quand même (${reste} manquante${reste > 1 ? 's' : ''})` : 'Générer'}
          </button>
        </>
      )}
    >
      <p className="text-muted small mb-3">
        Pour chaque note manquante : saisissez-la (« abs » pour un élève absent), ou <strong>dispensez</strong> l'élève de la matière —
        son coefficient est alors annulé pour lui sur cette séquence (ni points, ni coefficient).
        {modifie && ' Les moyennes seront recalculées à la génération.'}
      </p>
      {chargement ? (
        <SkelListe lignes={6} label="Recherche des notes manquantes…" />
      ) : !reste ? (
        <div className="alert alert-success mb-0"><i className="bx bx-check-circle me-1" />Plus aucune note ne manque : vous pouvez générer.</div>
      ) : (
        <div className="table-responsive" style={{ maxHeight: '60vh' }}>
          <table className="table table-sm align-middle mb-0">
            <thead className="table-light" style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr><th>Élève</th><th>Matière</th><th>Séquence</th><th style={{ width: 120 }}>Note</th><th className="text-end">Actions</th></tr>
            </thead>
            <tbody>
              {donnees.eleves.map((eleve) => eleve.trous.map((t, k) => {
                const cle = cleTrou(eleve, t);
                return (
                  <tr key={cle}>
                    {k === 0 && (
                      <td rowSpan={eleve.trous.length} className="fw-semibold" style={{ verticalAlign: 'top' }}>
                        {eleve.nom} {eleve.prenom}
                        {eleve.matricule && <div className="small text-muted fw-normal">{eleve.matricule}</div>}
                      </td>
                    )}
                    <td>
                      {t.matiere} <span className="badge bg-label-secondary">coef {t.coefficient}</span>
                      {t.enseignant && <div className="small text-muted">{t.enseignant}</div>}
                    </td>
                    <td>{t.sequence}{t.evaluation && <span className="badge bg-label-info ms-1">{t.evaluation}</span>}</td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="form-control form-control-sm"
                        placeholder="— / 20"
                        aria-label={`Note de ${eleve.nom} ${eleve.prenom} en ${t.matiere}`}
                        value={saisies[cle] ?? ''}
                        disabled={occupe === cle}
                        onChange={(e) => setSaisies((s) => ({ ...s, [cle]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); enregistrer(eleve, t); } }}
                      />
                    </td>
                    <td className="text-end text-nowrap">
                      <button type="button" className="btn btn-sm btn-primary me-1" disabled={occupe === cle || !(saisies[cle] || '').trim()} onClick={() => enregistrer(eleve, t)}>
                        <i className="bx bx-check me-1" />Enregistrer
                      </button>
                      <button type="button" className="btn btn-sm btn-outline-secondary" disabled={occupe === cle} onClick={() => dispenser(eleve, t)} title="Annuler le coefficient de cette matière pour cet élève sur cette séquence">
                        <i className="bx bx-block me-1" />Dispenser
                      </button>
                    </td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

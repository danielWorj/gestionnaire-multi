import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Modal from './Modal';

// Historique des modifications (journal d'audit, cf. server/api/audit_api.py) :
// qui a créé / modifié / supprimé quoi, et quand. Consultation à la demande
// seulement — l'enregistrement est automatique et invisible au quotidien.

export const TABLES_AUDIT = {
  note: 'Note', discipline: 'Discipline', horaire: 'Emploi du temps', eleve: 'Élève', parent: 'Parent',
  inscription: 'Inscription', paiement: 'Paiement', ligne_paiement: 'Ligne de paiement', tranche_classe: 'Échéancier',
  utilisateur: 'Compte', utilisateur_role: 'Rôle de compte', super_admin: 'Compte SuperAdmin', etablissement: 'Établissement',
  cycle: 'Cycle', classe: 'Classe', annee_scolaire: 'Année scolaire', trimestre: 'Trimestre', sequence: 'Séquence',
  groupe_matiere: 'Groupe de matières', matiere: 'Matière', matiere_classe: 'Matière-classe', departement: 'Département',
  grade: 'Grade', enseignant: 'Enseignant', censeur: 'Censeur', surveillant: 'Surveillant',
  titulaire_classe: 'Titulaire de classe', censeur_classe: 'Classe du censeur', surveillant_classe: 'Classe du surveillant',
  creneau_horaire: 'Créneau horaire',
};

const ACTIONS = {
  creation: { label: 'Création', cls: 'bg-label-success', icon: 'bx-plus' },
  modification: { label: 'Modification', cls: 'bg-label-warning', icon: 'bx-edit-alt' },
  suppression: { label: 'Suppression', cls: 'bg-label-danger', icon: 'bx-trash' },
};

const CHAMPS = {
  valeur: 'Note', absent: 'Absent', saisie_le: 'Saisie le', absences_justifiees: 'Absences justifiées',
  absences_non_justifiees: 'Absences non justifiées', retards: 'Retards', exclusions: 'Exclusions',
  observation: 'Observation', montant_total: 'Montant', montant_verse: 'Montant versé', mode_paiement: 'Mode de paiement',
  numero_recu: 'N° de reçu', reference_transaction: 'Référence', motif_annulation: "Motif d'annulation",
  date_paiement: 'Date du paiement', date_inscription: "Date d'inscription", date_naissance: 'Date de naissance',
  lieu_naissance: 'Lieu de naissance', mot_de_passe_hash: 'Code PIN', jour_semaine: 'Jour', creneau_id: 'Créneau',
};

const champLabel = (cle) => CHAMPS[cle] || (cle.endsWith('_id')
  ? `${cle.slice(0, -3).replace(/_/g, ' ')} (n°)` : cle.replace(/_/g, ' ')).replace(/^./, (c) => c.toUpperCase());

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/;

export function fmtHorodatage(iso) {
  if (!iso) return '—';
  // Le serveur stocke en UTC naïf : on le dit au navigateur.
  const d = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
  return d.toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtValeur(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if (typeof v === 'string' && ISO.test(v)) {
    return v.length <= 10 ? new Date(`${v}T00:00:00`).toLocaleDateString('fr-FR') : fmtHorodatage(v);
  }
  return String(v);
}

export function Auteur({ auteur }) {
  if (!auteur) return null;
  if (auteur.type === 'systeme') return <span className="text-muted">Système (import ou script)</span>;
  return (
    <span>
      <strong>{auteur.nom || (auteur.type === 'anonyme' ? 'Inconnu' : `Compte n°${auteur.id}`)}</strong>
      {auteur.role && <span className="text-muted"> · {auteur.role}</span>}
    </span>
  );
}

// `nomEtablissement(id)` (facultatif) : affiche l'établissement concerné
// (journal du SuperAdmin sur tout le réseau).
export function EntreeAudit({ entree, avecCible = false, nomEtablissement = null }) {
  const action = ACTIONS[entree.action] || { label: entree.action, cls: 'bg-label-secondary', icon: 'bx-info-circle' };
  const changements = Object.entries(entree.changements || {});
  return (
    <li className="audit-entree">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
        <span className={`badge ${action.cls}`}><i className={`bx ${action.icon} me-1`} />{action.label}</span>
        {avecCible && <span className="fw-semibold">{TABLES_AUDIT[entree.table] || entree.table} n°{entree.ligne_id}</span>}
        {nomEtablissement && (
          <span className="badge bg-label-secondary"><i className="bx bx-buildings me-1" />{entree.etablissement_id ? nomEtablissement(entree.etablissement_id) : 'Plateforme'}</span>
        )}
        <span className="small"><Auteur auteur={entree.auteur} /></span>
        <span className="small text-muted ms-auto"><i className="bx bx-time-five me-1" />{fmtHorodatage(entree.horodatage)}</span>
      </div>
      {entree.saisi_hors_ligne_le && (
        <div className="small text-warning mb-1"><i className="bx bx-wifi-off me-1" />Saisi hors connexion le {fmtHorodatage(entree.saisi_hors_ligne_le)}, synchronisé ensuite.</div>
      )}
      {changements.length > 0 && (
        <ul className="audit-changements small mb-0">
          {changements.map(([cle, [avant, apres]]) => (
            <li key={cle}>
              <span className="text-muted">{champLabel(cle)} :</span>{' '}
              {entree.action === 'creation' ? <strong>{fmtValeur(apres)}</strong>
                : entree.action === 'suppression' ? <s>{fmtValeur(avant)}</s>
                  : <><s className="text-muted">{fmtValeur(avant)}</s> <i className="bx bx-right-arrow-alt" /> <strong>{fmtValeur(apres)}</strong></>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ListeAudit({ items, avecCible = false, nomEtablissement = null }) {
  return <ul className="audit-liste list-unstyled mb-0">{items.map((e) => <EntreeAudit key={e.id} entree={e} avecCible={avecCible} nomEtablissement={nomEtablissement} />)}</ul>;
}

// Historique d'une donnée précise : <HistoriqueModal table="note" ligneId={12} titre="…" onClose={…} />
export function HistoriqueModal({ table, ligneId, titre, onClose }) {
  const [etat, setEtat] = useState({ chargement: true, items: [], erreur: null });
  useEffect(() => {
    let annule = false;
    api.get(`/audit/?table=${encodeURIComponent(table)}&ligne_id=${encodeURIComponent(ligneId)}&limite=200`)
      .then((d) => { if (!annule) setEtat({ chargement: false, items: d.items || [], erreur: null }); })
      .catch((e) => { if (!annule) setEtat({ chargement: false, items: [], erreur: e.message }); });
    return () => { annule = true; };
  }, [table, ligneId]);
  return (
    <Modal title="Historique des modifications" subtitle={titre || `${TABLES_AUDIT[table] || table} n°${ligneId}`} onClose={onClose}
      footer={<button type="button" className="btn btn-outline-secondary" onClick={onClose}>Fermer</button>}>
      {etat.chargement ? <div className="text-center py-4"><span className="spinner-border spinner-border-sm me-2" />Chargement…</div>
        : etat.erreur ? <div className="alert alert-danger mb-0">{etat.erreur}</div>
          : etat.items.length ? <ListeAudit items={etat.items} />
            : <div className="text-center text-muted py-4"><i className="bx bx-history bx-md d-block mb-2" />Aucune modification enregistrée depuis la mise en place du journal.</div>}
    </Modal>
  );
}

// Bouton « Historique » à poser sur une fiche (Admin / SuperAdmin / Censeur).
export function BoutonHistorique({ table, ligneId, titre, className = 'btn btn-sm btn-outline-secondary' }) {
  const [ouvert, setOuvert] = useState(false);
  return (
    <>
      <button type="button" className={className} title="Historique des modifications" onClick={() => setOuvert(true)}>
        <i className="bx bx-history" /><span className="d-none d-md-inline ms-1">Historique</span>
      </button>
      {ouvert && <HistoriqueModal table={table} ligneId={ligneId} titre={titre} onClose={() => setOuvert(false)} />}
    </>
  );
}

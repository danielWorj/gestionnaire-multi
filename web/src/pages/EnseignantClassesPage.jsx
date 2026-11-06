import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Avancement, BarreClasse, ClassesGrille, EspaceTitre, useMonEspace } from '../components/Espace';
import { EleveIdentite, filtrerRoster } from '../components/NotesCommun';
import { useToast } from '../components/ui';
import './notes.css';
import { SkelSaisie } from '../components/Skeleton';

// « Mes classes » de l'enseignant : cartes des classes où il enseigne, puis,
// pour la classe choisie, ses matières (accès direct à la saisie) et la liste
// des élèves.

export default function EnseignantClassesPage() {
  const espace = useMonEspace('/enseignant');
  const [params, setParams] = useSearchParams();
  const classeId = params.get('classe');
  const data = espace.data || {};
  const mcs = useMemo(() => espace.data?.matieres_classe || [], [espace.data]);
  const sequence = data.sequence_courante;

  const classes = useMemo(() => {
    const map = new Map();
    mcs.forEach((mc) => {
      const c = map.get(mc.classe_id) || { id: mc.classe_id, label: mc.classe_label, cycle: mc.cycle_libelle, effectif: mc.effectif, matieres: [], saisies: 0 };
      c.matieres.push(mc);
      c.saisies += Math.min(mc.notes_saisies || 0, mc.effectif || 0);
      map.set(mc.classe_id, c);
    });
    return [...map.values()].sort((a, b) => (a.label || '').localeCompare(b.label || '', 'fr'));
  }, [mcs]);

  if (!classeId) {
    const items = classes.map((c) => ({
      key: c.id,
      cycle: c.cycle,
      titre: c.label,
      sousTitre: c.matieres.map((m) => m.matiere_libelle).join(' · '),
      effectif: c.effectif,
      avancement: sequence ? { saisies: c.saisies, attendues: (c.effectif || 0) * c.matieres.length, libelle: sequence.libelle } : null,
      onClick: () => setParams({ classe: String(c.id) }),
    }));
    return (
      <>
        <EspaceTitre titre="Mes classes" sousTitre="Choisissez une classe pour voir ses élèves" icon="bx-group" />
        {espace.error && !espace.data && <div className="alert alert-warning"><i className="bx bx-error me-2" />{espace.error.message}</div>}
        <ClassesGrille items={items} loading={espace.loading} vide="Aucune classe ne vous a encore été attribuée. Contactez l'administration de votre établissement." />
      </>
    );
  }

  const classe = classes.find((c) => String(c.id) === String(classeId));
  const annee = (data.annees_scolaires || []).find((a) => a.active) || (data.annees_scolaires || [])[0];
  return (
    <>
      <BarreClasse
        titre="Mes classes"
        classe={classe?.label || (espace.loading ? '…' : `Classe #${classeId}`)}
        cycle={classe?.cycle}
        effectif={classe?.effectif}
        onChanger={() => setParams({})}
      />
      {classe && (
        <>
          <h6 className="esp-groupe-titre">Mes matières dans cette classe</h6>
          <div className="esp-liste-rapide mb-4">
            {classe.matieres.map((mc) => (
              <Link key={mc.id} to={`/enseignant/notes?mc=${mc.id}`} className="esp-ligne-rapide">
                <div className="esp-ligne-rapide-texte">
                  <div className="esp-ligne-rapide-titre">{mc.matiere_libelle} <small className="text-muted fw-normal">· coef. {mc.coefficient}</small></div>
                  {sequence && <Avancement saisies={mc.notes_saisies} attendues={mc.effectif} libelle={sequence.libelle} />}
                </div>
                <span className="btn btn-sm btn-primary flex-shrink-0"><i className="bx bx-edit me-1" />Saisir</span>
              </Link>
            ))}
          </div>
          {annee && <ListeEleves classeId={classeId} anneeId={annee.id} />}
        </>
      )}
    </>
  );
}

function ListeEleves({ classeId, anneeId }) {
  const toast = useToast();
  const [roster, setRoster] = useState(null);
  const [recherche, setRecherche] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get(`/enseignant/roster?classe_id=${classeId}&annee_scolaire_id=${anneeId}`)
      .then((r) => { if (!cancelled) setRoster(r || []); })
      .catch((e) => { if (!cancelled) { setRoster([]); toast(`Liste des élèves : ${e.message}`, 'error'); } });
    return () => { cancelled = true; };
  }, [classeId, anneeId, toast]);

  const eleves = useMemo(() => filtrerRoster(roster || [], recherche), [roster, recherche]);
  const filles = (roster || []).filter((e) => e.sexe === 'F').length;

  return (
    <>
      <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
        <h6 className="esp-groupe-titre mb-0">Élèves <span>{roster ? roster.length : '…'}</span></h6>
        {roster && <small className="text-muted">{filles} fille(s) · {roster.length - filles} garçon(s)</small>}
      </div>
      {roster && roster.length > 8 && (
        <div className="esp-recherche mb-2">
          <i className="bx bx-search" />
          <input type="search" className="form-control" placeholder="Rechercher un élève…" value={recherche} onChange={(e) => setRecherche(e.target.value)} aria-label="Rechercher un élève" />
        </div>
      )}
      <div className="saisie-liste">
        {roster === null ? (
          <SkelSaisie avecNote={false} />
        ) : !eleves.length ? (
          <div className="saisie-vide"><i className="bx bx-user-x me-1" />{roster.length ? 'Aucun élève ne correspond.' : 'Aucun élève inscrit dans cette classe.'}</div>
        ) : eleves.map((eleve, idx) => (
          <div key={eleve.inscription_id} className="saisie-ligne saisie-ligne-simple">
            <span className="saisie-num">{idx + 1}</span>
            <EleveIdentite eleve={eleve} />
            <span className={`sexe-badge sexe-${eleve.sexe || '?'}`}>{eleve.sexe || '?'}</span>
          </div>
        ))}
      </div>
    </>
  );
}

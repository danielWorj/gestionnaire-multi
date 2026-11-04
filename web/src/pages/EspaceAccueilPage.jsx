import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Avancement, RubriqueCard, useMonEspace } from '../components/Espace';
import { roleInfo, RUBRIQUES } from '../lib/espaces';

// Accueil des espaces Enseignant / Censeur / Surveillant : cartes des
// rubriques, puis ce qui reste à faire sur la séquence en cours.

const ratio = (saisies, attendues) => (attendues ? Math.min(saisies, attendues) / attendues : 1);

export default function EspaceAccueilPage({ role }) {
  const { user } = useAuth();
  const enseignant = role === 'Enseignant';
  const espace = useMonEspace(enseignant ? '/enseignant' : '/censeur');
  const data = espace.data || {};
  const sequence = data.sequence_courante;
  const info = roleInfo(role);
  const prenom = (user?.nom || '').split(/\s+/)[0];

  // Ce qui reste à saisir (enseignant : par matière-classe) ou à suivre
  // (censeur : par classe), du moins avancé au plus avancé.
  let aFaire = [];
  let nbClasses = 0;
  let nbEleves = 0;
  if (enseignant) {
    const mcs = data.matieres_classe || [];
    const classes = new Map(mcs.map((mc) => [mc.classe_id, mc.effectif]));
    nbClasses = classes.size;
    nbEleves = [...classes.values()].reduce((a, b) => a + (b || 0), 0);
    aFaire = mcs
      .filter((mc) => mc.effectif && mc.notes_saisies < mc.effectif)
      .sort((a, b) => ratio(a.notes_saisies, a.effectif) - ratio(b.notes_saisies, b.effectif))
      .map((mc) => ({ key: mc.id, to: `/enseignant/notes?mc=${mc.id}`, titre: `${mc.classe_label} · ${mc.matiere_libelle}`, saisies: mc.notes_saisies, attendues: mc.effectif }));
  } else {
    const classes = data.classes || [];
    nbClasses = classes.length;
    nbEleves = classes.reduce((a, c) => a + (c.effectif || 0), 0);
    aFaire = classes
      .filter((c) => c.notes_attendues && c.notes_saisies < c.notes_attendues)
      .sort((a, b) => ratio(a.notes_saisies, a.notes_attendues) - ratio(b.notes_saisies, b.notes_attendues))
      .map((c) => ({ key: c.id, to: `/notes?classe=${c.id}`, titre: `${c.label} · ${c.matieres_completes}/${c.matieres_total} matières complètes`, saisies: c.notes_saisies, attendues: c.notes_attendues }));
  }

  const badgeNotes = !espace.loading && sequence && aFaire.length ? `${aFaire.length} à compléter` : null;
  const rubriques = RUBRIQUES[role].map((r, i) => ({ ...r, badge: i === 0 ? badgeNotes : null }));

  return (
    <>
      <div className="esp-bienvenue">
        <h4>Bonjour{prenom ? `, ${prenom}` : ''} 👋</h4>
        <p>Espace {info.label.toLowerCase()}{user?.etablissement_nom ? ` · ${user.etablissement_nom}` : ''}</p>
        <div className="esp-bienvenue-meta">
          {sequence && <span><i className="bx bx-calendar" />{sequence.trimestre_libelle ? `${sequence.trimestre_libelle} · ` : ''}{sequence.libelle}</span>}
          {!espace.loading && <span><i className="bx bx-chalkboard" />{nbClasses} classe{nbClasses > 1 ? 's' : ''}</span>}
          {!espace.loading && <span><i className="bx bx-group" />{nbEleves} élève{nbEleves > 1 ? 's' : ''}</span>}
        </div>
      </div>

      {espace.error && !espace.data && (
        <div className="alert alert-warning"><i className="bx bx-error me-2" />{espace.error.message}</div>
      )}

      <div className="esp-grille-rubriques">
        {rubriques.map((r) => <RubriqueCard key={r.to} {...r} />)}
      </div>

      {sequence && !espace.loading && nbClasses > 0 && (
        <>
          <div className="esp-section-titre">
            <span>{enseignant ? 'Notes à compléter' : 'Classes à suivre'} · {sequence.libelle}</span>
            {aFaire.length > 4 && <Link to={enseignant ? '/enseignant/notes' : '/notes'}>Tout voir</Link>}
          </div>
          {aFaire.length ? (
            <div className="esp-liste-rapide">
              {aFaire.slice(0, 4).map((l) => (
                <Link key={l.key} to={l.to} className="esp-ligne-rapide">
                  <div className="esp-ligne-rapide-texte">
                    <div className="esp-ligne-rapide-titre">{l.titre}</div>
                    <Avancement saisies={l.saisies} attendues={l.attendues} libelle={sequence.libelle} />
                  </div>
                  <i className="bx bx-chevron-right" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="esp-vide"><i className="bx bx-check-circle text-success" /><p className="mb-0">Toutes les notes de {sequence.libelle} sont saisies. Bravo !</p></div>
          )}
        </>
      )}
    </>
  );
}

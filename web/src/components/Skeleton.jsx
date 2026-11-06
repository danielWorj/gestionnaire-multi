import { useEffect, useState } from 'react';

// Écrans squelettes (skeleton screens) : pendant un chargement de données,
// on dessine la FORME du contenu attendu (lignes de tableau, liste d'élèves,
// cartes de chiffres…) plutôt qu'un simple « Chargement… ». Sur une connexion
// lente, l'utilisateur voit tout de suite que la page répond et où les
// données vont apparaître.
//
// - Apparition différée (~180 ms, cf. index.css) : une réponse rapide ne
//   provoque pas de clignotement.
// - Après DELAI_LENT_MS, un message signale que la connexion est lente
//   (le chargement continue : api.js bascule de lui-même sur la copie locale
//   quand elle existe).
// - Accessibilité : les blocs gris sont aria-hidden ; un libellé
//   « Chargement… » est annoncé aux lecteurs d'écran (role="status").
//
// Les boutons d'action (Enregistrer, Se connecter, PDF…) gardent leur
// spinner : on y attend la confirmation d'une action, pas un contenu.

const DELAI_LENT_MS = 8000;

// Largeurs « pseudo-aléatoires » mais stables d'un rendu à l'autre (pas de
// Math.random : pas de saut visuel à chaque re-rendu).
const LARGEURS = [72, 55, 86, 64, 48, 92, 60, 78, 52, 68];
const largeur = (i) => `${LARGEURS[i % LARGEURS.length]}%`;

export function useConnexionLente(actif = true) {
  const [lente, setLente] = useState(false);
  useEffect(() => {
    if (!actif) return undefined;
    const t = setTimeout(() => setLente(true), DELAI_LENT_MS);
    return () => clearTimeout(t);
  }, [actif]);
  return lente;
}

export function MessageLent() {
  return (
    <div className="skel-lent">
      <i className="bx bx-wifi-1 me-1" />
      Connexion lente : le chargement continue…
    </div>
  );
}

/** Bloc gris élémentaire. `w` / `h` : dimensions CSS ; `rond` : cercle (avatar). */
export function Skel({ w = '100%', h, rond = false, className = '', style }) {
  return (
    <span
      className={`skel${rond ? ' skel-rond' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: w, height: h, ...style }}
      aria-hidden="true"
    />
  );
}

/** Conteneur d'un squelette hors tableau : apparition différée, libellé
 *  accessible et message « connexion lente ». */
export function SkelZone({ label = 'Chargement…', className = '', children }) {
  const lente = useConnexionLente();
  return (
    <div className={`skel-zone ${className}`} role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {children}
      {lente && <MessageLent />}
    </div>
  );
}

/** Lignes de tableau squelettes, à placer dans un <tbody>. */
export function SkelLignesTableau({ colonnes = 4, lignes = 5, label = 'Chargement…' }) {
  const lente = useConnexionLente();
  const n = Math.max(1, colonnes);
  return (
    <>
      {Array.from({ length: lignes }, (_, r) => (
        <tr key={r} className="skel-tr" aria-hidden={r > 0 ? 'true' : undefined}>
          {Array.from({ length: n }, (_, c) => (
            <td key={c}>
              {r === 0 && c === 0 && <span className="visually-hidden" role="status">{label}</span>}
              <Skel w={c === n - 1 && n > 2 ? '40%' : largeur(r * 3 + c)} />
            </td>
          ))}
        </tr>
      ))}
      {lente && (
        <tr className="skel-tr">
          <td colSpan={n}><MessageLent /></td>
        </tr>
      )}
    </>
  );
}

/** Liste d'élèves (grilles de saisie / consultation des notes, discipline,
 *  liste de classe) : n°, nom + matricule, case de note à droite. */
export function SkelSaisie({ lignes = 8, avecNote = true, label = 'Chargement de la liste…' }) {
  return (
    <SkelZone label={label}>
      {Array.from({ length: lignes }, (_, i) => (
        <div key={i} className={`saisie-ligne${avecNote ? '' : ' saisie-ligne-simple'}`}>
          <Skel w="14px" h="0.7rem" className="mx-auto" />
          <div className="skel-pile">
            <Skel w={largeur(i)} h="0.85rem" style={{ maxWidth: 260 }} />
            <Skel w="70px" h="0.65rem" />
          </div>
          {avecNote ? <Skel w="72px" h="46px" className="skel-arrondi" /> : <span />}
        </div>
      ))}
    </SkelZone>
  );
}

/** Liste générique : avatar optionnel + deux lignes de texte par élément
 *  (journal d'audit, administrateurs, liste d'élèves des bulletins…). */
export function SkelListe({ lignes = 5, avatar = false, label, className = '' }) {
  return (
    <SkelZone label={label} className={className}>
      {Array.from({ length: lignes }, (_, i) => (
        <div key={i} className="skel-item">
          {avatar && <Skel w="34px" h="34px" rond />}
          <div className="skel-pile flex-grow-1">
            <Skel w={largeur(i)} h="0.85rem" />
            <Skel w={largeur(i + 4)} h="0.65rem" style={{ maxWidth: '45%' }} />
          </div>
        </div>
      ))}
    </SkelZone>
  );
}

/** Rangée de cartes de chiffres clés (même gabarit que StatCard). */
export function SkelCartes({ nombre = 4, className = 'col-sm-6 col-xl-3', label = 'Chargement des indicateurs…' }) {
  return (
    <SkelZone label={label} className="row g-3 mb-4">
      {Array.from({ length: nombre }, (_, i) => (
        <div key={i} className={className}>
          <div className="card h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div className="skel-pile flex-grow-1">
                  <Skel w="55%" h="0.8rem" />
                  <Skel w="40%" h="1.6rem" />
                </div>
                <Skel w="38px" h="38px" className="skel-arrondi" />
              </div>
              <Skel w="70%" h="0.7rem" className="mt-3" />
            </div>
          </div>
        </div>
      ))}
    </SkelZone>
  );
}

/** Bloc de graphique (carte de tableau de bord). */
export function SkelGraphique({ hauteur = 220 }) {
  return (
    <SkelZone label="Chargement du graphique…">
      <Skel h={`${hauteur}px`} className="skel-arrondi" />
    </SkelZone>
  );
}

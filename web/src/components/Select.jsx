import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './select.css';

// Remplaçant de <select> : même API (value, onChange, <option>, <optgroup>,
// className, disabled, required…), mais avec une liste déroulante stylée et
// une barre de recherche intégrée. Le <select> natif reste dans le DOM,
// invisible : il porte la valeur, la validation `required` et émet le vrai
// événement `change`, si bien que les handlers existants (e.target.value)
// fonctionnent sans modification.

const texte = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(texte).join('');
  if (isValidElement(node)) return texte(node.props.children);
  return '';
};

const normaliser = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Aplatit les enfants (tableaux, fragments, optgroups) en une liste d'options.
function lireOptions(children, groupe = null, acc = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) {
      lireOptions(child.props.children, groupe, acc);
    } else if (child.type === 'optgroup') {
      lireOptions(child.props.children, child.props.label, acc);
    } else if (child.type === 'option') {
      const label = texte(child.props.children);
      acc.push({
        value: String(child.props.value ?? label),
        label,
        disabled: !!child.props.disabled,
        groupe,
      });
    }
  });
  return acc;
}

const MOBILE = '(max-width: 767.98px)';

// Libellé du champ (label[for], ou .form-label qui précède le Select).
function libelleDuChamp(bouton) {
  const sel = bouton?.closest('.sel');
  const label = (bouton?.id && document.querySelector(`label[for="${CSS.escape(bouton.id)}"]`))
    || (sel?.previousElementSibling?.matches('.form-label, label') && sel.previousElementSibling);
  return label?.textContent.replace(/\s*\*\s*$/, '').trim() || '';
}

const setterValeur = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;

export default function Select({
  className = 'form-select',
  style,
  id,
  value,
  defaultValue,
  disabled,
  children,
  placeholder = 'Sélectionner…',
  searchPlaceholder = 'Rechercher…',
  'aria-label': ariaLabel,
  ...rest
}) {
  const options = useMemo(() => lireOptions(children), [children]);
  const nativeRef = useRef(null);
  const triggerRef = useRef(null);
  const panneauRef = useRef(null);
  const listeRef = useRef(null);
  const rechercheRef = useRef(null);
  const listeId = useId();

  const [ouvert, setOuvert] = useState(false);
  const [recherche, setRecherche] = useState('');
  const [actif, setActif] = useState(-1);
  const [position, setPosition] = useState(null);
  // Valeur affichée : celle du <select> natif, relue après chaque rendu
  // (couvre aussi bien `value` contrôlé que `defaultValue`).
  const [courante, setCourante] = useState(value ?? defaultValue ?? '');
  useLayoutEffect(() => {
    if (nativeRef.current) setCourante(nativeRef.current.value);
  });

  const selection = options.find((o) => o.value === String(courante));

  const filtrees = useMemo(() => {
    const q = normaliser(recherche.trim());
    return q ? options.filter((o) => normaliser(o.label).includes(q) || (o.groupe && normaliser(o.groupe).includes(q))) : options;
  }, [options, recherche]);

  const placer = () => {
    // Téléphone : la liste s'ouvre en feuille glissante depuis le bas.
    if (window.matchMedia(MOBILE).matches) {
      setPosition({ feuille: true, titre: ariaLabel || libelleDuChamp(triggerRef.current) });
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const hauteurMax = 320;
    const dessous = window.innerHeight - r.bottom;
    const versLeHaut = dessous < Math.min(hauteurMax, 240) && r.top > dessous;
    const largeur = Math.max(r.width, 220);
    const left = Math.min(r.left, window.innerWidth - largeur - 8);
    setPosition({
      left: Math.max(8, left),
      width: largeur,
      ...(versLeHaut
        ? { bottom: window.innerHeight - r.top + 6, maxHeight: Math.min(hauteurMax, r.top - 16) }
        : { top: r.bottom + 6, maxHeight: Math.min(hauteurMax, dessous - 16) }),
      versLeHaut,
    });
  };

  const ouvrir = (texteInitial = '') => {
    if (disabled) return;
    placer();
    setRecherche(texteInitial);
    setOuvert(true);
  };

  const fermer = (rendreFocus = true) => {
    setOuvert(false);
    if (rendreFocus) triggerRef.current?.focus();
  };

  // À l'ouverture : focus sur la recherche, option sélectionnée en surbrillance.
  useEffect(() => {
    if (!ouvert) return;
    const index = filtrees.findIndex((o) => o.value === String(courante));
    setActif(index >= 0 ? index : filtrees.findIndex((o) => !o.disabled));
    // En feuille, pas de focus automatique : le clavier masquerait la liste.
    if (window.matchMedia(MOBILE).matches) {
      listeRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    } else {
      rechercheRef.current?.focus();
    }
  }, [ouvert]);

  useEffect(() => {
    if (ouvert && recherche) setActif(filtrees.findIndex((o) => !o.disabled));
  }, [recherche]);

  // Fermeture au clic extérieur, repositionnement au défilement / redimensionnement.
  useEffect(() => {
    if (!ouvert) return undefined;
    const surClic = (e) => {
      // Le fond de la feuille se ferme au « click » (pas au mousedown) pour
      // que le tap ne retombe pas sur l'élément situé dessous.
      if (e.target.classList?.contains('sel-fond')) return;
      if (!panneauRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) fermer(false);
    };
    document.addEventListener('mousedown', surClic);
    window.addEventListener('resize', placer);
    window.addEventListener('scroll', placer, true);
    return () => {
      document.removeEventListener('mousedown', surClic);
      window.removeEventListener('resize', placer);
      window.removeEventListener('scroll', placer, true);
    };
  }, [ouvert]);

  // Garde l'option active visible pendant la navigation au clavier.
  useEffect(() => {
    listeRef.current?.querySelector(`[data-index="${actif}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [actif]);

  const choisir = (option) => {
    if (!option || option.disabled) return;
    const select = nativeRef.current;
    if (select && select.value !== option.value) {
      setterValeur.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    fermer();
  };

  const deplacer = (pas) => {
    if (!filtrees.length) return;
    let i = actif;
    for (let n = 0; n < filtrees.length; n += 1) {
      i = (i + pas + filtrees.length) % filtrees.length;
      if (!filtrees[i].disabled) break;
    }
    setActif(i);
  };

  const surToucheRecherche = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); deplacer(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); deplacer(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); choisir(filtrees[actif]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(); }
    else if (e.key === 'Tab') { fermer(false); }
  };

  const surToucheBouton = (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      ouvrir();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      ouvrir(e.key);
    }
  };

  const classesBouton = `${className} sel-trigger${ouvert ? ' sel-trigger-ouvert' : ''}`;

  let groupePrecedent = null;
  const feuille = !!position?.feuille;
  const avecRecherche = !feuille || options.length > 7;
  const panneau = ouvert && position && createPortal(
    <>
      {feuille && <div className="sel-fond" onClick={() => fermer(false)} />}
      <div
        ref={panneauRef}
        className={`sel-panneau${position.versLeHaut ? ' sel-panneau-haut' : ''}${feuille ? ' sel-panneau-feuille' : ''}`}
        style={feuille ? undefined : { left: position.left, width: position.width, top: position.top, bottom: position.bottom, maxHeight: position.maxHeight }}
        role={feuille ? 'dialog' : undefined}
        aria-label={feuille ? ariaLabel : undefined}
      >
        {feuille && position.titre && <div className="sel-titre">{position.titre}</div>}
        {avecRecherche && (
          <div className="sel-recherche">
            <i className="bx bx-search" />
            <input
              ref={rechercheRef}
              type="text"
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
              onKeyDown={surToucheRecherche}
              placeholder={searchPlaceholder}
              aria-controls={listeId}
              aria-activedescendant={actif >= 0 ? `${listeId}-${actif}` : undefined}
            />
            {recherche && (
              <button type="button" className="sel-effacer" onClick={() => { setRecherche(''); rechercheRef.current?.focus(); }} aria-label="Effacer">
                <i className="bx bx-x" />
              </button>
            )}
          </div>
        )}
        <ul ref={listeRef} id={listeId} className="sel-liste" role="listbox">
          {filtrees.length === 0 && (
            <li className="sel-vide"><i className="bx bx-search-alt" />Aucun résultat</li>
          )}
          {filtrees.map((o, i) => {
            const entete = o.groupe && o.groupe !== groupePrecedent;
            groupePrecedent = o.groupe;
            const choisie = o.value === String(courante);
            return (
              <Fragment key={`${o.value}-${i}`}>
                {entete && <li className="sel-groupe">{o.groupe}</li>}
                <li
                  id={`${listeId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={choisie}
                  aria-disabled={o.disabled || undefined}
                  className={`sel-option${choisie ? ' sel-option-choisie' : ''}${i === actif ? ' sel-option-active' : ''}${o.disabled ? ' sel-option-desactivee' : ''}${o.groupe ? ' sel-option-groupee' : ''}`}
                  onMouseEnter={() => !o.disabled && setActif(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choisir(o)}
                >
                  <span className="sel-option-texte">{o.label || ' '}</span>
                  {choisie && <i className="bx bx-check" />}
                </li>
              </Fragment>
            );
          })}
        </ul>
      </div>
    </>,
    document.body,
  );

  return (
    <div className="sel" style={style}>
      <select
        ref={nativeRef}
        className="sel-natif"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        onFocus={() => triggerRef.current?.focus()}
        {...rest}
      >
        {children}
      </select>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={classesBouton}
        disabled={disabled}
        onClick={() => (ouvert ? fermer() : ouvrir())}
        onKeyDown={surToucheBouton}
        aria-haspopup="listbox"
        aria-expanded={ouvert}
        aria-label={ariaLabel}
      >
        <span className={`sel-valeur${selection?.label ? '' : ' sel-placeholder'}`}>
          {selection?.label || placeholder}
        </span>
      </button>
      {panneau}
    </div>
  );
}

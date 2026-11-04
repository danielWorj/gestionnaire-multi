import { useEffect } from 'react';

// Tableaux en « liste » sur téléphone : chaque ligne devient une fiche, et
// chaque cellule reçoit le libellé de sa colonne (data-label), affiché devant
// la valeur par app-mobile.css. Les tableaux concernés sont les .table
// Bootstrap ayant un <thead> d'au moins 3 colonnes ; on les marque
// .table-liste. Un tableau s'exclut avec la classe .table-garder (grilles de
// saisie, documents imprimables…).

const SELECTEUR = 'table.table:not(.table-garder)';
const COLONNE_NUMERO = /^(#|n°|no|num(éro)?|ordre|rang|)$/i;

function libelles(table) {
  const ligne = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!ligne) return null;
  const out = [];
  for (const th of ligne.cells) {
    const texte = th.textContent.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < (th.colSpan || 1); i += 1) out.push(texte);
  }
  return out;
}

function preparer(table) {
  const noms = libelles(table);
  if (!noms || noms.length < 3) {
    table.classList.remove('table-liste');
    return;
  }
  table.classList.add('table-liste');
  // 1re colonne simple numéro (#, N°, Ordre…) : le titre de la fiche est la 2e.
  table.classList.toggle('table-liste-t2', COLONNE_NUMERO.test(noms[0]));
  for (const corps of table.tBodies) {
    for (const tr of corps.rows) {
      let col = 0;
      for (const td of tr.cells) {
        const nom = td.colSpan > 1 ? '' : noms[col] || '';
        if (td.getAttribute('data-label') !== nom) td.setAttribute('data-label', nom);
        col += td.colSpan || 1;
      }
    }
  }
}

export function useTableauxMobiles(conteneurRef) {
  useEffect(() => {
    const racine = conteneurRef.current;
    if (!racine) return undefined;
    let image = 0;
    const tout = () => {
      image = 0;
      racine.querySelectorAll(SELECTEUR).forEach(preparer);
      // Les modales sont rendues hors du contenu (dans <body>).
      document.querySelectorAll(`.modal ${SELECTEUR}`).forEach(preparer);
    };
    const planifier = () => { if (!image) image = requestAnimationFrame(tout); };
    tout();
    const obs = new MutationObserver(planifier);
    obs.observe(racine, { childList: true, subtree: true });
    obs.observe(document.body, { childList: true });
    return () => {
      obs.disconnect();
      if (image) cancelAnimationFrame(image);
    };
  }, [conteneurRef]);
}

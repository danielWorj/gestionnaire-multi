import { useEffect, useRef, useState } from 'react';

// Pagination CÔTÉ SERVEUR (usePagination, dans components/ui.jsx, découpe une
// liste déjà chargée en entier). Ici, chaque page est demandée à l'API :
// {items, total, page, pages, per_page}.
//
// - `charger({ page, perPage })` : renvoie cette réponse ; il peut lire les
//   filtres courants dans la portée de l'appelant (la dernière version est
//   toujours utilisée).
// - `filtres` : objet sérialisable ; tout changement ramène à la page 1 et
//   recharge, sans requête intermédiaire sur l'ancienne page.
// - Une page demandée trop loin (dernier élément supprimé…) est ramenée à la
//   dernière page par le serveur : on affiche la page renvoyée.
export function usePaginationServeur({ charger, perPage, filtres = {} }) {
  const cle = JSON.stringify(filtres);
  const [demande, setDemande] = useState({ cle, page: 1 });
  const page = demande.cle === cle ? demande.page : 1;
  const [version, setVersion] = useState(0);
  const [etat, setEtat] = useState({ items: [], total: 0, pages: 1, page: 1, loading: true, error: '' });

  // Dernier `charger` (et donc derniers filtres), sans relancer le chargement
  // à chaque rendu. Déclaré avant l'effet de chargement : il s'exécute d'abord.
  const chargerRef = useRef(charger);
  useEffect(() => { chargerRef.current = charger; });

  useEffect(() => {
    let annule = false;
    setEtat((s) => ({ ...s, loading: true, error: '' }));
    Promise.resolve(chargerRef.current({ page, perPage }))
      .then((data) => {
        if (annule) return;
        setEtat({
          items: data?.items || [],
          total: data?.total || 0,
          pages: data?.pages || 1,
          page: data?.page || page,
          loading: false,
          error: '',
        });
      })
      .catch((e) => {
        if (!annule) setEtat({ items: [], total: 0, pages: 1, page: 1, loading: false, error: e.message });
      });
    return () => { annule = true; };
  }, [cle, page, perPage, version]);

  const start = etat.total ? (etat.page - 1) * perPage : 0;
  return {
    ...etat,
    perPage,
    start,
    end: Math.min(start + etat.items.length, etat.total),
    setPage: (p) => setDemande({ cle, page: p }),
    recharger: () => setVersion((v) => v + 1),
  };
}

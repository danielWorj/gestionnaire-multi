import { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Établissement courant pour les en-têtes de documents imprimables (listes
// de classe, bulletins) : comme dans les anciens templates, on tente
// GET /etablissements/<id> (réservé SuperAdmin côté serveur) et, en cas
// d'échec silencieux, on retombe sur le nom porté par la session.
export function useEtablissementCourant() {
  const { user, isSuperAdmin, etablissements, activeEtablissementId } = useAuth();
  const [etablissement, setEtablissement] = useState(null);

  const fromList = isSuperAdmin ? etablissements.find((e) => e.id === activeEtablissementId) : null;
  const etabId = user?.etablissement_id;

  useEffect(() => {
    if (isSuperAdmin || !etabId) return undefined;
    let cancelled = false;
    apiRequest(`/etablissements/${etabId}`)
      .then((data) => { if (!cancelled) setEtablissement(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isSuperAdmin, etabId]);

  if (fromList) return fromList;
  return etablissement || (user?.etablissement_nom ? { nom: user.etablissement_nom } : null);
}

export default function EnteteEtablissement({ etablissement: e }) {
  return (
    <div className="print-head">
      {e?.logo_url && <img src={e.logo_url} className="print-logo" alt="" />}
      <div>
        <div className="print-etab">{e?.nom || 'Établissement'}</div>
        {e?.nom_bilingue && <div className="print-etab-sub">{e.nom_bilingue}</div>}
        <div className="print-etab-sub">{[e?.adresse, e?.bp ? `BP ${e.bp}` : null, e?.telephone ? `Tél. ${e.telephone}` : null].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
}

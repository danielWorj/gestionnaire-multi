import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { classeLabel as baseClasseLabel, PageHeader } from '../components/ui';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import GenerateurListeClasse from '../components/ListeClasse';
import { SkelZone } from '../components/Skeleton';

// « Listes de classe » : impression et export CSV ouverts à TOUS les
// profils, chacun sur ses classes (toutes pour l'administration, le
// secrétariat et la comptabilité ; classes assignées pour le censeur et le
// surveillant ; classes enseignées pour l'enseignant) — périmètre et
// colonnes décidés par le serveur (GET /api/listes-classes/).

const classeLabel = (c) => (c ? baseClasseLabel(c, [], ' · ') : '—');

export default function ListesClassesPage() {
  const { activeEtablissementId } = useAuth();
  const etablissement = useEtablissementCourant();
  const [contexte, setContexte] = useState(null);
  const [annee, setAnnee] = useState('');
  const [lignes, setLignes] = useState([]);
  const [chargement, setChargement] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let annule = false;
    setContexte(null);
    setError('');
    api.get('/listes-classes/')
      .then((ctx) => {
        if (annule) return;
        setContexte(ctx);
        const def = (ctx.annees_scolaires.find((a) => a.active) || ctx.annees_scolaires[0])?.id;
        setAnnee(def ? String(def) : '');
      })
      .catch((err) => { if (!annule) setError(err.message); });
    return () => { annule = true; };
  }, [activeEtablissementId]);

  const chargerLignes = useCallback(async (anneeId, signal) => {
    if (!anneeId) { setLignes([]); return; }
    setChargement(true);
    try {
      const data = await api.get(`/listes-classes/eleves?annee_scolaire_id=${anneeId}`);
      if (!signal.annule) setLignes(data || []);
    } catch (err) {
      if (!signal.annule) { setLignes([]); setError(err.message); }
    } finally {
      if (!signal.annule) setChargement(false);
    }
  }, []);

  useEffect(() => {
    if (!contexte) return undefined;
    const signal = { annule: false };
    chargerLignes(annee, signal);
    return () => { signal.annule = true; };
  }, [contexte, annee, chargerLignes]);

  return (
    <>
      <PageHeader title="Listes de classe" subtitle="Imprimez ou téléchargez la liste des élèves de vos classes." />
      {error && <div className="alert alert-warning"><i className="bx bx-error me-2" />{error}</div>}
      {!contexte && !error && <SkelZone label="Chargement des classes…"><div style={{ height: 160 }} /></SkelZone>}
      {contexte && (contexte.classes.length ? (
        <GenerateurListeClasse
          lignes={lignes} classes={contexte.classes} classeLabel={classeLabel} annees={contexte.annees_scolaires}
          annee={annee} onAnneeChange={setAnnee} avecParents={contexte.avec_parents} etablissement={etablissement}
          chargement={chargement}
        />
      ) : (
        <div className="card"><div className="card-body text-center text-muted py-5">Aucune classe ne vous est encore attribuée. Contactez l'administration de votre établissement.</div></div>
      ))}
    </>
  );
}

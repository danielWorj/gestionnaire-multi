import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { roleDe } from '../components/Layout';
import { PageHeader, useToast } from '../components/ui';
import Select from '../components/Select';
import { SkelListe } from '../components/Skeleton';
import './notes.css';
import './bulletin.css';

// Document du conseil de classe (séquence, trimestre, année) — calculé et mis
// en page par le serveur (/api/conseil/, cf. server/services/conseil_services.py)
// à partir des mêmes calculs que les bulletins.
// Censeur : le conseil de chacune de ses classes. Admin / SuperAdmin : une
// classe, un niveau, un cycle ou tout l'établissement en une fois.

const PORTEES = [
  { value: 'classe', label: 'Une classe' },
  { value: 'niveau', label: 'Un niveau (classes parallèles)' },
  { value: 'cycle', label: 'Un cycle' },
  { value: 'etablissement', label: "Tout l'établissement" },
];

const nomFichier = (texte) => texte.normalize('NFKD').replace(/[^ -~]/g, '').replace(/[^A-Za-z0-9_.-]+/g, '_');

export default function ConseilClassePage() {
  const toast = useToast();
  const { user, activeEtablissementId } = useAuth();
  const admin = ['Admin', 'SuperAdmin'].includes(roleDe(user));

  const [annees, setAnnees] = useState(null);
  const [annee, setAnnee] = useState('');
  const [periodes, setPeriodes] = useState([]);
  const [periode, setPeriode] = useState('');
  const [perimetres, setPerimetres] = useState(null);
  const [portee, setPortee] = useState('classe');
  const [cible, setCible] = useState('');
  const [apercu, setApercu] = useState({ requete: '', html: '', erreur: '' });
  const [occupe, setOccupe] = useState(null);
  const [aImprimer, setAImprimer] = useState('');
  const impressionRef = useRef(null);

  useEffect(() => {
    api.get('/censeur/mon-espace').then((p) => {
      const liste = p.annees_scolaires || [];
      setAnnees(liste);
      setAnnee(String((liste.find((a) => a.active) || liste[0])?.id ?? ''));
    }).catch((e) => { setAnnees([]); toast(`Années scolaires : ${e.message}`, 'error'); });
    api.get('/conseil/perimetres').then(setPerimetres).catch((e) => { setPerimetres({ classes: [], niveaux: [], cycles: [] }); toast(e.message, 'error'); });
  }, [toast, activeEtablissementId]);

  useEffect(() => {
    if (!annee) return;
    api.get(`/bulletins/periodes?annee_scolaire_id=${annee}`).then((liste) => {
      setPeriodes(liste || []);
      setPeriode((p) => ((liste || []).some((x) => x.value === p) ? p : liste?.[0]?.value ?? ''));
    }).catch((e) => { setPeriodes([]); toast(`Périodes : ${e.message}`, 'error'); });
  }, [annee, toast]);

  const cibles = useMemo(() => {
    if (!perimetres) return [];
    if (portee === 'classe') return perimetres.classes.map((c) => ({ value: String(c.id), label: c.label }));
    if (portee === 'niveau') return perimetres.niveaux.map((n) => ({ value: n.cle, label: `${n.libelle} (${n.classe_ids.length} classe${n.classe_ids.length > 1 ? 's' : ''})` }));
    if (portee === 'cycle') return perimetres.cycles.map((c) => ({ value: String(c.id), label: `${c.libelle} (${c.classe_ids.length} classe${c.classe_ids.length > 1 ? 's' : ''})` }));
    return [];
  }, [perimetres, portee]);
  const cibleEffective = portee === 'etablissement' ? '' : (cibles.some((c) => c.value === cible) ? cible : cibles[0]?.value ?? '');
  const pret = Boolean(annee && periode && (portee === 'etablissement' || cibleEffective));

  const requete = pret ? new URLSearchParams({ annee_scolaire_id: annee, periode, portee, cible: cibleEffective }).toString() : '';

  useEffect(() => {
    if (!requete) return undefined;
    let annule = false;
    api.get(`/conseil/html?${requete}`)
      .then((html) => { if (!annule) setApercu({ requete, html, erreur: '' }); })
      .catch((e) => { if (!annule) setApercu({ requete, html: '', erreur: e.message }); });
    return () => { annule = true; };
  }, [requete]);

  const chargement = Boolean(requete) && apercu.requete !== requete;

  const imprimer = async () => {
    setOccupe('impression');
    try {
      setAImprimer(await api.get(`/conseil/html?${requete}`));
    } catch (e) {
      toast(`Impression : ${e.message}`, 'error');
      setOccupe(null);
    }
  };
  const lancerImpression = () => {
    const fenetre = impressionRef.current?.contentWindow;
    if (fenetre) { fenetre.focus(); fenetre.print(); }
    setOccupe(null);
    setTimeout(() => setAImprimer(''), 1000);
  };
  const telechargerPdf = async () => {
    setOccupe('pdf');
    try {
      const blob = await api.blob(`/conseil/pdf?${requete}`);
      const url = URL.createObjectURL(blob);
      const lien = document.createElement('a');
      lien.href = url;
      const intitule = portee === 'etablissement' ? 'etablissement' : cibles.find((c) => c.value === cibleEffective)?.label || portee;
      lien.download = `${nomFichier(`conseil_${intitule}_${periodes.find((p) => p.value === periode)?.libelle || ''}`)}.pdf`;
      document.body.appendChild(lien);
      lien.click();
      lien.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      const sansPdf = e.status === 503;
      toast(sansPdf ? `${e.message}. Utilisez « Imprimer », puis « Enregistrer au format PDF ».` : `PDF : ${e.message}`, 'error');
    } finally {
      setOccupe(null);
    }
  };

  return (
    <>
      <PageHeader title="Conseil de classe" subtitle={admin ? "Bilan d'une classe, d'un niveau, d'un cycle ou de tout l'établissement — séquence, trimestre ou année" : 'Bilan de vos classes — séquence, trimestre ou année'} />
      <div className="card mb-3">
        <div className="card-body py-3 d-flex flex-wrap align-items-end gap-3">
          <div>
            <label className="form-label">Année scolaire</label>
            <Select className="form-select form-select-sm" style={{ minWidth: 150 }} value={annee} onChange={(e) => setAnnee(e.target.value)}>
              {annees === null ? <option>Chargement…</option> : annees.length ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (active)' : ''}</option>) : <option value="">Aucune année</option>}
            </Select>
          </div>
          <div>
            <label className="form-label">Période</label>
            <Select className="form-select form-select-sm" style={{ minWidth: 240 }} value={periode} onChange={(e) => setPeriode(e.target.value)}>
              {periodes.length ? periodes.map((p) => <option key={p.value} value={p.value}>{p.libelle}</option>) : <option value="">Aucune période</option>}
            </Select>
          </div>
          {admin && (
            <div>
              <label className="form-label">Périmètre</label>
              <Select className="form-select form-select-sm" style={{ minWidth: 200 }} value={portee} onChange={(e) => { setPortee(e.target.value); setCible(''); }}>
                {PORTEES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
            </div>
          )}
          {portee !== 'etablissement' && (
            <div>
              <label className="form-label">{portee === 'classe' ? 'Classe' : portee === 'niveau' ? 'Niveau' : 'Cycle'}</label>
              <Select className="form-select form-select-sm" style={{ minWidth: 200 }} value={cibleEffective} onChange={(e) => setCible(e.target.value)} disabled={!cibles.length}>
                {perimetres === null ? <option>Chargement…</option> : cibles.length ? cibles.map((c) => <option key={c.value} value={c.value}>{c.label}</option>) : <option value="">Aucune classe</option>}
              </Select>
            </div>
          )}
          <div className="ms-auto d-flex gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={!pret || chargement || Boolean(occupe) || !apercu.html} onClick={imprimer}>
              {occupe === 'impression' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-printer me-1" />}Imprimer
            </button>
            <button type="button" className="btn btn-outline-primary btn-sm" disabled={!pret || chargement || Boolean(occupe) || !apercu.html} onClick={telechargerPdf}>
              {occupe === 'pdf' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bxs-file-pdf me-1" />}PDF
            </button>
          </div>
        </div>
      </div>

      {!pret ? (
        <div className="card"><div className="card-body text-center text-muted py-5"><i className="bx bx-info-circle me-1" />Choisissez une année, une période et un périmètre.</div></div>
      ) : chargement ? (
        <div className="card"><SkelListe lignes={8} label="Préparation du document du conseil…" className="px-3 py-2" /></div>
      ) : apercu.erreur ? (
        <div className="alert alert-danger">{apercu.erreur}</div>
      ) : (
        <iframe title="Aperçu du conseil de classe" className="bulletin-apercu" srcDoc={apercu.html} />
      )}

      {aImprimer && <iframe ref={impressionRef} title="Impression du conseil de classe" className="bulletin-impression" srcDoc={aImprimer} onLoad={lancerImpression} />}
    </>
  );
}

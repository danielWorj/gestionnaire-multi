import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useToast } from '../components/ui';
import { AvecChoixClasse } from '../components/Espace';
import './notes.css';
import './bulletin.css';
import Select from '../components/Select';

// Bulletins séquentiels, trimestriels et annuels (Censeur et Surveillant).
// Calcul et mise en page côté serveur (/api/bulletins/, cf.
// server/services/bulletin_services.py) : l'aperçu HTML, l'impression et le
// PDF utilisent le même gabarit (server/static/templates/bulletins/bulletin.html).

const fmt = (v, dec = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(dec));
const rangTexte = (r) => (r ? `${r}${r === 1 ? 'er' : 'e'}` : '—');

// Choix de la classe sur des cartes, puis bulletins de la classe choisie.
export default function BulletinsPage() {
  return (
    <AvecChoixClasse titre="Bulletins" icon="bx-file">
      {({ classeId }) => <BulletinsClasse key={classeId} classeId={classeId} />}
    </AvecChoixClasse>
  );
}

function BulletinsClasse({ classeId }) {
  const toast = useToast();
  const [params] = useSearchParams();

  const [annees, setAnnees] = useState(null);
  const [annee, setAnnee] = useState('');
  const [periodes, setPeriodes] = useState([]);
  const [periode, setPeriode] = useState('');
  const [donnees, setDonnees] = useState(null);
  const [chargement, setChargement] = useState(false);
  const [version, setVersion] = useState(0);
  const [recherche, setRecherche] = useState('');
  const [ordreTri, setOrdreTri] = useState('alphabetique');
  const [selection, setSelection] = useState(null);
  const [coches, setCoches] = useState(new Set());
  const [apercu, setApercu] = useState('');
  const [occupe, setOccupe] = useState(null);
  const [aImprimer, setAImprimer] = useState('');
  const impressionRef = useRef(null);

  // Années (paramètres d'URL quand on arrive depuis « Notes & discipline »).
  useEffect(() => {
    api.get('/censeur/mon-espace').then((payload) => {
      const liste = payload.annees_scolaires || [];
      setAnnees(liste);
      const pa = liste.find((a) => String(a.id) === params.get('annee_scolaire_id'));
      setAnnee(String((pa || liste.find((a) => a.active) || liste[0])?.id ?? ''));
    }).catch((e) => {
      toast(`Impossible de charger votre espace : ${e.message}`, 'error');
      setAnnees([]);
    });
  }, [toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Périodes : trimestres, séquences et annuel.
  useEffect(() => {
    if (!annee) {
      setPeriodes([]);
      return;
    }
    api.get(`/bulletins/periodes?annee_scolaire_id=${annee}`).then((liste) => {
      setPeriodes(liste || []);
      const parTrimestre = (liste || []).find((p) => p.value === `tri:${params.get('trimestre_id')}`);
      setPeriode((parTrimestre || liste?.[0])?.value ?? '');
    }).catch((e) => { setPeriodes([]); toast(`Périodes : ${e.message}`, 'error'); });
  }, [annee, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const requete = useCallback((extra = {}) => new URLSearchParams({
    classe_id: classeId, annee_scolaire_id: annee, periode, ordre: ordreTri, ...extra,
  }).toString(), [classeId, annee, periode, ordreTri]);

  // Moyennes et rangs de toute la classe (liste des élèves + bandeau).
  useEffect(() => {
    if (!annee || !periode) {
      setDonnees(null);
      return undefined;
    }
    let cancelled = false;
    setChargement(true);
    api.get(`/bulletins/?${new URLSearchParams({ classe_id: classeId, annee_scolaire_id: annee, periode })}`)
      .then((data) => {
        if (cancelled) return;
        setDonnees(data);
        const ids = data.bulletins.map((b) => String(b.inscription_id));
        setCoches(new Set(ids));
        setSelection((s) => (ids.includes(s) ? s : ids[0] ?? null));
      })
      .catch((e) => { if (!cancelled) { setDonnees(null); toast(`Bulletins : ${e.message}`, 'error'); } })
      .finally(() => { if (!cancelled) setChargement(false); });
    return () => { cancelled = true; };
  }, [classeId, annee, periode, version, toast]);

  // Aperçu du bulletin de l'élève sélectionné.
  useEffect(() => {
    if (!donnees || !selection) {
      setApercu('');
      return undefined;
    }
    let cancelled = false;
    api.get(`/bulletins/html?${requete({ inscription_ids: selection })}`)
      .then((html) => { if (!cancelled) setApercu(html); })
      .catch((e) => { if (!cancelled) toast(`Aperçu : ${e.message}`, 'error'); });
    return () => { cancelled = true; };
  }, [donnees, selection, requete, toast]);

  const eleves = useMemo(() => {
    const liste = (donnees?.bulletins || []).map((b) => ({ ...b.eleve, inscription_id: String(b.inscription_id), rang: b.rang, moyenne: b.moyenne }));
    if (ordreTri === 'rang') {
      liste.sort((a, b) => (a.rang ?? Infinity) - (b.rang ?? Infinity) || `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr'));
    } else {
      liste.sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr'));
    }
    const q = recherche.trim().toLowerCase();
    return q ? liste.filter((e) => `${e.nom} ${e.prenom} ${e.matricule || ''}`.toLowerCase().includes(q)) : liste;
  }, [donnees, ordreTri, recherche]);

  const idsOuErreur = (ids) => {
    if (!ids.length) toast('Aucun élève sélectionné.', 'error');
    return ids.length ? ids.join(',') : null;
  };

  const imprimer = async (ids) => {
    const liste = idsOuErreur(ids);
    if (!liste) return;
    setOccupe('impression');
    try {
      setAImprimer(await api.get(`/bulletins/html?${requete({ inscription_ids: liste })}`));
    } catch (e) {
      toast(`Impression : ${e.message}`, 'error');
      setOccupe(null);
    }
  };

  const telechargerPdf = async (ids) => {
    const liste = idsOuErreur(ids);
    if (!liste) return;
    setOccupe('pdf');
    try {
      const blob = await api.blob(`/bulletins/pdf?${requete({ inscription_ids: liste })}`);
      const eleve = ids.length === 1 ? eleves.find((e) => e.inscription_id === ids[0]) : null;
      const nom = eleve ? `bulletin_${eleve.nom}_${eleve.prenom}` : `bulletins_${donnees?.classe?.label || 'classe'}`;
      const url = URL.createObjectURL(blob);
      const lien = document.createElement('a');
      lien.href = url;
      lien.download = `${nom}_${donnees?.periode?.libelle || ''}.pdf`.replace(/\s+/g, '_');
      lien.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(`PDF : ${e.message}`, 'error');
    } finally {
      setOccupe(null);
    }
  };

  // Impression via un iframe caché, une fois le HTML chargé (logo compris).
  const lancerImpression = () => {
    const fenetre = impressionRef.current?.contentWindow;
    if (!fenetre) return;
    fenetre.focus();
    fenetre.print();
    setOccupe(null);
    setTimeout(() => setAImprimer(''), 1000);
  };

  const toggleCoche = (id, checked) => setCoches((s) => {
    const next = new Set(s);
    if (checked) next.add(id); else next.delete(id);
    return next;
  });

  const total = donnees?.bulletins.length || 0;
  const pret = Boolean(annee && periode);
  const stats = donnees?.statistiques;
  const libellePeriode = periodes.find((p) => p.value === periode)?.libelle || '—';

  return (
    <>
      <div className="d-flex align-items-center justify-content-between gap-2 mb-3">
        <small className="text-muted">Bulletin d'un élève ou de toute la classe : séquence, trimestre ou annuel.</small>
        <button type="button" className="btn btn-icon btn-outline-secondary flex-shrink-0" title="Actualiser" aria-label="Actualiser" onClick={() => { setVersion((v) => v + 1); toast('Données actualisées.'); }}><i className="bx bx-refresh" /></button>
      </div>

      <div className="card mb-3">
        <div className="card-body py-3 d-flex flex-wrap align-items-end gap-3">
          <div>
            <label className="form-label">Année scolaire</label>
            <Select className="form-select form-select-sm" style={{ minWidth: 150 }} value={annee} onChange={(e) => setAnnee(e.target.value)}>
              {annees === null ? <option>Chargement…</option> : annees.length ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (active)' : ''}</option>) : <option value="">Aucune année scolaire</option>}
            </Select>
          </div>
          <div>
            <label className="form-label">Période du bulletin</label>
            <Select className="form-select form-select-sm" style={{ minWidth: 260 }} value={periode} onChange={(e) => setPeriode(e.target.value)}>
              {annee ? (periodes.length ? periodes.map((p) => <option key={p.value} value={p.value}>{p.libelle}</option>) : <option value="">Aucune période disponible</option>) : <option value="">—</option>}
            </Select>
          </div>
        </div>
      </div>

      {donnees && !chargement && (
        <div className="contexte-bandeau">
          <div className="item"><i className="bx bx-chalkboard" /> {donnees.classe.label}</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-calendar" /> {libellePeriode}</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-group" /> {donnees.effectif} élève(s)</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-line-chart" /> Moy. classe : {fmt(stats?.moyenne_classe)}/20</div>
          <div className="sep" />
          <div className="item"><i className="bx bx-check-circle" /> Réussite : {fmt(stats?.taux_reussite)} %</div>
        </div>
      )}

      <div className="row g-3">
        <div className="col-xl-4">
          <div className="card h-100">
            <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
              <h6 className="mb-0"><i className="bx bx-group me-2 text-primary" />Élèves</h6>
              <div className="form-check mb-0">
                <input className="form-check-input" type="checkbox" id="checkToutSelectionner" checked={total > 0 && coches.size === total} onChange={(e) => setCoches(e.target.checked ? new Set(donnees.bulletins.map((b) => String(b.inscription_id))) : new Set())} />
                <label className="form-check-label small" htmlFor="checkToutSelectionner">Tous</label>
              </div>
            </div>
            <div className="card-body py-2 border-bottom d-grid gap-2">
              <div className="btn-group btn-group-sm">
                <button type="button" className="btn btn-primary" disabled={!coches.size || occupe} onClick={() => imprimer([...coches])}>
                  {occupe === 'impression' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-printer me-1" />}Imprimer la sélection ({coches.size})
                </button>
                <button type="button" className="btn btn-outline-primary" disabled={!coches.size || occupe} onClick={() => telechargerPdf([...coches])}>
                  {occupe === 'pdf' ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bxs-file-pdf me-1" />}PDF
                </button>
              </div>
              <div className="btn-group btn-group-sm">
                <button type="button" className="btn btn-outline-secondary" disabled={!selection || occupe} onClick={() => imprimer([selection])}><i className="bx bx-file me-1" />Imprimer ce bulletin</button>
                <button type="button" className="btn btn-outline-secondary" disabled={!selection || occupe} onClick={() => telechargerPdf([selection])}><i className="bx bxs-file-pdf me-1" />PDF</button>
              </div>
            </div>
            <div className="card-body py-2 border-bottom">
              <label className="form-label"><i className="bx bx-sort-a-z me-1" />Ordonner / produire par</label>
              <Select className="form-select form-select-sm" value={ordreTri} onChange={(e) => setOrdreTri(e.target.value)}>
                <option value="alphabetique">Ordre alphabétique</option>
                <option value="rang">Rang (classement)</option>
              </Select>
            </div>
            <div className="card-body py-2 border-bottom">
              <div className="input-group input-group-sm input-group-merge">
                <span className="input-group-text"><i className="bx bx-search" /></span>
                <input type="search" className="form-control" placeholder="Rechercher un élève (nom, prénom, matricule…)" aria-label="Rechercher un élève" value={recherche} onChange={(e) => setRecherche(e.target.value)} />
              </div>
            </div>
            <div className="eleves-liste">
              {annees === null || chargement ? (
                <div className="text-center text-muted py-5"><span className="spinner-border spinner-border-sm me-1" /> Chargement…</div>
              ) : !pret ? (
                <div className="text-center text-muted py-5"><i className="bx bx-info-circle me-1" />Sélectionnez une année et une période.</div>
              ) : !eleves.length ? (
                <div className="text-center text-muted py-5"><i className="bx bx-user-x me-1" />Aucun élève ne correspond à la sélection.</div>
              ) : eleves.map((e) => (
                <div key={e.inscription_id} className={`eleve-item ${e.inscription_id === selection ? 'active' : ''}`} role="button" onClick={() => setSelection(e.inscription_id)}>
                  <input type="checkbox" className="form-check-input" checked={coches.has(e.inscription_id)} onClick={(ev) => ev.stopPropagation()} onChange={(ev) => toggleCoche(e.inscription_id, ev.target.checked)} />
                  <div>
                    <div className="eleve-nom">{e.nom} {e.prenom}</div>
                    <div className="eleve-sub">{e.matricule || '—'}</div>
                  </div>
                  <span className="eleve-rang">{rangTexte(e.rang)} · {fmt(e.moyenne)}/20</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="col-xl-8">
          {selection && apercu && !chargement ? (
            <iframe title="Aperçu du bulletin" className="bulletin-apercu" srcDoc={apercu} />
          ) : (
            <div className="card"><div className="card-body text-center text-muted py-5"><i className="bx bx-file bx-md d-block mb-2" />Sélectionnez une période puis un élève dans la liste pour afficher l'aperçu de son bulletin.</div></div>
          )}
        </div>
      </div>

      {aImprimer && <iframe ref={impressionRef} title="Impression des bulletins" className="bulletin-impression" srcDoc={aImprimer} onLoad={lancerImpression} />}
    </>
  );
}

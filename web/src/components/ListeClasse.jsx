import { useMemo, useRef, useState } from 'react';
import { downloadCsv, formatDate, useToast } from './ui';
import EnteteEtablissement from './EnteteEtablissement';
import Select from './Select';

// Générateur de listes de classe (aperçu imprimable + export CSV), partagé
// par la page Inscriptions et la page « Listes de classe » ouverte à tous
// les profils. Une ligne = une inscription, au format de
// GET /api/listes-classes/eleves : {id, classe_id, annee_scolaire_id,
// date_inscription, statut, matricule, nom, prenom, sexe, date_naissance,
// lieu_naissance, parent_nom?, parent_telephone?}.

const COLONNES = [
  ['naissance', 'Date et lieu de naissance'],
  ['parent', 'Parent et téléphone'],
  ['date', "Date d'inscription"],
  ['statut', 'Statut'],
  ['emargement', "Colonne d'émargement"],
];

const iso = (d) => d.toISOString().slice(0, 10);
const eleveNom = (e) => (e ? `${(e.nom || '').toUpperCase()} ${e.prenom || ''}`.trim() : '—');
const fichier = (s) => String(s).replace(/[^\w-]/g, '_');

/**
 * annees : [{id, libelle}] ; annee / onAnneeChange : année choisie (contrôlée
 * par la page, qui peut avoir à recharger les lignes) ; classes : [{id}]
 * accessibles ; classeLabel(classe) ; avecParents : colonne parent proposée.
 */
export default function GenerateurListeClasse({
  lignes, classes, classeLabel, annees, annee, onAnneeChange, avecParents = true, etablissement, chargement = false,
}) {
  const toast = useToast();
  const apercuRef = useRef(null);
  const colonnes = useMemo(() => COLONNES.filter(([v]) => avecParents || v !== 'parent'), [avecParents]);
  const [liste, setListe] = useState({
    classe: '', mode: 'arret', debut: '', fin: iso(new Date()), statut: 'Actif', tri: 'nom',
    colonnes: avecParents ? ['naissance', 'parent', 'date'] : ['naissance', 'date'],
  });
  const [derniereListe, setDerniereListe] = useState(null);

  const classeById = useMemo(() => Object.fromEntries(classes.map((c) => [c.id, c])), [classes]);
  const classesTriees = useMemo(() => [...classes].sort((a, b) => classeLabel(a).localeCompare(classeLabel(b))), [classes, classeLabel]);
  const anneeLabel = (id) => annees.find((a) => a.id === Number(id))?.libelle || (id ? `Année #${id}` : '—');
  const set = (name) => (e) => setListe((l) => ({ ...l, [name]: e.target.value }));

  const generer = () => {
    const anneeId = Number(annee) || null;
    const classeId = Number(liste.classe) || null;
    const { mode, debut, fin, statut, tri } = liste;
    const choisies = lignes.filter((i) => {
      if (!classeById[i.classe_id]) return false;
      if (anneeId && i.annee_scolaire_id !== anneeId) return false;
      if (classeId && i.classe_id !== classeId) return false;
      if (statut && (i.statut || 'Actif') !== statut) return false;
      if (mode === 'arret' && fin && (!i.date_inscription || i.date_inscription > fin)) return false;
      if (mode === 'entre') {
        if (debut && (!i.date_inscription || i.date_inscription < debut)) return false;
        if (fin && (!i.date_inscription || i.date_inscription > fin)) return false;
      }
      return true;
    });
    choisies.sort((a, b) => {
      if (tri === 'matricule') return String(a.matricule || '').localeCompare(String(b.matricule || ''));
      if (tri === 'date') return String(a.date_inscription || '').localeCompare(String(b.date_inscription || ''));
      if (tri === 'sexe') {
        const s = String(a.sexe || 'Z').localeCompare(String(b.sexe || 'Z'));
        if (s !== 0) return s;
      }
      return `${a.nom || ''} ${a.prenom || ''}`.localeCompare(`${b.nom || ''} ${b.prenom || ''}`);
    });
    const parClasse = {};
    choisies.forEach((i) => { (parClasse[i.classe_id] ||= []).push(i); });
    const sections = Object.keys(parClasse).map(Number)
      .sort((a, b) => classeLabel(classeById[a]).localeCompare(classeLabel(classeById[b])))
      .map((id) => ({ classeId: id, lignes: parClasse[id] }));
    const periode = mode === 'tout' ? "Toute l'année scolaire" : mode === 'arret' ? `Situation arrêtée au ${formatDate(fin)}` : `Inscriptions du ${formatDate(debut)} au ${formatDate(fin)}`;
    const cols = liste.colonnes.filter((c) => avecParents || c !== 'parent');
    setDerniereListe({ anneeId, classeId, sections, cols, periode, statut, total: choisies.length });
    setTimeout(() => apercuRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    toast(choisies.length ? `${choisies.length} élève(s) dans ${sections.length} classe(s)` : 'Aucun élève ne correspond à ces critères', choisies.length ? undefined : 'error');
  };

  const exportCsv = () => {
    if (!derniereListe) return;
    const { cols } = derniereListe;
    const head = ['Classe', 'N°', 'Matricule', 'Nom et prénoms', 'Sexe'];
    if (cols.includes('naissance')) head.push('Date de naissance', 'Lieu de naissance');
    if (cols.includes('parent')) head.push('Parent', 'Téléphone');
    if (cols.includes('date')) head.push("Date d'inscription");
    if (cols.includes('statut')) head.push('Statut');
    const rows = [head];
    derniereListe.sections.forEach((sec) => {
      sec.lignes.forEach((i, idx) => {
        const r = [classeLabel(classeById[sec.classeId]), idx + 1, i.matricule || '', eleveNom(i), i.sexe || ''];
        if (cols.includes('naissance')) r.push(i.date_naissance || '', i.lieu_naissance || '');
        if (cols.includes('parent')) r.push(i.parent_nom || '', i.parent_telephone || '');
        if (cols.includes('date')) r.push(i.date_inscription || '');
        if (cols.includes('statut')) r.push(i.statut || 'Actif');
        rows.push(r);
      });
    });
    const classe = derniereListe.classeId ? `-${fichier(classeLabel(classeById[derniereListe.classeId]))}` : '';
    downloadCsv(`liste-${fichier(anneeLabel(derniereListe.anneeId))}${classe}.csv`, rows);
  };

  const anneeOptions = annees.length
    ? annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (en cours)' : ''}</option>)
    : <option value="">Aucune année</option>;

  return (
    <div className="card mb-4">
      <div className="card-header d-flex align-items-center justify-content-between">
        <h5 className="mb-0"><i className="bx bx-file me-2 text-primary" />Liste des élèves inscrits</h5>
        <span className="badge bg-label-secondary">Par classe et par date</span>
      </div>
      <div className="card-body">
        <div className="row g-2 align-items-end">
          <div className="col-lg-2 col-md-4"><label className="form-label">Année scolaire</label><Select className="form-select form-select-sm" value={annee} onChange={(e) => onAnneeChange(e.target.value)}>{anneeOptions}</Select></div>
          <div className="col-lg-3 col-md-4"><label className="form-label">Classe</label><Select className="form-select form-select-sm" value={liste.classe} onChange={set('classe')}><option value="">Toutes les classes (une section par classe)</option>{classesTriees.map((c) => <option key={c.id} value={c.id}>{classeLabel(c)}</option>)}</Select></div>
          <div className="col-lg-2 col-md-4"><label className="form-label">Période</label><Select className="form-select form-select-sm" value={liste.mode} onChange={set('mode')}><option value="arret">Arrêtée à une date</option><option value="entre">Entre deux dates</option><option value="tout">Toute l'année</option></Select></div>
          {liste.mode === 'entre' && <div className="col-lg-2 col-md-4"><label className="form-label">Du</label><input type="date" className="form-control form-control-sm" value={liste.debut} onChange={set('debut')} /></div>}
          {liste.mode !== 'tout' && <div className="col-lg-2 col-md-4"><label className="form-label">{liste.mode === 'entre' ? 'au' : 'Arrêtée au'}</label><input type="date" className="form-control form-control-sm" value={liste.fin} onChange={set('fin')} /></div>}
          <div className="col-lg-2 col-md-4">
            <label className="form-label">Statut</label>
            <Select className="form-select form-select-sm" value={liste.statut} onChange={set('statut')}>
              <option value="Actif">Actives seulement</option><option value="">Tous statuts</option><option value="Suspendu">Suspendues</option><option value="Radié">Radiées</option><option value="Transféré">Transférées</option>
            </Select>
          </div>
          <div className="col-lg-2 col-md-4">
            <label className="form-label">Trier par</label>
            <Select className="form-select form-select-sm" value={liste.tri} onChange={set('tri')}>
              <option value="nom">Ordre alphabétique</option><option value="matricule">Matricule</option><option value="date">Date d'inscription</option><option value="sexe">Sexe puis nom</option>
            </Select>
          </div>
          <div className="col-lg-3 col-md-6">
            <label className="form-label">Colonnes supplémentaires</label>
            <Select className="form-select form-select-sm" multiple size={3} value={liste.colonnes} onChange={(e) => setListe((l) => ({ ...l, colonnes: Array.from(e.target.selectedOptions).map((o) => o.value) }))}>
              {colonnes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          <div className="col-12 d-flex flex-wrap gap-2 mt-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={chargement} onClick={generer}>
              {chargement ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-list-check me-1" />} Générer la liste
            </button>
            <button type="button" className="btn btn-outline-secondary btn-sm" disabled={!derniereListe?.total} onClick={() => window.print()}><i className="bx bx-printer me-1" /> Imprimer</button>
            <button type="button" className="btn btn-outline-secondary btn-sm" disabled={!derniereListe?.total} onClick={exportCsv}><i className="bx bx-file me-1" /> Export CSV</button>
          </div>
        </div>
      </div>
      {derniereListe && (
        <div className="card-body border-top bg-lighter print-area" ref={apercuRef}>
          <ListeImprimable liste={derniereListe} etablissement={etablissement} classeById={classeById} classeLabel={classeLabel} anneeLabel={anneeLabel} />
        </div>
      )}
    </div>
  );
}

function ListeImprimable({ liste: L, etablissement, classeById, classeLabel, anneeLabel }) {
  const { cols } = L;
  return (
    <div className="print-doc">
      <EnteteEtablissement etablissement={etablissement} />
      <div className="print-title">Liste des élèves inscrits</div>
      <div className="print-subtitle">{anneeLabel(L.anneeId)} — {L.periode}{L.statut ? ` — inscriptions « ${L.statut} »` : ''}</div>
      <div className="print-meta">
        <span><b>Total :</b> {L.total} élève(s)</span>
        <span><b>Classes :</b> {L.sections.length}</span>
        <span><b>Éditée le :</b> {formatDate(new Date().toISOString())}</span>
      </div>
      {L.sections.length ? L.sections.map((sec) => {
        const g = sec.lignes.filter((i) => i.sexe === 'M').length;
        const f = sec.lignes.filter((i) => i.sexe === 'F').length;
        return (
          <div key={sec.classeId} style={{ marginTop: 18 }}>
            <div className="print-meta">
              <span><b>Classe :</b> {classeLabel(classeById[sec.classeId])}</span>
              <span><b>Effectif :</b> {sec.lignes.length}</span>
              <span><b>Garçons :</b> {g}</span>
              <span><b>Filles :</b> {f}</span>
            </div>
            <table className="print-table">
              <thead>
                <tr>
                  <th className="num">N°</th><th>Matricule</th><th>Nom et prénoms</th><th>Sexe</th>
                  {cols.includes('naissance') && <><th>Né(e) le</th><th>À</th></>}
                  {cols.includes('parent') && <><th>Parent</th><th>Téléphone</th></>}
                  {cols.includes('date') && <th>Inscrit le</th>}
                  {cols.includes('statut') && <th>Statut</th>}
                  {cols.includes('emargement') && <th>Émargement</th>}
                </tr>
              </thead>
              <tbody>
                {sec.lignes.map((i, idx) => (
                  <tr key={i.id}>
                    <td className="num">{idx + 1}</td>
                    <td>{i.matricule || '—'}</td>
                    <td>{eleveNom(i)}</td>
                    <td>{i.sexe || '—'}</td>
                    {cols.includes('naissance') && <><td>{formatDate(i.date_naissance)}</td><td>{i.lieu_naissance || '—'}</td></>}
                    {cols.includes('parent') && <><td>{i.parent_nom || '—'}</td><td>{i.parent_telephone || '—'}</td></>}
                    {cols.includes('date') && <td>{formatDate(i.date_inscription)}</td>}
                    {cols.includes('statut') && <td>{i.statut || 'Actif'}</td>}
                    {cols.includes('emargement') && <td />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }) : <p style={{ marginTop: 20 }}>Aucun élève ne correspond à ces critères.</p>}
      <div className="print-signature">
        <div>Le Censeur<span /></div>
        <div>Le Chef d'établissement<span /></div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import Select from './Select';
import { api, apiRequest } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { downloadCsv, formatDate, IconBtn, Pager, usePagination, useToast } from './ui';

// Import de masse des élèves depuis les archives de l'établissement (CSV,
// Excel, Word). Tout le travail d'interprétation est fait par le serveur
// (server/services/import_eleves_services.py) : cette modale envoie les
// fichiers, laisse l'utilisateur ajuster la correspondance des colonnes et
// les options, affiche l'aperçu ligne par ligne (modifiable), puis importe.
// L'aperçu et l'import passent par le même traitement : ce qui est affiché
// est exactement ce qui sera enregistré.

const ETAPES = [
  ['fichiers', 'Fichiers'],
  ['correspondance', 'Colonnes et options'],
  ['apercu', 'Vérification'],
  ['termine', 'Terminé'],
];

const FORMATS = '.csv,.txt,.tsv,.xlsx,.xlsm,.xls,.docx,.doc';

const today = () => new Date().toISOString().slice(0, 10);

const OPTIONS_DEFAUT = {
  separation: 'premier',
  harmoniser_casse: true,
  doublons: 'ignorer',
  matricules_auto: true,
  prefixe_matricule: '',
  lieu_defaut: 'Non renseigné',
  sexe_defaut: '',
  statut_defaut: 'Actif',
  parent_defaut: 'provisoire',
  inscrire: true,
  annee_scolaire_id: '',
  date_inscription: today(),
  classes: {},
  classe_fixe: '',
  classe_depuis_titre: true,
};

// Options mémorisées d'un import à l'autre (par établissement) : la
// correspondance des colonnes et des classes, et les choix de traitement.
const OPTIONS_MEMORISEES = ['separation', 'harmoniser_casse', 'doublons', 'matricules_auto', 'prefixe_matricule', 'lieu_defaut', 'sexe_defaut', 'classe_depuis_titre'];

const STATUTS = {
  nouveau: ['Nouveau', 'bg-label-success'],
  maj: ['Mis à jour', 'bg-label-info'],
  existant: ['Déjà enregistré', 'bg-label-secondary'],
  erreur: ['Erreur', 'bg-label-danger'],
  exclu: ['Exclu', 'bg-label-dark'],
};

const INSCRIPTIONS = {
  nouvelle: 'sera inscrit',
  deja: 'déjà inscrit',
  autre_classe: 'inscrit ailleurs',
  sans_classe: 'sans classe',
  non: '',
};

function lireMemoire(cle) {
  try {
    return JSON.parse(localStorage.getItem(cle) || 'null') || {};
  } catch {
    return {};
  }
}

const tailleLisible = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

export default function ImportElevesModal({ parents = [], onClose, onImported }) {
  const toast = useToast();
  const { user, activeEtablissementId } = useAuth();
  const cleMemoire = `import-eleves:${activeEtablissementId || user?.etablissement_id || 'etab'}`;
  const memoire = useMemo(() => lireMemoire(cleMemoire), [cleMemoire]);

  const [etape, setEtape] = useState('fichiers');
  const [fichiers, setFichiers] = useState([]); // { cle, nom, taille, etat, message, blocs }
  const [exclusBlocs, setExclusBlocs] = useState({}); // `${cleFichier}:${i}` -> bool (true = exclu, false = inclus)
  const [texte, setTexte] = useState('');
  const [modeTexte, setModeTexte] = useState(false);
  const [survol, setSurvol] = useState(false);

  const [mapping, setMapping] = useState(null);
  const [options, setOptions] = useState(() => ({
    ...OPTIONS_DEFAUT,
    ...Object.fromEntries(OPTIONS_MEMORISEES.filter((k) => k in (memoire.options || {})).map((k) => [k, memoire.options[k]])),
    classes: { ...(memoire.classes || {}) },
  }));
  const [corrections, setCorrections] = useState({});
  const [exclues, setExclues] = useState([]);
  const [rep, setRep] = useState(null);
  const [calcul, setCalcul] = useState(false);
  const [erreurCalcul, setErreurCalcul] = useState('');
  const [importEnCours, setImportEnCours] = useState(false);
  const [bilan, setBilan] = useState(null);
  const requete = useRef(0);

  /* ── Étape 1 : fichiers ─────────────────────────────────────────────── */

  const analyser = useCallback(async (liste) => {
    const nouveaux = liste.map((f) => ({ cle: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`, nom: f.name, taille: f.size, etat: 'analyse', blocs: [], message: '' }));
    setFichiers((prev) => [...prev, ...nouveaux]);
    // Un fichier par requête : pas de limite de taille cumulée côté proxy,
    // et un fichier illisible n'empêche pas de lire les autres.
    await Promise.all(liste.map(async (fichier, i) => {
      const { cle } = nouveaux[i];
      const fd = new FormData();
      fd.append('fichiers', fichier);
      try {
        const res = await apiRequest('/import/eleves/analyser', { method: 'POST', body: fd });
        const message = res.erreurs?.[0]?.message || (res.blocs.length ? '' : 'Aucun tableau trouvé.');
        setFichiers((prev) => prev.map((f) => (f.cle === cle ? { ...f, etat: res.blocs.length ? 'ok' : 'erreur', blocs: res.blocs, message } : f)));
      } catch (err) {
        setFichiers((prev) => prev.map((f) => (f.cle === cle ? { ...f, etat: 'erreur', message: err.message } : f)));
      }
    }));
  }, []);

  const ajouterTexte = async () => {
    if (!texte.trim()) return;
    const cle = `colle-${Date.now()}`;
    setFichiers((prev) => [...prev, { cle, nom: 'Tableau collé', taille: texte.length, etat: 'analyse', blocs: [], message: '' }]);
    const fd = new FormData();
    fd.append('texte', texte);
    try {
      const res = await apiRequest('/import/eleves/analyser', { method: 'POST', body: fd });
      setFichiers((prev) => prev.map((f) => (f.cle === cle ? { ...f, etat: res.blocs.length ? 'ok' : 'erreur', blocs: res.blocs, message: res.erreurs?.[0]?.message || '' } : f)));
      setTexte('');
      setModeTexte(false);
    } catch (err) {
      setFichiers((prev) => prev.map((f) => (f.cle === cle ? { ...f, etat: 'erreur', message: err.message } : f)));
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    setSurvol(false);
    const liste = [...(event.dataTransfer?.files || [])];
    if (liste.length) analyser(liste);
  };

  const blocInclus = (f, i) => {
    const forcé = exclusBlocs[`${f.cle}:${i}`];
    return forcé === undefined ? f.blocs[i].pertinent !== false : !forcé;
  };

  const blocsInclus = useMemo(() => fichiers.flatMap((f) => f.blocs
    .map((b, i) => [b, i])
    .filter(([, i]) => blocInclus(f, i))
    .map(([b]) => ({ source: b.source, entetes: b.entetes, lignes: b.lignes, numeros: b.numeros, classe_detectee: b.classe_detectee }))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [fichiers, exclusBlocs]);

  const nbLignesIncluses = blocsInclus.reduce((s, b) => s + b.lignes.length, 0);
  const analyseEnCours = fichiers.some((f) => f.etat === 'analyse');

  const retirerFichier = (cle) => setFichiers((prev) => prev.filter((f) => f.cle !== cle));

  const telechargerModele = async () => {
    try {
      const blob = await api.blob('/import/eleves/modele');
      const lien = document.createElement('a');
      lien.href = URL.createObjectURL(blob);
      lien.download = 'modele-import-eleves.xlsx';
      lien.click();
      URL.revokeObjectURL(lien.href);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const continuer = () => {
    setMapping(null);
    setCorrections({});
    setExclues([]);
    setRep(null);
    setEtape('correspondance');
  };

  /* ── Étapes 2-3 : aperçu calculé par le serveur ─────────────────────── */

  const calculer = useCallback(async (valider = false) => {
    const id = ++requete.current;
    setCalcul(true);
    setErreurCalcul('');
    try {
      const res = await api.post('/import/eleves/traiter', {
        blocs: blocsInclus,
        mapping,
        options: {
          ...options,
          annee_scolaire_id: options.annee_scolaire_id || null,
          sexe_defaut: options.sexe_defaut || null,
          classe_fixe: options.classe_fixe || null,
        },
        corrections,
        exclues,
        valider,
      });
      if (id !== requete.current) return null;
      setRep(res);
      if (mapping === null) {
        // Première passe : suggestion du serveur, complétée par la
        // correspondance mémorisée lors des imports précédents.
        const memo = memoire.colonnes || {};
        const fusion = { ...res.mapping_suggere };
        res.colonnes.forEach((c) => {
          if (c.cle in memo) fusion[c.cle] = memo[c.cle];
        });
        res.colonnes.forEach((c) => {
          if (!(c.cle in fusion)) fusion[c.cle] = '';
        });
        setMapping(fusion);
      }
      return res;
    } catch (err) {
      if (id === requete.current) setErreurCalcul(err.message);
      if (valider) throw err;
      return null;
    } finally {
      if (id === requete.current) setCalcul(false);
    }
  }, [blocsInclus, mapping, options, corrections, exclues, memoire]);

  useEffect(() => {
    if (etape !== 'correspondance' && etape !== 'apercu') return undefined;
    const t = setTimeout(() => { calculer(false); }, mapping === null ? 0 : 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping, options, corrections, exclues, etape === 'fichiers' || etape === 'termine']);

  const setOpt = (name) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setOptions((o) => ({ ...o, [name]: value }));
  };

  const champsMappes = useMemo(() => new Set(Object.values(mapping || {}).filter(Boolean)), [mapping]);
  const manquants = useMemo(() => {
    if (!mapping) return [];
    const m = [];
    if (!champsMappes.has('nom_complet') && !(champsMappes.has('nom') && champsMappes.has('prenom'))) {
      m.push('le nom et le prénom (une colonne « Nom et prénoms », ou deux colonnes « Nom » et « Prénom »)');
    }
    if (!champsMappes.has('sexe') && !options.sexe_defaut) m.push('le sexe (ou choisissez une valeur par défaut ci-dessous)');
    if (!champsMappes.has('matricule') && !options.matricules_auto) m.push('le matricule (ou activez la génération automatique)');
    return m;
  }, [mapping, champsMappes, options.sexe_defaut, options.matricules_auto]);

  const exempleNom = useMemo(() => {
    if (!rep || !champsMappes.has('nom_complet')) return null;
    return rep.lignes.find((l) => l.donnees.nom && l.donnees.prenom && l.statut !== 'exclu') || null;
  }, [rep, champsMappes]);

  /* ── Étape 3 : filtres et corrections ───────────────────────────────── */

  const [filtre, setFiltre] = useState('tous');
  const [recherche, setRecherche] = useState('');
  const [edition, setEdition] = useState(null); // { id, valeurs }

  const lignesFiltrees = useMemo(() => {
    if (!rep) return [];
    const q = recherche.trim().toLowerCase();
    return rep.lignes.filter((l) => {
      if (filtre === 'alertes' && !(l.avertissements.length && l.statut !== 'erreur' && l.statut !== 'exclu')) return false;
      if (filtre !== 'tous' && filtre !== 'alertes' && l.statut !== filtre) return false;
      if (q) {
        const d = l.donnees;
        if (!`${d.matricule} ${d.nom} ${d.prenom} ${d.classe_libelle} ${l.source}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rep, filtre, recherche]);
  const pagination = usePagination(lignesFiltrees, 50);

  const classeLibelle = useCallback((id) => rep?.classes.find((c) => c.id === Number(id))?.libelle || '', [rep]);

  const ouvrirEdition = (l) => setEdition({
    id: l.id,
    valeurs: {
      matricule: l.matricule_genere ? '' : l.donnees.matricule || '',
      nom: l.donnees.nom || '',
      prenom: l.donnees.prenom || '',
      sexe: l.donnees.sexe || '',
      date_naissance: l.donnees.date_naissance || '',
      lieu_naissance: l.donnees.lieu_naissance === options.lieu_defaut ? '' : l.donnees.lieu_naissance || '',
      classe_id: l.donnees.classe_id ? String(l.donnees.classe_id) : '',
    },
  });

  const validerEdition = () => {
    const { id, valeurs } = edition;
    setCorrections((c) => ({ ...c, [id]: { ...valeurs, classe_id: valeurs.classe_id || '' } }));
    setEdition(null);
  };

  const basculerExclusion = (id) => setExclues((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const exporterProblemes = (lignes, nom) => {
    const rows = [['Source', 'Statut', 'Matricule', 'Nom', 'Prénom', 'Sexe', 'Date de naissance', 'Lieu', 'Classe', 'Erreurs', 'Avertissements']];
    lignes.forEach((l) => {
      const d = l.donnees;
      rows.push([l.source, STATUTS[l.statut]?.[0] || l.statut, d.matricule, d.nom, d.prenom, d.sexe || '', d.date_naissance || '', d.lieu_naissance, d.classe_id ? classeLibelle(d.classe_id) : d.classe_libelle, l.erreurs.join(' | '), l.avertissements.join(' | ')]);
    });
    downloadCsv(nom, rows);
  };

  /* ── Import ─────────────────────────────────────────────────────────── */

  const r = rep?.resume;
  const nbAEcrire = r ? r.nouveaux + r.mises_a_jour : 0;
  const nbAction = r ? nbAEcrire + (rep.lignes.filter((l) => l.statut === 'existant' && l.inscription === 'nouvelle').length) : 0;

  const importer = async () => {
    setImportEnCours(true);
    try {
      const res = await calculer(true);
      if (!res) return;
      // Mémorise la correspondance pour les prochains imports.
      const classes = { ...(memoire.classes || {}) };
      res.classes_detectees.forEach((c) => {
        if (c.classe_id) classes[c.libelle] = c.classe_id;
      });
      localStorage.setItem(cleMemoire, JSON.stringify({
        colonnes: { ...(memoire.colonnes || {}), ...mapping },
        classes,
        options: Object.fromEntries(OPTIONS_MEMORISEES.map((k) => [k, options[k]])),
      }));
      setBilan(res.bilan || {});
      setEtape('termine');
      onImported?.();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setImportEnCours(false);
    }
  };

  /* ── Rendu ──────────────────────────────────────────────────────────── */

  const indexEtape = ETAPES.findIndex(([k]) => k === etape);

  const footer = (
    <>
      {etape === 'fichiers' && (
        <>
          <button type="button" className="btn btn-outline-secondary btn-sm me-auto" onClick={telechargerModele}><i className="bx bx-download me-1" /> Modèle Excel vierge</button>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onClose}>Annuler</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!nbLignesIncluses || analyseEnCours} onClick={continuer}>
            Continuer <i className="bx bx-right-arrow-alt ms-1" />
          </button>
        </>
      )}
      {etape === 'correspondance' && (
        <>
          <button type="button" className="btn btn-outline-secondary btn-sm me-auto" onClick={() => setEtape('fichiers')}><i className="bx bx-left-arrow-alt me-1" /> Fichiers</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!rep || manquants.length > 0} onClick={() => { setFiltre(r?.erreurs ? 'erreur' : 'tous'); pagination.reset(); setEtape('apercu'); }}>
            Vérifier les données <i className="bx bx-right-arrow-alt ms-1" />
          </button>
        </>
      )}
      {etape === 'apercu' && (
        <>
          <button type="button" className="btn btn-outline-secondary btn-sm me-auto" onClick={() => setEtape('correspondance')}><i className="bx bx-left-arrow-alt me-1" /> Colonnes et options</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!nbAction || calcul || importEnCours} onClick={importer}>
            {importEnCours ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-import me-1" />}
            Importer {nbAEcrire} élève{nbAEcrire > 1 ? 's' : ''}{r?.inscriptions ? ` et ${r.inscriptions} inscription${r.inscriptions > 1 ? 's' : ''}` : ''}
          </button>
        </>
      )}
      {etape === 'termine' && <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Fermer</button>}
    </>
  );

  return (
    <Modal
      size="modal-xl"
      title={<><i className="bx bx-import me-2 text-primary" />Importer des élèves</>}
      subtitle="Depuis vos anciens fichiers : Excel, CSV ou Word (tableaux). Rien n'est enregistré avant la dernière étape."
      onClose={importEnCours ? () => {} : onClose}
      footer={footer}
    >
      <ol className="import-etapes list-unstyled d-flex flex-wrap gap-2 mb-4">
        {ETAPES.map(([k, label], i) => (
          <li key={k} className={`badge rounded-pill px-3 py-2 ${i === indexEtape ? 'bg-primary' : i < indexEtape ? 'bg-label-primary' : 'bg-label-secondary'}`}>
            {i < indexEtape ? <i className="bx bx-check me-1" /> : `${i + 1}. `}{label}
          </li>
        ))}
      </ol>

      {etape === 'fichiers' && (
        <>
          <label
            className={`d-block border border-2 rounded-3 p-4 text-center mb-3 ${survol ? 'border-primary bg-label-primary' : ''}`}
            style={{ borderStyle: 'dashed', cursor: 'pointer' }}
            onDragOver={(e) => { e.preventDefault(); setSurvol(true); }}
            onDragLeave={() => setSurvol(false)}
            onDrop={onDrop}
          >
            <input type="file" multiple accept={FORMATS} className="d-none" onChange={(e) => { const liste = [...e.target.files]; e.target.value = ''; if (liste.length) analyser(liste); }} />
            <i className="bx bx-cloud-upload text-primary" style={{ fontSize: 42 }} />
            <div className="fw-semibold mt-1">Glissez vos fichiers ici ou cliquez pour les choisir</div>
            <small className="text-muted">Excel (.xlsx, .xls), CSV et Word (.docx). Plusieurs fichiers à la fois, un ou plusieurs tableaux par fichier.</small>
          </label>

          <div className="mb-3">
            {modeTexte ? (
              <div className="border rounded-3 p-3">
                <label className="form-label">Collez ici un tableau copié depuis Excel, Word ou une page web</label>
                <textarea className="form-control font-monospace small" rows={6} value={texte} onChange={(e) => setTexte(e.target.value)} placeholder={'Nom\tPrénom\tSexe\tDate de naissance\nNGONO\tMarie\tF\t12/03/2012'} />
                <div className="d-flex gap-2 mt-2">
                  <button type="button" className="btn btn-primary btn-sm" disabled={!texte.trim()} onClick={ajouterTexte}><i className="bx bx-check me-1" /> Lire ce tableau</button>
                  <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setModeTexte(false)}>Annuler</button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setModeTexte(true)}><i className="bx bx-paste me-1" /> Ou coller un tableau copié</button>
            )}
          </div>

          {fichiers.length > 0 && (
            <div className="list-group mb-2">
              {fichiers.map((f) => (
                <div key={f.cle} className="list-group-item">
                  <div className="d-flex align-items-center gap-2">
                    <i className={`bx ${/\.docx?$/i.test(f.nom) ? 'bxs-file-doc text-info' : /\.(csv|txt|tsv)$/i.test(f.nom) ? 'bx-spreadsheet text-success' : f.nom === 'Tableau collé' ? 'bx-paste text-secondary' : 'bxs-spreadsheet text-success'} fs-4`} />
                    <div className="flex-grow-1 min-w-0">
                      <div className="fw-semibold text-truncate">{f.nom}</div>
                      <small className="text-muted">
                        {tailleLisible(f.taille)}
                        {f.etat === 'ok' && ` · ${f.blocs.length} tableau${f.blocs.length > 1 ? 'x' : ''}`}
                      </small>
                    </div>
                    {f.etat === 'analyse' && <span className="spinner-border spinner-border-sm text-primary" />}
                    {f.etat === 'erreur' && <span className="badge bg-label-danger">Illisible</span>}
                    <IconBtn icon="bx-x" title="Retirer" onClick={() => retirerFichier(f.cle)} />
                  </div>
                  {f.etat === 'erreur' && <div className="text-danger small mt-1">{f.message}</div>}
                  {f.etat === 'ok' && (
                    <div className="mt-2 d-flex flex-column gap-1">
                      {f.blocs.map((b, i) => {
                        const inclus = blocInclus(f, i);
                        return (
                          <label key={b.source} className={`d-flex align-items-center gap-2 small rounded px-2 py-1 ${inclus ? 'bg-lighter' : 'text-muted'}`} style={{ cursor: 'pointer' }}>
                            <input type="checkbox" className="form-check-input mt-0" checked={inclus} onChange={() => setExclusBlocs((x) => ({ ...x, [`${f.cle}:${i}`]: inclus }))} />
                            <span className="text-truncate">{b.source.replace(`${b.fichier_base} · `, '')}</span>
                            {b.classe_detectee && <span className="badge bg-label-primary">{b.classe_detectee}</span>}
                            <span className="ms-auto text-nowrap">{b.lignes.length} ligne{b.lignes.length > 1 ? 's' : ''}</span>
                            {b.pertinent === false && <span className="badge bg-label-warning text-nowrap" title="Ce tableau ne ressemble pas à une liste d'élèves (emploi du temps, notes…). Cochez-le pour l'importer quand même.">ignoré</span>}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {fichiers.length > 0 && (
            <p className="small text-muted mb-0">
              <i className="bx bx-info-circle me-1" />
              {nbLignesIncluses} ligne{nbLignesIncluses > 1 ? 's' : ''} retenue{nbLignesIncluses > 1 ? 's' : ''}. Les titres, lignes vides, totaux et en-têtes répétés sont déjà écartés ; les tableaux qui ne sont pas des listes d'élèves sont décochés.
            </p>
          )}
        </>
      )}

      {(etape === 'correspondance' || etape === 'apercu') && !rep && (
        <div className="text-center text-muted py-5">
          {erreurCalcul ? <div className="alert alert-danger">{erreurCalcul}</div> : <><span className="spinner-border text-primary mb-2" /><div>Analyse des colonnes…</div></>}
        </div>
      )}

      {etape === 'correspondance' && rep && mapping && (
        <Correspondance
          rep={rep}
          mapping={mapping}
          setMapping={setMapping}
          options={options}
          setOptions={setOptions}
          setOpt={setOpt}
          parents={parents}
          manquants={manquants}
          exempleNom={exempleNom}
          champsMappes={champsMappes}
          calcul={calcul}
          erreurCalcul={erreurCalcul}
        />
      )}

      {etape === 'apercu' && rep && (
        <>
          <div className="d-flex flex-wrap gap-2 mb-3">
            {[
              ['tous', 'Toutes', r.total, 'secondary'],
              ['nouveau', 'Nouveaux', r.nouveaux, 'success'],
              ['maj', 'Mis à jour', r.mises_a_jour, 'info'],
              ['existant', 'Déjà enregistrés', r.existants, 'secondary'],
              ['erreur', 'Erreurs', r.erreurs, 'danger'],
              ['alertes', 'À vérifier', r.avertissements, 'warning'],
              ['exclu', 'Exclues', r.exclus, 'dark'],
            ].filter(([k, , n]) => k === 'tous' || n > 0).map(([k, label, n, color]) => (
              <button key={k} type="button" className={`btn btn-sm ${filtre === k ? `btn-${color}` : `btn-outline-${color}`}`} onClick={() => { setFiltre(k); pagination.reset(); }}>
                {label} <span className="badge bg-white text-dark ms-1">{n}</span>
              </button>
            ))}
            {calcul && <span className="spinner-border spinner-border-sm text-primary align-self-center ms-1" />}
          </div>

          <div className="row g-2 mb-3 small">
            <div className="col-md-8 d-flex flex-wrap gap-3 text-muted align-items-center">
              {r.inscriptions > 0 && <span><i className="bx bx-user-check text-success me-1" />{r.inscriptions} inscription{r.inscriptions > 1 ? 's' : ''} à créer</span>}
              {r.matricules_generes > 0 && <span><i className="bx bx-barcode me-1" />{r.matricules_generes} matricule{r.matricules_generes > 1 ? 's' : ''} généré{r.matricules_generes > 1 ? 's' : ''}</span>}
              {r.parents_nouveaux > 0 && <span><i className="bx bx-user-plus me-1" />{r.parents_nouveaux} parent{r.parents_nouveaux > 1 ? 's' : ''} à créer</span>}
              {r.erreurs > 0 && <button type="button" className="btn btn-link btn-sm p-0" onClick={() => exporterProblemes(rep.lignes.filter((l) => l.statut === 'erreur'), 'import-eleves-erreurs.csv')}><i className="bx bx-download me-1" />Exporter les erreurs</button>}
            </div>
            <div className="col-md-4">
              <input type="search" className="form-control form-control-sm" placeholder="Rechercher un nom, un matricule…" value={recherche} onChange={(e) => { setRecherche(e.target.value); pagination.reset(); }} />
            </div>
          </div>

          {r.erreurs > 0 && (
            <div className="alert alert-warning small py-2">
              <i className="bx bx-error me-1" />
              Les lignes en erreur ne seront pas importées. Corrigez-les avec <i className="bx bx-edit-alt" />, excluez-les, ou importez sans elles.
            </div>
          )}

          <div className="table-responsive border rounded">
            <table className="table table-sm table-hover mb-0 align-middle small">
              <thead className="table-light">
                <tr>
                  <th>Statut</th>
                  <th>Élève</th>
                  <th>Matricule</th>
                  <th>Sexe</th>
                  <th>Naissance</th>
                  <th>Classe</th>
                  <th>Remarques</th>
                  <th className="text-end" />
                </tr>
              </thead>
              <tbody>
                {pagination.slice.map((l) => {
                  const d = l.donnees;
                  const [libelleStatut, couleur] = STATUTS[l.statut] || [l.statut, 'bg-label-secondary'];
                  if (edition?.id === l.id) {
                    return <LigneEdition key={l.id} l={l} edition={edition} setEdition={setEdition} classes={rep.classes} onValider={validerEdition} />;
                  }
                  return (
                    <tr key={l.id} className={l.statut === 'exclu' ? 'opacity-50' : ''}>
                      <td><span className={`badge ${couleur}`}>{libelleStatut}</span>{l.statut === 'maj' && <div className="text-muted" style={{ fontSize: 11 }}>{l.changements.join(', ').replaceAll('_', ' ')}</div>}</td>
                      <td>
                        <div className="fw-semibold">{d.nom || <span className="text-danger">—</span>} {d.prenom || <span className="text-danger">—</span>}</div>
                        <small className="text-muted">{l.source}</small>
                      </td>
                      <td><code className="small">{d.matricule || '—'}</code>{l.matricule_genere && l.statut === 'nouveau' && <span className="badge bg-label-info ms-1" title="Généré automatiquement">auto</span>}</td>
                      <td>{d.sexe || <span className="text-danger">—</span>}</td>
                      <td className="text-nowrap">{d.date_naissance ? formatDate(d.date_naissance) : '—'}<div className="text-muted">{d.lieu_naissance}</div></td>
                      <td>
                        {d.classe_id ? <span className="badge bg-label-primary">{classeLibelle(d.classe_id)}</span> : d.classe_libelle ? <span className="badge bg-label-warning">{d.classe_libelle} ?</span> : <span className="text-muted">—</span>}
                        {INSCRIPTIONS[l.inscription] && <div className="text-muted" style={{ fontSize: 11 }}>{INSCRIPTIONS[l.inscription]}</div>}
                      </td>
                      <td style={{ maxWidth: 280 }}>
                        {l.erreurs.map((e) => <div key={e} className="text-danger"><i className="bx bx-x-circle me-1" />{e}</div>)}
                        {l.statut !== 'exclu' && l.avertissements.map((a) => <div key={a} className="text-warning"><i className="bx bx-error me-1" />{a}</div>)}
                      </td>
                      <td className="text-end text-nowrap">
                        {l.statut !== 'exclu' && <IconBtn icon="bx-edit-alt" title="Corriger" onClick={() => ouvrirEdition(l)} />}
                        <IconBtn icon={l.statut === 'exclu' ? 'bx-undo' : 'bx-block'} title={l.statut === 'exclu' ? 'Réintégrer' : "Exclure de l'import"} onClick={() => basculerExclusion(l.id)} />
                      </td>
                    </tr>
                  );
                })}
                {!lignesFiltrees.length && <tr><td colSpan={8} className="text-center text-muted py-4">Aucune ligne dans cette catégorie.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pager pagination={pagination} unit="lignes" />
        </>
      )}

      {etape === 'termine' && bilan && (
        <div className="text-center py-3">
          <i className="bx bx-check-circle text-success" style={{ fontSize: 56 }} />
          <h5 className="mt-2">Import terminé</h5>
          <div className="row g-3 justify-content-center my-3">
            {[
              ['Élèves créés', bilan.eleves_crees || 0, 'success'],
              ['Élèves mis à jour', bilan.eleves_mis_a_jour || 0, 'info'],
              ['Inscriptions créées', bilan.inscriptions_creees || 0, 'primary'],
              ['Parents créés', bilan.parents_crees || 0, 'secondary'],
            ].map(([label, n, color]) => (
              <div key={label} className="col-6 col-md-3">
                <div className={`border rounded-3 p-3 bg-label-${color}`}><div className="fs-3 fw-bold">{n}</div><small>{label}</small></div>
              </div>
            ))}
          </div>
          {r?.erreurs > 0 && (
            <p className="text-muted small">
              {r.erreurs} ligne{r.erreurs > 1 ? 's' : ''} en erreur n'{r.erreurs > 1 ? 'ont' : 'a'} pas été importée{r.erreurs > 1 ? 's' : ''}.{' '}
              <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={() => exporterProblemes(rep.lignes.filter((l) => l.statut === 'erreur'), 'import-eleves-non-importes.csv')}>Télécharger la liste</button>
            </p>
          )}
          {rep?.lignes.some((l) => l.parent === 'defaut') && options.parent_defaut === 'provisoire' && (
            <p className="text-muted small mb-0"><i className="bx bx-info-circle me-1" />Les élèves sans parent dans le fichier sont rattachés au parent « PARENT À compléter ». Complétez leur fiche quand vous aurez l'information.</p>
          )}
          <p className="text-muted small mb-0">La correspondance des colonnes et des classes est mémorisée pour vos prochains imports.</p>
        </div>
      )}
    </Modal>
  );
}

function Correspondance({ rep, mapping, setMapping, options, setOptions, setOpt, parents, manquants, exempleNom, champsMappes, calcul, erreurCalcul }) {
  const champs = rep.champs;
  const colonnes = [...rep.colonnes].sort((a, b) => (b.champ ? 1 : 0) - (a.champ ? 1 : 0));
  const classes = rep.classes;
  const parentsTries = useMemo(() => [...parents].sort((a, b) => (a.nom || '').localeCompare(b.nom || '')), [parents]);
  const setClasse = (libelle) => (e) => setOptions((o) => ({ ...o, classes: { ...o.classes, [libelle]: e.target.value } }));
  const anneeId = options.annee_scolaire_id || (rep.annee_scolaire_id ? String(rep.annee_scolaire_id) : '');
  const parentDansFichier = [...champsMappes].some((c) => c.startsWith('parent_'));

  return (
    <div className="row g-4">
      <div className="col-lg-7">
        <h6 className="mb-1">Correspondance des colonnes {calcul && <span className="spinner-border spinner-border-sm text-primary ms-1" />}</h6>
        <p className="small text-muted">Pour chaque colonne trouvée dans vos fichiers, indiquez l'information qu'elle contient. Les suggestions automatiques sont marquées <span className="badge bg-label-success">auto</span>.</p>
        {erreurCalcul && <div className="alert alert-danger small py-2">{erreurCalcul}</div>}
        <div className="table-responsive border rounded">
          <table className="table table-sm mb-0 align-middle small">
            <thead className="table-light"><tr><th>Colonne du fichier</th><th>Exemples</th><th style={{ minWidth: 220 }}>Correspond à</th></tr></thead>
            <tbody>
              {colonnes.map((c) => {
                const valeur = mapping[c.cle] ?? '';
                const auto = valeur && rep.mapping_suggere[c.cle] === valeur;
                return (
                  <tr key={c.cle} className={valeur ? '' : 'text-muted'}>
                    <td>
                      <div className="fw-semibold">{c.libelle}</div>
                      {c.nb_tableaux > 1 && <small className="text-muted">{c.nb_tableaux} tableaux</small>}
                    </td>
                    <td className="text-truncate" style={{ maxWidth: 200 }}>{c.exemples.join(' · ') || <em>vide</em>}</td>
                    <td>
                      <div className="d-flex align-items-center gap-1">
                        <Select className="form-select form-select-sm" value={valeur} onChange={(e) => setMapping((m) => ({ ...m, [c.cle]: e.target.value }))}>
                          <option value="">— Ignorer cette colonne —</option>
                          {champs.map((ch) => <option key={ch.cle} value={ch.cle}>{ch.libelle}</option>)}
                        </Select>
                        {auto && <span className="badge bg-label-success">auto</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {manquants.length > 0 && (
          <div className="alert alert-danger small mt-3 mb-0">
            <strong>Il manque :</strong>
            <ul className="mb-0 ps-3">{manquants.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        )}

        {champsMappes.has('nom_complet') && (
          <div className="border rounded p-3 mt-3">
            <div className="fw-semibold small mb-2">Découpage « Nom et prénoms »</div>
            <div className="d-flex flex-wrap gap-3 small">
              {[
                ['premier', 'Le 1er mot est le nom'],
                ['deux', 'Les 2 premiers mots sont le nom'],
                ['dernier', 'Le dernier mot est le prénom'],
              ].map(([k, label]) => (
                <label key={k} className="form-check mb-0">
                  <input type="radio" className="form-check-input" name="separation" checked={options.separation === k} onChange={() => setOptions((o) => ({ ...o, separation: k }))} />
                  <span className="form-check-label">{label}</span>
                </label>
              ))}
            </div>
            {exempleNom && (
              <div className="small mt-2">
                Exemple : <span className="badge bg-label-primary">Nom : {exempleNom.donnees.nom}</span> <span className="badge bg-label-info">Prénom : {exempleNom.donnees.prenom}</span>
              </div>
            )}
            <div className="form-text">Une virgule (« NGONO, Marie ») ou des MAJUSCULES pour le nom (« NGONO Marie Claire ») sont reconnues automatiquement.</div>
          </div>
        )}
      </div>

      <div className="col-lg-5">
        <h6 className="mb-2">Inscription dans les classes</h6>
        <div className="border rounded p-3 mb-3">
          <label className="form-check mb-2">
            <input type="checkbox" className="form-check-input" checked={options.inscrire} onChange={setOpt('inscrire')} />
            <span className="form-check-label small">Inscrire les élèves dans leur classe</span>
          </label>
          {options.inscrire && (
            <>
              <div className="row g-2 mb-2">
                <div className="col-7">
                  <label className="form-label small mb-1">Année scolaire</label>
                  <Select className="form-select form-select-sm" value={anneeId} onChange={setOpt('annee_scolaire_id')}>
                    {rep.annees.length ? rep.annees.map((a) => <option key={a.id} value={a.id}>{a.libelle}{a.active ? ' (en cours)' : ''}</option>) : <option value="">Aucune année</option>}
                  </Select>
                </div>
                <div className="col-5">
                  <label className="form-label small mb-1">Date d'inscription</label>
                  <input type="date" className="form-control form-control-sm" value={options.date_inscription} onChange={setOpt('date_inscription')} />
                </div>
              </div>
              {rep.classes_detectees.length > 0 && (
                <>
                  <div className="small fw-semibold mt-3 mb-1">Classes trouvées dans les fichiers</div>
                  <table className="table table-sm mb-2 small align-middle">
                    <tbody>
                      {rep.classes_detectees.map((c) => (
                        <tr key={c.libelle}>
                          <td className="text-nowrap"><span className="badge bg-label-secondary">{c.libelle}</span><div className="text-muted" style={{ fontSize: 11 }}>{c.nb} élève{c.nb > 1 ? 's' : ''}</div></td>
                          <td className="w-100">
                            <div className="d-flex align-items-center gap-1">
                              <Select className="form-select form-select-sm" value={c.classe_id ? String(c.classe_id) : ''} onChange={setClasse(c.libelle)}>
                                <option value="">— Ne pas inscrire —</option>
                                {classes.map((cl) => <option key={cl.id} value={cl.id}>{cl.libelle}</option>)}
                              </Select>
                              {c.suggere && <span className="badge bg-label-success">auto</span>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rep.classes_detectees.some((c) => !c.classe_id) && (
                    <div className="form-text mb-2">Une classe absente de la liste ? Créez-la dans Configuration, puis revenez : la correspondance sera proposée automatiquement.</div>
                  )}
                </>
              )}
              <label className="form-label small mb-1">{rep.classes_detectees.length ? 'Classe des élèves sans classe identifiée' : 'Classe de tous les élèves importés'}</label>
              <Select className="form-select form-select-sm" value={options.classe_fixe} onChange={setOpt('classe_fixe')}>
                <option value="">— Aucune (pas d'inscription) —</option>
                {classes.map((cl) => <option key={cl.id} value={cl.id}>{cl.libelle}</option>)}
              </Select>
              <label className="form-check mt-2 mb-0">
                <input type="checkbox" className="form-check-input" checked={options.classe_depuis_titre} onChange={setOpt('classe_depuis_titre')} />
                <span className="form-check-label small">Déduire la classe du titre du tableau ou du nom du fichier</span>
              </label>
            </>
          )}
        </div>

        <h6 className="mb-2">Règles de traitement</h6>
        <div className="border rounded p-3 small">
          <label className="form-label small mb-1">Élèves déjà enregistrés (même matricule, ou même nom et date de naissance)</label>
          <Select className="form-select form-select-sm mb-3" value={options.doublons} onChange={setOpt('doublons')}>
            <option value="ignorer">Ne pas modifier leur fiche (seulement les inscrire)</option>
            <option value="mettre_a_jour">Mettre à jour leur fiche avec le fichier</option>
          </Select>

          <label className="form-check mb-1">
            <input type="checkbox" className="form-check-input" checked={options.matricules_auto} onChange={setOpt('matricules_auto')} />
            <span className="form-check-label">Générer un matricule quand il manque</span>
          </label>
          {options.matricules_auto && (
            <div className="input-group input-group-sm mb-3">
              <span className="input-group-text">Préfixe</span>
              <input type="text" className="form-control" maxLength={20} placeholder={String(new Date().getFullYear())} value={options.prefixe_matricule} onChange={setOpt('prefixe_matricule')} />
              <span className="input-group-text text-muted">{(options.prefixe_matricule || new Date().getFullYear())}0001</span>
            </div>
          )}

          <div className="row g-2 mb-3">
            <div className="col-6">
              <label className="form-label small mb-1">Sexe manquant</label>
              <Select className="form-select form-select-sm" value={options.sexe_defaut} onChange={setOpt('sexe_defaut')}>
                <option value="">Signaler en erreur</option>
                <option value="M">Masculin par défaut</option>
                <option value="F">Féminin par défaut</option>
              </Select>
            </div>
            <div className="col-6">
              <label className="form-label small mb-1">Lieu de naissance manquant</label>
              <input type="text" className="form-control form-control-sm" placeholder="Laisser vide = erreur" value={options.lieu_defaut} onChange={setOpt('lieu_defaut')} />
            </div>
          </div>

          <label className="form-label small mb-1">{parentDansFichier ? 'Élèves sans parent renseigné' : 'Parent des élèves importés'}</label>
          <Select className="form-select form-select-sm mb-1" value={String(options.parent_defaut)} onChange={setOpt('parent_defaut')}>
            <option value="provisoire">Parent provisoire « À compléter »</option>
            {parentsTries.map((p) => <option key={p.id} value={p.id}>{`${p.nom || ''} ${p.prenom || ''}${p.telephone ? ` — ${p.telephone}` : ''}`}</option>)}
          </Select>
          <div className="form-text mb-3">{parentDansFichier ? 'Les parents du fichier sont créés, ou retrouvés par téléphone / e-mail (les frères et sœurs partagent le même parent).' : 'Aucune colonne parent dans le fichier : un parent provisoire unique est utilisé, à compléter plus tard.'}</div>

          <label className="form-check mb-0">
            <input type="checkbox" className="form-check-input" checked={options.harmoniser_casse} onChange={setOpt('harmoniser_casse')} />
            <span className="form-check-label">Harmoniser l'écriture : NOM en majuscules, Prénom en minuscules</span>
          </label>
        </div>
      </div>
    </div>
  );
}

function LigneEdition({ l, edition, setEdition, classes, onValider }) {
  const v = edition.valeurs;
  const set = (name) => (e) => setEdition((ed) => ({ ...ed, valeurs: { ...ed.valeurs, [name]: e.target.value } }));
  return (
    <tr className="table-active">
      <td colSpan={8}>
        <div className="small text-muted mb-2">{l.source}</div>
        <div className="row g-2">
          <div className="col-md-2"><label className="form-label small mb-0">Matricule</label><input className="form-control form-control-sm" value={v.matricule} placeholder={l.matricule_genere ? 'auto' : ''} onChange={set('matricule')} /></div>
          <div className="col-md-2"><label className="form-label small mb-0">Nom</label><input className="form-control form-control-sm" value={v.nom} onChange={set('nom')} /></div>
          <div className="col-md-3"><label className="form-label small mb-0">Prénom(s)</label><input className="form-control form-control-sm" value={v.prenom} onChange={set('prenom')} /></div>
          <div className="col-md-1">
            <label className="form-label small mb-0">Sexe</label>
            <select className="form-select form-select-sm" value={v.sexe} onChange={set('sexe')}><option value="">—</option><option value="M">M</option><option value="F">F</option></select>
          </div>
          <div className="col-md-2"><label className="form-label small mb-0">Né(e) le</label><input type="date" className="form-control form-control-sm" value={v.date_naissance} onChange={set('date_naissance')} /></div>
          <div className="col-md-2"><label className="form-label small mb-0">Lieu</label><input className="form-control form-control-sm" value={v.lieu_naissance} onChange={set('lieu_naissance')} /></div>
          <div className="col-md-4">
            <label className="form-label small mb-0">Classe</label>
            <Select className="form-select form-select-sm" value={v.classe_id} onChange={set('classe_id')}>
              <option value="">— Selon le fichier —</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
            </Select>
          </div>
          <div className="col-md-8 d-flex align-items-end justify-content-end gap-2">
            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setEdition(null)}>Annuler</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onValider}><i className="bx bx-check me-1" /> Appliquer</button>
          </div>
        </div>
      </td>
    </tr>
  );
}

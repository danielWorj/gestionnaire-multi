import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import Select from './Select';
import { api, apiRequest } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { downloadCsv, IconBtn, Pager, usePagination, useToast } from './ui';

// Assistant d'import générique (enseignants, classes, matières) : même
// déroulé que ImportElevesModal — fichiers, colonnes et options,
// vérification ligne par ligne, bilan. Tout le travail d'interprétation est
// fait par le serveur (server/services/import_<module>_services.py) ;
// l'aperçu et l'import passent par le même traitement, ce qui est affiché est
// exactement ce qui sera enregistré.
//
// Ce qui change d'un module à l'autre est décrit par `config` (cf.
// importConfigs.jsx) : options, panneau d'options, colonnes de l'aperçu,
// champs corrigeables, bilan.

const ETAPES = [
  ['fichiers', 'Fichiers'],
  ['correspondance', 'Colonnes et options'],
  ['apercu', 'Vérification'],
  ['termine', 'Terminé'],
];

const FORMATS = '.csv,.txt,.tsv,.xlsx,.xlsm,.xls,.docx,.doc';

export const STATUTS = {
  nouveau: ['Nouveau', 'bg-label-success'],
  maj: ['Mis à jour', 'bg-label-info'],
  existant: ['Déjà enregistré', 'bg-label-secondary'],
  erreur: ['Erreur', 'bg-label-danger'],
  exclu: ['Exclu', 'bg-label-dark'],
};

function lireMemoire(cle) {
  try {
    return JSON.parse(localStorage.getItem(cle) || 'null') || {};
  } catch {
    return {};
  }
}

const tailleLisible = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

export default function ImportAssistant({ config, onClose, onImported }) {
  const toast = useToast();
  const { user, activeEtablissementId } = useAuth();
  const { module } = config;
  const cleMemoire = `import-${module}:${activeEtablissementId || user?.etablissement_id || 'etab'}`;
  const memoire = useMemo(() => lireMemoire(cleMemoire), [cleMemoire]);

  const [etape, setEtape] = useState('fichiers');
  const [fichiers, setFichiers] = useState([]);
  const [exclusBlocs, setExclusBlocs] = useState({});
  const [texte, setTexte] = useState('');
  const [modeTexte, setModeTexte] = useState(false);
  const [survol, setSurvol] = useState(false);

  const [mapping, setMapping] = useState(null);
  const [options, setOptions] = useState(() => {
    const memo = memoire.options || {};
    return {
      ...config.optionsDefaut,
      ...Object.fromEntries((config.optionsMemorisees || []).filter((k) => k in memo).map((k) => [k, memo[k]])),
    };
  });
  const [corrections, setCorrections] = useState({});
  const [exclues, setExclues] = useState([]);
  const [rep, setRep] = useState(null);
  const [calcul, setCalcul] = useState(false);
  const [erreurCalcul, setErreurCalcul] = useState('');
  const [importEnCours, setImportEnCours] = useState(false);
  const [bilan, setBilan] = useState(null);
  const requete = useRef(0);

  /* ── Étape 1 : fichiers ─────────────────────────────────────────────── */

  const envoyer = useCallback(async (cle, fd) => {
    try {
      const res = await apiRequest(`/import/${module}/analyser`, { method: 'POST', body: fd });
      const message = res.erreurs?.[0]?.message || (res.blocs.length ? '' : 'Aucun tableau trouvé.');
      setFichiers((prev) => prev.map((f) => (f.cle === cle ? { ...f, etat: res.blocs.length ? 'ok' : 'erreur', blocs: res.blocs, message } : f)));
      return true;
    } catch (err) {
      setFichiers((prev) => prev.map((f) => (f.cle === cle ? { ...f, etat: 'erreur', message: err.message } : f)));
      return false;
    }
  }, [module]);

  const analyser = useCallback(async (liste) => {
    const nouveaux = liste.map((f) => ({ cle: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`, nom: f.name, taille: f.size, etat: 'analyse', blocs: [], message: '' }));
    setFichiers((prev) => [...prev, ...nouveaux]);
    // Un fichier par requête : pas de limite de taille cumulée côté proxy,
    // et un fichier illisible n'empêche pas de lire les autres.
    await Promise.all(liste.map((fichier, i) => {
      const fd = new FormData();
      fd.append('fichiers', fichier);
      return envoyer(nouveaux[i].cle, fd);
    }));
  }, [envoyer]);

  const ajouterTexte = async () => {
    if (!texte.trim()) return;
    const cle = `colle-${Date.now()}`;
    setFichiers((prev) => [...prev, { cle, nom: 'Tableau collé', taille: texte.length, etat: 'analyse', blocs: [], message: '' }]);
    const fd = new FormData();
    fd.append('texte', texte);
    if (await envoyer(cle, fd)) {
      setTexte('');
      setModeTexte(false);
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    setSurvol(false);
    const liste = [...(event.dataTransfer?.files || [])];
    if (liste.length) analyser(liste);
  };

  const blocInclus = useCallback((f, i) => {
    const force = exclusBlocs[`${f.cle}:${i}`];
    return force === undefined ? f.blocs[i].pertinent !== false : !force;
  }, [exclusBlocs]);

  const blocsInclus = useMemo(() => fichiers.flatMap((f) => f.blocs
    .map((b, i) => [b, i])
    .filter(([, i]) => blocInclus(f, i))
    .map(([b]) => ({ source: b.source, entetes: b.entetes, lignes: b.lignes, numeros: b.numeros, classe_detectee: b.classe_detectee }))),
  [fichiers, blocInclus]);

  const nbLignesIncluses = blocsInclus.reduce((s, b) => s + b.lignes.length, 0);
  const analyseEnCours = fichiers.some((f) => f.etat === 'analyse');

  const telechargerModele = async () => {
    try {
      const blob = await api.blob(`/import/${module}/modele`);
      const lien = document.createElement('a');
      lien.href = URL.createObjectURL(blob);
      lien.download = `modele-import-${module}.xlsx`;
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
      const res = await api.post(`/import/${module}/traiter`, {
        blocs: blocsInclus,
        mapping,
        options: config.optionsPourServeur ? config.optionsPourServeur(options) : options,
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
  }, [module, blocsInclus, mapping, options, corrections, exclues, memoire, config]);

  const enApercu = etape === 'correspondance' || etape === 'apercu';
  useEffect(() => {
    if (!enApercu) return undefined;
    const t = setTimeout(() => { calculer(false); }, mapping === null ? 0 : 350);
    return () => clearTimeout(t);
    // calculer change à chaque modification ci-dessous : on ne relance que
    // sur ces modifications (et à l'entrée dans l'étape 2).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping, options, corrections, exclues, enApercu]);

  const setOpt = useCallback((name) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setOptions((o) => ({ ...o, [name]: value }));
  }, []);

  const champsMappes = useMemo(() => new Set(Object.values(mapping || {}).filter(Boolean)), [mapping]);
  const manquants = useMemo(() => (mapping ? config.manquants(champsMappes, options) : []), [mapping, champsMappes, options, config]);

  /* ── Étape 3 : filtres, corrections, exclusions ─────────────────────── */

  const [filtre, setFiltre] = useState('tous');
  const [recherche, setRecherche] = useState('');
  const [edition, setEdition] = useState(null); // { id, valeurs }

  const lignesFiltrees = useMemo(() => {
    if (!rep) return [];
    const q = recherche.trim().toLowerCase();
    return rep.lignes.filter((l) => {
      if (filtre === 'alertes' && !(l.avertissements.length && l.statut !== 'erreur' && l.statut !== 'exclu')) return false;
      if (filtre !== 'tous' && filtre !== 'alertes' && l.statut !== filtre) return false;
      if (q && !`${Object.values(l.donnees).filter((x) => typeof x === 'string').join(' ')} ${l.source}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rep, filtre, recherche]);
  const pagination = usePagination(lignesFiltrees, 50);

  const validerEdition = () => {
    const { id, valeurs } = edition;
    setCorrections((c) => ({ ...c, [id]: valeurs }));
    setEdition(null);
  };

  const basculerExclusion = (id) => setExclues((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const exporterErreurs = () => {
    const lignes = rep.lignes.filter((l) => l.statut === 'erreur');
    downloadCsv(`import-${module}-erreurs.csv`, [
      ['Source', ...config.exportColonnes.map(([titre]) => titre), 'Erreurs', 'Avertissements'],
      ...lignes.map((l) => [l.source, ...config.exportColonnes.map(([, f]) => f(l)), l.erreurs.join(' | '), l.avertissements.join(' | ')]),
    ]);
  };

  /* ── Import ─────────────────────────────────────────────────────────── */

  const r = rep?.resume;
  const nbAction = rep ? config.nbActions(rep) : 0;

  const importer = async () => {
    setImportEnCours(true);
    try {
      const res = await calculer(true);
      if (!res) return;
      localStorage.setItem(cleMemoire, JSON.stringify({
        colonnes: { ...(memoire.colonnes || {}), ...mapping },
        options: Object.fromEntries((config.optionsMemorisees || []).map((k) => [k, options[k]])),
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
  const contexte = { rep, options, setOptions, setOpt, champsMappes, mapping };

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
            {rep ? config.libelleImport(rep) : 'Importer'}
          </button>
        </>
      )}
      {etape === 'termine' && <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Fermer</button>}
    </>
  );

  const PanneauOptions = config.Options;
  const Bilan = config.Bilan;

  return (
    <Modal
      size="modal-xl"
      title={<><i className={`bx ${config.icone} me-2 text-primary`} />{config.titre}</>}
      subtitle="Depuis vos anciens fichiers : Excel, CSV ou Word (tableaux ou fiches). Rien n'est enregistré avant la dernière étape."
      onClose={importEnCours ? () => {} : onClose}
      footer={footer}
    >
      <ol className="list-unstyled d-flex flex-wrap gap-2 mb-4">
        {ETAPES.map(([k, label], i) => (
          <li key={k} className={`badge rounded-pill px-3 py-2 ${i === indexEtape ? 'bg-primary' : i < indexEtape ? 'bg-label-primary' : 'bg-label-secondary'}`}>
            {i < indexEtape ? <i className="bx bx-check me-1" /> : `${i + 1}. `}{label}
          </li>
        ))}
      </ol>

      {etape === 'fichiers' && (
        <>
          {config.aideFichiers && <div className="alert alert-info small py-2"><i className="bx bx-info-circle me-1" />{config.aideFichiers}</div>}
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
            <small className="text-muted">Excel (.xlsx, .xls), CSV et Word (.docx). Plusieurs fichiers à la fois.</small>
          </label>

          <div className="mb-3">
            {modeTexte ? (
              <div className="border rounded-3 p-3">
                <label className="form-label">Collez ici un tableau copié depuis Excel, Word ou une page web</label>
                <textarea className="form-control font-monospace small" rows={6} value={texte} onChange={(e) => setTexte(e.target.value)} placeholder={config.exempleCollage} />
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
                    <i className={`bx ${/\.docx?$/i.test(f.nom) ? 'bxs-file-doc text-info' : f.nom === 'Tableau collé' ? 'bx-paste text-secondary' : 'bxs-spreadsheet text-success'} fs-4`} />
                    <div className="flex-grow-1 min-w-0">
                      <div className="fw-semibold text-truncate">{f.nom}</div>
                      <small className="text-muted">{tailleLisible(f.taille)}{f.etat === 'ok' && ` · ${f.blocs.length} tableau${f.blocs.length > 1 ? 'x' : ''}`}</small>
                    </div>
                    {f.etat === 'analyse' && <span className="spinner-border spinner-border-sm text-primary" />}
                    {f.etat === 'erreur' && <span className="badge bg-label-danger">Illisible</span>}
                    <IconBtn icon="bx-x" title="Retirer" onClick={() => setFichiers((prev) => prev.filter((x) => x.cle !== f.cle))} />
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
                            {b.classe_detectee && config.afficherClasseBloc && <span className="badge bg-label-primary">{b.classe_detectee}</span>}
                            <span className="ms-auto text-nowrap">{b.lignes.length} ligne{b.lignes.length > 1 ? 's' : ''}</span>
                            {b.pertinent === false && <span className="badge bg-label-warning text-nowrap" title={config.titreIgnore}>ignoré</span>}
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
              {nbLignesIncluses} ligne{nbLignesIncluses > 1 ? 's' : ''} retenue{nbLignesIncluses > 1 ? 's' : ''}. Titres, lignes vides, totaux et en-têtes répétés sont déjà écartés ; les tableaux sans rapport sont décochés.
            </p>
          )}
        </>
      )}

      {enApercu && !rep && (
        <div className="text-center text-muted py-5">
          {erreurCalcul ? <div className="alert alert-danger">{erreurCalcul}</div> : <><span className="spinner-border text-primary mb-2" /><div>Analyse des colonnes…</div></>}
        </div>
      )}

      {etape === 'correspondance' && rep && mapping && (
        <div className="row g-4">
          <div className="col-lg-7">
            <h6 className="mb-1">Correspondance des colonnes {calcul && <span className="spinner-border spinner-border-sm text-primary ms-1" />}</h6>
            <p className="small text-muted">Pour chaque colonne trouvée dans vos fichiers, indiquez l'information qu'elle contient. Les suggestions automatiques sont marquées <span className="badge bg-label-success">auto</span>.</p>
            {erreurCalcul && <div className="alert alert-danger small py-2">{erreurCalcul}</div>}
            <div className="table-responsive border rounded">
              <table className="table table-sm mb-0 align-middle small">
                <thead className="table-light"><tr><th>Colonne du fichier</th><th>Exemples</th><th style={{ minWidth: 220 }}>Correspond à</th></tr></thead>
                <tbody>
                  {[...rep.colonnes].sort((a, b) => (mapping[b.cle] ? 1 : 0) - (mapping[a.cle] ? 1 : 0)).map((c) => {
                    const valeur = mapping[c.cle] ?? '';
                    const auto = valeur && rep.mapping_suggere[c.cle] === valeur;
                    return (
                      <tr key={c.cle} className={valeur ? '' : 'text-muted'}>
                        <td><div className="fw-semibold">{c.libelle}</div>{c.nb_tableaux > 1 && <small className="text-muted">{c.nb_tableaux} tableaux</small>}</td>
                        <td className="text-truncate" style={{ maxWidth: 200 }}>{c.exemples.join(' · ') || <em>vide</em>}</td>
                        <td>
                          <div className="d-flex align-items-center gap-1">
                            <Select className="form-select form-select-sm" value={valeur} onChange={(e) => setMapping((m) => ({ ...m, [c.cle]: e.target.value }))}>
                              <option value="">— Ignorer cette colonne —</option>
                              {rep.champs.map((ch) => <option key={ch.cle} value={ch.cle}>{ch.libelle}</option>)}
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
            {config.OptionsColonnes && <config.OptionsColonnes {...contexte} />}
          </div>
          <div className="col-lg-5">
            <PanneauOptions {...contexte} />
          </div>
        </div>
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
              {config.resumeApercu(rep).map(([icone, texte]) => <span key={texte}><i className={`bx ${icone} me-1`} />{texte}</span>)}
              {r.erreurs > 0 && <button type="button" className="btn btn-link btn-sm p-0" onClick={exporterErreurs}><i className="bx bx-download me-1" />Exporter les erreurs</button>}
            </div>
            <div className="col-md-4">
              <input type="search" className="form-control form-control-sm" placeholder="Rechercher…" value={recherche} onChange={(e) => { setRecherche(e.target.value); pagination.reset(); }} />
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
                  {config.colonnesApercu.map(([titre]) => <th key={titre}>{titre}</th>)}
                  <th>Remarques</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pagination.slice.map((l) => {
                  const [libelleStatut, couleur] = STATUTS[l.statut] || [l.statut, 'bg-label-secondary'];
                  const nbColonnes = config.colonnesApercu.length + 3;
                  if (edition?.id === l.id) {
                    return (
                      <LigneEdition
                        key={l.id}
                        l={l}
                        colSpan={nbColonnes}
                        champs={config.edition.champs(rep, l)}
                        edition={edition}
                        setEdition={setEdition}
                        onValider={validerEdition}
                      />
                    );
                  }
                  return (
                    <tr key={l.id} className={l.statut === 'exclu' ? 'opacity-50' : ''}>
                      <td>
                        <span className={`badge ${couleur}`}>{libelleStatut}</span>
                        {l.statut === 'maj' && l.changements?.length > 0 && <div className="text-muted" style={{ fontSize: 11 }}>{l.changements.join(', ').replaceAll('_', ' ')}</div>}
                      </td>
                      {config.colonnesApercu.map(([titre, rendu]) => <td key={titre}>{rendu(l, rep)}</td>)}
                      <td style={{ maxWidth: 280 }}>
                        {l.erreurs.map((e) => <div key={e} className="text-danger"><i className="bx bx-x-circle me-1" />{e}</div>)}
                        {l.statut !== 'exclu' && l.avertissements.map((a) => <div key={a} className="text-warning"><i className="bx bx-error me-1" />{a}</div>)}
                      </td>
                      <td className="text-end text-nowrap">
                        {l.statut !== 'exclu' && <IconBtn icon="bx-edit-alt" title="Corriger" onClick={() => setEdition({ id: l.id, valeurs: config.edition.initial(l, options) })} />}
                        <IconBtn icon={l.statut === 'exclu' ? 'bx-undo' : 'bx-block'} title={l.statut === 'exclu' ? 'Réintégrer' : "Exclure de l'import"} onClick={() => basculerExclusion(l.id)} />
                      </td>
                    </tr>
                  );
                })}
                {!lignesFiltrees.length && <tr><td colSpan={config.colonnesApercu.length + 3} className="text-center text-muted py-4">Aucune ligne dans cette catégorie.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pager pagination={pagination} unit="lignes" />
        </>
      )}

      {etape === 'termine' && bilan && (
        <div className="py-2">
          <div className="text-center">
            <i className="bx bx-check-circle text-success" style={{ fontSize: 56 }} />
            <h5 className="mt-2">Import terminé</h5>
            <div className="row g-3 justify-content-center my-3">
              {config.cartesBilan.map(([cle, label, color]) => (
                <div key={cle} className="col-6 col-md-3">
                  <div className={`border rounded-3 p-3 bg-label-${color}`}><div className="fs-3 fw-bold">{bilan[cle] || 0}</div><small>{label}</small></div>
                </div>
              ))}
            </div>
            {r?.erreurs > 0 && (
              <p className="text-muted small">
                {r.erreurs} ligne{r.erreurs > 1 ? 's' : ''} en erreur n'{r.erreurs > 1 ? 'ont' : 'a'} pas été importée{r.erreurs > 1 ? 's' : ''}.{' '}
                <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={exporterErreurs}>Télécharger la liste</button>
              </p>
            )}
            <p className="text-muted small">La correspondance des colonnes et vos choix sont mémorisés pour les prochains imports.</p>
          </div>
          {Bilan && <Bilan bilan={bilan} rep={rep} />}
        </div>
      )}
    </Modal>
  );
}

function LigneEdition({ l, colSpan, champs, edition, setEdition, onValider }) {
  const v = edition.valeurs;
  const set = (name) => (e) => setEdition((ed) => ({ ...ed, valeurs: { ...ed.valeurs, [name]: e.target.value } }));
  return (
    <tr className="table-active">
      <td colSpan={colSpan}>
        <div className="small text-muted mb-2">{l.source}</div>
        <div className="row g-2">
          {champs.map((c) => (
            <div key={c.cle} className={c.col || 'col-md-3'}>
              <label className="form-label small mb-0">{c.label}</label>
              {c.choix ? (
                <Select className="form-select form-select-sm" value={v[c.cle] ?? ''} onChange={set(c.cle)}>
                  {c.choix.map(([valeur, libelle]) => <option key={valeur} value={valeur}>{libelle}</option>)}
                </Select>
              ) : (
                <>
                  <input className="form-control form-control-sm" value={v[c.cle] ?? ''} onChange={set(c.cle)} list={c.suggestions ? `liste-${c.cle}` : undefined} />
                  {c.suggestions && <datalist id={`liste-${c.cle}`}>{c.suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
                </>
              )}
            </div>
          ))}
          <div className="col-12 d-flex justify-content-end gap-2">
            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setEdition(null)}>Annuler</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onValider}><i className="bx bx-check me-1" /> Appliquer</button>
          </div>
        </div>
      </td>
    </tr>
  );
}

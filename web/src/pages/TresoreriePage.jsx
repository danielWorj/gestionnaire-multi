import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import {
  enregistrer, estARessayer, mettreEnAttente, nouvelleCle, terminerEnregistrement, useApresSynchro, useEnLigne,
} from '../lib/offline';
import Modal from '../components/Modal';
import Select from '../components/Select';
import OperationsEnAttente from '../components/OperationsEnAttente';
import ImportModal from '../components/importConfigs';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import { useAuth } from '../context/AuthContext';
import {
  downloadCsv, formatMontant, FormFooter, IconBtn, PageHeader, StatCard, TableCard, Tabs, TBody, useConfirm, useToast,
} from '../components/ui';
import { aujourdhuiIso, formatDateCourt, ouvrirImpression } from '../lib/paiementsImpression';
import { construireHtmlBon, construireHtmlEtat, construireHtmlJournal } from '../lib/tresorerieImpression';
import { periodeParDefaut, SENS, TYPES_COMPTE, urlEtat } from '../lib/tresorerie';

// Trésorerie (server/api/tresorerie_api.py) : entrées et sorties par
// catégorie, fonds (catégories d'entrée) et comptes. Les paiements de
// scolarité y figurent automatiquement ; seules les autres opérations se
// saisissent ici.
//
// Hors connexion : la page s'ouvre sur les copies locales (préchargées à
// chaque connexion pour la période par défaut, cf. lib/offline.js) ; une
// opération ou une annulation saisie sans réseau est gardée sur l'appareil
// et envoyée au retour de la connexion (clé d'idempotence : jamais de
// doublon). Les catégories et comptes ne se modifient qu'en ligne.

const MODULES = ['tresorerie'];

const Montant = ({ valeur, signe = false }) => (
  <span className={signe && valeur < 0 ? 'text-danger fw-semibold' : ''}>{formatMontant(valeur)}</span>
);

const nouvelIdentifiant = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : nouvelleCle('t'));

export default function TresoreriePage() {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const { activeEtablissementId, isSuperAdmin } = useAuth();
  const etablissement = useEtablissementCourant();
  const enLigne = useEnLigne();

  const [periode, setPeriode] = useState(periodeParDefaut);
  const [categories, setCategories] = useState([]);
  const [comptes, setComptes] = useState([]);
  const [synthese, setSynthese] = useState(null);
  const [journal, setJournal] = useState([]);
  const [filtres, setFiltres] = useState({ sens: '', categorie: '', compte: '' });
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState('');
  const [tab, setTab] = useState('synthese');
  const [modal, setModal] = useState(null);

  const charger = useCallback(async () => {
    setLoading(true);
    setErreur('');
    try {
      // Hors connexion, api.get sert la copie locale si elle existe.
      const [cats, cpts, synth, jour] = await Promise.all([
        api.get('/tresorerie/categories'), api.get('/tresorerie/comptes'),
        api.get(urlEtat('synthese', periode)), api.get(urlEtat('journal', periode)),
      ]);
      setCategories(cats || []);
      setComptes(cpts || []);
      setSynthese(synth);
      setJournal(jour?.lignes || []);
    } catch (e) {
      setErreur(e.status === 0
        ? "Serveur injoignable et aucune copie de cette période sur l'appareil. Hors connexion, seule la période par défaut (depuis le 1er septembre) est disponible."
        : e.message);
    } finally {
      setLoading(false);
    }
  }, [periode]);

  useEffect(() => { charger(); }, [charger, activeEtablissementId]);
  // Opérations saisies hors connexion, arrivées sur le serveur : totaux à jour.
  useApresSynchro(MODULES, charger);

  const categoriesById = useMemo(() => Object.fromEntries(categories.map((c) => [c.id, c])), [categories]);
  const comptesById = useMemo(() => Object.fromEntries(comptes.map((c) => [c.id, c])), [comptes]);
  const nomCategorie = useCallback((id) => categoriesById[id]?.libelle || '—', [categoriesById]);
  const nomCompte = useCallback((id) => comptesById[id]?.libelle || '—', [comptesById]);
  const fonds = categories.filter((c) => c.type === 'ENTREE');
  const soldesFonds = useMemo(() => Object.fromEntries((synthese?.fonds || []).map((f) => [f.categorie_id, f.solde])), [synthese]);

  const lignesJournal = useMemo(() => journal.filter((l) => {
    if (filtres.sens && l.sens !== filtres.sens) return false;
    if (filtres.compte && ![l.compte_id, l.compte_destination_id].includes(Number(filtres.compte))) return false;
    if (filtres.categorie) {
      const id = Number(filtres.categorie);
      if (l.categorie_id !== id && !(l.ventilation || []).some((v) => v.categorie_id === id)) return false;
    }
    return true;
  }), [journal, filtres]);

  const fondsDe = (l) => (l.sens === 'SORTIE' || (l.origine === 'paiement' && l.ventilation.length > 1)
    ? l.ventilation.map((v) => (l.ventilation.length > 1 ? `${nomCategorie(v.categorie_id)} (${formatMontant(v.montant)})` : nomCategorie(v.categorie_id))).join(', ')
    : '');

  const filtresTexte = [
    filtres.sens && SENS[filtres.sens].pluriel,
    filtres.categorie && `Catégorie : ${nomCategorie(Number(filtres.categorie))}`,
    filtres.compte && `Compte : ${nomCompte(Number(filtres.compte))}`,
  ].filter(Boolean).join(' · ');

  /* ── Exports et impressions ── */
  const exporterJournal = () => {
    downloadCsv(`tresorerie_${periode.du}_${periode.au}.csv`, [
      ['Date', 'Type', 'Libellé', 'Tiers', 'Catégorie', 'Fonds', 'Compte', 'Entrée', 'Sortie', 'Référence', 'Statut'],
      ...lignesJournal.map((l) => [
        l.date, l.origine === 'paiement' ? 'Scolarité' : SENS[l.sens].label, l.libelle, l.tiers || '',
        l.sens === 'TRANSFERT' ? '' : nomCategorie(l.categorie_id), fondsDe(l),
        l.sens === 'TRANSFERT' ? `${nomCompte(l.compte_id)} → ${nomCompte(l.compte_destination_id)}` : nomCompte(l.compte_id),
        l.sens === 'ENTREE' ? l.montant : '', l.sens === 'SORTIE' ? l.montant : '', l.reference || '',
        l.statut === 'ANNULE' ? `Annulé (${l.motif_annulation})` : '',
      ]),
    ]);
  };

  const imprimer = (html) => {
    if (!ouvrirImpression(html)) toast("Autorisez les fenêtres pop-up pour imprimer.", 'error');
  };
  const imprimerEtat = () => synthese && imprimer(construireHtmlEtat({ synthese, etablissement }));
  const imprimerJournal = () => imprimer(construireHtmlJournal({
    lignes: lignesJournal, du: periode.du, au: periode.au, filtresTexte, nomCategorie, nomCompte, etablissement,
  }));
  const imprimerBon = (operation) => imprimer(construireHtmlBon({ operation, nomCategorie, nomCompte, etablissement }));

  /* ── Saisies ── */
  const apresEnregistrement = async (message) => {
    setModal(null);
    toast(message);
    await charger();
  };

  const nouvelle = (sens) => {
    if (isSuperAdmin) {
      toast("Le SuperAdmin ne saisit pas d'opération : connectez-vous avec un compte Comptable ou Admin de l'établissement.", 'error');
      return;
    }
    setModal({ kind: 'mouvement', sens });
  };

  return (
    <>
      <PageHeader title="Trésorerie" subtitle="Entrées, dépenses, fonds et comptes de l'établissement. Les paiements de scolarité y figurent automatiquement.">
        <button type="button" className="btn btn-success" onClick={() => nouvelle('ENTREE')}><i className="bx bx-plus me-1" /> Entrée</button>
        <button type="button" className="btn btn-danger" onClick={() => nouvelle('SORTIE')}><i className="bx bx-minus me-1" /> Dépense</button>
        <button type="button" className="btn btn-outline-primary" onClick={() => nouvelle('TRANSFERT')}><i className="bx bx-transfer-alt me-1" /> Transfert</button>
        <button type="button" className="btn btn-outline-secondary" disabled={!enLigne} title={enLigne ? '' : "L'import nécessite une connexion"} onClick={() => setModal({ kind: 'import' })}><i className="bx bx-import me-1" /> Importer</button>
        <button type="button" className="btn btn-outline-secondary" disabled={!synthese} onClick={imprimerEtat}><i className="bx bx-printer me-1" /> État</button>
      </PageHeader>

      {!enLigne && (
        <div className="alert alert-warning small"><i className="bx bx-wifi-off me-1" />Hors connexion : chiffres de la dernière synchronisation. Les opérations saisies sont gardées sur l'appareil et envoyées au retour de la connexion.</div>
      )}
      <OperationsEnAttente modules={MODULES} titre="Opérations pas encore enregistrées sur le serveur" />

      <div className="card mb-4">
        <div className="card-body d-flex flex-wrap align-items-end gap-3">
          <div><label className="form-label">Du</label><input type="date" className="form-control" value={periode.du} max={periode.au} onChange={(e) => setPeriode((p) => ({ ...p, du: e.target.value }))} /></div>
          <div><label className="form-label">Au</label><input type="date" className="form-control" value={periode.au} min={periode.du} max={aujourdhuiIso()} onChange={(e) => setPeriode((p) => ({ ...p, au: e.target.value }))} /></div>
          <small className="text-muted mb-2">Les entrées et sorties portent sur la période ; les soldes sont cumulés jusqu'au {formatDateCourt(periode.au)}.</small>
        </div>
      </div>

      {erreur && <div className="alert alert-danger">{erreur}</div>}

      <div className="row g-4 mb-4">
        <StatCard loading={loading} label="Entrées" value={formatMontant(synthese?.total_entrees)} icon="bx-down-arrow-circle" color="success" sub="sur la période" />
        <StatCard loading={loading} label="Sorties" value={formatMontant(synthese?.total_sorties)} icon="bx-up-arrow-circle" color="danger" sub="sur la période" />
        <StatCard loading={loading} label="Résultat" value={formatMontant(synthese?.resultat)} icon="bx-line-chart" color={synthese?.resultat < 0 ? 'danger' : 'primary'} sub="entrées − sorties" />
        <StatCard loading={loading} label="Trésorerie disponible" value={formatMontant(synthese?.solde_global)} icon="bx-wallet" color="info" sub="total des comptes" />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'synthese', label: 'Synthèse', icon: 'bx-pie-chart-alt-2' },
          { key: 'journal', label: 'Journal', icon: 'bx-list-ul', count: lignesJournal.length },
          { key: 'parametres', label: 'Catégories & comptes', icon: 'bx-cog' },
        ]}
      />

      {tab === 'synthese' && (
        <div className="row g-4">
          <div className="col-lg-6">
            <TableCard title="Entrées par catégorie" icon="bx-down-arrow-circle">
              <table className="table">
                <thead><tr><th>Catégorie</th><th className="text-end">Montant</th><th className="text-end">dont scolarité</th></tr></thead>
                <TBody colSpan={3} loading={loading} rows={synthese?.entrees_par_categorie.length} empty="Aucune entrée sur la période">
                  {synthese?.entrees_par_categorie.map((c) => (
                    <tr key={c.categorie_id}><td>{c.libelle}</td><td className="text-end">{formatMontant(c.montant)}</td><td className="text-end text-muted">{c.dont_scolarite ? formatMontant(c.dont_scolarite) : '—'}</td></tr>
                  ))}
                </TBody>
              </table>
            </TableCard>
          </div>
          <div className="col-lg-6">
            <TableCard title="Sorties par catégorie" icon="bx-up-arrow-circle">
              <table className="table">
                <thead><tr><th>Catégorie</th><th className="text-end">Montant</th></tr></thead>
                <TBody colSpan={2} loading={loading} rows={synthese?.sorties_par_categorie.length} empty="Aucune dépense sur la période">
                  {synthese?.sorties_par_categorie.map((c) => (
                    <tr key={c.categorie_id}><td>{c.libelle}</td><td className="text-end">{formatMontant(c.montant)}</td></tr>
                  ))}
                </TBody>
              </table>
            </TableCard>
          </div>
          <div className="col-lg-7">
            <TableCard title="Fonds" icon="bx-coin-stack" footer={<small className="text-muted"><i className="bx bx-info-circle me-1" />Solde d'un fonds = tout ce qui y est entré − les dépenses prises dessus, depuis l'ouverture.</small>}>
              <table className="table">
                <thead><tr><th>Fonds</th><th className="text-end">Entrées (période)</th><th className="text-end">Dépenses (période)</th><th className="text-end">Solde</th></tr></thead>
                <TBody colSpan={4} loading={loading} rows={synthese?.fonds.length}>
                  {synthese?.fonds.filter((f) => f.actif || f.solde).map((f) => (
                    <tr key={f.categorie_id}>
                      <td>{f.libelle}{f.par_defaut && <span className="badge bg-label-secondary ms-2">par défaut</span>}</td>
                      <td className="text-end">{formatMontant(f.entrees_periode)}</td>
                      <td className="text-end">{formatMontant(f.depenses_periode)}</td>
                      <td className="text-end fw-semibold"><Montant valeur={f.solde} signe /></td>
                    </tr>
                  ))}
                </TBody>
              </table>
            </TableCard>
          </div>
          <div className="col-lg-5">
            <TableCard title="Comptes" icon="bx-wallet">
              <table className="table">
                <thead><tr><th>Compte</th><th className="text-end">Solde</th></tr></thead>
                <TBody colSpan={2} loading={loading} rows={synthese?.comptes.length}>
                  {synthese?.comptes.filter((c) => c.actif || c.solde).map((c) => (
                    <tr key={c.compte_id}><td>{c.libelle}<small className="text-muted d-block">{TYPES_COMPTE[c.type]}</small></td><td className="text-end fw-semibold"><Montant valeur={c.solde} signe /></td></tr>
                  ))}
                </TBody>
              </table>
            </TableCard>
          </div>
        </div>
      )}

      {tab === 'journal' && (
        <TableCard
          title="Journal des opérations"
          icon="bx-list-ul"
          count={lignesJournal.length}
          actions={(
            <>
              <Select className="form-select form-select-sm" style={{ minWidth: 140 }} value={filtres.sens} onChange={(e) => setFiltres((f) => ({ ...f, sens: e.target.value }))}>
                <option value="">Tous les types</option>
                {Object.entries(SENS).map(([k, s]) => <option key={k} value={k}>{s.pluriel}</option>)}
              </Select>
              <Select className="form-select form-select-sm" style={{ minWidth: 170 }} value={filtres.categorie} onChange={(e) => setFiltres((f) => ({ ...f, categorie: e.target.value }))}>
                <option value="">Toutes les catégories</option>
                <optgroup label="Entrées (fonds)">{fonds.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}</optgroup>
                <optgroup label="Sorties">{categories.filter((c) => c.type === 'SORTIE').map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}</optgroup>
              </Select>
              <Select className="form-select form-select-sm" style={{ minWidth: 150 }} value={filtres.compte} onChange={(e) => setFiltres((f) => ({ ...f, compte: e.target.value }))}>
                <option value="">Tous les comptes</option>
                {comptes.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
              </Select>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={exporterJournal} disabled={!lignesJournal.length}><i className="bx bx-download me-1" /> CSV</button>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={imprimerJournal} disabled={!lignesJournal.length}><i className="bx bx-printer me-1" /> Imprimer</button>
            </>
          )}
        >
          <table className="table table-hover">
            <thead><tr><th>Date</th><th>Opération</th><th>Catégorie / fonds</th><th>Compte</th><th className="text-end">Entrée</th><th className="text-end">Sortie</th><th /></tr></thead>
            <TBody colSpan={7} loading={loading} rows={lignesJournal.length} empty="Aucune opération sur la période">
              {lignesJournal.map((l) => {
                const annule = l.statut === 'ANNULE';
                const sens = SENS[l.sens];
                return (
                  <tr key={`${l.origine}-${l.id}`} className={annule ? 'text-muted' : ''}>
                    <td>{formatDateCourt(l.date)}</td>
                    <td className="text-wrap" style={{ minWidth: 220 }}>
                      <i className={`bx ${l.origine === 'paiement' ? 'bx-receipt' : sens.icon} text-${sens.color} me-1`} />
                      <span style={annule ? { textDecoration: 'line-through' } : undefined}>{l.libelle}</span>
                      {annule && <span className="badge bg-label-danger ms-1" title={l.motif_annulation}>Annulée</span>}
                      {(l.tiers || l.reference) && <small className="d-block text-muted">{[l.tiers, l.reference].filter(Boolean).join(' · ')}</small>}
                    </td>
                    <td className="text-wrap">
                      {l.sens === 'TRANSFERT' ? <span className="text-muted">—</span> : nomCategorie(l.categorie_id)}
                      {fondsDe(l) && <small className="d-block text-muted">{l.sens === 'SORTIE' ? 'Pris sur : ' : ''}{fondsDe(l)}</small>}
                    </td>
                    <td>{l.sens === 'TRANSFERT' ? `${nomCompte(l.compte_id)} → ${nomCompte(l.compte_destination_id)}` : nomCompte(l.compte_id)}</td>
                    <td className="text-end text-success">{l.sens === 'ENTREE' ? formatMontant(l.montant) : ''}</td>
                    <td className="text-end text-danger">{l.sens === 'SORTIE' ? formatMontant(l.montant) : l.sens === 'TRANSFERT' ? <span className="text-info">{formatMontant(l.montant)}</span> : ''}</td>
                    <td className="text-end text-nowrap">
                      {l.origine === 'mouvement' && <IconBtn icon="bx-printer" title="Imprimer le bon" onClick={() => imprimerBon(l)} />}
                      {l.origine === 'mouvement' && !annule && <IconBtn icon="bx-block" title="Annuler l'opération" danger onClick={() => setModal({ kind: 'annuler', data: l })} />}
                    </td>
                  </tr>
                );
              })}
            </TBody>
          </table>
        </TableCard>
      )}

      {tab === 'parametres' && (
        <>
          {!enLigne && <div className="alert alert-info small"><i className="bx bx-info-circle me-1" />Les catégories et les comptes ne se modifient qu'avec une connexion.</div>}
          <div className="row g-4">
            <div className="col-lg-4">
              <ListeReferentiel
                titre="Catégories d'entrée (fonds)" icon="bx-coin-stack" url="/tresorerie/categories" extra={{ type: 'ENTREE' }}
                elements={fonds} confirm={confirm} onChange={charger} lectureSeule={!enLigne}
                aide="Chaque catégorie d'entrée est un fonds. Rattachez-y les tranches de l'échéancier (page Paiements) ; les tranches non rattachées vont dans le fonds par défaut."
              />
            </div>
            <div className="col-lg-4">
              <ListeReferentiel
                titre="Catégories de sortie" icon="bx-purchase-tag" url="/tresorerie/categories" extra={{ type: 'SORTIE' }}
                elements={categories.filter((c) => c.type === 'SORTIE')} confirm={confirm} onChange={charger} lectureSeule={!enLigne}
                aide="Nature des dépenses : salaires, fournitures, entretien, électricité…"
              />
            </div>
            <div className="col-lg-4">
              <ListeReferentiel
                titre="Comptes" icon="bx-wallet" url="/tresorerie/comptes" comptes
                elements={comptes} confirm={confirm} onChange={charger} lectureSeule={!enLigne}
                aide="Les paiements de scolarité vont sur le compte par défaut de leur mode : espèces → caisse, mobile money → mobile money, virement et chèque → banque."
              />
            </div>
          </div>
        </>
      )}

      {modal?.kind === 'mouvement' && (
        <MouvementModal sens={modal.sens} categories={categories} comptes={comptes} soldesFonds={soldesFonds} onClose={() => setModal(null)} onSaved={apresEnregistrement} />
      )}
      {modal?.kind === 'annuler' && <AnnulerModal operation={modal.data} onClose={() => setModal(null)} onSaved={apresEnregistrement} />}
      {modal?.kind === 'import' && <ImportModal module="tresorerie" onClose={() => setModal(null)} onImported={charger} />}
      {confirmNode}
    </>
  );
}

/* ── Catégories / comptes ─────────────────────────────────────────────── */

function ListeReferentiel({ titre, icon, url, extra = {}, comptes = false, elements, confirm, onChange, aide, lectureSeule }) {
  const toast = useToast();
  const [form, setForm] = useState({ libelle: '', type: 'CAISSE' });
  const [edition, setEdition] = useState(null); // { id, libelle }
  const [occupe, setOccupe] = useState(false);
  const bloque = occupe || lectureSeule;

  const agir = async (action, message) => {
    setOccupe(true);
    try {
      await action();
      if (message) toast(message);
      await onChange();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setOccupe(false);
    }
  };

  const ajouter = (e) => {
    e.preventDefault();
    if (!form.libelle.trim()) return;
    agir(async () => {
      await api.post(url, { ...extra, ...(comptes ? { type: form.type } : {}), libelle: form.libelle.trim() });
      setForm((f) => ({ ...f, libelle: '' }));
    }, 'Ajouté.');
  };

  const renommer = (e) => {
    e.preventDefault();
    if (!edition.libelle.trim()) return;
    agir(async () => {
      await api.put(`${url}/${edition.id}`, { libelle: edition.libelle.trim() });
      setEdition(null);
    }, 'Renommé.');
  };

  const supprimer = async (el) => {
    if (await confirm(`Supprimer « ${el.libelle} » ?`, { details: 'Impossible si elle a déjà servi : désactivez-la dans ce cas.' })) {
      agir(() => api.del(`${url}/${el.id}`), 'Supprimé.');
    }
  };

  return (
    <div className="card h-100">
      <div className="card-header"><h5 className="mb-0"><i className={`bx ${icon} me-2 text-primary`} />{titre}</h5></div>
      <div className="card-body">
        <form className="d-flex gap-2 mb-3" onSubmit={ajouter}>
          {comptes && (
            <Select className="form-select form-select-sm" style={{ maxWidth: 130 }} value={form.type} disabled={lectureSeule} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
              {Object.entries(TYPES_COMPTE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          )}
          <input className="form-control form-control-sm" maxLength={100} placeholder="Nouveau…" disabled={lectureSeule} value={form.libelle} onChange={(e) => setForm((f) => ({ ...f, libelle: e.target.value }))} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={bloque || !form.libelle.trim()}><i className="bx bx-plus" /></button>
        </form>
        <ul className="list-group list-group-flush">
          {!elements.length && <li className="list-group-item text-muted small px-0">Aucun élément.</li>}
          {elements.map((el) => (
            <li key={el.id} className="list-group-item px-0 d-flex align-items-center gap-2">
              {edition?.id === el.id ? (
                <form className="d-flex gap-2 flex-grow-1" onSubmit={renommer}>
                  <input className="form-control form-control-sm" autoFocus maxLength={100} value={edition.libelle} onChange={(e) => setEdition({ ...edition, libelle: e.target.value })} />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={bloque}><i className="bx bx-check" /></button>
                  <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setEdition(null)}><i className="bx bx-x" /></button>
                </form>
              ) : (
                <>
                  <div className={`flex-grow-1 ${el.actif ? '' : 'text-muted text-decoration-line-through'}`}>
                    {el.libelle}
                    {comptes && <small className="text-muted d-block">{TYPES_COMPTE[el.type]}</small>}
                  </div>
                  {el.par_defaut && <span className="badge bg-label-primary">par défaut</span>}
                  {comptes && !el.par_defaut && el.actif && (
                    <IconBtn icon="bx-star" title="Compte par défaut de ce type (reçoit les paiements de scolarité)" disabled={bloque} onClick={() => agir(() => api.put(`${url}/${el.id}`, { par_defaut: true }), 'Compte par défaut modifié.')} />
                  )}
                  <IconBtn icon="bx-edit-alt" title="Renommer" disabled={bloque} onClick={() => setEdition({ id: el.id, libelle: el.libelle })} />
                  {!el.par_defaut && (
                    <IconBtn icon={el.actif ? 'bx-hide' : 'bx-show'} title={el.actif ? 'Désactiver' : 'Réactiver'} disabled={bloque} onClick={() => agir(() => api.put(`${url}/${el.id}`, { actif: !el.actif }), el.actif ? 'Désactivé.' : 'Réactivé.')} />
                  )}
                  {!el.par_defaut && <IconBtn icon="bx-trash" title="Supprimer" danger disabled={bloque} onClick={() => supprimer(el)} />}
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      {aide && <div className="card-footer"><small className="text-muted"><i className="bx bx-info-circle me-1" />{aide}</small></div>}
    </div>
  );
}

/* ── Saisie d'une opération ───────────────────────────────────────────── */

function MouvementModal({ sens, categories, comptes, soldesFonds, onClose, onSaved }) {
  const info = SENS[sens];
  const actifs = (type) => categories.filter((c) => c.type === type && c.actif);
  const fonds = actifs('ENTREE');
  const comptesActifs = comptes.filter((c) => c.actif);
  const caisse = comptesActifs.find((c) => c.type === 'CAISSE' && c.par_defaut) || comptesActifs[0];
  const defautFonds = fonds.find((c) => c.par_defaut) || fonds[0];
  // Une seule clé pour toute la vie du formulaire : un renvoi (réponse
  // perdue, « Enregistrer quand même ») ne peut jamais créer deux opérations.
  const [cle] = useState(nouvelIdentifiant);

  const [form, setForm] = useState({
    date_operation: aujourdhuiIso(), montant: '', libelle: '', categorie_id: '', compte_id: caisse ? String(caisse.id) : '',
    compte_destination_id: '', tiers: '', reference: '',
  });
  const [parts, setParts] = useState([{ categorie_id: defautFonds ? String(defautFonds.id) : '', montant: '' }]);
  const [erreur, setErreur] = useState('');
  const [alerte, setAlerte] = useState(null); // { code, message, avertissements }
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => { setForm((f) => ({ ...f, [name]: e.target.value })); setAlerte(null); };

  // Un seul fonds : sa part suit le montant de la dépense.
  const total = Number(form.montant || 0);
  const partsEffectives = parts.length === 1 ? [{ ...parts[0], montant: form.montant }] : parts;
  const reparti = partsEffectives.reduce((s, p) => s + Number(p.montant || 0), 0);
  const setPart = (i, champ, valeur) => { setParts((ps) => ps.map((p, j) => (j === i ? { ...p, [champ]: valeur } : p))); setAlerte(null); };
  const nomCompte = (id) => comptes.find((c) => String(c.id) === String(id))?.libelle || '';

  const envoyer = async (forcer = false) => {
    setErreur('');
    if (!form.montant || total <= 0 || !form.libelle.trim() || !form.compte_id) {
      setErreur('Renseignez le montant, le libellé et le compte.');
      return;
    }
    const body = {
      sens, date_operation: form.date_operation, montant: total, libelle: form.libelle.trim(), compte_id: Number(form.compte_id),
      tiers: form.tiers.trim() || null, reference: form.reference.trim() || null, cle_idempotence: cle,
    };
    if (sens === 'TRANSFERT') {
      if (!form.compte_destination_id) { setErreur('Choisissez le compte de destination.'); return; }
      body.compte_destination_id = Number(form.compte_destination_id);
    } else {
      if (!form.categorie_id) { setErreur('Choisissez la catégorie.'); return; }
      body.categorie_id = Number(form.categorie_id);
    }
    if (sens === 'SORTIE') {
      if (partsEffectives.some((p) => !p.categorie_id || Number(p.montant || 0) <= 0)) { setErreur('Indiquez pour chaque fonds un montant positif.'); return; }
      if (Math.round(reparti * 100) !== Math.round(total * 100)) { setErreur(`La répartition sur les fonds (${formatMontant(reparti)}) doit être égale au montant (${formatMontant(total)}).`); return; }
      body.ventilation = partsEffectives.map((p) => ({ categorie_id: Number(p.categorie_id), montant: Number(p.montant) }));
    }
    if (forcer) body.forcer = true;

    // Opération gardée sur l'appareil si le réseau manque : envoyée au retour
    // de la connexion ; un doublon ou un solde insuffisant découvert à ce
    // moment-là est soumis à l'utilisateur (écran des conflits).
    const op = {
      cle: `tresorerie|${cle}`, module: 'tresorerie', methode: 'POST', url: '/tresorerie/mouvements', body,
      versionBase: null, conserverSiRefus: true,
      libelle: `${info.label} — ${body.libelle} — ${formatMontant(total)}${sens === 'TRANSFERT' ? ` (${nomCompte(body.compte_id)} → ${nomCompte(body.compte_destination_id)})` : ''}`,
    };
    const garder = () => {
      mettreEnAttente(op);
      return onSaved(`${info.label} gardée sur cet appareil : envoi automatique au retour de la connexion.`);
    };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { await garder(); return; }

    setSaving(true);
    try {
      await api.post('/tresorerie/mouvements', { ...body, version_base: null });
      await onSaved(`${info.label} enregistrée.`);
    } catch (e) {
      if (estARessayer(e)) { await garder(); return; }
      if (e.status === 409 && ['solde_insuffisant', 'doublon'].includes(e.payload?.code)) {
        setAlerte({ code: e.payload.code, message: e.message, avertissements: e.payload.avertissements || [] });
      } else setErreur(e.message);
      setSaving(false);
    }
  };

  const fondsUtilises = new Set(parts.map((p) => p.categorie_id));

  return (
    <Modal
      title={<><i className={`bx ${info.icon} me-2 text-${info.color}`} />{info.titre}</>}
      onClose={onClose}
      onSubmit={() => envoyer(false)}
      footer={alerte ? (
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={() => setAlerte(null)} disabled={saving}>Corriger</button>
          <button type="button" className="btn btn-warning" onClick={() => envoyer(true)} disabled={saving}><i className="bx bx-error me-1" /> Enregistrer quand même</button>
        </>
      ) : <FormFooter onCancel={onClose} saving={saving} />}
    >
      {erreur && <div className="alert alert-danger">{erreur}</div>}
      {alerte && (
        <div className="alert alert-warning">
          <strong><i className="bx bx-error me-1" />{alerte.code === 'doublon' ? 'Doublon probable' : 'Solde insuffisant'}</strong>
          {alerte.code === 'doublon' ? <div className="mt-1">{alerte.message}</div> : (
            <ul className="mb-0 mt-1">
              {alerte.avertissements.map((a) => (
                <li key={`${a.type}-${a.id}`}>{a.type === 'fonds' ? 'Fonds' : 'Compte'} « {a.libelle} » : disponible {formatMontant(a.disponible)}, demandé {formatMontant(a.demande)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="row g-3">
        <div className="col-md-4"><label className="form-label">Date *</label><input type="date" className="form-control" max={aujourdhuiIso()} value={form.date_operation} onChange={set('date_operation')} /></div>
        <div className="col-md-4"><label className="form-label">Montant (FCFA) *</label><input type="number" className="form-control" min="1" step="1" value={form.montant} onChange={set('montant')} /></div>
        <div className="col-md-4">
          <label className="form-label">{sens === 'TRANSFERT' ? 'Depuis le compte *' : sens === 'ENTREE' ? 'Reçu sur *' : 'Payé depuis *'}</label>
          <Select className="form-select" value={form.compte_id} onChange={set('compte_id')}>
            <option value="">-- Compte --</option>
            {comptesActifs.map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
          </Select>
        </div>
        <div className="col-12"><label className="form-label">Libellé *</label><input className="form-control" maxLength={255} placeholder={sens === 'SORTIE' ? 'Ex : Achat de craies' : sens === 'ENTREE' ? 'Ex : Subvention de la commune' : 'Ex : Dépôt des espèces en banque'} value={form.libelle} onChange={set('libelle')} /></div>
        {sens === 'TRANSFERT' ? (
          <div className="col-md-6">
            <label className="form-label">Vers le compte *</label>
            <Select className="form-select" value={form.compte_destination_id} onChange={set('compte_destination_id')}>
              <option value="">-- Compte --</option>
              {comptesActifs.filter((c) => String(c.id) !== form.compte_id).map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
            </Select>
          </div>
        ) : (
          <div className="col-md-6">
            <label className="form-label">{sens === 'ENTREE' ? 'Catégorie (fonds) *' : 'Catégorie de dépense *'}</label>
            <Select className="form-select" value={form.categorie_id} onChange={set('categorie_id')}>
              <option value="">-- Catégorie --</option>
              {actifs(sens).map((c) => <option key={c.id} value={c.id}>{c.libelle}</option>)}
            </Select>
            {!actifs(sens).length && <div className="form-text text-danger">Créez d'abord une catégorie (onglet « Catégories &amp; comptes »).</div>}
          </div>
        )}
        <div className="col-md-3"><label className="form-label">{sens === 'SORTIE' ? 'Bénéficiaire' : sens === 'ENTREE' ? 'Payeur' : 'Tiers'}</label><input className="form-control" maxLength={150} value={form.tiers} onChange={set('tiers')} /></div>
        <div className="col-md-3"><label className="form-label">Référence</label><input className="form-control" maxLength={100} placeholder="N° facture, bordereau…" value={form.reference} onChange={set('reference')} /></div>

        {sens === 'SORTIE' && (
          <div className="col-12">
            <label className="form-label">Pris sur le(s) fonds *</label>
            {parts.map((p, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} className="d-flex gap-2 mb-2 align-items-center">
                <Select className="form-select" value={p.categorie_id} onChange={(e) => setPart(i, 'categorie_id', e.target.value)}>
                  <option value="">-- Fonds --</option>
                  {fonds.filter((c) => String(c.id) === p.categorie_id || !fondsUtilises.has(String(c.id))).map((c) => (
                    <option key={c.id} value={c.id}>{c.libelle} — disponible {formatMontant(soldesFonds[c.id] || 0)}</option>
                  ))}
                </Select>
                {parts.length > 1 && (
                  <>
                    <input type="number" className="form-control" style={{ maxWidth: 160 }} min="1" step="1" placeholder="Montant" value={p.montant} onChange={(e) => setPart(i, 'montant', e.target.value)} />
                    <IconBtn icon="bx-x" title="Retirer ce fonds" danger onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))} />
                  </>
                )}
              </div>
            ))}
            <div className="d-flex justify-content-between align-items-center">
              <button
                type="button"
                className="btn btn-link btn-sm px-0"
                disabled={parts.length >= fonds.length}
                onClick={() => setParts((ps) => (ps.length === 1 ? [{ ...ps[0], montant: form.montant }, { categorie_id: '', montant: '' }] : [...ps, { categorie_id: '', montant: '' }]))}
              >
                <i className="bx bx-plus me-1" />Répartir sur un autre fonds
              </button>
              {parts.length > 1 && (
                <small className={Math.round(reparti * 100) === Math.round(total * 100) ? 'text-success' : 'text-danger'}>Réparti : {formatMontant(reparti)} / {formatMontant(total)}</small>
              )}
            </div>
            <div className="form-text">Soldes disponibles à la dernière synchronisation.</div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function AnnulerModal({ operation, onClose, onSaved }) {
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!motif.trim()) { setErreur("Le motif d'annulation est obligatoire."); return; }
    setSaving(true);
    try {
      // Rejouable sans risque : le serveur ignore une annulation déjà faite.
      const res = await enregistrer({
        cle: `tresorerie-annulation|${operation.id}`,
        module: 'tresorerie',
        methode: 'POST',
        url: `/tresorerie/mouvements/${operation.id}/annuler`,
        body: { motif_annulation: motif.trim() },
        libelle: `Annulation — ${operation.libelle} — ${formatMontant(operation.montant)}`,
        conserverSiRefus: true,
      });
      await terminerEnregistrement(res, { onSaved, ok: 'Opération annulée.' });
    } catch (e) {
      setErreur(e.message);
      setSaving(false);
    }
  };
  return (
    <Modal size="" title={<span className="text-danger"><i className="bx bx-block me-2" />Annuler l'opération</span>} onClose={onClose} onSubmit={submit} footer={<FormFooter onCancel={onClose} saving={saving} label="Annuler l'opération" icon="bx-block" />}>
      {erreur && <div className="alert alert-danger">{erreur}</div>}
      <p className="mb-2"><strong>{operation.libelle}</strong> — {formatMontant(operation.montant)} du {formatDateCourt(operation.date)}</p>
      <p className="small text-muted">L'opération reste visible au journal, barrée, et ne compte plus dans les totaux ni les soldes.</p>
      <label className="form-label">Motif *</label>
      <textarea className="form-control" rows={2} maxLength={255} value={motif} onChange={(e) => setMotif(e.target.value)} />
    </Modal>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import ChartCanvas from '../components/ChartCanvas';
import { useAuth } from '../context/AuthContext';
import { useEtablissementCourant } from '../components/EnteteEtablissement';
import { initiales } from '../components/ui';

// Portage de server/static/templates/dashboard.html (Admin d'établissement) :
// toutes les métriques sont recalculées à partir des données réelles de
// l'API, sans valeur codée en dur.

const PALETTE = ['#696cff', '#6d28d9', '#03c3ec', '#71dd37', '#ffab00', '#ff3e1d'];
const fmtNombre = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));
const SEUIL_ABSENCES = 10;

function relTime(date, now) {
  const min = Math.floor((now - date) / 60000);
  if (min < 1) return "À l'instant";
  if (min < 60) return `Il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Il y a ${h}h`;
  const j = Math.floor(h / 24);
  if (j === 1) return 'Hier';
  if (j < 7) return `Il y a ${j}j`;
  return date.toLocaleDateString('fr-FR');
}

function Stat({ label, value, icon, color, sub, trend }) {
  return (
    <div className="col-sm-6 col-xl-3">
      <div className="card h-100">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-start mb-2">
            <div className="avatar flex-shrink-0"><span className={`avatar-initial rounded bg-label-${color}`}><i className={`bx ${icon}`} /></span></div>
            {trend}
          </div>
          <span className="fw-semibold d-block mb-1">{label}</span>
          <h4 className="card-title mb-1">{value}</h4>
          <small className="text-muted">{sub}</small>
        </div>
      </div>
    </div>
  );
}

const Vide = ({ icon, children }) => <div className="text-center text-muted py-4 small"><i className={`bx ${icon} bx-sm d-block mb-1`} />{children}</div>;

export default function EtablissementDashboardPage() {
  const { user, activeEtablissementId } = useAuth();
  const etablissement = useEtablissementCourant();
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const g = (p) => api.get(p).catch(() => []);
    Promise.all([
      g('/annees-scolaires/'), g('/trimestres/'), g('/sequences/'), g('/classes/'), g('/cycles/'), g('/eleves/'), g('/enseignants/'),
      g('/parents/'), g('/inscriptions/'), g('/matieres-classe/'), g('/tranches-classe/'), g('/paiements/?statut=VALIDE'), g('/disciplines/'), g('/notes/'), g('/matieres/'),
    ]).then(([annees, trimestres, sequences, classes, cycles, eleves, enseignants, parents, inscriptions, matieresClasse, tranches, paiements, disciplines, notes, matieres]) => {
      if (!cancelled) setData({ annees, trimestres, sequences, classes, cycles, eleves, enseignants, parents, inscriptions, matieresClasse, tranches, paiements, disciplines, notes, matieres });
    });
    return () => { cancelled = true; };
  }, [activeEtablissementId]);

  const m = useMemo(() => {
    if (!data) return null;
    const now = new Date();
    const { annees, trimestres, sequences, classes, cycles, eleves, enseignants, parents, inscriptions, matieresClasse, tranches, paiements, disciplines, notes, matieres } = data;
    const anneeActive = annees.find((a) => a.active) || [...annees].sort((a, b) => b.id - a.id)[0] || null;
    const trims = anneeActive ? trimestres.filter((t) => t.annee_scolaire_id === anneeActive.id) : [];
    const enCours = (x) => x.date_debut && x.date_fin && new Date(x.date_debut) <= now && now <= new Date(x.date_fin);
    const trimestreCourant = trims.find(enCours) || [...trims].sort((a, b) => b.id - a.id)[0] || null;
    const seqs = trimestreCourant ? sequences.filter((s) => s.trimestre_id === trimestreCourant.id) : [];
    const sequenceCourante = seqs.find(enCours) || [...seqs].sort((a, b) => b.id - a.id)[0] || null;

    const cycleMap = new Map(cycles.map((c) => [c.id, c]));
    const classeMap = new Map(classes.map((c) => [c.id, c]));
    const eleveMap = new Map(eleves.map((e) => [e.id, e]));
    const inscriptionMap = new Map(inscriptions.map((i) => [i.id, i]));
    const mcMap = new Map(matieresClasse.map((mc) => [mc.id, mc]));
    const matiereMap = new Map(matieres.map((x) => [x.id, x]));
    const classeLabel = (c) => {
      if (!c) return '—';
      const cy = cycleMap.get(c.cycle_id)?.libelle;
      if (cy && c.option) return `${cy} ${c.option}`;
      return cy || c.option || `Classe #${c.id}`;
    };

    const inscriptionsAnnee = anneeActive ? inscriptions.filter((i) => i.annee_scolaire_id === anneeActive.id && i.statut === 'Actif') : [];
    const effectifParClasse = new Map();
    inscriptionsAnnee.forEach((i) => effectifParClasse.set(i.classe_id, (effectifParClasse.get(i.classe_id) || 0) + 1));
    const elevesActifs = eleves.filter((e) => e.statut === 'Actif').length;
    const inscritsCeMois = inscriptions.filter((i) => {
      if (!i.date_inscription) return false;
      const d = new Date(i.date_inscription);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;

    // Notes de la séquence en cours
    const notesSeq = sequenceCourante ? notes.filter((n) => n.sequence_id === sequenceCourante.id) : [];
    const mcParClasse = new Map();
    matieresClasse.forEach((mc) => mcParClasse.set(mc.classe_id, (mcParClasse.get(mc.classe_id) || 0) + 1));
    let notesAttendues = 0;
    classes.forEach((c) => { notesAttendues += (effectifParClasse.get(c.id) || 0) * (mcParClasse.get(c.id) || 0); });
    const notesEnAttente = Math.max(0, notesAttendues - notesSeq.length);

    // Discipline de la séquence en cours
    const discSeq = sequenceCourante ? disciplines.filter((d) => d.sequence_id === sequenceCourante.id) : [];
    const absences = discSeq.reduce((s, d) => s + (d.absences_justifiees || 0) + (d.absences_non_justifiees || 0), 0);

    // Recouvrement (montant_attendu par élève × effectif de la classe)
    const tranchesAnnee = anneeActive ? tranches.filter((t) => t.annee_scolaire_id === anneeActive.id) : [];
    const totalAttendu = tranchesAnnee.reduce((s, t) => s + (t.montant_attendu || 0) * (effectifParClasse.get(t.classe_id) || 0), 0);
    const paiementsAnnee = anneeActive ? paiements.filter((p) => inscriptionMap.get(p.inscription_id)?.annee_scolaire_id === anneeActive.id) : paiements;
    const totalPercu = paiementsAnnee.reduce((s, p) => s + Number(p.montant_total || 0), 0);
    const totalReste = Math.max(0, totalAttendu - totalPercu);

    const parLibelle = new Map();
    tranchesAnnee.forEach((t) => {
      const cur = parLibelle.get(t.libelle) || { attendu: 0, ordre: t.ordre };
      cur.attendu += (t.montant_attendu || 0) * (effectifParClasse.get(t.classe_id) || 0);
      parLibelle.set(t.libelle, cur);
    });
    const tranchesListe = [...parLibelle.entries()].sort((a, b) => a[1].ordre - b[1].ordre);

    const classBars = classes.map((c) => ({ label: classeLabel(c), effectif: effectifParClasse.get(c.id) || 0 })).sort((a, b) => b.effectif - a.effectif).slice(0, 8);

    const effParCycle = new Map();
    classes.forEach((c) => effParCycle.set(c.cycle_id, (effParCycle.get(c.cycle_id) || 0) + (effectifParClasse.get(c.id) || 0)));
    const cyclesTries = [...effParCycle.entries()].map(([id, effectif]) => ({ cycle: cycleMap.get(id), effectif })).filter((x) => x.cycle).sort((a, b) => b.effectif - a.effectif);

    // Inscriptions cumulées par mois (11 derniers mois), 2 cycles principaux
    const mois = [];
    for (let k = 10; k >= 0; k--) mois.push(new Date(now.getFullYear(), now.getMonth() - k, 1));
    const cyclesChart = cyclesTries.slice(0, 2);
    const cumul = (cycleId, d) => {
      const fin = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      return inscriptions.filter((i) => i.date_inscription && classeMap.get(i.classe_id)?.cycle_id === cycleId && new Date(i.date_inscription) < fin).length;
    };

    // Top 5 élèves (moyenne pondérée sur la séquence en cours)
    const parInscription = new Map();
    notesSeq.forEach((n) => {
      if (n.absent || n.valeur === null || n.valeur === undefined) return;
      const coef = mcMap.get(n.matiere_classe_id)?.coefficient || 1;
      const cur = parInscription.get(n.inscription_id) || { points: 0, coefs: 0 };
      cur.points += n.valeur * coef;
      cur.coefs += coef;
      parInscription.set(n.inscription_id, cur);
    });
    const top = [...parInscription.entries()].filter(([, v]) => v.coefs > 0).map(([id, v]) => {
      const insc = inscriptionMap.get(id);
      const el = insc ? eleveMap.get(insc.eleve_id) : null;
      return { nom: el ? `${el.prenom} ${el.nom}` : `Inscription #${id}`, classe: classeLabel(insc ? classeMap.get(insc.classe_id) : null), moyenne: v.points / v.coefs };
    }).sort((a, b) => b.moyenne - a.moyenne).slice(0, 5);

    // Alertes
    const alertes = [];
    const mcIncompletes = matieresClasse.filter((mc) => (effectifParClasse.get(mc.classe_id) || 0) > 0 && notesSeq.filter((n) => n.matiere_classe_id === mc.id).length < (effectifParClasse.get(mc.classe_id) || 0)).length;
    if (mcIncompletes > 0) alertes.push(['warning', 'bx-edit', `${fmtNombre(notesEnAttente)} notes manquantes`, `${fmtNombre(mcIncompletes)} matière(s)-classe encore incomplète(s) sur la séquence en cours`]);
    const enDifficulte = top.length ? [...parInscription.values()].filter((v) => v.points / v.coefs < 8).length : 0;
    if (enDifficulte > 0) alertes.push(['danger', 'bxs-graduation', `${fmtNombre(enDifficulte)} élève(s) en difficulté (< 8/20)`, 'Moyenne pondérée sur la séquence en cours']);
    const absExcessives = discSeq.filter((d) => (d.absences_justifiees || 0) + (d.absences_non_justifiees || 0) > SEUIL_ABSENCES).length;
    if (absExcessives > 0) alertes.push(['danger', 'bx-user-x', `${fmtNombre(absExcessives)} élève(s) avec absences excessives`, `Plus de ${SEUIL_ABSENCES} absences cumulées ce trimestre`]);
    if (totalReste > 0) alertes.push(['warning', 'bx-wallet', `${fmtNombre(totalReste)} FCFA restant à percevoir`, `Sur un total attendu de ${fmtNombre(totalAttendu)} FCFA (année en cours)`]);
    if (sequenceCourante?.date_fin) {
      const fin = new Date(sequenceCourante.date_fin);
      const jours = Math.ceil((fin - now) / 86400000);
      if (jours >= 0 && jours <= 14) alertes.push(['info', 'bx-calendar-check', `Fin de ${sequenceCourante.libelle} dans ${jours} jour(s)`, `Clôture prévue le ${fin.toLocaleDateString('fr-FR')}`]);
    }

    // Activité récente (paiements, inscriptions, notes horodatés)
    const events = [];
    [...paiementsAnnee].sort((a, b) => new Date(b.date_paiement) - new Date(a.date_paiement)).slice(0, 5)
      .forEach((p) => events.push({ ts: new Date(p.date_paiement), color: 'success', icon: 'bx-money', titre: `Paiement reçu — ${fmtNombre(p.montant_total)} FCFA`, desc: `Reçu n°${p.numero_recu} · ${p.mode_paiement}` }));
    [...inscriptions].filter((i) => i.date_inscription).sort((a, b) => new Date(b.date_inscription) - new Date(a.date_inscription)).slice(0, 5)
      .forEach((i) => {
        const el = eleveMap.get(i.eleve_id);
        events.push({ ts: new Date(i.date_inscription), color: 'info', icon: 'bx-user-plus', titre: 'Nouvelle inscription', desc: `${el ? `${el.prenom} ${el.nom}` : `Élève #${i.eleve_id}`} · ${classeLabel(classeMap.get(i.classe_id))}` });
      });
    [...notes].filter((n) => n.saisie_le).sort((a, b) => new Date(b.saisie_le) - new Date(a.saisie_le)).slice(0, 5)
      .forEach((n) => {
        const insc = inscriptionMap.get(n.inscription_id);
        const el = insc ? eleveMap.get(insc.eleve_id) : null;
        const mat = matiereMap.get(mcMap.get(n.matiere_classe_id)?.matiere_id);
        events.push({ ts: new Date(n.saisie_le), color: 'primary', icon: 'bx-edit', titre: `Note saisie — ${mat ? mat.libelle : 'Matière'}`, desc: `${el ? `${el.prenom} ${el.nom}` : 'Élève'} · ${n.absent ? 'Absent' : `${n.valeur ?? '—'}/20`}` });
      });
    events.sort((a, b) => b.ts - a.ts);

    return {
      now, anneeActive, trimestreCourant, sequenceCourante,
      eleves: eleves.length, elevesActifs, inscritsCeMois,
      classes: classes.length, cycles: cycles.length, niveaux: new Set(classes.map((c) => c.option).filter(Boolean)).size,
      enseignants: enseignants.length, matieresClasse: matieresClasse.length,
      parents: parents.length, parentsTel: parents.filter((p) => p.telephone).length,
      filles: eleves.filter((e) => e.sexe === 'F').length, garcons: eleves.filter((e) => e.sexe === 'M').length,
      notesSaisies: notesSeq.length, notesAttendues, notesEnAttente,
      absences, retards: discSeq.reduce((s, d) => s + (d.retards || 0), 0), exclusions: discSeq.reduce((s, d) => s + (d.exclusions || 0), 0),
      totalAttendu, totalPercu, totalReste, pctRecouvrement: totalAttendu ? Math.round((totalPercu / totalAttendu) * 100) : 0,
      tranchesListe, classBars, cyclesTries, top, alertes, events: events.slice(0, 6),
      chartInscriptions: {
        type: 'line',
        data: {
          labels: mois.map((d) => d.toLocaleDateString('fr-FR', { month: 'short' })),
          datasets: cyclesChart.map((x, i) => ({ label: x.cycle.libelle, data: mois.map((d) => cumul(x.cycle.id, d)), borderColor: PALETTE[i], backgroundColor: `${PALETTE[i]}1A`, fill: true, tension: 0.4, borderWidth: 2, pointRadius: 3, pointBackgroundColor: PALETTE[i] })),
        },
        options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
      },
      cyclesChart: cyclesChart.length,
      chartCycles: cyclesTries.length ? {
        type: 'doughnut',
        data: { labels: cyclesTries.map((x) => x.cycle.libelle), datasets: [{ data: cyclesTries.map((x) => x.effectif), backgroundColor: cyclesTries.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 0 }] },
        options: { cutout: '70%', plugins: { legend: { display: false } } },
      } : null,
    };
  }, [data]);

  const nom = etablissement?.nom || user?.etablissement_nom || 'Établissement';
  const v = (x) => (m ? x : <span className="spinner-border spinner-border-sm text-primary" />);

  return (
    <>
      {/* Bandeau établissement */}
      <div className="card mb-4">
        <div className="card-body d-flex flex-wrap align-items-center gap-3">
          <div className="avatar avatar-xl flex-shrink-0">
            {etablissement?.logo_url ? <img src={etablissement.logo_url} alt="" className="rounded" style={{ objectFit: 'contain' }} /> : <span className="avatar-initial rounded bg-label-primary fs-4">{initiales(nom)}</span>}
          </div>
          <div className="flex-grow-1">
            <h4 className="mb-1">{nom}</h4>
            <small className="text-muted"><i className="bx bx-map me-1" />{[etablissement?.region, etablissement?.adresse].filter(Boolean).join(' · ') || '—'}</small>
          </div>
          <div className="d-flex flex-wrap gap-4">
            {[['Année scolaire', m?.anneeActive?.libelle], ['Trimestre en cours', m?.trimestreCourant?.libelle], ['Séquence', m?.sequenceCourante?.libelle]].map(([l, val]) => (
              <div key={l}><small className="text-muted d-block">{l}</small><span className="fw-semibold">{val || '—'}</span></div>
            ))}
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <Stat label="Élèves inscrits" value={v(fmtNombre(m?.eleves))} icon="bxs-graduation" color="primary" sub={m ? `${fmtNombre(m.elevesActifs)} actifs · ${m.eleves ? Math.round((m.elevesActifs / m.eleves) * 100) : 0}%` : '…'} trend={m && <span className={`badge ${m.inscritsCeMois > 0 ? 'bg-label-success' : 'bg-label-secondary'}`}>+{m.inscritsCeMois} ce mois-ci</span>} />
        <Stat label="Classes actives" value={v(fmtNombre(m?.classes))} icon="bx-chalkboard" color="info" sub={m ? `${fmtNombre(m.cycles)} cycle(s) · ${fmtNombre(m.niveaux)} niveau(x)` : '…'} />
        <Stat label="Enseignants" value={v(fmtNombre(m?.enseignants))} icon="bx-user-voice" color="success" sub={m ? `${fmtNombre(m.matieresClasse)} matières-classe` : '…'} />
        <Stat label="Recouvrement" value={v(`${m?.pctRecouvrement}%`)} icon="bx-wallet" color="warning" sub={m ? `${fmtNombre(m.totalReste)} FCFA restants` : '…'} />
      </div>
      <div className="row g-3 mb-4">
        <Stat label="Notes saisies (séquence en cours)" value={v(`${fmtNombre(m?.notesSaisies)} / ${fmtNombre(m?.notesAttendues)}`)} icon="bx-edit" color="primary" sub={m ? `${fmtNombre(m.notesEnAttente)} en attente` : '…'} trend={m && <span className="badge bg-label-secondary">{m.notesAttendues ? Math.round((m.notesSaisies / m.notesAttendues) * 100) : 0}%</span>} />
        <Stat label="Filles / Garçons" value={v(`${fmtNombre(m?.filles)} / ${fmtNombre(m?.garcons)}`)} icon="bx-male-female" color="info" sub={m ? `Effectif total : ${fmtNombre(m.eleves)}` : '…'} />
        <Stat label="Absences (séquence en cours)" value={v(fmtNombre(m?.absences))} icon="bx-run" color="danger" sub={m ? `${fmtNombre(m.retards)} retards · ${fmtNombre(m.exclusions)} exclusions` : '…'} />
        <Stat label="Parents enregistrés" value={v(fmtNombre(m?.parents))} icon="bx-group" color="success" sub={m ? `${fmtNombre(m.parentsTel)} avec téléphone` : '…'} />
      </div>

      {m && (
        <>
          <div className="row g-3 mb-4">
            <div className="col-lg-8">
              <div className="card h-100">
                <div className="card-header d-flex flex-wrap justify-content-between gap-2">
                  <div><h5 className="mb-0">Évolution des inscriptions</h5><small className="text-muted">{m.anneeActive ? `Inscriptions cumulées par mois — ${m.anneeActive.libelle}` : 'Inscriptions cumulées par mois'}</small></div>
                  <div className="d-flex gap-3 small">{m.cyclesTries.slice(0, 2).map((x, i) => <span key={x.cycle.id}><span className="d-inline-block rounded-circle me-1" style={{ width: 8, height: 8, background: PALETTE[i] }} />{x.cycle.libelle}</span>)}</div>
                </div>
                <div className="card-body">{m.cyclesChart ? <ChartCanvas config={m.chartInscriptions} height={280} /> : <Vide icon="bx-line-chart">Aucune inscription enregistrée.</Vide>}</div>
              </div>
            </div>
            <div className="col-lg-4">
              <div className="card h-100">
                <div className="card-header"><h5 className="mb-0">Répartition par cycle</h5><small className="text-muted">{fmtNombre(m.eleves)} élèves · {fmtNombre(m.classes)} classes</small></div>
                <div className="card-body">
                  {m.chartCycles ? <ChartCanvas config={m.chartCycles} height={180} /> : <Vide icon="bx-pie-chart-alt-2">Aucun effectif par cycle.</Vide>}
                  <div className="d-flex justify-content-around flex-wrap gap-2 mt-3 small">
                    {m.cyclesTries.map((x, i) => <div key={x.cycle.id} className="text-center"><div className="fw-bold" style={{ color: PALETTE[i % PALETTE.length] }}>{fmtNombre(x.effectif)}</div><div className="text-muted">{x.cycle.libelle}</div></div>)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="row g-3 mb-4">
            <div className="col-lg-6">
              <div className="card h-100">
                <div className="card-header d-flex justify-content-between">
                  <div><h5 className="mb-0">Effectifs par classe</h5><small className="text-muted">Top 8 — classes les plus peuplées (année en cours)</small></div>
                  <Link to="/configuration" className="btn btn-outline-secondary btn-sm align-self-start">Voir tout</Link>
                </div>
                <div className="card-body">
                  {!m.classBars.length ? <Vide icon="bx-chalkboard">Aucune inscription enregistrée pour cette année.</Vide> : m.classBars.map((b, i) => {
                    const max = Math.max(...m.classBars.map((x) => x.effectif), 1);
                    return (
                      <div key={b.label} className="d-flex align-items-center gap-2 mb-2">
                        <span className="text-truncate small" style={{ width: 120 }} title={b.label}>{b.label}</span>
                        <div className="progress flex-grow-1" style={{ height: 8 }}><div className="progress-bar" style={{ width: `${Math.round((b.effectif / max) * 100)}%`, background: PALETTE[i % PALETTE.length] }} /></div>
                        <span className="fw-semibold small" style={{ width: 30, textAlign: 'right' }}>{b.effectif}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="col-lg-6">
              <div className="card h-100">
                <div className="card-header d-flex justify-content-between">
                  <div><h5 className="mb-0">Échéancier de paiement</h5><small className="text-muted">Montants attendus réels par tranche — année en cours</small></div>
                  <Link to="/paiements" className="btn btn-outline-secondary btn-sm align-self-start">Détails</Link>
                </div>
                <div className="card-body">
                  {!m.tranchesListe.length ? <Vide icon="bx-file-find">Aucune tranche définie pour l'année en cours.</Vide> : m.tranchesListe.map(([libelle, t]) => {
                    const max = Math.max(...m.tranchesListe.map(([, x]) => x.attendu), 1);
                    return (
                      <div key={libelle} className="d-flex align-items-center gap-2 mb-2">
                        <span className="small text-truncate" style={{ width: 110 }}>{libelle}</span>
                        <div className="progress flex-grow-1" style={{ height: 8 }}><div className="progress-bar" style={{ width: `${Math.round((t.attendu / max) * 100)}%` }} /></div>
                        <small className="text-nowrap"><strong>{fmtNombre(t.attendu)}</strong> FCFA attendus</small>
                      </div>
                    );
                  })}
                  <hr />
                  <div className="d-flex justify-content-between align-items-center small">
                    <div><div className="text-muted">Total perçu (paiements validés)</div><div className="fs-6 fw-bold">{fmtNombre(m.totalPercu)} <small className="text-muted fw-normal">FCFA</small></div></div>
                    <div className="text-end"><div className="text-muted">Reste à percevoir</div><div className="fs-6 fw-bold text-warning">{fmtNombre(m.totalReste)} <small className="text-muted fw-normal">FCFA</small></div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="row g-3">
            <div className="col-lg-6 col-xl-3">
              <div className="card h-100">
                <div className="card-header"><h6 className="mb-0"><i className="bx bx-trophy text-warning me-1" />Top 5 élèves — {m.sequenceCourante?.libelle || 'séquence en cours'}</h6></div>
                <div className="card-body">
                  {!m.top.length ? <Vide icon="bx-edit">Pas encore de notes saisies pour cette séquence.</Vide> : m.top.map((c, i) => (
                    <div key={c.nom} className="d-flex align-items-center gap-2 mb-3">
                      <span className={`badge rounded-pill ${i < 3 ? 'bg-warning' : 'bg-label-secondary'}`}>{i + 1}</span>
                      <div className="flex-grow-1"><div className="fw-semibold small">{c.nom}</div><small className="text-muted">{c.classe}</small></div>
                      <span className="fw-bold">{c.moyenne.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="col-lg-6 col-xl-3">
              <div className="card h-100">
                <div className="card-header d-flex justify-content-between"><h6 className="mb-0"><i className="bx bx-bell text-danger me-1" />Alertes à traiter</h6><span className="badge bg-danger">{m.alertes.length}</span></div>
                <div className="card-body">
                  {!m.alertes.length ? <Vide icon="bx-check-circle">Aucune alerte active pour le moment.</Vide> : m.alertes.map(([color, icon, titre, desc]) => (
                    <div key={titre} className="d-flex gap-2 mb-3">
                      <div className="avatar avatar-sm flex-shrink-0"><span className={`avatar-initial rounded bg-label-${color}`}><i className={`bx ${icon}`} /></span></div>
                      <div><div className="fw-semibold small">{titre}</div><small className="text-muted">{desc}</small></div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="col-lg-6 col-xl-3">
              <div className="card h-100">
                <div className="card-header"><h6 className="mb-0"><i className="bx bx-time-five me-1" />Activité récente</h6></div>
                <div className="card-body">
                  {!m.events.length ? <Vide icon="bx-time-five">Aucune activité récente enregistrée.</Vide> : m.events.map((e, i) => (
                    <div key={i} className="d-flex gap-2 mb-3">
                      <div className="avatar avatar-sm flex-shrink-0"><span className={`avatar-initial rounded bg-label-${e.color}`}><i className={`bx ${e.icon}`} /></span></div>
                      <div className="flex-grow-1"><div className="fw-semibold small">{e.titre}</div><small className="text-muted">{e.desc}</small></div>
                      <small className="text-muted text-nowrap">{relTime(e.ts, m.now)}</small>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="col-lg-6 col-xl-3">
              <div className="card h-100">
                <div className="card-header"><h6 className="mb-0"><i className="bx bx-bolt-circle text-warning me-1" />Actions rapides</h6></div>
                <div className="card-body d-flex flex-column gap-2">
                  {[
                    ['/inscriptions', 'bx-user-plus', 'info', 'Inscrire un élève', 'Nouvelle fiche + affectation'],
                    ['/paiements', 'bx-money', 'success', 'Enregistrer un paiement', 'Scolarité · Reçu PDF'],
                    ['/emploi-du-temps', 'bx-calendar', 'warning', 'Emploi du temps', 'Planification hebdomadaire'],
                  ].map(([to, icon, color, label, desc]) => (
                    <Link key={to} to={to} className="d-flex align-items-center gap-2 p-2 border rounded text-body">
                      <div className="avatar avatar-sm flex-shrink-0"><span className={`avatar-initial rounded bg-label-${color}`}><i className={`bx ${icon}`} /></span></div>
                      <div><div className="fw-semibold small">{label}</div><small className="text-muted">{desc}</small></div>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

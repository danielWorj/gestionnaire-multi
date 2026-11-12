import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { EspaceTitre, Pastilles } from '../components/Espace';
import { SkelZone } from '../components/Skeleton';
import { ChoixEnfant, EtatEspace, PhotoEnfant } from '../components/EspaceParent';
import { prenomNom, useEnfantChoisi, useEspaceParent } from '../lib/espaceParent';
import { formatMontant, useToast } from '../components/ui';
import { api } from '../lib/api';

// Bulletins d'un enfant, pour les périodes terminées. Grisé (non
// consultable) tant que des frais échus restent impayés, sauf levée du
// blocage par l'administration — règle appliquée par le serveur.

export default function ParentBulletinsPage() {
  const toast = useToast();
  const espace = useEspaceParent();
  const enfants = espace.data?.enfants || [];
  const [enfant, choisir] = useEnfantChoisi(enfants);
  const bulletin = enfant?.bulletin;
  const periodes = bulletin?.periodes || [];
  const [periode, setPeriode] = useState('');
  const [apercu, setApercu] = useState({ html: '', chargement: false, erreur: '' });
  const [pdfEnCours, setPdfEnCours] = useState(false);
  const iframeRef = useRef(null);
  const eleveId = enfant?.eleve.id;

  // Période la plus récente par défaut (la liste va de la plus ancienne à
  // l'annuel) ; on garde le choix si la nouvelle liste le contient.
  useEffect(() => {
    setPeriode((prev) => (periodes.some((p) => p.value === prev) ? prev : periodes.at(-1)?.value || ''));
  }, [eleveId, periodes.map((p) => p.value).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!eleveId || !periode || bulletin?.bloque) {
      setApercu({ html: '', chargement: false, erreur: '' });
      return undefined;
    }
    let annule = false;
    setApercu({ html: '', chargement: true, erreur: '' });
    api.get(`/parent/enfants/${eleveId}/bulletin?periode=${encodeURIComponent(periode)}`)
      .then((html) => { if (!annule) setApercu({ html, chargement: false, erreur: '' }); })
      .catch((e) => { if (!annule) setApercu({ html: '', chargement: false, erreur: e.message }); });
    return () => { annule = true; };
  }, [eleveId, periode, bulletin?.bloque]);

  const libellePeriode = periodes.find((p) => p.value === periode)?.libelle || '';

  const telecharger = async () => {
    setPdfEnCours(true);
    try {
      const blob = await api.blob(`/parent/enfants/${eleveId}/bulletin.pdf?periode=${encodeURIComponent(periode)}`);
      const url = URL.createObjectURL(blob);
      const lien = document.createElement('a');
      lien.href = url;
      lien.download = `bulletin_${prenomNom(enfant.eleve)}_${libellePeriode}.pdf`.replace(/\s+/g, '_');
      lien.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(`PDF : ${e.message}`, 'error');
    } finally {
      setPdfEnCours(false);
    }
  };

  // Bulletin au format A4 : réduit pour tenir dans la largeur de l'écran
  // (téléphone) ; l'impression et le PDF gardent la taille réelle.
  const ajusterLargeur = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    doc.body.style.zoom = '';
    const ratio = iframeRef.current.clientWidth / doc.documentElement.scrollWidth;
    if (ratio < 1) doc.body.style.zoom = String(ratio);
  };

  const imprimer = () => {
    const fenetre = iframeRef.current?.contentWindow;
    if (!fenetre) return;
    const doc = iframeRef.current.contentDocument;
    const zoom = doc.body.style.zoom;
    doc.body.style.zoom = '';
    fenetre.focus();
    fenetre.print();
    doc.body.style.zoom = zoom;
  };

  return (
    <>
      <EspaceTitre titre="Bulletins" sousTitre="Disponibles à la fin de chaque séquence" icon="bx-file" />
      <EtatEspace espace={espace} />
      <ChoixEnfant enfants={enfants} enfant={enfant} onChoisir={choisir} />

      {espace.loading && !espace.data && <SkelZone label="Chargement des bulletins…"><div style={{ height: 320 }} /></SkelZone>}

      {enfant && (
        <>
          <div className="d-flex align-items-center gap-2 mb-3">
            <PhotoEnfant eleve={enfant.eleve} taille={40} />
            <div className="min-w-0">
              <div className="fw-bold">{prenomNom(enfant.eleve)}</div>
              <small className="text-muted">{enfant.inscription?.classe || "Pas inscrit cette année"}</small>
            </div>
          </div>

          {!bulletin ? (
            <div className="esp-vide"><i className="bx bx-file-blank" /><p className="mb-0">{enfant.eleve.prenom} n'est pas inscrit pour l'année en cours.</p></div>
          ) : !periodes.length ? (
            <div className="esp-vide">
              <i className="bx bx-time-five" />
              <p className="mb-0">Aucun bulletin disponible pour le moment. Le bulletin d'une séquence apparaît ici dès qu'elle est terminée.</p>
            </div>
          ) : bulletin.bloque ? (
            <>
              <div className="par-periodes-grisees mb-3" aria-hidden="true">
                <Pastilles ariaLabel="Période" value={periode} onChange={() => {}} options={periodes.map((p) => ({ value: p.value, label: p.libelle }))} />
              </div>
              <div className="par-bulletin-bloque">
                <div className="par-bulletin-bloque-carte">
                  <i className="bx bx-lock-alt" />
                  <h6 className="fw-bold mb-2">Bulletin suspendu</h6>
                  <p className="text-muted small mb-3">{bulletin.motif}</p>
                  {enfant.paiements?.impaye_exigible > 0 && (
                    <p className="mb-3">Montant échu à régler : <strong>{formatMontant(enfant.paiements.impaye_exigible)}</strong></p>
                  )}
                  <Link to={`/parent/paiements?enfant=${enfant.eleve.id}`} className="btn btn-primary btn-sm"><i className="bx bx-wallet me-1" />Voir les paiements</Link>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="mb-3">
                <Pastilles ariaLabel="Période" value={periode} onChange={setPeriode} options={periodes.map((p) => ({ value: p.value, label: p.libelle }))} />
              </div>
              <div className="par-bulletin-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={telecharger} disabled={!apercu.html || pdfEnCours}>
                  {pdfEnCours ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bx bx-download me-1" />}Télécharger en PDF
                </button>
                <button type="button" className="btn btn-outline-secondary btn-sm" onClick={imprimer} disabled={!apercu.html}><i className="bx bx-printer me-1" />Imprimer</button>
              </div>
              {apercu.erreur && <div className="alert alert-warning"><i className="bx bx-error me-2" />{apercu.erreur}</div>}
              {apercu.chargement && <SkelZone label="Préparation du bulletin…"><div style={{ height: 320 }} /></SkelZone>}
              {apercu.html && <iframe ref={iframeRef} title={`Bulletin — ${libellePeriode}`} className="par-bulletin-apercu" srcDoc={apercu.html} onLoad={ajusterLargeur} />}
            </>
          )}
        </>
      )}
    </>
  );
}

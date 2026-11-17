import { useState } from 'react';
import { api } from '../lib/api';
import { useConfirm, useToast } from './ui';

// État de la saisie des notes d'une séquence (cf. server/models/
// structure_models.py, Sequence.etat_saisie) et boutons de l'administration :
//   - auto     : ouverte jusqu'à la date de fin, verrouillée ensuite ;
//   - cloturee : clôturée à la main (plus aucun enseignant ne peut saisir) ;
//   - ouverte  : rouverte à la main, même après la date de fin.
// L'Admin et le SuperAdmin peuvent toujours corriger une note, même verrouillée.

export function BadgeSaisie({ sequence }) {
  if (sequence.verrouillee) {
    return (
      <span className="badge bg-label-danger" title={sequence.etat_saisie === 'cloturee' ? "Clôturée par l'administration" : 'Date de fin passée'}>
        <i className="bx bx-lock-alt me-1" />{sequence.etat_saisie === 'cloturee' ? 'Clôturée' : 'Verrouillée (date passée)'}
      </span>
    );
  }
  return (
    <span className="badge bg-label-success" title={sequence.etat_saisie === 'ouverte' ? "Rouverte par l'administration" : 'Ouverte jusqu’à la date de fin'}>
      <i className="bx bx-lock-open-alt me-1" />{sequence.etat_saisie === 'ouverte' ? 'Rouverte' : 'Ouverte'}
    </span>
  );
}

// url : adresse de la séquence (le SuperAdmin y précise l'établissement).
export default function VerrouSequence({ sequence, onChange, url = `/sequences/${sequence.id}` }) {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [occupe, setOccupe] = useState(false);

  const changer = async (etat, message, titre, libelle, icone) => {
    if (!(await confirm(message, { title: titre, confirmLabel: libelle, confirmIcon: icone, icon: icone, danger: etat === 'cloturee' }))) return;
    setOccupe(true);
    try {
      await api.put(url, { etat_saisie: etat });
      toast(etat === 'cloturee' ? `${sequence.libelle} clôturée : les enseignants ne peuvent plus modifier les notes.`
        : etat === 'ouverte' ? `${sequence.libelle} rouverte : les enseignants peuvent de nouveau saisir.`
          : `${sequence.libelle} : verrouillage automatique à la date de fin.`);
      await onChange?.();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setOccupe(false);
    }
  };

  return (
    <span className="d-inline-flex align-items-center gap-1 flex-wrap">
      <BadgeSaisie sequence={sequence} />
      {sequence.verrouillee ? (
        <button type="button" className="btn btn-sm btn-outline-success" disabled={occupe}
          onClick={() => changer('ouverte', `Rouvrir la saisie de « ${sequence.libelle} » ? Les enseignants pourront de nouveau modifier leurs notes jusqu'à ce que vous la clôturiez.`, 'Rouvrir la séquence', 'Rouvrir', 'bx-lock-open-alt')}>
          <i className="bx bx-lock-open-alt me-1" />Rouvrir
        </button>
      ) : (
        <button type="button" className="btn btn-sm btn-outline-danger" disabled={occupe}
          onClick={() => changer('cloturee', `Clôturer la saisie de « ${sequence.libelle} » ? Plus aucun enseignant ne pourra modifier ses notes ; seule l'administration pourra encore les corriger.`, 'Clôturer la séquence', 'Clôturer', 'bx-lock-alt')}>
          <i className="bx bx-lock-alt me-1" />Clôturer
        </button>
      )}
      {sequence.etat_saisie !== 'auto' && (
        <button type="button" className="btn btn-sm btn-link px-1" disabled={occupe} title="Verrouillage automatique à la date de fin"
          onClick={() => changer('auto', `Revenir au verrouillage automatique pour « ${sequence.libelle} » (saisie fermée le lendemain de sa date de fin) ?`, 'Verrouillage automatique', 'Confirmer', 'bx-time')}>
          Auto
        </button>
      )}
      {confirmNode}
    </span>
  );
}

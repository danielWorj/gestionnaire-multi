import { useMemo, useState } from 'react';
import Modal from './Modal';
import Select from './Select';
import { Field, FormFooter, useToast } from './ui';
import {
  EPREUVE_ACCEPT, EPREUVE_FORMATS_AIDE, EPREUVE_TITRE_MAX,
  classesDe, deposerEpreuve, formaterTaille, matieresDe, verifierFichierLocal,
} from '../lib/epreuves';

// Fenêtre d'ajout d'une épreuve : classe → matière (limitée à la classe) →
// titre → fichier.
//
// `espace` : 'enseignant' (ses propres classes/matières) ou 'admin' (toutes ;
// l'enseignant est celui de l'affectation, affiché dès la matière choisie).
// `mcs` : affectations normalisées (cf. lib/epreuves.js). Le serveur reste
// juge : il refuse une matière qui n'est pas celle de l'enseignant (403),
// un format ou une taille invalide (400).
export default function EpreuveModal({ espace, mcs, onClose, onSaved }) {
  const toast = useToast();
  const [classeId, setClasseId] = useState('');
  const [matiereId, setMatiereId] = useState('');
  const [titre, setTitre] = useState('');
  const [fichier, setFichier] = useState(null);
  const [erreurs, setErreurs] = useState({});
  const [erreurServeur, setErreurServeur] = useState('');
  const [saving, setSaving] = useState(false);

  const classes = useMemo(() => classesDe(mcs), [mcs]);
  // Une seule classe (ou une seule matière dans la classe) : choisie d'office.
  const classeEff = classeId || (classes.length === 1 ? String(classes[0].id) : '');
  const matieres = useMemo(() => (classeEff ? matieresDe(mcs, classeEff) : []), [mcs, classeEff]);
  const matiereEff = matieres.some((m) => String(m.id) === matiereId)
    ? matiereId
    : (matieres.length === 1 ? String(matieres[0].id) : '');
  const mc = useMemo(
    () => mcs.find((x) => String(x.classe_id) === classeEff && String(x.matiere_id) === matiereEff),
    [mcs, classeEff, matiereEff],
  );

  const effacer = (champ) => setErreurs((e) => ({ ...e, [champ]: undefined }));

  const choisirClasse = (valeur) => {
    setClasseId(valeur);
    setMatiereId('');
    setErreurs((e) => ({ ...e, classe: undefined, matiere: undefined }));
  };

  const choisirFichier = (event) => {
    const choisi = event.target.files?.[0] || null;
    setFichier(choisi);
    effacer('fichier');
    // Titre proposé d'après le nom du fichier, s'il n'est pas déjà saisi.
    if (choisi && !titre.trim()) {
      setTitre(choisi.name.replace(/\.[^.]+$/, '').slice(0, EPREUVE_TITRE_MAX));
      effacer('titre');
    }
  };

  const submit = async () => {
    const e = {};
    if (!classeEff) e.classe = 'Choisissez une classe.';
    if (!matiereEff || !mc) e.matiere = 'Choisissez une matière.';
    if (!titre.trim()) e.titre = 'Saisissez un titre.';
    if (!fichier) e.fichier = 'Choisissez un fichier.';
    else {
      const probleme = verifierFichierLocal(fichier);
      if (probleme) e.fichier = probleme;
    }
    setErreurs(e);
    setErreurServeur('');
    if (Object.keys(e).length) return;

    setSaving(true);
    try {
      const epreuve = await deposerEpreuve(espace, { matiereClasseId: mc.id, titre, fichier });
      toast('Épreuve ajoutée.');
      onSaved(epreuve);
    } catch (err) {
      setErreurServeur(err.message);
      setSaving(false);
    }
  };

  const cls = (base, champ) => `${base} ${erreurs[champ] ? 'is-invalid' : ''}`;

  return (
    <Modal
      title="Ajouter une épreuve"
      subtitle={espace === 'admin' ? "L'enseignant est celui affecté à la matière dans la classe." : 'Dans l\'une de vos classes'}
      size=""
      onClose={saving ? () => {} : onClose}
      onSubmit={submit}
      footer={<FormFooter onCancel={onClose} saving={saving} label="Ajouter" icon="bx-upload" />}
    >
      {erreurServeur && (
        <div className="alert alert-danger d-flex gap-2 py-2" role="alert">
          <i className="bx bx-error-circle mt-1" />
          <div>{erreurServeur}</div>
        </div>
      )}

      <Field label="Classe" required invalid={erreurs.classe}>
        <Select className={cls('form-select', 'classe')} value={classeEff} onChange={(e) => choisirClasse(e.target.value)} disabled={saving}>
          <option value="">{classes.length ? 'Choisir une classe' : 'Aucune classe disponible'}</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
      </Field>

      <Field label="Matière" required invalid={erreurs.matiere}>
        <Select
          className={cls('form-select', 'matiere')}
          value={matiereEff}
          onChange={(e) => { setMatiereId(e.target.value); effacer('matiere'); }}
          disabled={saving || !classeEff}
        >
          <option value="">{classeEff ? 'Choisir une matière' : "Choisissez d'abord une classe"}</option>
          {matieres.map((m) => <option key={m.id} value={m.id}>{m.libelle}</option>)}
        </Select>
      </Field>

      {espace === 'admin' && (
        <Field label="Enseignant">
          <input
            type="text"
            className="form-control"
            value={mc?.enseignant_nom || ''}
            placeholder="Affiché après le choix de la matière"
            readOnly
            disabled
          />
        </Field>
      )}

      <Field label="Titre" required invalid={erreurs.titre}>
        <input
          type="text"
          className={cls('form-control', 'titre')}
          maxLength={EPREUVE_TITRE_MAX}
          placeholder="Ex. Devoir de mathématiques n°2"
          value={titre}
          onChange={(e) => { setTitre(e.target.value); effacer('titre'); }}
          disabled={saving}
        />
      </Field>

      <Field label="Fichier" required className="mb-0" invalid={erreurs.fichier} hint={fichier && !erreurs.fichier ? `${fichier.name} · ${formaterTaille(fichier.size)}` : EPREUVE_FORMATS_AIDE}>
        <input
          type="file"
          className={cls('form-control', 'fichier')}
          accept={EPREUVE_ACCEPT}
          onChange={choisirFichier}
          disabled={saving}
        />
      </Field>
    </Modal>
  );
}

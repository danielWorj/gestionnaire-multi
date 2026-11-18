"""Procès-verbal d'évaluation : calcul (Decimal, troncature, N.C., absent = 0,
rangs), formats, rouge < 10, effectif, droits (Admin/SuperAdmin), HTML et PDF."""
from datetime import date
from decimal import Decimal

import pytest

from extensions import db
from models.authentification_models import Role
from models.evaluation_models import Note
from models.inscription_models import Eleve, Inscription
from models.pedagogie_models import Matiere, MatiereClasse
from services.authentification_services import create_utilisateur
from services.pv_services import (construire_pv, fmt_moyenne, fmt_points, fmt_rang, nom_affiche,
                                  tronquer_2, abreviation_matiere)
from models.structure_models import Etablissement

# Jeu issu du PV papier (coef total 34) : (total, moyenne affichée, rang photo).
PHOTO = [
    ('397.75', '11.69'), ('418.25', '12.30'), ('302', '08.88'), ('441.5', '12.98'),
    ('325.75', '09.58'), ('366.5', '10.77'), ('423.25', '12.44'), ('323.25', '09.50'),
    ('280.25', '08.24'), ('346.75', '10.19'), ('349.25', '10.27'), ('333.5', '09.80'),
    ('457.5', '13.45'), ('528', '15.52'), ('396', '11.64'), ('419', '12.32'), ('271.5', '07.98'),
]


# ---------------------------------------------------------------------------
# Outils
# ---------------------------------------------------------------------------

def _matiere(monde, libelle, coef, abreviation=None):
    etab = db.session.get(Etablissement, monde.etab_id)
    groupe_id = db.session.get(Matiere, monde.matiere_id).groupe_id
    mat = Matiere(etablissement_id=etab.id, libelle=libelle, groupe_id=groupe_id, abreviation=abreviation)
    db.session.add(mat)
    db.session.flush()
    mc = MatiereClasse(classe_id=monde.classe_id, matiere_id=mat.id, enseignant_id=monde.enseignant_id,
                       coefficient=coef)
    db.session.add(mc)
    db.session.commit()
    return mc.id


def _coef(monde, coef):
    """Coefficient de la matière-classe de base du monde de test."""
    db.session.get(MatiereClasse, monde.mc_id).coefficient = coef
    db.session.commit()


def _eleve(monde, nom, prenom='X', sexe='M', statut='Actif'):
    e = Eleve(etablissement_id=monde.etab_id, matricule=f'M-{nom}-{prenom}', nom=nom, prenom=prenom, sexe=sexe,
              lieu_naissance='Douala', parent_id=monde.parent_id)
    db.session.add(e)
    db.session.flush()
    insc = Inscription(eleve_id=e.id, classe_id=monde.classe_id, annee_scolaire_id=monde.annee_id,
                       date_inscription=date(2026, 9, 1), statut=statut)
    db.session.add(insc)
    db.session.commit()
    return insc.id


def _note(monde, insc_id, mc_id, valeur=None, absent=False):
    db.session.add(Note(inscription_id=insc_id, matiere_classe_id=mc_id, sequence_id=monde.sequence_id,
                        valeur=Decimal(str(valeur)) if valeur is not None else None, absent=absent))
    db.session.commit()


def _pv(monde, ordre='alphabetique'):
    return construire_pv(db.session.get(Etablissement, monde.etab_id), monde.classe_id, monde.annee_id,
                         monde.sequence_id, ordre)


def _ligne(pv, nom):
    return next(e for e in pv["eleves"] if e["nom"] == nom)


def _cell(ligne, mc_id):
    return next(c for c in ligne["cellules"] if c["mc_id"] == mc_id)


@pytest.fixture()
def classe_34(monde):
    """Classe à deux matières, coefficients 14 + 20 = 34 ; l'élève de base
    (« Eleve », sans note) reste dans la classe. Retourne (mc_a, mc_b)."""
    _coef(monde, 14)
    return monde.mc_id, _matiere(monde, 'Français', 20, abreviation='Fr')


# ---------------------------------------------------------------------------
# Utilitaires purs
# ---------------------------------------------------------------------------

def test_tronquer_et_formater():
    assert tronquer_2(Decimal('13.45588')) == Decimal('13.45')
    assert tronquer_2(Decimal('11.6985')) == Decimal('11.69')
    assert fmt_moyenne(Decimal('8.88')) == '08,88'
    assert fmt_moyenne(Decimal('15.52')) == '15,52'
    assert fmt_moyenne(Decimal('20')) == '20,00'
    assert fmt_points(Decimal('42.5')) == '42,5'
    assert fmt_points(Decimal('26.00')) == '26'
    assert fmt_points(Decimal('27.75')) == '27,75'
    assert fmt_points(Decimal('0')) == '0'
    assert fmt_rang(8, 'F') == '8e' and fmt_rang(19, 'M') == '19e'
    assert fmt_rang(1, 'F') == '1ère' and fmt_rang(1, 'M') == '1er'
    assert nom_affiche('diloga', 'samira') == 'DILOGA Samira'


@pytest.mark.parametrize('total,attendue', PHOTO)
def test_valeurs_photo(total, attendue):
    moyenne = tronquer_2(Decimal(total) / Decimal(34))
    assert fmt_moyenne(moyenne) == attendue.replace('.', ',')


def test_troncature_et_non_arrondi():
    """FEUJIO (441,5) et NGOUADJIO (457,5) échoueraient avec un arrondi."""
    for total, tronque, arrondi in (('441.5', '12.98', '12.99'), ('457.5', '13.45', '13.46'),
                                    ('397.75', '11.69', '11.70'), ('366.5', '10.77', '10.78')):
        exacte = Decimal(total) / Decimal(34)
        assert tronquer_2(exacte) == Decimal(tronque)
        assert exacte.quantize(Decimal('0.01')) == Decimal(arrondi)


def test_abreviation_de_repli(monde):
    mat = db.session.get(Matiere, monde.matiere_id)
    assert abreviation_matiere(mat) == 'Mathé'          # 5 premiers caractères
    mat.abreviation = 'Math'
    assert abreviation_matiere(mat) == 'Math'


# ---------------------------------------------------------------------------
# Calcul
# ---------------------------------------------------------------------------

def test_total_ponderee(monde, classe_34):
    mc_a, mc_b = classe_34
    insc = _eleve(monde, 'Diloga', 'samira', 'F')
    _note(monde, insc, mc_a, 12)
    _note(monde, insc, mc_b, 8.5)
    pv = _pv(monde)
    assert pv["total_coef"] == 34
    d = _ligne(pv, 'Diloga')
    assert (_cell(d, mc_a)["points"], _cell(d, mc_b)["points"]) == (168.0, 170.0)      # note × coef
    assert d["total"] == 338.0 and d["total_fmt"] == '338'
    assert d["moyenne"] == 9.94 and d["moyenne_fmt"] == '09,94'        # 338/34 = 9,941… tronqué
    assert d["nom_affiche"] == 'DILOGA Samira'


def test_valeurs_photo_en_base_troncature(monde, classe_34):
    """441,5 / 34 = 12,9853 : la moyenne affichée est 12,98 et non 12,99."""
    mc_a, mc_b = classe_34
    insc = _eleve(monde, 'Feujio', 'Grâce', 'F')
    _note(monde, insc, mc_a, 15.25)      # 213,5
    _note(monde, insc, mc_b, 11.4)       # 228
    d = _ligne(_pv(monde), 'Feujio')
    assert d["total_fmt"] == '441,5'
    assert d["moyenne_fmt"] == '12,98'


def test_non_classe(monde, classe_34):
    mc_a, mc_b = classe_34
    insc = _eleve(monde, 'Nc')
    _note(monde, insc, mc_a, 9.25)       # la matière B n'a pas de ligne : non saisie
    pv = _pv(monde)
    d = _ligne(pv, 'Nc')
    assert d["classe"] is False and d["moyenne"] is None and d["rang"] is None
    assert d["moyenne_fmt"] == '' and d["rang_fmt"] == 'N.C.'
    assert d["total"] == 129.5 and d["total_fmt"] == '129,5'           # total partiel conservé
    assert (_cell(d, mc_a)["statut"], _cell(d, mc_b)["statut"]) == ('ok', 'manquante')
    assert pv["statistiques"]["nb_non_classes"] >= 1


def test_absent_vaut_zero(monde, classe_34):
    mc_a, mc_b = classe_34
    absent = _eleve(monde, 'Absent')
    _note(monde, absent, mc_a, absent=True)
    _note(monde, absent, mc_b, 10)
    pv = _pv(monde)
    d = _ligne(pv, 'Absent')
    assert _cell(d, mc_a)["points"] == 0.0 and _cell(d, mc_a)["statut"] == 'absent'
    assert _cell(d, mc_a)["rouge"] is True                             # 0 < 10
    assert d["classe"] is True and d["total"] == 200.0 and d["rang"] == 1
    # Aucune ligne Note du tout -> non saisie, donc N.C. (jamais confondu avec absent).
    assert _ligne(pv, 'Eleve')["classe"] is False


def test_rouge(monde, classe_34):
    mc_a, mc_b = classe_34
    insc = _eleve(monde, 'Rouge')
    _note(monde, insc, mc_a, 9.99)
    _note(monde, insc, mc_b, 10)
    d = _ligne(_pv(monde), 'Rouge')
    assert _cell(d, mc_a)["rouge"] is True
    assert _cell(d, mc_b)["rouge"] is False
    bas = _eleve(monde, 'Bas')
    _note(monde, bas, mc_a, 8)
    _note(monde, bas, mc_b, 8)
    haut = _eleve(monde, 'Haut')
    _note(monde, haut, mc_a, 10)
    _note(monde, haut, mc_b, 10)
    pv = _pv(monde)
    assert _ligne(pv, 'Bas')["moyenne_rouge"] is True
    assert _ligne(pv, 'Haut')["moyenne_rouge"] is False                # 10 pile : pas rouge


def test_rang_ex_aequo(monde, classe_34):
    mc_a, mc_b = classe_34
    for nom, note in (('Aa', 14), ('Bb', 14), ('Cc', 12), ('Dd', 16)):
        i = _eleve(monde, nom)
        _note(monde, i, mc_a, note)
        _note(monde, i, mc_b, note)
    pv = _pv(monde)
    assert [(_ligne(pv, n)["rang"]) for n in ('Dd', 'Aa', 'Bb', 'Cc')] == [1, 2, 2, 4]
    assert _ligne(pv, 'Dd')["rang_fmt"] == '1er' and _ligne(pv, 'Aa')["rang_fmt"] == '2e'


def test_rang_exclut_non_classes(monde, classe_34):
    mc_a, mc_b = classe_34
    a = _eleve(monde, 'Aa')
    _note(monde, a, mc_a, 10), _note(monde, a, mc_b, 10)
    b = _eleve(monde, 'Bb')
    _note(monde, b, mc_a, 8), _note(monde, b, mc_b, 8)
    n = _eleve(monde, 'Cc')
    _note(monde, n, mc_a, 20)            # B manquante : N.C. malgré une très bonne note
    pv = _pv(monde)
    assert _ligne(pv, 'Aa')["rang"] == 1 and _ligne(pv, 'Bb')["rang"] == 2
    assert _ligne(pv, 'Cc')["rang"] is None
    assert pv["statistiques"]["nb_classes"] == 2


def test_classement_sur_valeur_exacte(monde, classe_34):
    """Deux totaux différents dont les moyennes AFFICHÉES (tronquées) sont
    égales gardent des rangs distincts : le classement se fait sur la valeur
    exacte (D2), pas sur la moyenne tronquée."""
    mc_a, mc_b = classe_34
    a = _eleve(monde, 'Aa')
    _note(monde, a, mc_a, 10), _note(monde, a, mc_b, 10.01)     # 340,2 -> 10,0058 -> 10,00
    b = _eleve(monde, 'Bb')
    _note(monde, b, mc_a, 10), _note(monde, b, mc_b, 10)        # 340   -> 10,0000 -> 10,00
    pv = _pv(monde)
    assert _ligne(pv, 'Aa')["moyenne_fmt"] == _ligne(pv, 'Bb')["moyenne_fmt"] == '10,00'
    assert _ligne(pv, 'Aa')["rang"] == 1 and _ligne(pv, 'Bb')["rang"] == 2


def test_effectif_exclut_radies(monde, classe_34):
    _eleve(monde, 'Radie', statut='Radié')
    _eleve(monde, 'Transfere', statut='Transféré')
    _eleve(monde, 'Suspendu', statut='Suspendu')
    pv = _pv(monde)
    noms = {e["nom"] for e in pv["eleves"]}
    assert 'Radie' not in noms and 'Transfere' not in noms and 'Suspendu' in noms
    assert pv["effectif"] == len(pv["eleves"]) == 2                    # Eleve + Suspendu


def test_numerotation_alphabetique_et_ordre_rang(monde, classe_34):
    mc_a, mc_b = classe_34
    for nom, note in (('Zed', 18), ('Abel', 8), ('Marc', 12)):
        i = _eleve(monde, nom)
        _note(monde, i, mc_a, note), _note(monde, i, mc_b, note)
    alpha = _pv(monde)
    assert [e["nom"] for e in alpha["eleves"]] == ['Abel', 'Eleve', 'Marc', 'Zed']
    assert [e["numero"] for e in alpha["eleves"]] == [1, 2, 3, 4]
    par_rang = _pv(monde, 'rang')
    assert [e["nom"] for e in par_rang["eleves"]] == ['Zed', 'Marc', 'Abel', 'Eleve']   # N.C. en dernier
    assert _ligne(par_rang, 'Zed')["numero"] == 4                      # le N° reste alphabétique


def test_matieres_alertes_et_statistiques(monde, classe_34):
    mc_a, mc_b = classe_34
    a = _eleve(monde, 'Aa')
    _note(monde, a, mc_a, 10), _note(monde, a, mc_b, 10)
    b = _eleve(monde, 'Bb')
    _note(monde, b, mc_a, 6), _note(monde, b, mc_b, 6)
    pv = _pv(monde)
    assert [m["abreviation"] for m in pv["matieres"]] == ['Fr', 'Mathé']      # Français < Mathématiques
    assert pv["sequence"]["titre"] == 'CONTRÔLE CONTINU N°1'                  # « Seq1 » -> numéro 1
    assert {a["matiere"] for a in pv["alertes"]} == {'Mathématiques', 'Français'}   # « Eleve » sans note
    st = pv["statistiques"]
    assert st["nb_classes"] == 2 and st["nb_sup_10"] == 1 and st["taux_reussite"] == 50.0
    assert st["moyenne_classe"] == 8.0 and st["moyenne_classe_fmt"] == '08,00'
    # Noms à côté de la plus forte / plus faible moyenne.
    assert st["premier"] == nom_affiche("Aa", "X")
    assert st["dernier"] == nom_affiche("Bb", "X")


def test_dimensions_une_page():
    from api.pv_api import HAUTEUR_LIGNES_MM, _dimensions
    assert _dimensions(10, 20) == (7.8, 4.2)             # petite classe : taille normale
    for n in (45, 60, 80):
        police, hauteur = _dimensions(16, n)
        assert hauteur * n <= HAUTEUR_LIGNES_MM + 0.5   # toutes les lignes tiennent
        assert 4 <= police < 7.2


def test_erreurs_perimetre(monde, appli):
    from services.pv_services import PvErreur
    etab = db.session.get(Etablissement, monde.etab_id)
    for args in ((9999, monde.annee_id, monde.sequence_id), (monde.classe_id, 9999, monde.sequence_id),
                 (monde.classe_id, monde.annee_id, 9999)):
        with pytest.raises(PvErreur) as err:
            construire_pv(etab, *args)
        assert err.value.status == 404
    autre = Etablissement(code='TST2', nom='Autre')
    db.session.add(autre)
    db.session.commit()
    with pytest.raises(PvErreur):
        construire_pv(autre, monde.classe_id, monde.annee_id, monde.sequence_id)


def test_classe_sans_matiere(monde):
    db.session.delete(db.session.get(MatiereClasse, monde.mc_id))
    db.session.commit()
    pv = _pv(monde)
    assert pv["total_coef"] == 0 and pv["matieres"] == []
    assert pv["eleves"][0]["classe"] is False                          # pas de division par zéro


# ---------------------------------------------------------------------------
# API : droits, JSON, HTML, PDF
# ---------------------------------------------------------------------------

def _compte(monde, nom, role):
    r = Role.query.filter_by(libelle=role).first()
    res, status = create_utilisateur({'nom': nom, 'role_ids': [r.id], 'etablissement_id': monde.etab_id})
    assert status == 201, res
    return res


def _url(monde, route='', **extra):
    params = f"classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}&sequence_id={monde.sequence_id}"
    for k, v in extra.items():
        params += f"&{k}={v}"
    return f"/api/pv/{route}?{params}"


def test_roles(monde, connecter, connecter_superadmin):
    admin = connecter(monde.admin_compte)
    assert admin.get(_url(monde)).status_code == 200
    assert admin.get(f"/api/pv/sequences?annee_scolaire_id={monde.annee_id}").status_code == 200
    sup = connecter_superadmin()
    assert sup.get(_url(monde, etablissement_id=monde.etab_id)).status_code == 200
    assert sup.get(_url(monde)).status_code == 400                     # etablissement_id requis
    # Censeur : ses classes assignées (la classe du monde lui est assignée).
    assert connecter(monde.censeur_compte).get(_url(monde)).status_code == 200
    # Enseignant non titulaire, Surveillant sans classe : refusés.
    interdits = [monde.enseignant_compte, _compte(monde, 'Surv', 'Surveillant')]
    for compte in interdits:
        api = connecter(compte)
        for route in ('', 'html', 'pdf'):
            assert api.get(_url(monde, route)).status_code == 403, route
    # Enseignant titulaire de la classe pour l'année active : autorisé.
    from models.pedagogie_models import TitulaireClasse
    db.session.add(TitulaireClasse(classe_id=monde.classe_id, enseignant_id=monde.enseignant_id,
                                   annee_scolaire_id=monde.annee_id))
    db.session.commit()
    assert connecter(monde.enseignant_compte).get(_url(monde)).status_code == 200
    anonyme = admin.client.application.test_client()
    assert anonyme.get(_url(monde)).status_code == 401


def test_api_json_et_sequences(monde, connecter, classe_34):
    mc_a, mc_b = classe_34
    i = _eleve(monde, 'Aa', sexe='F')
    _note(monde, i, mc_a, 12), _note(monde, i, mc_b, 12)
    admin = connecter(monde.admin_compte)
    reponse = admin.get(_url(monde, ordre='rang'))
    data = reponse.get_json()
    assert data["classe"]["id"] == monde.classe_id and data["total_coef"] == 34
    assert data["eleves"][0]["nom"] == 'Aa' and data["eleves"][0]["rang_fmt"] == '1ère'
    seqs = admin.get(f"/api/pv/sequences?annee_scolaire_id={monde.annee_id}").get_json()
    assert [s["id"] for s in seqs] == [monde.sequence_id]
    assert admin.get("/api/pv/sequences?annee_scolaire_id=9999").status_code == 404
    assert admin.get(_url(monde).replace(f"sequence_id={monde.sequence_id}", "sequence_id=9999")).status_code == 404


def test_html(monde, connecter, classe_34):
    mc_a, mc_b = classe_34
    bon = _eleve(monde, 'Bon', 'Anna', 'F')
    _note(monde, bon, mc_a, 9.99), _note(monde, bon, mc_b, 15)
    admin = connecter(monde.admin_compte)
    html = admin.get(_url(monde, 'html')).get_data(as_text=True)
    assert 'size: A4 landscape' in html
    assert "PROCÈS VERBAL D'ÉVALUATION" in html
    assert 'Classe : ' in html and 'Effectif : 2' in html
    assert 'BON Anna' in html
    assert 'rouge' in html                                            # 9,99 < 10
    assert 'N.C.' in html                                             # l'élève de base n'a aucune note
    assert 'valeurs' not in html
    notes = admin.get(_url(monde, 'html', valeurs='notes')).get_data(as_text=True)
    assert '9,99' in notes and '139,86' in html                       # note brute vs points (9,99 × 14)


def test_pdf(monde, connecter, classe_34):
    pytest.importorskip('weasyprint')
    mc_a, mc_b = classe_34
    i = _eleve(monde, 'Aa')
    _note(monde, i, mc_a, 12), _note(monde, i, mc_b, 12)
    admin = connecter(monde.admin_compte)
    try:
        reponse = admin.get(_url(monde, 'pdf'))
    except OSError:
        pytest.skip('Pango indisponible')
    if reponse.status_code == 503:
        pytest.skip('WeasyPrint/Pango indisponible')
    assert reponse.status_code == 200
    assert reponse.mimetype == 'application/pdf'
    assert reponse.data.startswith(b'%PDF')
    disposition = reponse.headers['Content-Disposition']
    assert disposition.startswith('attachment; filename="pv_') and disposition.endswith('.pdf"')
    assert all(ord(c) < 128 for c in disposition) and ' ' not in disposition.split('filename=')[1]


def test_pdf_sans_eleve_404(monde, connecter):
    db.session.get(Inscription, monde.inscription_id).statut = 'Radié'
    db.session.commit()
    admin = connecter(monde.admin_compte)
    assert admin.get(_url(monde, 'pdf')).status_code == 404

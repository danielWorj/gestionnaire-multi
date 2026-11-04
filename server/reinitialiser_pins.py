"""
Attribue un nouveau PIN aux comptes existants et produit les fiches
d'accès (code de connexion + PIN) à distribuer.

À lancer UNE FOIS après la migration « connexion par code + PIN »
(e7a2c4d9f310) : les anciens mots de passe ne peuvent pas servir de PIN, donc
aucun compte existant ne peut se connecter tant qu'il n'a pas reçu de PIN.

Usage :
    python reinitialiser_pins.py                    # tous les établissements
    python reinitialiser_pins.py --etablissement 3  # un seul établissement

Seuls les comptes ACTIFS sont traités. Chacun reçoit un nouveau PIN
définitif (modifiable ensuite depuis son espace) ; ses sessions en cours
sont fermées. Les PIN en clair ne sont écrits que dans le fichier produit
(storage/fiches_acces_<date>.txt, ignoré par git — storage/ est monté sur
l'hôte en Docker) : à imprimer ou transmettre, puis à SUPPRIMER. PIN
oublié : un admin en régénère un depuis l'application.
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from app import create_app

app = create_app()

from extensions import db
from models.authentification_models import Utilisateur
from models.structure_models import Etablissement
from services.authentification_services import reset_temp_password


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--etablissement', type=int, help="id de l'établissement (défaut : tous)")
    args = parser.parse_args()

    with app.app_context():
        query = Etablissement.query.order_by(Etablissement.nom)
        if args.etablissement:
            query = query.filter_by(id=args.etablissement)
        etablissements = query.all()
        if not etablissements:
            sys.exit("Aucun établissement trouvé.")

        comptes = (Utilisateur.query
                   .filter(Utilisateur.actif.is_(True),
                           Utilisateur.etablissement_id.in_([e.id for e in etablissements]))
                   .order_by(Utilisateur.nom).all())
        if not comptes:
            sys.exit("Aucun compte actif à traiter.")

        print(f"{len(comptes)} compte(s) actif(s) dans {len(etablissements)} établissement(s) "
              "vont recevoir un nouveau PIN (l'ancien cessera de fonctionner).")
        if input("Continuer ? [o/N] ").strip().lower() != 'o':
            sys.exit("Abandon.")

        genere_le = datetime.now()
        lignes = [
            "FICHES D'ACCÈS — CODES DE CONNEXION ET PIN",
            f"Générées le {genere_le:%d/%m/%Y à %H:%M}",
            "PIN définitifs, modifiables par chacun depuis son espace (« Changer mon code PIN »).",
            "À distribuer puis SUPPRIMER ce fichier.",
        ]
        erreurs = 0
        for etab in etablissements:
            comptes_etab = [u for u in comptes if u.etablissement_id == etab.id]
            if not comptes_etab:
                continue
            lignes += ['', '=' * 70, f"{etab.nom} (code établissement : {etab.code})", '=' * 70,
                       f"{'CODE':<8}{'PIN':<7}{'RÔLE(S)':<30}NOM", '-' * 70]
            for u in comptes_etab:
                result, status = reset_temp_password(u.id)
                if status != 200:
                    erreurs += 1
                    print(f"  ⚠️  {u.nom} : {result.get('erreur')}")
                    continue
                lignes.append(f"{u.code_connexion:<8}{result['pin_temporaire']:<7}"
                              f"{', '.join(u.libelles_roles()):<30}{u.nom}")

        fichier = CURRENT_DIR / 'storage' / f"fiches_acces_{genere_le:%Y%m%d_%H%M}.txt"
        fichier.parent.mkdir(parents=True, exist_ok=True)
        fichier.write_text('\n'.join(lignes) + '\n', encoding='utf-8')
        db.session.remove()

        print(f"✅ {len(comptes) - erreurs} PIN générés. Fiches d'accès : {fichier}")
        if erreurs:
            print(f"⚠️  {erreurs} compte(s) en erreur : relancer ou réinitialiser depuis l'application.")


if __name__ == '__main__':
    main()

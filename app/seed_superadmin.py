"""
Script de création du compte SuperAdmin.

Usage :
    python seed_superadmin.py

Le mot de passe est saisi de façon interactive (invisible à l'écran) et
n'est JAMAIS stocké en clair : il est hashé en bcrypt par SuperAdmin.set_password()
avant d'être enregistré en base (colonne mot_de_passe_hash).
C'est ce mot de passe en clair, que TU choisis ici, qui te servira à te
connecter ensuite via POST /api/auth/superadmin/login.

⚠️ À adapter : la ligne d'import de l'app Flask ci-dessous dépend de la
structure de ton projet. Si tu as un app.py avec une factory create_app(),
remplace par : from app import create_app ; app = create_app()
Si tu as un objet app global (ex: app.py contient `app = Flask(__name__)`),
remplace par : from app import app
"""

import sys
import getpass

# --- À ADAPTER SELON TON PROJET -------------------------------------------
from app import create_app
app = create_app()
# ----------------------------------------------------------------------------

from extensions import db
from models.authentification_models import SuperAdmin


def main():
    with app.app_context():
        # 1. Infos du superadmin
        nom = input("Nom du superadmin : ").strip()
        email = input("Email du superadmin : ").strip()

        if not nom or not email:
            print("Nom et email sont obligatoires.")
            sys.exit(1)

        # 2. Vérifier qu'il n'existe pas déjà
        existing = SuperAdmin.query.filter_by(email=email).first()
        if existing:
            print(f"Un SuperAdmin avec l'email '{email}' existe déjà (id={existing.id}).")
            sys.exit(1)

        # 3. Saisie sécurisée du mot de passe (non affiché, non stocké en clair)
        password = getpass.getpass("Mot de passe du superadmin : ")
        password_confirm = getpass.getpass("Confirmez le mot de passe : ")

        if password != password_confirm:
            print("Les deux mots de passe ne correspondent pas.")
            sys.exit(1)

        if len(password) < 8:
            print("Le mot de passe doit contenir au moins 8 caractères.")
            sys.exit(1)

        # 4. Création (SuperAdmin : compte global, indépendant de tout établissement)
        superadmin = SuperAdmin(
            nom=nom,
            email=email,
            actif=True,
        )
        superadmin.set_password(password)  # hash bcrypt, jamais stocké en clair

        db.session.add(superadmin)
        db.session.commit()

        print(f"\n✅ Superadmin créé avec succès (id={superadmin.id}).")
        print(f"   Connecte-toi avec : POST /api/auth/superadmin/login")
        print(f'   Body: {{"email": "{email}", "password": "<le mot de passe que tu viens de choisir>"}}')


if __name__ == '__main__':
    main()
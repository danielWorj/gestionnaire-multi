
Je développe une application Flask de gestion scolaire (multi-établissements, JWT en cookies httpOnly, rôles : SuperAdmin, Admin d'établissement, Censeur, Surveillant, Enseignant, ...). J'ai besoin de deux pages front-end (Jinja2 + Bootstrap 5 + Font Awesome + Chart.js, dans le style exact des pages existantes) destinées au rôle **Censeur**.

## Contexte technique (à respecter strictement)

- Templates dans `static/templates/`, servis par des routes Flask (voir `app.py`).
- Chaque page suit la même ossature que les pages jointes : `<body data-page="...">`, breadcrumb, titre + actions, cards de stats, éventuels graphiques Chart.js, tableau/grille principal, modals Bootstrap pour la création/édition/suppression.
- JS : `intercepteur.js`, `auth.js` (expose `window.GestionnaireAuth` avec `authFetch`, `requireAuth()`, `getUser()`, `getRole()`), `sidebar.js`. Chaque page définit un petit helper local `api.get/post/put/del(path)` qui wrappe `GestionnaireAuth.authFetch`.
- **Aucune route ni aucun champ inventé** : toutes les URLs d'API, tous les champs de payload/réponse doivent venir strictement des fichiers `models` / `services` / `api` que je fournis. Si un champ ou un endpoint dont tu aurais besoin n'existe pas, dis-le explicitement au lieu de l'inventer.
- Gestion défensive des 403 (référentiels réservés à un autre rôle) et des listes vides, comme le fait déjà `enseignant.html` (ex. `/api/matieres/` peut renvoyer 403 pour un Admin/Censeur selon le contexte — prévoir un message informatif plutôt qu'un plantage).

## Ce que je veux construire

### 1. Page "Pédagogie" (nom de fichier à proposer, ex. `pedagogie.html`)
Permet au **Censeur** de gérer l'interconnexion Enseignant ↔ Matière ↔ Classe, c'est-à-dire les affectations `MatiereClasse` (matière + enseignant + coefficient pour une classe), pour les classes dont il a la charge. S'inspirer de la logique déjà présente dans `enseignant.html` et `matiere.html` (jointes) pour le CRUD des affectations, mais recentrée sur la vue "par classe" plutôt que "par enseignant".

Fonctionnalités attendues :
- Lister les classes concernées, avec pour chacune la liste des matières affectées (matière, enseignant, coefficient).
- Créer / modifier / supprimer une affectation `MatiereClasse`.
- Filtrer par classe / cycle / année scolaire si les endpoints le permettent.
- Réutiliser les référentiels déjà exposés (`/api/matieres/`, `/api/enseignants/`, `/api/classes/`, `/api/cycles/`, etc.) sans dupliquer leur gestion CRUD complète (ça reste la responsabilité d'`enseignant.html`/`matiere.html`).

### 2. Page "Emploi du temps" côté Censeur (nom à proposer, ex. `horaire_censeur.html` ou adaptation de `horaire.html` existant)
Permet au Censeur de gérer les créneaux/horaires (`CreneauHoraire`, `Horaire`) des classes dont il a la charge. Reprendre la grille horaire déjà construite dans `horaire.html` (jointe) — même look (chips de cours, cellules vides cliquables, filtres) — mais adaptée au périmètre du Censeur.

## ⚠️ Prérequis obligatoire : refaire d'abord le backend (assignation de classes)

Le backend actuel (`pedagogie_api.py`, `structure_api.py`, `emploi_du_temps_api.py`) donne au Censeur **et** au Surveillant un accès lecture+écriture sur **tout l'établissement** (mêmes règles que l'Admin), cloisonné uniquement par `etablissement_id` — **il n'existe aucune notion de "classes assignées à tel Censeur/Surveillant"** dans les modèles actuels (`pedagogie_models.py`, `structure_models.py`).

Avant de toucher au moindre HTML/JS, **commence obligatoirement par refaire cette partie du backend** :

1. **Modèle** : ajouter une table de liaison (ex. `ClasseResponsable` ou deux tables dédiées `censeur_classe` / `surveillant_classe`, selon ce qui te semble le plus cohérent avec le style du projet) qui associe un `Censeur` (ou un `Surveillant`) à une ou plusieurs `Classe`, cloisonnée par `etablissement_id` comme les autres modèles pédagogiques (cf. `pedagogie_models.py` pour le style attendu : `to_dict()`, contraintes d'unicité, relations SQLAlchemy).
2. **Attribution réservée à l'Admin** : seul l'Admin d'établissement (et le SuperAdmin) peut créer/modifier/supprimer ces affectations Censeur↔Classe ou Surveillant↔Classe — ni le Censeur ni le Surveillant ne doit pouvoir s'auto-assigner une classe. Suivre la même logique de `roles_autorises` déjà en place dans `pedagogie_api.py`/`structure_api.py`/`emploi_du_temps_api.py`.
3. **Cloisonnement effectif** : une fois ce modèle en place, les endpoints de `pedagogie_api.py` (affectations `MatiereClasse`) et `emploi_du_temps_api.py` (`Horaire`, `CreneauHoraire`) consultés/modifiés par un Censeur ou un Surveillant doivent être **filtrés aux seules classes qui leur ont été assignées** (et non plus à tout l'établissement comme aujourd'hui) — sauf éventuellement pour la lecture des référentiels globaux (matières, enseignants) qui peuvent rester visibles pour permettre de composer une affectation. Documente clairement, comme le fait le code existant, la logique de cloisonnement retenue (directe vs. via jointure).
4. **Ne garde pas l'accès large actuel** une fois l'assignation en place : mets à jour les vérifications d'autorisation (`_validate_foreign_keys_scoped`, `scoped_query`, etc.) pour qu'elles tiennent compte de cette nouvelle restriction pour les rôles Censeur/Surveillant, sans casser l'accès Admin/SuperAdmin qui reste établissement-large.
5. Donne-moi d'abord une synthèse du modèle et des changements d'API envisagés, **avant** d'écrire le code, pour validation.

Ce n'est qu'une fois ce backend en place que les pages front-end "Pédagogie" et "Emploi du temps" ci-dessous doivent être construites sur ce périmètre réellement restreint (et non sur un filtrage arbitraire côté JS sans base réelle côté données).

## Fichiers à joindre à ce prompt

- `horaire.html` (référence de style/structure pour la grille horaire)
- `enseignant.html`, `matiere.html` (référence de style/structure pour les CRUD et les filtres)
- `pedagogie_models.py`, `pedagogie_services.py`, `pedagogie_api.py`
- `structure_models.py`, `structure_services.py`, `structure_api.py`
- `emploi_du_temps_models.py`, `emploi_du_temps_services.py`, `emploi_du_temps_api.py`
- `authentification_models.py`, `authentification_api.py` (pour les claims JWT : `role`, `etablissement_id`)
- `app.py` (pour voir les routes déjà enregistrées et où ajouter les nouvelles)

## Livrables attendus (dans cet ordre)

1. Une synthèse du modèle d'assignation Censeur/Surveillant↔Classe envisagé et de son impact sur les endpoints existants — **avant tout code**, pour validation.
2. Le backend correspondant : modèle(s), migration/table de liaison, mise à jour des services et des blueprints (`pedagogie_api.py`, `emploi_du_temps_api.py`, `structure_api.py` si nécessaire) pour que Censeur/Surveillant soient effectivement cantonnés aux classes qui leur sont assignées, plus un endpoint permettant à l'Admin de gérer ces assignations.
3. Les fichiers HTML des deux pages ("Pédagogie" et "Emploi du temps" côté Censeur), dans le style exact des pages existantes, construites sur ce périmètre restreint.
4. Les modifications nécessaires à `app.py` (routes + enregistrement de blueprint) et à `sidebar.js`/navigation si pertinent — y compris, si besoin, une page/section pour que l'Admin assigne les classes à un Censeur ou un Surveillant.
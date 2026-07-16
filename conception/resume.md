# Résumé du Projet — Application Bulletins de Notes
> Logiciel de gestion scolaire SaaS pour les établissements camerounais (sous-système francophone)
> Application **multi-établissements** (multi-tenant)
> Backend : Flask / Python (SQLAlchemy) — Base de données : MySQL
> Document aligné sur `diagrammes_classes.puml` (modèle SQLAlchemy réel des `backend/models/`)

---

## Vue d'ensemble

Ce projet est une application SaaS de gestion scolaire destinée à **plusieurs établissements** scolaires camerounais du sous-système francophone. Chaque établissement dispose de son propre espace de travail, entièrement isolé des autres, au sein d'une même instance de l'application. Elle permet de gérer l'ensemble du cycle scolaire : inscription des élèves, saisie des notes, calcul et export des bulletins, suivi des paiements de scolarité, emploi du temps — pour chaque établissement de manière indépendante.

L'application repose sur une architecture multi-tenant : toutes les entités clés (`AnneeScolaire`, `Classe`, `Enseignant`, `Eleve`, `Parent`, `Utilisateur`…) portent un `etablissement_id` qui cloisonne les données par école. Un **SuperAdmin**, entité totalement indépendante de tout établissement, supervise l'ensemble de la plateforme.

---

## Modules Principaux

### 🏫 1. Gestion des Établissements

**Fichiers concernés :** `api/etablissement/`, `models/etablissement.py`, `services/etablissement_service.py`

Ce module est le socle de toute l'application. Il permet de créer, configurer et administrer chaque établissement client de la plateforme.

**Fonctionnalités :**
- Création et configuration de plusieurs établissements (nom, nom bilingue, adresse, boîte postale, téléphone, région) — une ligne par établissement en base
- Upload et gestion du logo propre à chaque établissement
- Isolation stricte des données par établissement (`etablissement_id`) sur toutes les entités qui en dépendent
- Vue d'administration globale permettant au SuperAdmin de lister, activer, suspendre ou supprimer un établissement client

---

### 📅 2. Années Scolaires, Trimestres & Séquences

**Fichiers concernés :** `api/annee_scolaire/`, `models/annee_scolaire.py`, `models/trimestre.py`, `models/sequence.py`

Gère le découpage temporel de l'activité pédagogique, sur **trois niveaux hiérarchiques**, pour chaque établissement.

**Fonctionnalités :**
- Création des années scolaires par établissement (ex : `2025-2026`), avec marquage de l'année active (`active = TRUE`)
- Découpage de chaque année scolaire en **trimestres** (numérotés, avec dates de début/fin)
- Découpage de chaque trimestre en **séquences d'évaluation** (numérotées, avec dates de début/fin) — la séquence est l'unité de base pour la saisie des notes dans le système camerounais
- Unicité garantie : un seul libellé de trimestre par numéro et par année, une seule séquence par numéro et par trimestre

**Hiérarchie :**
```
AnneeScolaire (1) → Trimestre (0..*) → Sequence (0..*)
```

---

### 🏛️ 3. Cycles & Classes

**Fichiers concernés :** `api/classe/`, `models/classe.py`, `models/cycle.py`, `models/titulaire_classe.py`

Organise la structure pédagogique de chaque établissement autour de la notion de **cycle** (et non de « niveau » indépendant).

**Fonctionnalités :**
- Gestion des cycles (`Cycle`) : libellé, ordre de progression et regroupement Collège / Lycée
- Création des classes par établissement, rattachées à un cycle, avec option (ex : Espagnol I, Anglais) et salle affectée
- L'**effectif** d'une classe n'est pas un champ stocké : il est calculé à la demande (`COUNT(Inscription)` avec statut `Actif` pour la classe)
- Une classe n'a pas de lien direct avec l'année scolaire : la temporalité passe par `Inscription`, `TitulaireClasse` et `MatiereClasse`
- Affectation d'un **enseignant titulaire** par classe et par année scolaire (table `titulaire_classe`)

---

### 👨‍🏫 4. Enseignants

**Fichiers concernés :** `api/enseignant/`, `models/enseignant.py`

Gère le corps enseignant de chaque établissement.

**Fonctionnalités :**
- Création et gestion des profils enseignants (nom, prénom, grade, téléphone, email unique), rattachés à un établissement
- Liaison d'un enseignant à une ou plusieurs matières dans une classe (via `matiere_classe`)
- Le statut « titulaire d'une classe » n'est **pas un champ stocké** sur `Enseignant` : il est déduit dynamiquement (`EXISTS(TitulaireClasse)` pour l'enseignant)
- Un enseignant n'appartient qu'à l'établissement auquel il est rattaché

---

### 📚 5. Matières & Coefficients

**Fichiers concernés :** `api/matiere/`, `models/matiere.py`, `models/matiere_classe.py`, `models/groupe_matiere.py`

Gère le programme pédagogique et la pondération des matières.

**Fonctionnalités :**
- Définition des matières (`Matiere`), rattachées à un **groupe de matières** (`GroupeMatiere` : Littéraire, Scientifique, Divers…)
- **`Matiere` ne porte pas de coefficient par défaut.** Le coefficient n'existe qu'au niveau de `MatiereClasse.coefficient` : il n'a de sens que dans le contexte d'une affectation classe / matière / enseignant
- Affectation d'une matière à une classe avec un enseignant assigné et un coefficient spécifique à cette affectation (`matiere_classe`)

> **Remarque :** `MatiereClasse` est la table pivot centrale — elle seule porte le coefficient réellement utilisé pour tous les calculs de moyenne.

---

---

## 📋 Modules Bulletins de Notes (Cœur Métier)

---

### 👨‍👩‍👧 6. Parents

**Fichiers concernés :** `api/parent/`, `models/parent.py`

Gère le référentiel des parents/tuteurs, rattachés à un établissement.

**Fonctionnalités :**
- Création de fiches parents (nom, prénom, téléphone, email unique), rattachées à l'établissement
- Un parent peut avoir plusieurs enfants (`Eleve`) inscrits dans l'établissement
- Le rattachement d'un élève à un parent est **obligatoire** (contrainte `parent_id IS NOT NULL`)

---

### 👦 7. Gestion des Élèves & Inscriptions

**Fichiers concernés :** `api/eleve/`, `models/eleve.py`, `models/inscription.py`, `services/eleve_service.py`

Gère le référentiel élèves et leur rattachement aux classes, pour chaque établissement.

**Fonctionnalités :**
- Création de fiches élèves avec matricule unique par établissement, données civiles (nom, prénom, sexe, date et lieu de naissance) et rattachement obligatoire à un parent
- Upload de la **photo 4x4** de l'élève (redimensionnement automatique via Pillow)
- **Inscription** d'un élève dans une classe pour une année scolaire donnée (unicité élève / classe / année)
- Suivi du statut de l'élève (Actif / Inactif) et du statut d'inscription (Actif par défaut, Transféré…)
- Un élève peut être réinscrit dans une nouvelle classe chaque année, toujours au sein du même établissement

---

### ✏️ 8. Saisie des Notes

**Fichiers concernés :** `api/note/`, `models/note.py`, `services/note_service.py`, `services/import_service.py`

Permet la saisie et la gestion des évaluations par séquence, rattachées à l'inscription de l'élève (et non directement à l'élève).

**Fonctionnalités :**
- Saisie manuelle des notes par matière-classe et par séquence (note sur 20, valeur comprise entre 0 et 20)
- Gestion de l'absence lors d'une évaluation (flag `absent`)
- **Import en masse** depuis un fichier Excel (via OpenPyXL)
- Unicité garantie : une seule note par inscription / matière-classe / séquence
- Horodatage automatique de chaque saisie (`saisie_le`)

**Règle de calcul :**
```
moyenne_matiere = Σ(notes des séquences) / nombre de séquences renseignées
```

---

### 📊 9. Calcul & Génération des Bulletins

**Fichiers concernés :** `api/bulletin/`, `services/bulletin_service.py`, `services/pdf_service.py`

> ⚠️ **Le bulletin n'est pas une entité persistée en base.** Il n'existe ni table `bulletin` ni `bulletin_ligne` dans le modèle de données. Le bulletin est **calculé à la demande** à partir des données de `Note` (jointes à `Inscription`, `MatiereClasse`, `Sequence`), puis exporté directement en PDF. Rien n'est stocké côté résultats de calcul (moyennes, rangs, mentions, décisions) — tout est recalculé à chaque génération.

**Fonctionnalités (calculées à la volée, non stockées) :**

#### Calcul automatique
- **Moyenne par matière** : calculée sur les séquences disponibles pour l'inscription concernée
- **Moyenne générale** : moyenne pondérée par les coefficients (`MatiereClasse.coefficient`)
  ```
  moyenne_annuelle = Σ(moyenne_matiere × coefficient) / Σ(coefficients)
  ```
- **Rang dans la classe** et **rang par matière** : calculés dynamiquement à chaque génération, en comparant les moyennes des élèves de la classe

#### Grille des appréciations par matière
| Code | Signification | Seuil |
|------|--------------|-------|
| `NA` | Non Acquis | < 5/20 |
| `ECA` | En Cours d'Acquisition | 5 – 9,99/20 |
| `A` | Acquis | 10 – 14,99/20 |
| `A+` | Expert | ≥ 15/20 |

#### Grille des mentions (bulletin global)
| Mention | Seuil |
|---------|-------|
| Médiocre | < 10/20 |
| Passable | 10 – 11,99/20 |
| Assez Bien | 12 – 13,99/20 |
| Bien | 14 – 15,99/20 |
| Très Bien | ≥ 16/20 |

#### Décisions de conseil de classe
| Décision | Condition |
|----------|-----------|
| **Admis** | Moyenne ≥ 10/20 |
| **Rattrapage** | Moyenne entre 8 et 9,99/20 |
| **Redoublant** | Moyenne < 8/20 |

#### Génération PDF
- Bulletin mis en page via un **template HTML** (`bulletin_francophone.html`) et converti en PDF avec **WeasyPrint**, à la demande (pas de version stockée à l'avance)
- Téléchargement direct depuis l'interface
- Stockage du **fichier PDF généré** (résultat final uniquement, pas de données de calcul) : `storage/bulletins/{etablissement_id}/{annee}/{matricule}_bulletin.pdf`

---

### 🚨 10. Discipline

**Fichiers concernés :** `api/discipline/`, `models/discipline.py`, `services/discipline_service.py`

Suivi du comportement et de l'assiduité des élèves, rattaché à l'inscription et à la séquence.

**Fonctionnalités :**
- Enregistrement des absences justifiées et non justifiées (en heures)
- Comptage des retards et des exclusions
- Observations textuelles du titulaire de classe
- Unicité garantie : un seul enregistrement discipline par inscription et par séquence
- Ces données apparaissent sur le bulletin de l'élève

---

---

## 💰 Module Paiements de Scolarité

---

### 11. Gestion des Paiements

**Fichiers concernés :** `api/paiement/`, `models/paiement.py`, `models/tranche_paiement.py`, `services/paiement_service.py`, `services/pdf_service.py`

Gère la collecte et le suivi des frais de scolarité, rattachés à l'inscription de l'élève.

**Fonctionnalités :**

#### Tranches de paiement (`tranche_paiement`)
- Chaque établissement définit ses propres tranches par année scolaire (ex : Tranche 1 en octobre, Tranche 2 en janvier, Tranche 3 en avril)
- Chaque tranche a un montant attendu (strictement positif) et une date limite

#### Enregistrement des paiements (`paiement`)
- Saisie de chaque versement effectué, rattaché à une inscription et à une tranche (montant strictement positif, date, mode de paiement)
- Calcul automatique du **solde restant dû**
- Gestion des **alertes** pour les élèves en retard de paiement

#### Reçus de paiement PDF
- Génération d'un **reçu officiel** en PDF pour chaque paiement (via WeasyPrint)
- Template : `recu_paiement.html`
- Stockage : `storage/recus/{etablissement_id}/`

---

---

## 🗓️ Module Emploi du Temps

---

### 12. Créneaux Horaires & Emploi du Temps

**Fichiers concernés :** `api/horaire/`, `models/creneau_horaire.py`, `models/horaire.py`, `services/horaire_service.py`

Gère la planification hebdomadaire des cours, par établissement et par année scolaire.

**Fonctionnalités :**
- Définition des **créneaux horaires** (`CreneauHoraire`) : libellé, heure de début, heure de fin, ordre d'affichage — communs à l'établissement
- Placement des cours (`Horaire`) : pour chaque `MatiereClasse`, sur un jour de la semaine (Lundi à Samedi) et un créneau, avec salle assignée, pour une année scolaire donnée
- `classe_id` et `enseignant_id` ne sont **pas dupliqués** sur `Horaire` : ils sont accessibles via la jointure avec `MatiereClasse`
- Unicité garantie : pas deux cours pour la même matière-classe sur le même jour/créneau/année
- La **détection des collisions** (classe ou enseignant déjà occupé sur un créneau) est gérée côté application, via une requête joignant `Horaire → MatiereClasse` avant chaque insertion ou génération d'emploi du temps

---

## Modules Support & Infrastructure

### 13. Authentification & Sécurité

**Fichiers :** `api/auth/`, `services/auth_service.py`, `middlewares/auth_middleware.py`, `models/utilisateur.py`, `models/role.py`, `models/super_admin.py`

- Connexion sécurisée par **JWT** (Access Token généré à la volée à chaque login/refresh et vérifié via sa signature — non stocké ; seul le **hash du refresh token**, longue durée, est persisté pour permettre sa révocation)
- Deux types de comptes bien distincts :
  - **`Utilisateur`** : personnel et parents rattachés à un établissement (`etablissement_id` obligatoire), avec un rôle (`role_id`). Rôles disponibles : **Admin, Proviseur, Censeur, Surveillant, Secretaire, Comptable, Infirmier, Enseignant, Parent**
  - **`SuperAdmin`** : compte d'administration globale de la plateforme, **indépendant de tout établissement** (pas d'`etablissement_id`). Gère les établissements eux-mêmes et la configuration générale de l'application
- Unicité de l'email par établissement pour `Utilisateur` (`etablissement_id`, `email`) ; unicité globale de l'email pour `SuperAdmin`
- Middleware de vérification sur toutes les routes protégées, avec filtrage systématique par `etablissement_id` pour tout `Utilisateur` — seul le `SuperAdmin` opère de façon transversale sur l'ensemble des établissements

---

### 14. Notifications

**Fichiers :** `services/notification_service.py`

- Envoi d'**emails** aux parents (via SMTP)
- Envoi de **SMS** via l'API d'un opérateur camerounais (Orange API)
- Cas d'usage : bulletin disponible, retard de paiement, absence excessive

> Ce service n'a pas de modèle de données dédié dans le diagramme de classes : il consomme les données des autres modules (élève, parent, paiement…) sans persister d'état propre.

---

### 15. Import / Export

**Fichiers :** `services/import_service.py`, `services/export_service.py`

- **Import Excel** : notes saisies par les enseignants hors connexion, réintégrées en masse
- **Export Excel** : statistiques de classe, listes d'élèves, récapitulatifs de paiements
- **Export PDF** : bulletins (calculés à la demande) et reçus de paiement

---

### 16. Administration SaaS

**Fichiers concernés :** `api/superadmin/`, `models/abonnement.py`, `services/abonnement_service.py`

Module réservé au **SuperAdmin**, permettant de piloter l'ensemble de la plateforme multi-établissements.

**Fonctionnalités :**
- Supervision globale de tous les établissements clients de la plateforme
- Gestion des **abonnements** (plans, tarification, cycle de facturation)
- Gestion des **quotas** par établissement (nombre d'élèves, nombre d'utilisateurs, espace de stockage…)
- Activation, suspension ou suppression d'un établissement client
- Tableau de bord global multi-écoles (statistiques d'usage, établissements actifs, etc.)

> Comme pour les Notifications, ce module de facturation/quotas (`Abonnement`) n'apparaît pas dans le diagramme de classes fourni — il reste à modéliser ou est géré ailleurs dans le code.

---

## Schéma des dépendances entre modules clés

```
Plateforme SaaS (SuperAdmin — hors etablissement_id)
    └── Établissement #1 ── Établissement #2 ── Établissement #N
              │
              ├── Année Scolaire
              │       └── Trimestre
              │               └── Séquence
              │
              ├── Cycle ── Classe
              │               ├── MatiereClasse (Matière × Enseignant × Coefficient)
              │               ├── TitulaireClasse (Enseignant titulaire)
              │               └── Horaire (via MatiereClasse + CreneauHoraire)
              │
              ├── Parent ── Eleve (obligatoire)
              │                └── Inscription (Élève × Classe × Année)
              │                        ├── Note (× MatiereClasse × Séquence)
              │                        │       └── → Bulletin (calculé à la demande, non stocké)
              │                        ├── Discipline (× Séquence)
              │                        └── Paiement (× TranchePaiement)
              │
              └── Utilisateur (Admin, Proviseur, Censeur, Surveillant,
                                Secretaire, Comptable, Infirmier,
                                Enseignant, Parent)
```

*(Chaque branche « Établissement » est totalement isolée des autres : aucune donnée n'est partagée entre établissements, hormis la supervision globale du SuperAdmin.)*

---

*Document généré à partir de l'arborescence backend et du modèle relationnel du projet (`diagrammes_classes.puml`) — architecture multi-tenant / SaaS multi-établissements / MySQL.*
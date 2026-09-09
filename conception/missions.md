# Fiches de Mission par Acteur — Application Bulletins de Notes

> Document dérivé du résumé fonctionnel du projet (`resume.md`).
> Chaque fiche décrit le rôle, les responsabilités clés et les actions principales (CRUD) de l'acteur sur les entités du système.
> Rappel : tous les rôles « Utilisateur » sont rattachés à un `etablissement_id` et n'opèrent que sur les données de leur propre établissement, à l'exception du **SuperAdmin**.

---

## 1. SuperAdmin

**Portée :** Globale, transversale à tous les établissements (aucun `etablissement_id`)

**Responsabilités clés :**
- Superviser l'ensemble de la plateforme SaaS multi-établissements
- Créer, configurer, activer, suspendre ou supprimer un établissement client
- Gérer les abonnements (plans, tarification, cycle de facturation)
- Gérer les quotas par établissement (élèves, utilisateurs, stockage)
- Consulter le tableau de bord global multi-écoles (statistiques d'usage)

**Actions CRUD principales :**
- **Créer / Modifier / Supprimer** : Établissements, Abonnements, Quotas
- **Lire** : Statistiques globales, liste de tous les établissements

---

## 2. Admin (établissement)

**Portée :** Un seul établissement (`etablissement_id`)

**Responsabilités clés :**
- Configurer l'établissement (informations générales, logo)
- Gérer les comptes utilisateurs de l'établissement (créer les comptes Proviseur, Censeur, Surveillant, Secrétaire, Comptable, Infirmier, Enseignant) et leurs rôles
- Piloter la structure pédagogique : années scolaires, trimestres, séquences, cycles, classes
- Superviser l'ensemble des modules de son établissement

**Actions CRUD principales :**
- **Créer / Modifier / Supprimer** : Utilisateurs, Années scolaires, Trimestres, Séquences, Cycles, Classes
- **Lire** : Toutes les données de l'établissement

---

## 3. Proviseur

**Portée :** Un seul établissement

**Responsabilités clés :**
- Assurer la direction pédagogique générale de l'établissement
- Valider les décisions de conseil de classe (admis, rattrapage, redoublant)
- Superviser la génération et la diffusion des bulletins
- Suivre les indicateurs globaux de l'établissement (résultats, effectifs, discipline)

**Actions CRUD principales :**
- **Lire** : Bulletins, moyennes, rangs, statistiques de classe et d'établissement
- **Modifier** (validation) : Décisions de conseil de classe
- **Lire** : Emplois du temps, dossiers enseignants et élèves

---

## 4. Censeur

**Portée :** Un seul établissement

**Responsabilités clés :**
- Superviser la vie pédagogique et l'organisation des enseignements
- Piloter l'affectation des enseignants titulaires par classe (`TitulaireClasse`)
- Coordonner l'emploi du temps et la répartition des matières par classe (`MatiereClasse`)
- Contrôler la cohérence des coefficients et des programmes
- **Générer les bulletins des classes dont il est titulaire** (au même titre qu'un enseignant titulaire de classe)

**Actions CRUD principales :**
- **Créer / Modifier** : Affectations enseignant-classe-matière, coefficients, emploi du temps
- **Lire** : Résultats pédagogiques, taux de couverture des programmes
- **Générer** : Bulletins PDF des classes dont il est titulaire

---

## 5. Surveillant

**Portée :** Un seul établissement

**Responsabilités clés :**
- Suivre l'assiduité et la discipline des élèves au quotidien
- Enregistrer les absences justifiées et non justifiées, les retards, les exclusions
- Rédiger les observations disciplinaires par élève et par séquence
- Alimenter les données de discipline visibles sur le bulletin

**Actions CRUD principales :**
- **Créer / Modifier** : Enregistrements de discipline (absences, retards, exclusions, observations)
- **Lire** : Listes de classes, inscriptions, séquences en cours

---

## 6. Secrétaire

**Portée :** Un seul établissement

**Responsabilités clés :**
- Gérer les inscriptions et réinscriptions des élèves
- Créer et maintenir les fiches élèves (état civil, photo, matricule) et fiches parents
- Assurer le rattachement obligatoire élève-parent
- Suivre les statuts des élèves et des inscriptions (actif, inactif, transféré)

**Actions CRUD principales :**
- **Créer / Modifier / Supprimer** : Élèves, Parents, Inscriptions
- **Lire** : Classes, effectifs, dossiers administratifs

---

## 7. Comptable

**Portée :** Un seul établissement

**Responsabilités clés :**
- Définir les tranches de paiement de scolarité par année scolaire
- Enregistrer les versements effectués par les familles
- Suivre les soldes restants dus et gérer les alertes de retard de paiement
- Générer et transmettre les reçus de paiement officiels (PDF)

**Actions CRUD principales :**
- **Créer / Modifier** : Tranches de paiement, Paiements
- **Lire** : Soldes, historiques de paiement, reçus
- **Générer** : Reçus PDF, exports Excel des paiements

---

## 8. Infirmier

**Portée :** Un seul établissement

**Responsabilités clés :**
- Assurer le suivi sanitaire des élèves au sein de l'établissement
- Signaler les cas médicaux ou absences liées à la santé pouvant impacter la discipline ou l'assiduité

**Actions CRUD principales :**
- **Lire** : Fiches élèves, données de discipline (absences)

> ⚠️ **Remarque :** ce rôle est prévu dans le système d'authentification (liste des rôles `Utilisateur`), mais aucun module métier dédié (modèle, API, service « infirmerie ») n'apparaît dans le résumé fonctionnel actuel. Ses missions précises restent à définir/modéliser.

---

## 9. Enseignant

**Portée :** Un seul établissement, limité aux classes et matières qui lui sont affectées

**Responsabilités clés :**
- Saisir les notes des élèves par matière-classe et par séquence
- Importer des notes en masse depuis un fichier Excel
- Signaler les absences des élèves lors des évaluations
- Consulter son emploi du temps et les classes dont il est titulaire ou intervenant
- Rédiger les observations de discipline s'il est titulaire de classe

**Actions CRUD principales :**
- **Créer / Modifier** : Notes (par inscription, matière-classe, séquence)
- **Lire** : Emploi du temps, listes de classe, moyennes de ses matières
- **Importer** : Notes via fichier Excel

---

## 10. Parent

**Portée :** Un seul établissement, limité à ses propres enfants (`Eleve` rattachés)

**Responsabilités clés :**
- Consulter les bulletins de notes de ses enfants (téléchargement PDF)
- Suivre la situation financière (paiements effectués, solde restant dû, reçus)
- Recevoir les notifications (email/SMS) : bulletin disponible, retard de paiement, absence excessive
- Mettre à jour ses coordonnées de contact

**Actions CRUD principales :**
- **Lire** : Bulletins, notes, discipline, historique de paiement de ses enfants
- **Modifier** : Ses propres coordonnées (téléphone, email)

---

## Synthèse — Vue d'ensemble par module

| Module | Acteur(s) principal(aux) |
|---|---|
| Établissements, Abonnements, Quotas | SuperAdmin |
| Utilisateurs, Structure pédagogique (années/cycles/classes) | Admin |
| Décisions de conseil de classe, supervision globale | Proviseur |
| Affectations enseignant-classe-matière, emploi du temps, bulletins des classes dont il est titulaire | Censeur |
| Discipline, assiduité | Surveillant |
| Élèves, Parents, Inscriptions | Secrétaire |
| Tranches de paiement, Paiements, Reçus | Comptable |
| Suivi sanitaire (module non formalisé) | Infirmier |
| Notes, import Excel | Enseignant |
| Consultation bulletins, paiements, notifications | Parent |

---

*Document généré à partir de `resume.md` — le fichier `missions.md` fourni était vide et n'a pas pu être utilisé comme base.*
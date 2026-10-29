(function () {
  "use strict";

  /* ═══════════════════════════════════════════════
     CONFIGURATION DU MENU
     Modifier ici pour ajouter / retirer des entrées.
     "key" correspond à la valeur de data-page="..." sur la page cible.

     ⚠️ Chaque "href" ci-dessous correspond à une route réellement
     enregistrée dans app.py au moment de cette révision :
       /dashboard                    → dashboard_etablissement
       /configuration                → configuration_etablissement
       /matiere                      → matiere_etablissement
       /enseignant                   → enseignant_etablissement
       /emploi-du-temps              → emploi_du_temps_etablissement
       /eleves                       → eleves_etablissement
       /parents                      → parents_etablissement
       /inscriptions                 → inscriptions_etablissement
       /paiements                    → paiements_etablissement
       /pedagogie                    → pedagogie_censeur
       /emploi-du-temps-censeur      → emploi_du_temps_censeur
       /emploi-du-temps-surveillant  → emploi_du_temps_surveillant
       /censeur/notes                → censeur_notes_page
       /censeur/bulletin             → censeur_bulletin_page
       /surveillant/notes            → surveillant_notes_page
       /surveillant/bulletin         → surveillant_bulletin_page
       /superadmin/dashboard         → superadmin_dashboard_page
       /superadmin/etablissements    → superadmin_etablissements_page
       /change-password              → change_password_page
     Si tu ajoutes une route dans app.py, ajoute l'entrée correspondante
     ici ; si tu retires une entrée d'ici, vérifie qu'aucune page ne pointe
     encore dessus.

     ⚠️ ROUTES MANQUANTES : la section "Enseignant" plus bas pointe vers
     /enseignant/dashboard, /enseignant/notes, /enseignant/horaires,
     /enseignant/communiques et /enseignant/primes — AUCUNE de ces routes
     n'existe dans app.py à ce jour (seule /enseignant existe, et c'est la
     page Admin de gestion des comptes enseignants, pas un portail dédié).
     Ces liens mèneront à une 404 tant que les routes + templates + blueprint
     correspondants ne sont pas ajoutés côté back.
  ════════════════════════════════════════════════ */
  const MENU = [
    /* ── Tableau de bord (une seule des deux entrées est visible : elles
           partagent la même "key" pour que data-page="dashboard" fonctionne
           quel que soit le rôle connecté) ── */
    {
      section: null,
      items: [
        {
          key: "dashboard",
          label: "Tableau de bord",
          icon: "fa-gauge-high",
          href: "/dashboard",
          roles: ["Admin"],
        },
        {
          key: "dashboard",
          label: "Tableau de bord",
          icon: "fa-gauge-high",
          href: "/superadmin/dashboard",
          roles: ["SuperAdmin"],
        },
        {
          /* ⚠️ Route supposée (/enseignant/dashboard) en l'absence de
             confirmation dans app.py — à ajuster si la route réelle diffère. */
          key: "dashboard",
          label: "Tableau de bord",
          icon: "fa-gauge-high",
          href: "/enseignant/dashboard",
          roles: ["Enseignant"],
        },
      ],
    },

    /* ── Pédagogie (compte Admin uniquement) ── */
    {
      section: "Pédagogie",
      items: [
        {
          key: "matieres",
          label: "Matières",
          icon: "fa-book-open",
          href: "/matiere",
          roles: ["Admin"],
        },
        {
          key: "enseignants",
          label: "Enseignants",
          icon: "fa-user-tie",
          href: "/enseignant",
          roles: ["Admin"],
        },
      ],
    },

    /* ── Inscriptions (compte Admin uniquement) ── */
    {
      section: "Inscriptions",
      items: [
        {
          key: "eleve",
          label: "Élèves",
          icon: "fa-user-graduate",
          href: "/eleves",
          roles: ["Admin"],
        },
        {
          key: "parent",
          label: "Parents",
          icon: "fa-user-friends",
          href: "/parents",
          roles: ["Admin"],
        },
        {
          key: "inscription",
          label: "Inscriptions",
          icon: "fa-user-plus",
          href: "/inscriptions",
          roles: ["Admin"],
        },
      ],
    },

    /* ── Horaires (compte Admin uniquement) ── */
    {
      section: "Horaires",
      items: [
        {
          key: "horaire",
          label: "Emploi du temps",
          icon: "fa-calendar-days",
          href: "/emploi-du-temps",
          roles: ["Admin"],
        },
      ],
    },

    /* ── Finances (compte Admin d'établissement + Comptable) — pointe vers
           paiements.html (data-page="paiements"). roles aligné sur
           ROLES_ACCES_PAIEMENTS dans paiements_api.py (Admin, SuperAdmin,
           Comptable) : SuperAdmin volontairement exclu ici, comme pour les
           autres sections cloisonnées par établissement ci-dessus
           (Pédagogie/Inscriptions/Horaires/Configuration) — son propre menu
           reste limité à la section "Super Administration" plus bas. ── */
    {
      section: "Finances",
      items: [
        {
          key: "paiements",
          label: "Paiements",
          icon: "fa-sack-dollar",
          href: "/paiements",
          roles: ["Admin", "Comptable"],
        },
      ],
    },

    /* ── Configuration (compte Admin uniquement) ── */
    {
      section: "Configuration",
      items: [
        {
          key: "config",
          label: "Configuration",
          icon: "fa-gear",
          href: "/configuration",
          roles: ["Admin"],
        },
      ],
    },

    /* ── Pédagogie (Censeur / Surveillant) — une seule route /pedagogie,
           partagée par les deux rôles (contrairement à Horaires/Notes
           ci-dessous qui ont chacun leurs propres routes -censeur/
           -surveillant) : un seul item, deux rôles autorisés. ── */
    {
      section: "Pédagogie",
      items: [
        {
          key: "pedagogie-censeur",
          label: "Pédagogie",
          icon: "fa-people-arrows",
          href: "/pedagogie",
          roles: ["Censeur", "Surveillant"],
        },
      ],
    },

    /* ── Horaires (Censeur / Surveillant) — routes distinctes par rôle,
           même "key" (même template censeur/horaire.html, cf. app.py) pour
           que la surbrillance fonctionne quel que soit le rôle connecté. ── */
    {
      section: "Horaires",
      items: [
        {
          key: "horaire-censeur",
          label: "Emploi du temps",
          icon: "fa-calendar-days",
          href: "/emploi-du-temps-censeur",
          roles: ["Censeur"],
        },
        {
          key: "horaire-censeur",
          label: "Emploi du temps",
          icon: "fa-calendar-days",
          href: "/emploi-du-temps-surveillant",
          roles: ["Surveillant"],
        },
      ],
    },

    /* ── Notes (Censeur / Surveillant) — regroupe "Notes & discipline"
           (censeur/notes.html) et "Bulletins" (censeur/bulletin.html),
           chacun avec ses deux routes par rôle. Les "key" DOIVENT
           correspondre exactement aux data-page posés sur le <body> de ces
           templates ("censeur-notes" / "censeur-bulletin", cf.
           getActivePage()), sans quoi la surbrillance du menu ne
           fonctionnerait pas. Le lien "Bulletins" mène directement à
           /censeur/bulletin (ou /surveillant/bulletin) SANS paramètre de
           classe : bulletin.html doit donc être capable de démarrer sans
           query string (ex. présélectionner la première classe assignée,
           comme le fait déjà notes.html pour son propre filtre "Classe") —
           à vérifier/ajuster côté template si ce n'est pas déjà le cas. ── */
    {
      section: "Notes",
      items: [
        {
          key: "censeur-notes",
          label: "Notes & discipline",
          icon: "fa-clipboard-list",
          href: "/censeur/notes",
          roles: ["Censeur"],
        },
        {
          key: "censeur-notes",
          label: "Notes & discipline",
          icon: "fa-clipboard-list",
          href: "/surveillant/notes",
          roles: ["Surveillant"],
        },
        {
          key: "censeur-bulletin",
          label: "Bulletins",
          icon: "fa-file-lines",
          href: "/censeur/bulletin",
          roles: ["Censeur"],
        },
        {
          key: "censeur-bulletin",
          label: "Bulletins",
          icon: "fa-file-lines",
          href: "/surveillant/bulletin",
          roles: ["Surveillant"],
        },
      ],
    },

    /* ── Enseignant (compte Enseignant uniquement) — routes désormais
           enregistrées dans app.py, cf. routes /enseignant/... ── */

    /* Pédagogie */
    {
      section: "Pédagogie",
      items: [
        {
          key: "notes",
          label: "Notes",
          icon: "fa-clipboard-list",
          href: "/enseignant/notes",
          roles: ["Enseignant"],
        },
      ],
    },

    /* Horaires */
    {
      section: "Horaires",
      items: [
        {
          key: "horaire",
          label: "Horaires",
          icon: "fa-calendar-days",
          href: "/enseignant/emploi-du-temps",
          roles: ["Enseignant"],
        },
      ],
    },

    /* Communication */
    {
      section: "Communication",
      items: [
        {
          key: "communique",
          label: "Communiqués",
          icon: "fa-bullhorn",
          href: "/enseignant/communiques",
          roles: ["Enseignant"],
        },
      ],
    },

    /* Finances */
    {
      section: "Finances",
      items: [
        {
          key: "primes",
          label: "Primes",
          icon: "fa-sack-dollar",
          href: "/enseignant/primes",
          roles: ["Enseignant"],
        },
      ],
    },

    /* Compte */
    {
      section: "Compte",
      items: [
        {
          key: "logout",
          label: "Déconnexion",
          icon: "fa-right-from-bracket",
          href: "#",
          roles: ["Enseignant"],
          logout: true,
        },
      ],
    },

    /* ── Super Administration (compte SuperAdmin uniquement) ── */
    {
      section: "Super Administration",
      items: [
        {
          key: "superadmin-etablissements",
          label: "Établissements",
          icon: "fa-school",
          href: "/superadmin/etablissements",
          roles: ["SuperAdmin"],
        },
      ],
    },
  ];

  /* ═══════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════════ */

  /** Un item est visible si : pas de "roles" défini, OU le rôle courant
   *  figure dans sa liste "roles". */
  function isVisibleForRole(item, role) {
    return !item.roles || item.roles.includes(role);
  }

  /** Filtre récursivement un groupe de menu selon le rôle courant, en
   *  retirant aussi les sous-menus devenus vides. */
  function filterMenuForRole(menu, role) {
    return menu
      .map((group) => {
        const items = group.items.filter((item) => isVisibleForRole(item, role));
        return { ...group, items };
      })
      .filter((group) => group.items.length > 0);
  }

  /** Normalise un chemin pour comparaison (retire query string, fragment,
   *  barre oblique finale). */
  function normalizePath(path) {
    if (!path) return "";
    const clean = path.split("?")[0].split("#")[0].replace(/\/+$/, "");
    return clean === "" ? "/" : clean;
  }

  /** Aplatit le MENU (items + sous-menus, tous rôles confondus) en une
   *  liste plate { key, href } pour pouvoir retrouver la clé associée à
   *  l'URL couramment affichée. */
  function flattenMenuItems(menu) {
    const flat = [];
    menu.forEach((group) => {
      group.items.forEach((item) => {
        if (item.href) flat.push({ key: item.key, href: item.href });
        if (item.submenu) {
          item.submenu.forEach((sub) => {
            if (sub.href) flat.push({ key: sub.key, href: sub.href });
          });
        }
      });
    });
    return flat;
  }

  /** Retrouve la clé de menu dont le href correspond au chemin donné. */
  function findKeyByPathname(pathname) {
    const target = normalizePath(pathname);
    const match = flattenMenuItems(MENU).find(
      (entry) => normalizePath(entry.href) === target
    );
    return match ? match.key : "";
  }

  /** Retourne la page active. Ordre de priorité :
   *   1. data-page sur <body>/<main> si le template le définit explicitement
   *      (le plus fiable quand il est présent).
   *   2. L'URL couramment affichée, comparée aux "href" du menu — ne dépend
   *      d'aucun attribut à poser côté template, donc fonctionne même si
   *      data-page est absent ou mal renseigné sur une page donnée (c'était
   *      le cas pour /eleves, /parents, /inscriptions).
   *   3. En dernier recours, la clé mémorisée au clic précédent en
   *      sessionStorage. */
  function getActivePage() {
    const domPage =
      document.body.dataset.page || document.querySelector("main")?.dataset.page;
    if (domPage) {
      try {
        sessionStorage.setItem("sidebarActiveKey", domPage);
      } catch (e) {
        /* sessionStorage indisponible (mode privé, etc.) : on ignore */
      }
      return domPage;
    }

    const keyFromUrl = findKeyByPathname(window.location.pathname);
    if (keyFromUrl) {
      try {
        sessionStorage.setItem("sidebarActiveKey", keyFromUrl);
      } catch (e) {
        /* sessionStorage indisponible : on ignore */
      }
      return keyFromUrl;
    }

    try {
      return sessionStorage.getItem("sidebarActiveKey") || "";
    } catch (e) {
      return "";
    }
  }

  /** Construit le HTML d'un lien de sous-menu. */
  function buildSubmenuItem(sub, activePage) {
    const isActive = activePage === sub.key ? " active" : "";
    return `<li class="nav-item">
      <a class="nav-link${isActive}" href="${sub.href}" data-key="${sub.key}">${sub.label}</a>
    </li>`;
  }

  /** Construit le HTML d'un item de menu (avec ou sans sous-menu). */
  function buildMenuItem(item, activePage) {
    const hasSubmenu = item.submenu && item.submenu.length > 0;

    /* Vérifier si l'item ou l'un de ses enfants est actif */
    const isSelfActive = activePage === item.key;
    const isChildActive =
      hasSubmenu && item.submenu.some((s) => s.key === activePage);
    const isActive = isSelfActive || isChildActive;

    const activeClass = isActive ? " active" : "";
    const expandedAttr = isActive && hasSubmenu ? ' aria-expanded="true"' : ' aria-expanded="false"';

    /* Badge optionnel */
    const badgeHtml = item.badge
      ? `<span class="nav-badge">${item.badge}</span>`
      : "";

    /* Chevron pour les sous-menus */
    const chevronHtml = hasSubmenu
      ? `<i class="fa-solid fa-chevron-down nav-chevron"></i>`
      : "";

    if (!hasSubmenu) {
      const logoutAttr = item.logout ? ' data-logout="true"' : "";
      return `<li class="nav-item">
        <a class="nav-link${activeClass}" href="${item.href}" data-key="${item.key}"${logoutAttr}>
          <span class="nav-icon"><i class="fa-solid ${item.icon}"></i></span>
          <span class="nav-label">${item.label}</span>
          ${badgeHtml}
        </a>
      </li>`;
    }

    /* Avec sous-menu */
    const submenuId = `submenu-${item.key}`;
    const submenuShow = isActive ? " show" : "";
    const submenuHtml = item.submenu.map((s) => buildSubmenuItem(s, activePage)).join("");

    return `<li class="nav-item">
      <button class="nav-link${activeClass}" ${expandedAttr}
              data-submenu="${submenuId}" type="button">
        <span class="nav-icon"><i class="fa-solid ${item.icon}"></i></span>
        <span class="nav-label">${item.label}</span>
        ${badgeHtml}
        ${chevronHtml}
      </button>
      <ul class="nav-submenu${submenuShow}" id="${submenuId}">
        ${submenuHtml}
      </ul>
    </li>`;
  }

  /** Construit le HTML d'un groupe de menu (section + items). */
  function buildMenuGroup(group, activePage) {
    const sectionHtml = group.section
      ? `<li><p class="section-label">${group.section}</p></li>`
      : "";
    const itemsHtml = group.items.map((i) => buildMenuItem(i, activePage)).join("");
    return `${sectionHtml}${itemsHtml}`;
  }

  /** Construit l'objet utilisateur { nom, role, avatar } à partir de la
   *  session mise en cache par auth.js (GestionnaireAuth.getUser()).
   *
   *  ⚠️ auth.js n'expose PAS de méthode isAuthenticated() (voir son objet
   *  exporté : getUser, getRole, getEtablissementId, checkSession,
   *  requireAuth, logout, authFetch) — l'appeler plantait ici sur toutes
   *  les pages. L'absence d'utilisateur en cache se détecte simplement par
   *  GestionnaireAuth.getUser() qui renvoie null. */
  function getCurrentUser() {
    const stored = window.GestionnaireAuth ? GestionnaireAuth.getUser() : null;
    if (!stored) {
      return { nom: "Utilisateur", role: "", avatar: null };
    }

    const role = (window.GestionnaireAuth && GestionnaireAuth.getRole())
      || (stored.role && stored.role.libelle)
      || "";
    const nomComplet = `${stored.prenom || ""} ${stored.nom || ""}`.trim() || stored.nom || "Utilisateur";

    return {
      nom: nomComplet,
      role: role,
      avatar: stored.avatar_url || stored.avatar || null,
    };
  }

  /** Construit l'avatar (img ou initiales). */
  function buildAvatar(user, cssClass, size) {
    if (user.avatar) {
      return `<img src="${user.avatar}" alt="${user.nom}"
               class="${cssClass}" width="${size}" height="${size}">`;
    }
    const initials = user.nom
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
    return `<div class="${cssClass} eleve-avatar-placeholder"
                 style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;">
               ${initials}
             </div>`;
  }

  /* ═══════════════════════════════════════════════
     TEMPLATE HTML
  ════════════════════════════════════════════════ */

  function buildSidebarHTML() {
    const activePage = getActivePage();
    const user = getCurrentUser();
    const visibleMenu = filterMenuForRole(MENU, user.role);

    const navHTML = visibleMenu.map((g) => buildMenuGroup(g, activePage)).join("");
    const avatarHTML = buildAvatar(user, "sidebar-user-avatar", 34);

    // /change-password existe pour tout compte d'établissement (Utilisateur),
    // pas pour le SuperAdmin (modèle distinct, cf. authentification_models.py) :
    // on ne propose donc le lien qu'en dehors du rôle SuperAdmin.
    const changePasswordHtml = user.role && user.role !== "SuperAdmin"
      ? `<a href="/change-password" title="Changer mon mot de passe"
            style="color:var(--ta-text-light);font-size:14px;margin-left:8px;
                   transition:color var(--ta-transition);"
            onmouseover="this.style.color='var(--ta-primary)'"
            onmouseout="this.style.color='var(--ta-text-light)'">
           <i class="fa-solid fa-key"></i>
         </a>`
      : "";

    return `
    <!-- ── Overlay mobile ── -->
    <div class="sidebar-overlay" id="sidebarOverlay"></div>

    <!-- ── Sidebar ── -->
    <aside class="sidebar" id="appSidebar" role="navigation" aria-label="Menu principal">

      <!-- Logo -->
      <div class="sidebar-logo">
        <div style="
          width:32px;height:32px;
          background:var(--ta-primary);
          border-radius:var(--ta-radius-sm);
          display:flex;align-items:center;justify-content:center;
          flex-shrink:0;">
          <i class="fa-solid fa-graduation-cap" style="color:#fff;font-size:15px;"></i>
        </div>
        <span class="sidebar-logo-text">
          Gestionnaire<span>.</span>
        </span>
      </div>

      <!-- Zone de scroll / Navigation -->
      <div class="sidebar-scroll">
        <ul class="sidebar-nav">
          ${navHTML}
        </ul>
      </div>

      <!-- Pied de sidebar — utilisateur connecté -->
      <div class="sidebar-footer">
        <div class="sidebar-user">
          ${avatarHTML}
          <div class="sidebar-user-info">
            <div class="sidebar-user-name">${user.nom}</div>
            <div class="sidebar-user-role">${user.role}</div>
          </div>
          ${changePasswordHtml}
          <button type="button" id="sidebarLogoutBtn" title="Se déconnecter"
             style="margin-left:${changePasswordHtml ? "8px" : "auto"};background:none;border:none;cursor:pointer;
                    color:var(--ta-text-light);font-size:14px;
                    transition:color var(--ta-transition);"
             onmouseover="this.style.color='var(--ta-danger)'"
             onmouseout="this.style.color='var(--ta-text-light)'">
            <i class="fa-solid fa-right-from-bracket"></i>
          </button>
        </div>
      </div>
    </aside>`;
  }

  /* ═══════════════════════════════════════════════
     TOPBAR — barre sticky (optionnelle, injectée si
     #mainContent ne contient pas déjà .topbar)
  ════════════════════════════════════════════════ */

  function buildTopbarHTML() {
    const user = getCurrentUser();
    const avatarHTML = buildAvatar(user, "topbar-avatar", 34);

    return `
    <header class="topbar" role="banner">
      <!-- Bouton toggle sidebar -->
      <button class="topbar-toggle" id="sidebarToggle"
              aria-label="Ouvrir/Fermer le menu" type="button">
        <i class="fa-solid fa-bars"></i>
      </button>

      <!-- Recherche rapide -->
      <div class="topbar-search">
        <div class="input-group input-group-sm">
          <span class="input-group-text">
            <i class="fa-solid fa-magnifying-glass" style="font-size:12px;"></i>
          </span>
          <input type="search" class="form-control"
                 placeholder="Rechercher…"
                 aria-label="Recherche">
        </div>
      </div>

      <!-- Actions droite -->
      <div class="topbar-right">
        <!-- Séparateur -->
        <div style="width:1px;height:20px;background:var(--ta-border);margin:0 4px;"></div>

        <!-- Profil utilisateur -->
        ${avatarHTML}
        <div class="topbar-user-info">
          <span class="topbar-user-name">${user.nom}</span>
          <span class="topbar-user-role">${user.role}</span>
        </div>
      </div>
    </header>`;
  }

  /* ═══════════════════════════════════════════════
     STYLES — hover + surbrillance au clic/actif
     Injecté ici pour que l'effet fonctionne même si le
     CSS externe ne définit pas encore ces états.
  ════════════════════════════════════════════════ */

  function injectSidebarStyles() {
    if (document.getElementById("sidebarNavStateStyles")) return;

    const style = document.createElement("style");
    style.id = "sidebarNavStateStyles";
    style.textContent = `
      .sidebar-nav .nav-link {
        position: relative;
        cursor: pointer;
        transition: background-color var(--ta-transition, .2s ease),
                    color var(--ta-transition, .2s ease);
      }
      .sidebar-nav .nav-link:hover {
        background-color: rgba(var(--ta-primary-rgb, 37, 99, 235), 0.08);
        color: var(--ta-primary, #2563eb);
      }
      .sidebar-nav .nav-link:hover .nav-icon i {
        color: var(--ta-primary, #2563eb);
      }
      .sidebar-nav .nav-link.active {
        background-color: rgba(var(--ta-primary-rgb, 37, 99, 235), 0.12);
        color: var(--ta-primary, #2563eb);
        font-weight: 600;
      }
      .sidebar-nav .nav-link.active::before {
        content: "";
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        border-radius: 0 2px 2px 0;
        background: var(--ta-primary, #2563eb);
      }
      .sidebar-nav .nav-link.active .nav-icon i {
        color: var(--ta-primary, #2563eb);
      }
      .sidebar-nav .nav-submenu .nav-link.active {
        background-color: rgba(var(--ta-primary-rgb, 37, 99, 235), 0.08);
      }
    `;
    document.head.appendChild(style);
  }

  /* ═══════════════════════════════════════════════
     INJECTION
  ════════════════════════════════════════════════ */

  function inject() {
    const wrapper = document.querySelector(".app-wrapper");
    if (!wrapper) {
      console.warn("[sidebar.js] Élément .app-wrapper introuvable. Le sidebar ne peut pas être injecté.");
      return;
    }

    injectSidebarStyles();

    /* Injecter sidebar + overlay avant le .main-content */
    const mainContent = wrapper.querySelector(".main-content") || wrapper.querySelector("#mainContent");
    wrapper.insertAdjacentHTML("afterbegin", buildSidebarHTML());

    /* Injecter la topbar si elle n'existe pas déjà */
    if (mainContent && !mainContent.querySelector(".topbar")) {
      mainContent.insertAdjacentHTML("afterbegin", buildTopbarHTML());
    }
  }

  /* ═══════════════════════════════════════════════
     COMPORTEMENTS INTERACTIFS
  ════════════════════════════════════════════════ */

  function bindEvents() {
    const sidebar  = document.getElementById("appSidebar");
    const overlay  = document.getElementById("sidebarOverlay");
    const toggle   = document.getElementById("sidebarToggle");
    const mainContent = document.querySelector(".main-content") || document.getElementById("mainContent");

    if (!sidebar) return;

    /* ── Ouvrir / Fermer le sidebar ── */
    function openSidebar() {
      sidebar.classList.add("sidebar-open");
      overlay.classList.add("show");
    }

    function closeSidebar() {
      sidebar.classList.remove("sidebar-open");
      overlay.classList.remove("show");
    }

    function isDesktop() {
      return window.innerWidth > 991;
    }

    /* Toggle sur desktop : masquer/afficher avec translation */
    function toggleDesktop() {
      const hidden = sidebar.classList.toggle("sidebar-hidden");
      if (mainContent) {
        mainContent.classList.toggle("sidebar-collapsed", hidden);
      }
    }

    if (toggle) {
      toggle.addEventListener("click", () => {
        if (isDesktop()) {
          toggleDesktop();
        } else {
          sidebar.classList.contains("sidebar-open") ? closeSidebar() : openSidebar();
        }
      });
    }

    if (overlay) {
      overlay.addEventListener("click", closeSidebar);
    }

    /* Fermer avec Échap */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSidebar();
    });

    /* ── Sous-menus ── */
    sidebar.querySelectorAll("[data-submenu]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.submenu;
        const submenu = document.getElementById(targetId);
        if (!submenu) return;

        const isOpen = submenu.classList.contains("show");

        /* Fermer tous les sous-menus ouverts */
        sidebar.querySelectorAll(".nav-submenu.show").forEach((el) => {
          el.classList.remove("show");
          const parentBtn = sidebar.querySelector(`[data-submenu="${el.id}"]`);
          if (parentBtn) parentBtn.setAttribute("aria-expanded", "false");
        });

        /* Ouvrir le cible si elle était fermée */
        if (!isOpen) {
          submenu.classList.add("show");
          btn.setAttribute("aria-expanded", "true");
        }
      });
    });

    /* ── Responsive : fermer le sidebar au redimensionnement ── */
    window.addEventListener("resize", () => {
      if (isDesktop()) {
        closeSidebar();
      }
    });

    /* ── Surbrillance immédiate au clic (avant même le chargement de la
           page cible) + mémorisation en sessionStorage pour que la
           surbrillance survive au rechargement complet de page + gestion
           des liens de déconnexion insérés dans le menu (data-logout, ex.
           rubrique "Déconnexion" de l'Enseignant) ── */
    sidebar.querySelectorAll(".sidebar-nav a.nav-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        if (link.dataset.logout === "true") {
          e.preventDefault();
          if (window.GestionnaireAuth) {
            GestionnaireAuth.logout();
          }
          return;
        }

        sidebar.querySelectorAll(".nav-link.active").forEach((el) => {
          el.classList.remove("active");
        });
        link.classList.add("active");

        if (link.dataset.key) {
          try {
            sessionStorage.setItem("sidebarActiveKey", link.dataset.key);
          } catch (err) {
            /* sessionStorage indisponible : la page cible s'appuiera
               uniquement sur data-page, comme avant */
          }
        }
      });
    });
  }

  /* ═══════════════════════════════════════════════
     POINT D'ENTRÉE
  ════════════════════════════════════════════════ */

  /** Attend que window.GestionnaireAuth soit défini, avec un timeout de
   *  sécurité. Nécessaire car sidebar.js doit normalement être chargé APRÈS
   *  auth.js (les scripts "defer" s'exécutent dans l'ordre du document) ;
   *  ce garde-fou évite qu'un template qui aurait les balises <script> dans
   *  le mauvais ordre ne fasse silencieusement retomber le sidebar sur
   *  l'utilisateur générique "Utilisateur" avec un rôle vide (menu vide, cf.
   *  filterMenuForRole). Si le timeout expire, on continue quand même : le
   *  comportement précédent (dégradé) est préférable à un blocage total. */
  function waitForAuth(timeoutMs = 2000, intervalMs = 20) {
    return new Promise((resolve) => {
      if (window.GestionnaireAuth) return resolve(true);
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.GestionnaireAuth) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          console.warn("[sidebar.js] GestionnaireAuth introuvable après " + timeoutMs + "ms — vérifier l'ordre des balises <script> (auth.js doit précéder sidebar.js).");
          resolve(false);
        }
      }, intervalMs);
    });
  }

  async function init() {
    /* Page protégée : redirige vers /login si non authentifié.
       ⚠️ requireAuth() est une fonction ASYNC (elle interroge /api/auth/me) :
       il faut l'attendre. L'ancien code faisait `!GestionnaireAuth.requireAuth()`
       sans await, donc testait la véracité d'une Promise (toujours vraie) —
       la redirection n'était en pratique jamais bloquante ici. */
    await waitForAuth();

    if (window.GestionnaireAuth) {
      const ok = await GestionnaireAuth.requireAuth();
      if (!ok) return; // requireAuth() a déjà redirigé vers /login
    }

    inject();
    bindEvents();

    const logoutBtn = document.getElementById("sidebarLogoutBtn");
    if (logoutBtn && window.GestionnaireAuth) {
      logoutBtn.addEventListener("click", () => {
        GestionnaireAuth.logout();
      });
    }
  }

  /* Attendre que le DOM soit prêt */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
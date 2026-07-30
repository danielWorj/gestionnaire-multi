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
       /pedagogie                    → pedagogie_censeur
       /emploi-du-temps-censeur      → emploi_du_temps_censeur
       /superadmin/dashboard         → superadmin_dashboard_page
       /superadmin/etablissements    → superadmin_etablissements_page
       /change-password              → change_password_page
     Si tu ajoutes une route dans app.py, ajoute l'entrée correspondante
     ici ; si tu retires une entrée d'ici, vérifie qu'aucune page ne pointe
     encore dessus.
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
      ],
    },

    /* ── Établissement (comptes Admin uniquement) ── */
    {
      section: "Établissement",
      items: [
        {
          key: "config",
          label: "Configuration",
          icon: "fa-gear",
          href: "/configuration",
          roles: ["Admin"],
        },
        {
          key: "enseignants",
          label: "Enseignants",
          icon: "fa-user-tie",
          href: "/enseignant",
          roles: ["Admin"],
        },
        {
          key: "matieres",
          label: "Matières",
          icon: "fa-book-open",
          href: "/matiere",
          roles: ["Admin"],
        },
        {
          key: "horaire",
          label: "Emploi du temps",
          icon: "fa-calendar-days",
          href: "/emploi-du-temps",
          roles: ["Admin"],
        },
         {
          key: "inscription",
          label: "Inscriptions",
          icon: "fa-user-plus",
          href: "/inscriptions",
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
          key: "eleve",
          label: "Élèves",
          icon: "fa-user-graduate",
          href: "/eleves",
          roles: ["Admin"],
        },
      ],

    },

    /* ── Mes classes (compte Censeur uniquement) — périmètre restreint aux
           classes qui lui ont été assignées par l'Admin d'établissement,
           cf. CenseurClasse dans pedagogie_models.py. Avant cette révision,
           aucune entrée de menu n'existait pour ce rôle : la page était
           accessible en tapant l'URL directement, mais invisible dans la
           navigation. ── */
    {
      section: "Mes classes",
      items: [
        {
          key: "pedagogie-censeur",
          label: "Pédagogie",
          icon: "fa-people-arrows",
          href: "/pedagogie",
          roles: ["Censeur"],
        },
        {
          key: "horaire-censeur",
          label: "Emploi du temps",
          icon: "fa-calendar-days",
          href: "/emploi-du-temps-censeur",
          roles: ["Censeur"],
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

  /** Retourne la page active depuis data-page sur <body> ou <main>. */
  function getActivePage() {
    return (
      document.body.dataset.page ||
      document.querySelector("main")?.dataset.page ||
      ""
    );
  }

  /** Construit le HTML d'un lien de sous-menu. */
  function buildSubmenuItem(sub, activePage) {
    const isActive = activePage === sub.key ? " active" : "";
    return `<li class="nav-item">
      <a class="nav-link${isActive}" href="${sub.href}">${sub.label}</a>
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
      return `<li class="nav-item">
        <a class="nav-link${activeClass}" href="${item.href}">
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
     INJECTION
  ════════════════════════════════════════════════ */

  function inject() {
    const wrapper = document.querySelector(".app-wrapper");
    if (!wrapper) {
      console.warn("[sidebar.js] Élément .app-wrapper introuvable. Le sidebar ne peut pas être injecté.");
      return;
    }

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
  }

  /* ═══════════════════════════════════════════════
     POINT D'ENTRÉE
  ════════════════════════════════════════════════ */

  async function init() {
    /* Page protégée : redirige vers /login si non authentifié.
       ⚠️ requireAuth() est une fonction ASYNC (elle interroge /api/auth/me) :
       il faut l'attendre. L'ancien code faisait `!GestionnaireAuth.requireAuth()`
       sans await, donc testait la véracité d'une Promise (toujours vraie) —
       la redirection n'était en pratique jamais bloquante ici. */
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
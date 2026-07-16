/**
 * sidebar.js — Gestionnaire SaaS Bulletins de Notes
 * ─────────────────────────────────────────────────
 * Injecte le sidebar dans n'importe quelle page HTML.
 *
 * UTILISATION :
 *   1. Inclure ce fichier dans chaque page :
 *      <script src="/js/sidebar.js" defer></script>
 *
 *   2. Ajouter la structure minimale dans le <body> :
 *      <div class="app-wrapper">
 *        <!-- le sidebar sera injecté ici automatiquement -->
 *        <div class="main-content" id="mainContent">
 *          <!-- topbar + contenu de la page -->
 *        </div>
 *      </div>
 *
 *   3. Pour marquer le lien actif, ajouter sur le <body> ou sur le <main> :
 *      data-page="eleves"   (voir PAGES_MAP ci-dessous)
 *
 *   4. Ce fichier dépend de auth.js (doit être inclus AVANT sidebar.js) :
 *      <script src="/static/js/auth.js"></script>
 *      <script src="/static/js/sidebar.js" defer></script>
 *
 *      L'utilisateur connecté et son rôle sont lus automatiquement depuis
 *      la session stockée par auth.js (GestionnaireAuth.getUser() /
 *      GestionnaireAuth.getRole()), elle-même alimentée par la réponse de
 *      /api/auth/login ou /api/auth/superadmin/login.
 *
 *      Chaque entrée du menu peut définir "roles: [...]" pour restreindre
 *      sa visibilité (libellés de Role : Admin, Proviseur, Censeur,
 *      Surveillant, Secretaire, Comptable, Infirmier, Enseignant, Parent,
 *      ou "SuperAdmin"). Une entrée sans "roles" est visible par tous les
 *      utilisateurs connectés.
 * ─────────────────────────────────────────────────
 */

(function () {
  "use strict";

  /* ═══════════════════════════════════════════════
     CONFIGURATION DU MENU
     Modifier ici pour ajouter / retirer des entrées.
     "key" correspond à la valeur de data-page="..."
  ════════════════════════════════════════════════ */
  const MENU = [
    /* ── Tableau de bord ── */
    {
      section: null,
      items: [
        {
          key: "dashboard",
          label: "Tableau de bord",
          icon: "fa-gauge-high",
          href: "/dashboard",
          // Pas de "roles" => visible par tout utilisateur connecté
        },
      ],
    },

    /* ── Pédagogie ── */
    {
      section: "Pédagogie",
      items: [
        {
          key: "etablissement",
          label: "Établissement",
          icon: "fa-school",
          href: "/etablissement",
          roles: ["SuperAdmin", "Admin", "Proviseur"],
        },
        {
          key: "annees",
          label: "Années scolaires",
          icon: "fa-calendar-days",
          href: "/annees-scolaires",
          roles: ["Admin", "Proviseur", "Censeur"],
        },
        {
          key: "classes",
          label: "Classes & Niveaux",
          icon: "fa-chalkboard",
          href: "/classes",
          roles: ["Admin", "Proviseur", "Censeur", "Enseignant"],
        },
        {
          key: "enseignants",
          label: "Enseignants",
          icon: "fa-user-tie",
          href: "/enseignants",
          roles: ["Admin", "Proviseur"],
        },
        {
          key: "matieres",
          label: "Matières & Coefficients",
          icon: "fa-book-open",
          href: "/matieres",
          roles: ["Admin", "Proviseur", "Censeur"],
        },
      ],
    },

    /* ── Bulletins ── */
    {
      section: "Bulletins",
      items: [
        {
          key: "eleves",
          label: "Élèves & Inscriptions",
          icon: "fa-users",
          href: "/eleves",
          roles: ["Admin", "Proviseur", "Censeur", "Secretaire", "Surveillant", "Enseignant"],
        },
        {
          key: "notes",
          label: "Saisie des notes",
          icon: "fa-pen-to-square",
          href: "/notes",
          roles: ["Admin", "Proviseur", "Censeur", "Enseignant"],
          submenu: [
            { key: "notes-saisie",  label: "Saisie manuelle", href: "/notes/saisie" },
            { key: "notes-import",  label: "Import Excel",     href: "/notes/import" },
          ],
        },
        {
          key: "bulletins",
          label: "Bulletins",
          icon: "fa-file-lines",
          href: "/bulletins",
          roles: ["Admin", "Proviseur", "Censeur", "Secretaire", "Parent"],
          submenu: [
            { key: "bulletins-generer",   label: "Générer",         href: "/bulletins/generer" },
            { key: "bulletins-telecharger", label: "Télécharger",   href: "/bulletins/telecharger" },
          ],
        },
        {
          key: "discipline",
          label: "Discipline",
          icon: "fa-triangle-exclamation",
          href: "/discipline",
          roles: ["Admin", "Proviseur", "Censeur", "Surveillant"],
        },
      ],
    },

    /* ── Scolarité ── */
    {
      section: "Scolarité",
      items: [
        {
          key: "paiements",
          label: "Paiements",
          icon: "fa-money-bill-wave",
          href: "/paiements",
          roles: ["Admin", "Comptable", "Secretaire"],
        },
        {
          key: "recus",
          label: "Reçus",
          icon: "fa-receipt",
          href: "/recus",
          roles: ["Admin", "Comptable", "Secretaire"],
        },
      ],
    },

    /* ── Administration ── */
    {
      section: "Administration",
      items: [
        {
          key: "utilisateurs",
          label: "Utilisateurs & Rôles",
          icon: "fa-user-shield",
          href: "/utilisateurs",
          roles: ["SuperAdmin", "Admin"],
        },
        {
          key: "abonnement",
          label: "Abonnement",
          icon: "fa-crown",
          href: "/abonnement",
          roles: ["SuperAdmin", "Admin"],
        },
        {
          key: "notifications",
          label: "Notifications",
          icon: "fa-bell",
          href: "/notifications",
          badge: "3",
          // Visible par tout utilisateur connecté
        },
        {
          key: "parametres",
          label: "Paramètres",
          icon: "fa-gear",
          href: "/parametres",
          roles: ["SuperAdmin", "Admin"],
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
   *  session stockée par auth.js (utilisateur ou superadmin connecté). */
  function getCurrentUser() {
    if (!window.GestionnaireAuth || !GestionnaireAuth.isAuthenticated()) {
      return { nom: "Utilisateur", role: "" };
    }

    const stored = GestionnaireAuth.getUser() || {};
    const role = GestionnaireAuth.getRole() || (stored.role && stored.role.libelle) || "";

    return {
      nom: stored.nom || "Utilisateur",
      role: role,
      avatar: stored.avatar || null,
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
          <button type="button" id="sidebarLogoutBtn" title="Se déconnecter"
             style="margin-left:auto;background:none;border:none;cursor:pointer;
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
                 placeholder="Rechercher un élève, une classe…"
                 aria-label="Recherche">
        </div>
      </div>

      <!-- Actions droite -->
      <div class="topbar-right">
        <!-- Notifications -->
        <button class="topbar-icon-btn" title="Notifications" type="button">
          <i class="fa-regular fa-bell"></i>
          <span class="topbar-badge"></span>
        </button>

        <!-- Aide -->
        <button class="topbar-icon-btn" title="Aide" type="button">
          <i class="fa-regular fa-circle-question"></i>
        </button>

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

  function init() {
    /* Page protégée : redirige vers /login si non authentifié */
    if (window.GestionnaireAuth && !GestionnaireAuth.requireAuth()) {
      return;
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
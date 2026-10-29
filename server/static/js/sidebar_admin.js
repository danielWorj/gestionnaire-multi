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
          href: "/superadmin/dashboard",
        },
      ],
    },

    /* ── Administration de la plateforme ── */
    {
      section: "Plateforme",
      items: [
        {
          key: "etablissements",
          label: "Établissements",
          icon: "fa-school",
          href: "/superadmin/etablissements",
        },
        {
          key: "abonnements",
          label: "Abonnements",
          icon: "fa-crown",
          href: "/superadmin/abonnements",
          submenu: [
            { key: "abonnements-plans",   label: "Plans & Tarifs",         href: "/superadmin/abonnements/plans" },
            { key: "abonnements-quotas",  label: "Quotas par établissement", href: "/superadmin/abonnements/quotas" },
          ],
        },
        {
          key: "utilisateurs",
          label: "Utilisateurs",
          icon: "fa-user-shield",
          href: "/superadmin/utilisateurs",
        },
      ],
    },

    /* ── Finances ── */
    {
      section: "Finances",
      items: [
        {
          key: "paiements",
          label: "Paiements",
          icon: "fa-money-bill-wave",
          href: "/superadmin/paiements",
        },
      ],
    },

    /* ── Système ── */
    {
      section: "Système",
      items: [
        {
          key: "configuration",
          label: "Configuration",
          icon: "fa-gear",
          href: "/superadmin/configuration",
        },
      ],
    },
  ];

  /* ═══════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════════ */

  /** Normalise un chemin pour comparaison (retire query string, fragment,
   *  barre oblique finale). */
  function normalizePath(path) {
    if (!path) return "";
    const clean = path.split("?")[0].split("#")[0].replace(/\/+$/, "");
    return clean === "" ? "/" : clean;
  }

  /** Aplatit le MENU (items + sous-menus) en une liste plate { key, href }
   *  pour pouvoir retrouver la clé associée à l'URL couramment affichée. */
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

  /** Retourne la page active. Ordre de priorité : data-page du template,
   *  puis l'URL couramment affichée comparée aux "href" du menu (fiable
   *  même sans data-page côté template), puis la clé mémorisée au clic
   *  précédent en sessionStorage. */
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
      return `<li class="nav-item">
        <a class="nav-link${activeClass}" href="${item.href}" data-key="${item.key}">
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

  /** Construit l'objet SuperAdmin { nom, role, avatar } à partir de la
   *  session stockée par auth.js. */
  function getCurrentUser() {
    if (!window.GestionnaireAuth || !GestionnaireAuth.isAuthenticated()) {
      return { nom: "SuperAdmin", role: "SuperAdmin" };
    }

    const stored = GestionnaireAuth.getUser() || {};

    return {
      nom: stored.nom || "SuperAdmin",
      role: "SuperAdmin",
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

    const navHTML = MENU.map((g) => buildMenuGroup(g, activePage)).join("");
    const avatarHTML = buildAvatar(user, "sidebar-user-avatar", 34);

    return `
    <!-- ── Overlay mobile ── -->
    <div class="sidebar-overlay" id="sidebarOverlay"></div>

    <!-- ── Sidebar ── -->
    <aside class="sidebar" id="appSidebar" role="navigation" aria-label="Menu principal SuperAdmin">

      <!-- Logo -->
      <div class="sidebar-logo">
        <div style="
          width:32px;height:32px;
          background:var(--ta-primary);
          border-radius:var(--ta-radius-sm);
          display:flex;align-items:center;justify-content:center;
          flex-shrink:0;">
          <i class="fa-solid fa-shield-halved" style="color:#fff;font-size:15px;"></i>
        </div>
        <span class="sidebar-logo-text">
          Gestionnaire<span>.</span> <small style="font-size:11px;opacity:.7;">Admin</small>
        </span>
      </div>

      <!-- Zone de scroll / Navigation -->
      <div class="sidebar-scroll">
        <ul class="sidebar-nav">
          ${navHTML}
        </ul>
      </div>

      <!-- Pied de sidebar — SuperAdmin connecté -->
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
                 placeholder="Rechercher un établissement, un utilisateur…"
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

        <!-- Profil SuperAdmin -->
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
      console.warn("[sidebar_admin.js] Élément .app-wrapper introuvable. Le sidebar ne peut pas être injecté.");
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
           surbrillance survive au rechargement complet de page ── */
    sidebar.querySelectorAll(".sidebar-nav a.nav-link").forEach((link) => {
      link.addEventListener("click", () => {
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

  function init() {
    /* Page protégée : redirige vers /superadmin/login si non authentifié */
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
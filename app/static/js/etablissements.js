/**
 * etablissements.js — Page /superadmin/etablissements
 * ─────────────────────────────────────────────────────────────────────────
 * Consomme les vraies APIs SuperAdmin exposées par structure_api.py :
 *   - /api/etablissements/            (CRUD non cloisonné, réservé SuperAdmin)
 *   - /api/cycles/?etablissement_id=  (CRUD cloisonné, SuperAdmin doit passer
 *   - /api/classes/?etablissement_id=  le etablissement_id en query/param body)
 *   - /api/annees-scolaires/?etablissement_id=
 *   - /api/trimestres/?etablissement_id=
 *   - /api/sequences/?etablissement_id=
 * et /api/auth/utilisateurs + /api/auth/roles pour la création du compte
 * Admin d'un établissement.
 *
 * Ne modélise QUE les champs qui existent réellement dans structure_models.py
 * et authentification_models.py (pas de "sous-système", "abonnement",
 * "statut", "département" ou "téléphone admin" : ces champs n'existent pas
 * côté backend).
 *
 * S'appuie sur GestionnaireAuthAdmin.authFetch (= ApiIntercepteur.apiFetch)
 * pour le transport HTTP authentifié (cookies + CSRF + retry après refresh).
 * ─────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  "use strict";

  const authFetch = () => (global.GestionnaireAuthAdmin
    ? global.GestionnaireAuthAdmin.authFetch
    : global.ApiIntercepteur.apiFetch);

  const state = {
    etablissements: [],
    rolesCache: null,       // liste des rôles (pour retrouver l'id du rôle 'Admin')
    currentEtabId: null,    // établissement ouvert dans la modale "Gérer structure"
    structure: {            // cache des données de structure du currentEtabId
      cycles: [],
      classes: [],
      annees: [],
      trimestres: [],
      sequences: [],
    },
  };

  /* ── Helpers génériques ──────────────────────────────────────────────── */

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function initiales(nom) {
    if (!nom) return "??";
    const parts = nom.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /** Appelle l'API et renvoie le JSON parsé. Lève une Error (avec le message
   *  serveur si disponible) si la réponse n'est pas OK. */
  async function api(url, options) {
    const res = await authFetch()(url, Object.assign(
      { headers: { "Content-Type": "application/json" } },
      options
    ));
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const message = (data && (data.erreur || data.message)) || `Erreur ${res.status}`;
      throw new Error(message);
    }
    return data;
  }

  function toast(kind, message) {
    const id = kind === "error" ? "toastError" : "toastSuccess";
    const msgId = kind === "error" ? "toastErrorMessage" : "toastSuccessMessage";
    const el = document.getElementById(id);
    const msgEl = document.getElementById(msgId);
    if (!el || !msgEl || !global.bootstrap) return;
    msgEl.textContent = message;
    new bootstrap.Toast(el, { delay: 4500 }).show();
  }

  /** Remplace window.confirm() par une pop-up Bootstrap élégante.
   *  Retourne une Promise<boolean> résolue à true si l'utilisateur clique sur
   *  "Confirmer", à false s'il annule ou ferme la modale (croix, Échap, clic
   *  en dehors). Usage : if (!(await confirmerAction("Supprimer ?"))) return;
   *  Option "details" : message complémentaire (encadré orange) utilisé pour
   *  prévenir qu'un objet parent (cycle, année, trimestre) entraîne la
   *  suppression en cascade de ses objets enfants (classes, trimestres,
   *  séquences), avec leur décompte exact. */
  function confirmerAction(message, options) {
    const opts = options || {};
    return new Promise((resolve) => {
      const modalEl = document.getElementById("modalConfirmAction");
      const titleEl = document.getElementById("confirmActionTitle");
      const msgEl = document.getElementById("confirmActionMessage");
      const detailsEl = document.getElementById("confirmActionDetails");
      const detailsTextEl = document.getElementById("confirmActionDetailsText");
      const btnValider = document.getElementById("btnConfirmActionValider");

      titleEl.textContent = opts.title || "Confirmer la suppression";
      msgEl.textContent = message;
      if (opts.details) {
        detailsTextEl.textContent = opts.details;
        detailsEl.classList.remove("d-none");
      } else {
        detailsEl.classList.add("d-none");
      }
      btnValider.innerHTML = `<i class="fa-solid ${opts.icon || "fa-trash"} me-1"></i> ${opts.confirmLabel || "Confirmer"}`;

      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      let resolved = false;

      function onConfirm() {
        resolved = true;
        modal.hide();
        resolve(true);
      }
      function onHidden() {
        btnValider.removeEventListener("click", onConfirm);
        modalEl.removeEventListener("hidden.bs.modal", onHidden);
        if (!resolved) resolve(false);
      }

      btnValider.addEventListener("click", onConfirm);
      modalEl.addEventListener("hidden.bs.modal", onHidden);
      modal.show();
    });
  }

  /* ── Chargement de la liste des établissements ───────────────────────── */

  async function loadEtablissements() {
    const loadingEl = document.getElementById("etablissementsLoading");
    const errorEl = document.getElementById("etablissementsError");
    const wrapEl = document.getElementById("etablissementsTableWrap");
    const footerEl = document.getElementById("etablissementsFooter");

    loadingEl.classList.remove("d-none");
    errorEl.classList.add("d-none");
    wrapEl.classList.add("d-none");
    footerEl.classList.add("d-none");

    try {
      const data = await api("/api/etablissements/", { method: "GET" });
      state.etablissements = Array.isArray(data) ? data : [];
      loadingEl.classList.add("d-none");
      wrapEl.classList.remove("d-none");
      footerEl.classList.remove("d-none");
      applyFilters();
      loadStructureSummaries(state.etablissements);
    } catch (err) {
      loadingEl.classList.add("d-none");
      errorEl.classList.remove("d-none");
      errorEl.textContent = "Impossible de charger les établissements : " + err.message;
    }
  }

  function applyFilters() {
    const region = document.getElementById("filterRegion").value.trim().toLowerCase();
    const search = document.getElementById("filterSearch").value.trim().toLowerCase();

    const filtered = state.etablissements.filter((e) => {
      if (region && (e.region || "").toLowerCase() !== region) return false;
      if (search) {
        const haystack = [e.nom, e.nom_bilingue, e.adresse, e.bp, e.region]
          .filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    renderTable(filtered);

    document.getElementById("countEtablissements").textContent =
      `(${filtered.length}${filtered.length !== state.etablissements.length ? " / " + state.etablissements.length : ""})`;
    document.getElementById("kpiTotalEtablissements").textContent = state.etablissements.length;
    document.getElementById("etablissementsFooterText").textContent =
      `Affichage de ${filtered.length} établissement(s) sur ${state.etablissements.length}`;
  }

  function renderTable(list) {
    const tbody = document.getElementById("etablissementsTableBody");
    tbody.innerHTML = "";

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">Aucun établissement ne correspond à ces critères.</td></tr>`;
      return;
    }

    list.forEach((etab) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <div class="d-flex align-items-center gap-2">
            <div class="bg-primary-light text-primary rounded-ta-sm d-flex align-items-center justify-content-center" style="width:36px;height:36px;font-weight:700;font-size:11px;">${escapeHtml(initiales(etab.nom))}</div>
            <div>
              <div class="fw-semibold">${escapeHtml(etab.nom)}</div>
              ${etab.nom_bilingue ? `<div class="text-muted small">${escapeHtml(etab.nom_bilingue)}</div>` : ""}
            </div>
          </div>
        </td>
        <td>${etab.region ? `<span class="badge badge-neutral">${escapeHtml(etab.region)}</span>` : `<span class="text-muted">—</span>`}</td>
        <td id="structCell-${etab.id}"><span class="text-muted small"><i class="fa-solid fa-spinner fa-spin"></i> chargement...</span></td>
        <td id="adminCell-${etab.id}"><span class="text-muted small"><i class="fa-solid fa-spinner fa-spin"></i> chargement...</span></td>
        <td class="text-end">
          <div class="dropdown">
            <button class="btn btn-icon btn-light btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown">
              <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
            <ul class="dropdown-menu dropdown-menu-end">
              <li><a class="dropdown-item" href="#" data-bs-toggle="modal" data-bs-target="#modalStructure"
                     data-id="${etab.id}" data-nom="${escapeHtml(etab.nom)}" data-region="${escapeHtml(etab.region || "")}">
                     <i class="fa-solid fa-diagram-project"></i> Gérer structure</a></li>
              <li><a class="dropdown-item" href="#" data-bs-toggle="modal" data-bs-target="#modalNouvelEtablissement"
                     data-action="edit" data-id="${etab.id}"><i class="fa-solid fa-pen"></i> Modifier</a></li>
              <li><hr class="dropdown-divider"></li>
              <li><a class="dropdown-item text-danger" href="#" data-bs-toggle="modal" data-bs-target="#modalSupprimer"
                     data-id="${etab.id}" data-nom="${escapeHtml(etab.nom)}"><i class="fa-solid fa-trash"></i> Supprimer</a></li>
            </ul>
          </div>
        </td>`;
      tbody.appendChild(tr);
    });
  }

  /** Charge, pour chaque établissement affiché, un résumé de sa structure
   *  scolaire (cycles/classes/année active) et son admin, en tâche de fond
   *  (le tableau s'affiche déjà avec un aperçu "chargement..."). Alimente
   *  aussi les KPIs globaux au fur et à mesure. */
  async function loadStructureSummaries(list) {
    let totalCycles = 0;
    let totalClasses = 0;
    let anneesActives = 0;

    await Promise.all(list.map(async (etab) => {
      const structCell = document.getElementById(`structCell-${etab.id}`);
      const adminCell = document.getElementById(`adminCell-${etab.id}`);

      try {
        const [cycles, classes, annees, admins] = await Promise.all([
          api(`/api/cycles/?etablissement_id=${etab.id}`, { method: "GET" }),
          api(`/api/classes/?etablissement_id=${etab.id}`, { method: "GET" }),
          api(`/api/annees-scolaires/?etablissement_id=${etab.id}`, { method: "GET" }),
          api(`/api/auth/utilisateurs?etablissement_id=${etab.id}&role=Admin`, { method: "GET" }),
        ]);

        totalCycles += cycles.length;
        totalClasses += classes.length;
        const anneeActive = annees.find((a) => a.active);
        if (anneeActive) anneesActives += 1;

        if (structCell) {
          structCell.innerHTML = `
            <div class="d-flex flex-column gap-1">
              <div class="d-flex align-items-center gap-2 small">
                <i class="fa-solid fa-layer-group text-info" style="width:14px;"></i>
                <span>${cycles.length} cycle(s)</span>
                <span class="text-muted">·</span>
                <span>${classes.length} classe(s)</span>
              </div>
              <div class="d-flex align-items-center gap-2 small">
                <i class="fa-solid fa-calendar-check text-warning" style="width:14px;"></i>
                <span>${anneeActive ? escapeHtml(anneeActive.libelle) + " (Active)" : "Aucune année active"}</span>
              </div>
            </div>`;
        }

        if (adminCell) {
          if (admins.length > 0) {
            adminCell.innerHTML = `
              <div class="small">
                <div class="fw-medium">${escapeHtml(admins[0].nom)}</div>
                <div class="text-muted">${escapeHtml(admins[0].email)}</div>
              </div>`;
          } else {
            adminCell.innerHTML = `<span class="text-muted small">Aucun admin</span>`;
          }
        }
      } catch (err) {
        if (structCell) structCell.innerHTML = `<span class="text-danger small">Erreur de chargement</span>`;
        if (adminCell) adminCell.innerHTML = `<span class="text-danger small">—</span>`;
      }
    }));

    document.getElementById("kpiTotalCycles").textContent = totalCycles;
    document.getElementById("kpiTotalClasses").textContent = totalClasses;
    document.getElementById("kpiTotalAnneesActives").textContent = anneesActives;
    const nbEtabs = state.etablissements.length || 1;
    document.getElementById("kpiCyclesSub").textContent = `Moy. ${(totalCycles / nbEtabs).toFixed(1)} / établissement`;
    document.getElementById("kpiClassesSub").textContent = `Réparties sur ${state.etablissements.length} établissement(s)`;
    document.getElementById("kpiAnneesSub").textContent = `Sur ${state.etablissements.length} établissement(s)`;
  }

  /* ── Rôles (pour créer un compte Admin d'établissement) ──────────────── */

  async function getAdminRoleId() {
    if (!state.rolesCache) {
      state.rolesCache = await api("/api/auth/roles", { method: "GET" });
    }
    const adminRole = state.rolesCache.find((r) => r.libelle === "Admin");
    if (!adminRole) throw new Error("Le rôle 'Admin' n'existe pas côté serveur");
    return adminRole.id;
  }

  /* ── Modale création / édition d'un établissement ─────────────────────── */

  function resetFormEtablissement() {
    document.getElementById("formEtablissementAlert").classList.add("d-none");
    document.getElementById("etablissementId").value = "";
    document.getElementById("etabNom").value = "";
    document.getElementById("etabNomBilingue").value = "";
    document.getElementById("etabRegion").value = "";
    document.getElementById("etabTelephone").value = "";
    document.getElementById("etabAdresse").value = "";
    document.getElementById("etabBp").value = "";
    document.getElementById("etabLogoUrl").value = "";
    document.getElementById("adminNom").value = "";
    document.getElementById("adminEmail").value = "";
  }

  function setModeCreate() {
    resetFormEtablissement();
    document.getElementById("modalEtablissementTitle").innerHTML =
      '<i class="fa-solid fa-plus me-2 text-primary"></i>Nouvel établissement';
    ["adminSectionDivider", "adminSectionTitle", "adminNomWrap", "adminEmailWrap"].forEach((id) => {
      document.getElementById(id).classList.remove("d-none");
    });
  }

  function setModeEdit(etab) {
    resetFormEtablissement();
    document.getElementById("modalEtablissementTitle").innerHTML =
      '<i class="fa-solid fa-pen me-2 text-primary"></i>Modifier l\'établissement';
    document.getElementById("etablissementId").value = etab.id;
    document.getElementById("etabNom").value = etab.nom || "";
    document.getElementById("etabNomBilingue").value = etab.nom_bilingue || "";
    document.getElementById("etabRegion").value = etab.region || "";
    document.getElementById("etabTelephone").value = etab.telephone || "";
    document.getElementById("etabAdresse").value = etab.adresse || "";
    document.getElementById("etabBp").value = etab.bp || "";
    document.getElementById("etabLogoUrl").value = etab.logo_url || "";
    // La création de compte Admin ne se fait qu'à la création de l'établissement.
    ["adminSectionDivider", "adminSectionTitle", "adminNomWrap", "adminEmailWrap"].forEach((id) => {
      document.getElementById(id).classList.add("d-none");
    });
  }

  async function submitFormEtablissement() {
    const alertEl = document.getElementById("formEtablissementAlert");
    alertEl.classList.add("d-none");

    const id = document.getElementById("etablissementId").value;
    const nom = document.getElementById("etabNom").value.trim();
    const region = document.getElementById("etabRegion").value;

    if (!nom || !region) {
      alertEl.textContent = "Le nom et la région sont obligatoires.";
      alertEl.classList.remove("d-none");
      return;
    }

    const payload = {
      nom,
      nom_bilingue: document.getElementById("etabNomBilingue").value.trim() || null,
      region,
      telephone: document.getElementById("etabTelephone").value.trim() || null,
      adresse: document.getElementById("etabAdresse").value.trim() || null,
      bp: document.getElementById("etabBp").value.trim() || null,
      logo_url: document.getElementById("etabLogoUrl").value.trim() || null,
    };

    const btn = document.getElementById("btnEnregistrerEtablissement");
    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Enregistrement...';

    try {
      let etab;
      if (id) {
        etab = await api(`/api/etablissements/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        etab = await api("/api/etablissements/", { method: "POST", body: JSON.stringify(payload) });
      }

      // Création optionnelle du compte Admin de l'établissement, uniquement à la création.
      if (!id) {
        const adminNom = document.getElementById("adminNom").value.trim();
        const adminEmail = document.getElementById("adminEmail").value.trim();
        if (adminNom && adminEmail) {
          try {
            const roleId = await getAdminRoleId();
            const result = await api("/api/auth/utilisateurs", {
              method: "POST",
              body: JSON.stringify({
                nom: adminNom,
                email: adminEmail,
                role_id: roleId,
                etablissement_id: etab.id,
              }),
            });
            if (result && result.mot_de_passe_temporaire) {
              document.getElementById("mdpTempEmail").textContent = adminEmail;
              document.getElementById("mdpTempValeur").textContent = result.mot_de_passe_temporaire;
              const mdpModal = new bootstrap.Modal(document.getElementById("modalMdpTemp"));
              mdpModal.show();
            }
          } catch (adminErr) {
            toast("error", "Établissement créé, mais le compte Admin n'a pas pu être créé : " + adminErr.message);
          }
        }
      }

      const modalEl = document.getElementById("modalNouvelEtablissement");
      bootstrap.Modal.getInstance(modalEl)?.hide();
      toast("success", id ? "Établissement modifié avec succès." : "Établissement créé avec succès.");
      loadEtablissements();
    } catch (err) {
      alertEl.textContent = err.message;
      alertEl.classList.remove("d-none");
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }

  /* ── Suppression d'un établissement ───────────────────────────────────── */

  async function confirmerSuppressionEtablissement() {
    const btn = document.getElementById("btnConfirmerSuppression");
    const id = btn.dataset.id;
    const alertEl = document.getElementById("supprimerAlert");
    alertEl.classList.add("d-none");
    btn.disabled = true;

    try {
      await api(`/api/etablissements/${id}`, { method: "DELETE" });
      bootstrap.Modal.getInstance(document.getElementById("modalSupprimer"))?.hide();
      toast("success", "Établissement supprimé.");
      loadEtablissements();
    } catch (err) {
      alertEl.textContent = err.message;
      alertEl.classList.remove("d-none");
    } finally {
      btn.disabled = false;
    }
  }

  /* ── Modale "Gérer la structure scolaire" ─────────────────────────────── */

  async function ouvrirModaleStructure(id, nom, region) {
    state.currentEtabId = id;
    document.getElementById("modalStructureSubtitle").textContent =
      `${nom}${region ? " · " + region : ""}`;
    await chargerDonneesStructure(id);
  }

  async function chargerDonneesStructure(id) {
    const setLoading = (tbodyId, colspan) => {
      const el = document.getElementById(tbodyId);
      if (el) el.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-muted py-3"><i class="fa-solid fa-spinner fa-spin"></i> Chargement...</td></tr>`;
    };
    setLoading("tbodyCycles", 3);
    setLoading("tbodyClasses", 4);
    setLoading("tbodyAnnees", 3);
    document.getElementById("containerTrimestres").innerHTML =
      '<div class="col-12 text-center text-muted py-3"><i class="fa-solid fa-spinner fa-spin"></i> Chargement...</div>';

    try {
      const [cycles, classes, annees, trimestres, sequences] = await Promise.all([
        api(`/api/cycles/?etablissement_id=${id}`, { method: "GET" }),
        api(`/api/classes/?etablissement_id=${id}`, { method: "GET" }),
        api(`/api/annees-scolaires/?etablissement_id=${id}`, { method: "GET" }),
        api(`/api/trimestres/?etablissement_id=${id}`, { method: "GET" }),
        api(`/api/sequences/?etablissement_id=${id}`, { method: "GET" }),
      ]);
      state.structure = { cycles, classes, annees, trimestres, sequences };
      renderCycles();
      renderClasses();
      renderAnnees();
      renderSelectAnnees();
    } catch (err) {
      toast("error", "Impossible de charger la structure : " + err.message);
    }
  }

  function nomCycle(cycleId) {
    const c = state.structure.cycles.find((cy) => cy.id === cycleId);
    return c ? c.libelle : `#${cycleId}`;
  }

  function renderCycles() {
    document.getElementById("countCycles").textContent = state.structure.cycles.length;
    const tbody = document.getElementById("tbodyCycles");
    if (state.structure.cycles.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-3">Aucun cycle défini.</td></tr>`;
      return;
    }
    tbody.innerHTML = state.structure.cycles
      .slice()
      .sort((a, b) => a.libelle.localeCompare(b.libelle))
      .map((c) => {
        const nbClasses = state.structure.classes.filter((cl) => cl.cycle_id === c.id).length;
        return `<tr>
          <td class="fw-semibold">${escapeHtml(c.libelle)}</td>
          <td>${nbClasses} classe(s)</td>
          <td class="text-end">
            <button class="btn btn-icon btn-light btn-sm" data-action="edit-cycle" data-id="${c.id}"><i class="fa-solid fa-pen"></i></button>
            <button class="btn btn-icon btn-light btn-sm text-danger" data-action="delete-cycle" data-id="${c.id}"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>`;
      }).join("");
  }

  function renderClasses() {
    document.getElementById("countClasses").textContent = state.structure.classes.length;
    const tbody = document.getElementById("tbodyClasses");
    if (state.structure.classes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-3">Aucune classe définie.</td></tr>`;
      return;
    }
    tbody.innerHTML = state.structure.classes.map((cl) => `
      <tr>
        <td><span class="badge badge-neutral">${escapeHtml(nomCycle(cl.cycle_id))}</span></td>
        <td>${cl.option ? escapeHtml(cl.option) : "-"}</td>
        <td>${cl.effectif}</td>
        <td class="text-end">
          <button class="btn btn-icon btn-light btn-sm" data-action="edit-classe" data-id="${cl.id}"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-icon btn-light btn-sm text-danger" data-action="delete-classe" data-id="${cl.id}"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`).join("");
  }

  function renderAnnees() {
    document.getElementById("countAnnees").textContent = state.structure.annees.length;
    const tbody = document.getElementById("tbodyAnnees");
    if (state.structure.annees.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-3">Aucune année scolaire définie.</td></tr>`;
      return;
    }
    tbody.innerHTML = state.structure.annees.map((a) => `
      <tr>
        <td class="fw-semibold">${escapeHtml(a.libelle)}</td>
        <td>${a.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
        <td class="text-end">
          <button class="btn btn-icon btn-light btn-sm" data-action="toggle-annee" data-id="${a.id}" title="${a.active ? 'Désactiver' : 'Activer'}">
            <i class="fa-solid ${a.active ? "fa-toggle-on" : "fa-toggle-off"}"></i>
          </button>
          <button class="btn btn-icon btn-light btn-sm" data-action="edit-annee" data-id="${a.id}"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-icon btn-light btn-sm text-danger" data-action="delete-annee" data-id="${a.id}"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`).join("");
  }

  function renderSelectAnnees() {
    const select = document.getElementById("selectAnneeTrimestres");
    const previous = select.value;
    if (state.structure.annees.length === 0) {
      select.innerHTML = '<option value="">Aucune année scolaire</option>';
      renderTrimestres(null);
      return;
    }
    select.innerHTML = state.structure.annees.map((a) =>
      `<option value="${a.id}">${escapeHtml(a.libelle)}${a.active ? " (Active)" : ""}</option>`).join("");
    const toSelect = state.structure.annees.some((a) => String(a.id) === previous)
      ? previous
      : (state.structure.annees.find((a) => a.active) || state.structure.annees[0]).id;
    select.value = toSelect;
    renderTrimestres(Number(select.value));
  }

  function renderTrimestres(anneeId) {
    const container = document.getElementById("containerTrimestres");
    if (!anneeId) {
      container.innerHTML = '<div class="col-12 text-center text-muted py-3">Sélectionnez une année scolaire.</div>';
      return;
    }
    const trimestres = state.structure.trimestres
      .filter((t) => t.annee_scolaire_id === anneeId)
      .sort((a, b) => {
        if (a.date_debut && b.date_debut) return a.date_debut.localeCompare(b.date_debut);
        if (a.date_debut) return -1;
        if (b.date_debut) return 1;
        return a.id - b.id;
      });

    if (trimestres.length === 0) {
      container.innerHTML = '<div class="col-12 text-center text-muted py-3">Aucun trimestre pour cette année scolaire.</div>';
      return;
    }

    container.innerHTML = trimestres.map((t) => {
      const sequences = state.structure.sequences
        .filter((s) => s.trimestre_id === t.id);
      return `
        <div class="col-md-4">
          <div class="card h-100">
            <div class="card-header">
              <h6 class="card-title mb-0">${escapeHtml(t.libelle)}</h6>
              <div>
                <button class="btn btn-icon btn-light btn-sm" data-action="edit-trimestre" data-id="${t.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="btn btn-icon btn-light btn-sm text-danger" data-action="delete-trimestre" data-id="${t.id}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </div>
            <div class="card-body">
              <p class="small text-muted mb-2">${t.date_debut || "?"} → ${t.date_fin || "?"}</p>
              <hr class="divider">
              <div class="small fw-semibold mb-2">Séquences :</div>

              <!-- Formulaire inline Séquence (création / édition) — masqué par défaut,
                   affiché au-dessus de la liste des séquences de ce trimestre -->
              <div class="p-2 mb-2 border rounded-ta bg-light d-none" id="panelFormSequence-${t.id}">
                <input type="hidden" class="seqFormId" value="">
                <div class="row g-1">
                  <div class="col-12">
                    <input type="text" class="form-control form-control-sm seqFormLibelle" placeholder="Libellé (ex: Séquence 1)">
                  </div>
                  <div class="col-6">
                    <input type="date" class="form-control form-control-sm seqFormDateDebut" title="Date de début">
                  </div>
                  <div class="col-6">
                    <input type="date" class="form-control form-control-sm seqFormDateFin" title="Date de fin">
                  </div>
                  <div class="col-12 d-flex gap-1 mt-1">
                    <button class="btn btn-primary btn-sm flex-fill" type="button" data-action="submit-sequence-form" data-trimestre-id="${t.id}">
                      <i class="fa-solid fa-check me-1"></i><span class="seqFormSubmitLabel">Ajouter</span>
                    </button>
                    <button class="btn btn-light btn-sm" type="button" data-action="cancel-sequence-form" data-trimestre-id="${t.id}">Annuler</button>
                  </div>
                </div>
                <div class="alert alert-danger py-1 px-2 small mt-1 mb-0 d-none seqFormAlert"></div>
              </div>

              <div class="d-flex flex-column gap-1">
                ${sequences.map((s) => `
                  <div class="d-flex justify-content-between align-items-center small">
                    <span>${escapeHtml(s.libelle)}</span>
                    <span class="text-muted">${s.date_debut || "?"} → ${s.date_fin || "?"}</span>
                    <span>
                      <button class="btn btn-icon btn-light btn-sm" data-action="edit-sequence" data-id="${s.id}"><i class="fa-solid fa-pen fa-xs"></i></button>
                      <button class="btn btn-icon btn-light btn-sm text-danger" data-action="delete-sequence" data-id="${s.id}"><i class="fa-solid fa-trash fa-xs"></i></button>
                    </span>
                  </div>`).join("") || '<span class="text-muted small">Aucune séquence</span>'}
              </div>
            </div>
            <div class="card-footer">
              <button class="btn btn-outline-primary btn-sm w-100" data-action="toggle-sequence-form" data-trimestre-id="${t.id}">
                <i class="fa-solid fa-plus me-1"></i> Ajouter une séquence
              </button>
            </div>
          </div>
        </div>`;
    }).join("");
  }

  /* ── Formulaires inline (remplacent les anciens prompt()/confirm() de
     saisie) pour Cycle / Classe / Année / Trimestre / Séquence.
     Chaque panneau de formulaire (voir etablissements.html, juste au-dessus
     du tableau/de la liste concerné·e) sert à la fois pour la création et
     l'édition : le champ hidden "...FormId" est vide en création, rempli
     avec l'id de l'entité en édition ; le titre du panneau et le libellé du
     bouton s'adaptent en conséquence. Les confirmations de suppression
     utilisent confirmerAction() (pop-up Bootstrap), plus les confirm()
     natifs du navigateur. ─────────────────────────────────────────────── */

  function showFormAlert(alertId, message) {
    const el = document.getElementById(alertId);
    el.textContent = message;
    el.classList.remove("d-none");
  }

  function hideFormAlert(alertId) {
    document.getElementById(alertId).classList.add("d-none");
  }

  /* ── Cycle ──────────────────────────────────────────────────────────── */

  function ouvrirFormCycle(cycle) {
    hideFormAlert("cycleFormAlert");
    document.getElementById("cycleFormId").value = cycle ? cycle.id : "";
    document.getElementById("cycleFormLibelle").value = cycle ? cycle.libelle : "";
    document.getElementById("panelFormCycleTitle").innerHTML = cycle
      ? '<i class="fa-solid fa-pen me-1 text-primary"></i>Modifier le cycle'
      : '<i class="fa-solid fa-plus me-1 text-primary"></i>Nouveau cycle';
    document.getElementById("btnEnregistrerCycleLabel").textContent = cycle ? "Enregistrer" : "Ajouter";
    document.getElementById("panelFormCycle").classList.remove("d-none");
    document.getElementById("cycleFormLibelle").focus();
  }

  function fermerFormCycle() {
    document.getElementById("panelFormCycle").classList.add("d-none");
  }

  async function soumettreFormCycle() {
    const id = document.getElementById("cycleFormId").value;
    const libelle = document.getElementById("cycleFormLibelle").value.trim();
    hideFormAlert("cycleFormAlert");
    if (!libelle) { showFormAlert("cycleFormAlert", "Le libellé est requis."); return; }
    try {
      if (id) {
        await api(`/api/cycles/${id}?etablissement_id=${state.currentEtabId}`, {
          method: "PUT",
          body: JSON.stringify({ libelle }),
        });
        toast("success", "Cycle modifié.");
      } else {
        await api("/api/cycles/", {
          method: "POST",
          body: JSON.stringify({ libelle, etablissement_id: state.currentEtabId }),
        });
        toast("success", "Cycle ajouté.");
      }
      fermerFormCycle();
      await chargerDonneesStructure(state.currentEtabId);
    } catch (err) {
      showFormAlert("cycleFormAlert", err.message);
    }
  }

  async function supprimerCycle(id) {
    const nbClasses = state.structure.classes.filter((cl) => cl.cycle_id === id).length;
    const details = nbClasses > 0
      ? `Ce cycle est rattaché à ${nbClasses} classe${nbClasses > 1 ? "s" : ""}. ${nbClasses > 1 ? "Elles seront" : "Elle sera"} définitivement supprimée${nbClasses > 1 ? "s" : ""} en même temps que le cycle.`
      : null;
    if (!(await confirmerAction("Supprimer ce cycle ?", { details }))) return;
    try {
      await api(`/api/cycles/${id}?etablissement_id=${state.currentEtabId}`, { method: "DELETE" });
      toast("success", "Cycle supprimé.");
      await chargerDonneesStructure(state.currentEtabId);
    } catch (err) {
      toast("error", err.message);
    }
  }

  /* ── Classe ─────────────────────────────────────────────────────────── */

  function remplirSelectCyclesClasse(selectedCycleId) {
    const select = document.getElementById("classeFormCycle");
    if (state.structure.cycles.length === 0) {
      select.innerHTML = '<option value="">Aucun cycle disponible</option>';
      return false;
    }
    select.innerHTML = state.structure.cycles
      .slice()
      .sort((a, b) => a.libelle.localeCompare(b.libelle))
      .map((c) => `<option value="${c.id}">${escapeHtml(c.libelle)}</option>`)
      .join("");
    select.value = selectedCycleId ? String(selectedCycleId) : String(state.structure.cycles[0].id);
    return true;
  }

  function ouvrirFormClasse(classe) {
    hideFormAlert("classeFormAlert");
    const okCycles = remplirSelectCyclesClasse(classe ? classe.cycle_id : null);
    if (!okCycles) {
      showFormAlert("classeFormAlert", "Créez d'abord au moins un cycle pour cet établissement.");
    }
    document.getElementById("classeFormId").value = classe ? classe.id : "";
    document.getElementById("classeFormOption").value = classe ? (classe.option || "") : "";
    document.getElementById("panelFormClasseTitle").innerHTML = classe
      ? '<i class="fa-solid fa-pen me-1 text-primary"></i>Modifier la classe'
      : '<i class="fa-solid fa-plus me-1 text-primary"></i>Nouvelle classe';
    document.getElementById("btnEnregistrerClasseLabel").textContent = classe ? "Enregistrer" : "Ajouter";
    document.getElementById("panelFormClasse").classList.remove("d-none");
  }

  function fermerFormClasse() {
    document.getElementById("panelFormClasse").classList.add("d-none");
  }

  async function soumettreFormClasse() {
    const id = document.getElementById("classeFormId").value;
    const cycleId = parseInt(document.getElementById("classeFormCycle").value, 10);
    const option = document.getElementById("classeFormOption").value.trim() || null;
    hideFormAlert("classeFormAlert");
    if (Number.isNaN(cycleId)) { showFormAlert("classeFormAlert", "Sélectionnez un cycle valide."); return; }
    try {
      if (id) {
        await api(`/api/classes/${id}?etablissement_id=${state.currentEtabId}`, {
          method: "PUT",
          body: JSON.stringify({ cycle_id: cycleId, option }),
        });
        toast("success", "Classe modifiée.");
      } else {
        await api("/api/classes/", {
          method: "POST",
          body: JSON.stringify({ cycle_id: cycleId, option, etablissement_id: state.currentEtabId }),
        });
        toast("success", "Classe ajoutée.");
      }
      fermerFormClasse();
      await chargerDonneesStructure(state.currentEtabId);
    } catch (err) {
      showFormAlert("classeFormAlert", err.message);
    }
  }

  async function supprimerClasse(id) {
    if (!(await confirmerAction("Supprimer cette classe ?"))) return;
    try {
      await api(`/api/classes/${id}?etablissement_id=${state.currentEtabId}`, { method: "DELETE" });
      toast("success", "Classe supprimée.");
      await chargerDonneesStructure(state.currentEtabId);
    } catch (err) {
      toast("error", err.message);
    }
  }

  /* ── Année scolaire ─────────────────────────────────────────────────── */

  function ouvrirFormAnnee(annee) {
    hideFormAlert("anneeFormAlert");
    document.getElementById("anneeFormId").value = annee ? annee.id : "";
    document.getElementById("anneeFormLibelle").value = annee ? annee.libelle : "";
    document.getElementById("anneeFormActive").checked = annee ? !!annee.active : false;
    // En édition, l'activation se gère via le bouton toggle dédié du tableau
    // (elle peut avoir des effets de bord sur les autres années) : on masque
    // la case à cocher dans ce cas pour ne pas dupliquer l'action.
    document.getElementById("anneeFormActive").closest(".form-check").classList.toggle("d-none", !!annee);
    document.getElementById("panelFormAnneeTitle").innerHTML = annee
      ? "<i class=\"fa-solid fa-pen me-1 text-primary\"></i>Modifier l'année scolaire"
      : '<i class="fa-solid fa-plus me-1 text-primary"></i>Nouvelle année scolaire';
    document.getElementById("btnEnregistrerAnneeLabel").textContent = annee ? "Enregistrer" : "Ajouter";
    document.getElementById("panelFormAnnee").classList.remove("d-none");
  }

  function fermerFormAnnee() {
    document.getElementById("panelFormAnnee").classList.add("d-none");
  }

  async function soumettreFormAnnee() {
    const id = document.getElementById("anneeFormId").value;
    const libelle = document.getElementById("anneeFormLibelle").value.trim();
    hideFormAlert("anneeFormAlert");
    if (!libelle) { showFormAlert("anneeFormAlert", "Le libellé est requis."); return; }
    try {
      if (id) {
        await api(`/api/annees-scolaires/${id}?etablissement_id=${state.currentEtabId}`, {
          method: "PUT",
          body: JSON.stringify({ libelle }),
        });
        toast("success", "Année scolaire modifiée.");
      } else {
        const active = document.getElementById("anneeFormActive").checked;
        await api("/api/annees-scolaires/", {
          method: "POST",
          body: JSON.stringify({ libelle, active, etablissement_id: state.currentEtabId }),
        });
        toast("success", "Année scolaire ajoutée.");
      }
      fermerFormAnnee();
      await chargerDonneesStructure(state.currentEtabId);
    } catch (err) {
      showFormAlert("anneeFormAlert", err.message);
    }
  }

  async function toggleAnnee(id) {
    const a = state.structure.annees.find((x) => x.id === id);
    if (!a) return;
    try {
      await api(`/api/annees-scolaires/${id}?etablissement_id=${state.currentEtabId}`, {
        method: "PUT",
        body: JSON.stringify({ active: !a.active }),
      });
      await chargerDonneesStructure(state.currentEtabId);
    } catch (err) {
      toast("error", err.message);
    }
  }

  async function supprimerAnnee(id) {
    const trimestresLies = state.structure.trimestres.filter((t) => t.annee_scolaire_id === id);
    const nbTrimestres = trimestresLies.length;
    const nbSequences = state.structure.sequences.filter((s) =>
      trimestresLies.some((t) => t.id === s.trimestre_id)
    ).length;
    let details = null;
    if (nbTrimestres > 0) {
      const partsTrimestres = `${nbTrimestres} trimestre${nbTrimestres > 1 ? "s" : ""}`;
      const partsSequences = nbSequences > 0 ? ` et ${nbSequences} séquence${nbSequences > 1 ? "s" : ""}` : "";
      details = `Cette année scolaire contient ${partsTrimestres}${partsSequences}. Ils seront tous définitivement supprimés en même temps qu'elle.`;
    }
    if (!(await confirmerAction("Supprimer cette année scolaire ?", { details }))) return;
    try {
      await api(`/api/annees-scolaires/${id}?etablissement_id=${state.currentEtabId}`, { method: "DELETE" });
      toast("success", "Année scolaire supprimée.");
      await chargerDonneesStructure(state.currentEtabId);
    } catch (err) {
      toast("error", err.message);
    }
  }

  function anneeSelectionneeId() {
    const val = document.getElementById("selectAnneeTrimestres").value;
    return val ? Number(val) : null;
  }

  /* ── Trimestre ──────────────────────────────────────────────────────── */

  function ouvrirFormTrimestre(trimestre) {
    hideFormAlert("trimestreFormAlert");
    document.getElementById("trimestreFormId").value = trimestre ? trimestre.id : "";
    document.getElementById("trimestreFormLibelle").value = trimestre ? trimestre.libelle : "";
    document.getElementById("trimestreFormDateDebut").value = trimestre ? (trimestre.date_debut || "") : "";
    document.getElementById("trimestreFormDateFin").value = trimestre ? (trimestre.date_fin || "") : "";
    document.getElementById("panelFormTrimestreTitle").innerHTML = trimestre
      ? '<i class="fa-solid fa-pen me-1 text-primary"></i>Modifier le trimestre'
      : '<i class="fa-solid fa-plus me-1 text-primary"></i>Nouveau trimestre';
    document.getElementById("btnEnregistrerTrimestreLabel").textContent = trimestre ? "Enregistrer" : "Ajouter";
    document.getElementById("panelFormTrimestre").classList.remove("d-none");
  }

  function fermerFormTrimestre() {
    document.getElementById("panelFormTrimestre").classList.add("d-none");
  }

  async function soumettreFormTrimestre() {
    const id = document.getElementById("trimestreFormId").value;
    const libelle = document.getElementById("trimestreFormLibelle").value.trim();
    const date_debut = document.getElementById("trimestreFormDateDebut").value || null;
    const date_fin = document.getElementById("trimestreFormDateFin").value || null;
    hideFormAlert("trimestreFormAlert");
    if (!libelle) { showFormAlert("trimestreFormAlert", "Le libellé est requis."); return; }

    let anneeId;
    try {
      if (id) {
        const t = state.structure.trimestres.find((x) => x.id === Number(id));
        anneeId = t ? t.annee_scolaire_id : anneeSelectionneeId();
        await api(`/api/trimestres/${id}?etablissement_id=${state.currentEtabId}`, {
          method: "PUT",
          body: JSON.stringify({ libelle, date_debut, date_fin }),
        });
        toast("success", "Trimestre modifié.");
      } else {
        anneeId = anneeSelectionneeId();
        if (!anneeId) { showFormAlert("trimestreFormAlert", "Sélectionnez d'abord une année scolaire."); return; }
        await api("/api/trimestres/", {
          method: "POST",
          body: JSON.stringify({ annee_scolaire_id: anneeId, libelle, date_debut, date_fin, etablissement_id: state.currentEtabId }),
        });
        toast("success", "Trimestre ajouté.");
      }
      fermerFormTrimestre();
      await chargerDonneesStructure(state.currentEtabId);
      if (anneeId) {
        document.getElementById("selectAnneeTrimestres").value = String(anneeId);
        renderTrimestres(anneeId);
      }
    } catch (err) {
      showFormAlert("trimestreFormAlert", err.message);
    }
  }

  async function supprimerTrimestre(id) {
    const nbSequences = state.structure.sequences.filter((s) => s.trimestre_id === id).length;
    const details = nbSequences > 0
      ? `Ce trimestre contient ${nbSequences} séquence${nbSequences > 1 ? "s" : ""}. ${nbSequences > 1 ? "Elles seront" : "Elle sera"} définitivement supprimée${nbSequences > 1 ? "s" : ""} en même temps que lui.`
      : null;
    if (!(await confirmerAction("Supprimer ce trimestre ?", { details }))) return;
    const t = state.structure.trimestres.find((x) => x.id === id);
    const anneeId = t ? t.annee_scolaire_id : null;
    try {
      await api(`/api/trimestres/${id}?etablissement_id=${state.currentEtabId}`, { method: "DELETE" });
      toast("success", "Trimestre supprimé.");
      await chargerDonneesStructure(state.currentEtabId);
      if (anneeId) {
        document.getElementById("selectAnneeTrimestres").value = String(anneeId);
        renderTrimestres(anneeId);
      }
    } catch (err) {
      toast("error", err.message);
    }
  }

  /* ── Séquence ───────────────────────────────────────────────────────── */
  /* Un panneau de formulaire est généré par carte de trimestre (voir
     renderTrimestres) : un seul panneau par trimestre suffit puisqu'on n'y
     crée/édite qu'une séquence à la fois. Les champs sont retrouvés par
     classe CSS (scopée au panneau) plutôt que par id, ces derniers étant
     dupliqués d'une carte à l'autre. ────────────────────────────────────── */

  function panelSequence(trimestreId) {
    return document.getElementById(`panelFormSequence-${trimestreId}`);
  }

  function ouvrirFormSequence(trimestreId, sequence) {
    const panel = panelSequence(trimestreId);
    if (!panel) return;
    panel.querySelector(".seqFormAlert").classList.add("d-none");
    panel.querySelector(".seqFormId").value = sequence ? sequence.id : "";
    panel.querySelector(".seqFormLibelle").value = sequence ? sequence.libelle : "";
    panel.querySelector(".seqFormDateDebut").value = sequence ? (sequence.date_debut || "") : "";
    panel.querySelector(".seqFormDateFin").value = sequence ? (sequence.date_fin || "") : "";
    panel.querySelector(".seqFormSubmitLabel").textContent = sequence ? "Enregistrer" : "Ajouter";
    panel.classList.remove("d-none");
  }

  function fermerFormSequence(trimestreId) {
    const panel = panelSequence(trimestreId);
    if (panel) panel.classList.add("d-none");
  }

  async function soumettreFormSequence(trimestreId) {
    const panel = panelSequence(trimestreId);
    if (!panel) return;
    const alertEl = panel.querySelector(".seqFormAlert");
    alertEl.classList.add("d-none");
    const id = panel.querySelector(".seqFormId").value;
    const libelle = panel.querySelector(".seqFormLibelle").value.trim();
    const date_debut = panel.querySelector(".seqFormDateDebut").value || null;
    const date_fin = panel.querySelector(".seqFormDateFin").value || null;
    if (!libelle) { alertEl.textContent = "Le libellé est requis."; alertEl.classList.remove("d-none"); return; }

    try {
      if (id) {
        await api(`/api/sequences/${id}?etablissement_id=${state.currentEtabId}`, {
          method: "PUT",
          body: JSON.stringify({ libelle, date_debut, date_fin }),
        });
        toast("success", "Séquence modifiée.");
      } else {
        await api("/api/sequences/", {
          method: "POST",
          body: JSON.stringify({ trimestre_id: trimestreId, libelle, date_debut, date_fin, etablissement_id: state.currentEtabId }),
        });
        toast("success", "Séquence ajoutée.");
      }
      const t = state.structure.trimestres.find((x) => x.id === trimestreId);
      const anneeId = t ? t.annee_scolaire_id : null;
      await chargerDonneesStructure(state.currentEtabId);
      if (anneeId) {
        document.getElementById("selectAnneeTrimestres").value = String(anneeId);
        renderTrimestres(anneeId);
      }
    } catch (err) {
      alertEl.textContent = err.message;
      alertEl.classList.remove("d-none");
    }
  }

  async function supprimerSequence(id) {
    if (!(await confirmerAction("Supprimer cette séquence ?"))) return;
    const s = state.structure.sequences.find((x) => x.id === id);
    const t = s ? state.structure.trimestres.find((x) => x.id === s.trimestre_id) : null;
    const anneeId = t ? t.annee_scolaire_id : null;
    try {
      await api(`/api/sequences/${id}?etablissement_id=${state.currentEtabId}`, { method: "DELETE" });
      toast("success", "Séquence supprimée.");
      await chargerDonneesStructure(state.currentEtabId);
      if (anneeId) {
        document.getElementById("selectAnneeTrimestres").value = String(anneeId);
        renderTrimestres(anneeId);
      }
    } catch (err) {
      toast("error", err.message);
    }
  }

  /* ── Câblage des évènements ────────────────────────────────────────────── */

  function wireEvents() {
    document.getElementById("filterRegion").addEventListener("change", applyFilters);
    document.getElementById("filterSearch").addEventListener("input", applyFilters);
    document.getElementById("btnResetFiltres").addEventListener("click", () => {
      document.getElementById("filterRegion").value = "";
      document.getElementById("filterSearch").value = "";
      applyFilters();
    });

    // Modale Nouvel/Modifier établissement : décide du mode selon le
    // bouton ayant déclenché l'ouverture (data-action="edit" + data-id).
    const modalEtab = document.getElementById("modalNouvelEtablissement");
    modalEtab.addEventListener("show.bs.modal", (event) => {
      const trigger = event.relatedTarget;
      if (trigger && trigger.dataset && trigger.dataset.action === "edit") {
        const id = Number(trigger.dataset.id);
        const etab = state.etablissements.find((e) => e.id === id);
        if (etab) setModeEdit(etab);
      } else {
        setModeCreate();
      }
    });
    document.getElementById("btnEnregistrerEtablissement").addEventListener("click", submitFormEtablissement);

    // Modale suppression
    const modalSupprimer = document.getElementById("modalSupprimer");
    modalSupprimer.addEventListener("show.bs.modal", (event) => {
      const trigger = event.relatedTarget;
      const id = trigger.dataset.id;
      const nom = trigger.dataset.nom;
      document.getElementById("supprimerNomEtab").textContent = nom;
      document.getElementById("supprimerAlert").classList.add("d-none");
      document.getElementById("btnConfirmerSuppression").dataset.id = id;
    });
    document.getElementById("btnConfirmerSuppression").addEventListener("click", confirmerSuppressionEtablissement);

    // Modale structure
    const modalStructure = document.getElementById("modalStructure");
    modalStructure.addEventListener("show.bs.modal", (event) => {
      const trigger = event.relatedTarget;
      ouvrirModaleStructure(Number(trigger.dataset.id), trigger.dataset.nom, trigger.dataset.region);
    });
    // Referme les formulaires inline encore ouverts quand on quitte la modale,
    // pour repartir propre à la prochaine ouverture (autre établissement).
    modalStructure.addEventListener("hidden.bs.modal", () => {
      fermerFormCycle();
      fermerFormClasse();
      fermerFormAnnee();
      fermerFormTrimestre();
    });

    // Boutons "Ajouter ..." : ouvrent le panneau de formulaire inline en mode
    // création (au-dessus du tableau/de la liste concerné·e). Ni prompt()
    // ni confirm() natifs ne sont utilisés sur cette page.
    document.getElementById("btnAjouterCycle").addEventListener("click", () => ouvrirFormCycle(null));
    document.getElementById("btnAjouterClasse").addEventListener("click", () => ouvrirFormClasse(null));
    document.getElementById("btnAjouterAnnee").addEventListener("click", () => ouvrirFormAnnee(null));
    document.getElementById("btnAjouterTrimestre").addEventListener("click", () => ouvrirFormTrimestre(null));

    // Boutons "Enregistrer"/"Annuler" de chaque panneau.
    document.getElementById("btnEnregistrerCycle").addEventListener("click", soumettreFormCycle);
    document.getElementById("btnAnnulerCycle").addEventListener("click", fermerFormCycle);
    document.getElementById("btnEnregistrerClasse").addEventListener("click", soumettreFormClasse);
    document.getElementById("btnAnnulerClasse").addEventListener("click", fermerFormClasse);
    document.getElementById("btnEnregistrerAnnee").addEventListener("click", soumettreFormAnnee);
    document.getElementById("btnAnnulerAnnee").addEventListener("click", fermerFormAnnee);
    document.getElementById("btnEnregistrerTrimestre").addEventListener("click", soumettreFormTrimestre);
    document.getElementById("btnAnnulerTrimestre").addEventListener("click", fermerFormTrimestre);

    document.getElementById("selectAnneeTrimestres").addEventListener("change", (e) => {
      fermerFormTrimestre();
      renderTrimestres(e.target.value ? Number(e.target.value) : null);
    });

    // Délégation d'évènements pour les actions dynamiques (edit/delete/
    // toggle cycle/classe/annee/trimestre/sequence + soumission/annulation
    // des formulaires inline de séquence), générées après coup en innerHTML.
    document.getElementById("modalStructure").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const id = btn.dataset.id ? Number(btn.dataset.id) : null;
      switch (btn.dataset.action) {
        case "edit-cycle":
          ouvrirFormCycle(state.structure.cycles.find((c) => c.id === id));
          break;
        case "delete-cycle": supprimerCycle(id); break;
        case "edit-classe":
          ouvrirFormClasse(state.structure.classes.find((c) => c.id === id));
          break;
        case "delete-classe": supprimerClasse(id); break;
        case "edit-annee":
          ouvrirFormAnnee(state.structure.annees.find((a) => a.id === id));
          break;
        case "toggle-annee": toggleAnnee(id); break;
        case "delete-annee": supprimerAnnee(id); break;
        case "edit-trimestre":
          ouvrirFormTrimestre(state.structure.trimestres.find((t) => t.id === id));
          break;
        case "delete-trimestre": supprimerTrimestre(id); break;
        case "toggle-sequence-form": {
          const tId = Number(btn.dataset.trimestreId);
          const panel = panelSequence(tId);
          if (panel && !panel.classList.contains("d-none")) {
            fermerFormSequence(tId);
          } else {
            ouvrirFormSequence(tId, null);
          }
          break;
        }
        case "submit-sequence-form": soumettreFormSequence(Number(btn.dataset.trimestreId)); break;
        case "cancel-sequence-form": fermerFormSequence(Number(btn.dataset.trimestreId)); break;
        case "edit-sequence": {
          const seq = state.structure.sequences.find((s) => s.id === id);
          if (seq) ouvrirFormSequence(seq.trimestre_id, seq);
          break;
        }
        case "delete-sequence": supprimerSequence(id); break;
      }
    });
  }

  /* ── Point d'entrée ────────────────────────────────────────────────────── */

  function init() {
    wireEvents();
    loadEtablissements();
  }

  global.EtablissementsPage = { init };
})(window);
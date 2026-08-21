import { API_BASE_URL } from "./config.js";

let allLostFoundItems = [];
let uploadedImageData = "";
let latestMatches = [];

function getValue(id) {
  return document.getElementById(id)?.value.trim() || "";
}

function getCurrentUser() {
  const rawUser = localStorage.getItem("currentUser");
  return rawUser ? JSON.parse(rawUser) : null;
}

function escapeHtml(value = "") {
  const result = value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  return result;
}

function formatDateString(dateString) {
  try {
    return new Date(dateString).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  } catch (_error) {
    return dateString;
  }
}

function getMatchSignalLabel(value) {
  if (value >= 85) return "High";
  if (value >= 65) return "Medium";
  if (value >= 40) return "Low";
  return "Weak";
}

function renderMatchEmpty(message = "No strong matches found yet. We'll show possible matches when relevant Lost & Found posts are available.") {
  const container = document.getElementById("lostFoundMatchResults");
  if (!container) return;
  container.innerHTML = `<div class="home-empty-state"><p>${escapeHtml(message)}</p></div>`;
}

function renderMatchCards(matches, options = {}) {
  const container = options.container || document.getElementById("lostFoundMatchResults");
  if (!container) return;

  if (!matches || !matches.length) {
    container.innerHTML = `<div class="home-empty-state"><p>No strong matches found yet. We'll show possible matches when relevant Lost & Found posts are available.</p></div>`;
    return;
  }

  container.innerHTML = matches.map((match, index) => {
    const item = match.item;
    const reasons = (match.reasons || []).slice(0, 4);

    return `
      <article class="ai-match-card">
        <div class="ai-match-media">
          ${item.imageUrl
            ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" loading="lazy">`
            : `<div class="product-placeholder">${escapeHtml(item.itemType || "match")}</div>`}
        </div>
        <div class="ai-match-body">
          <div class="ai-match-score-row">
            <span class="listing-pill ${escapeHtml(item.itemType)}">${escapeHtml(item.itemType)}</span>
            <strong>${match.score}% Match</strong>
          </div>
          <h3>${escapeHtml(item.title)}</h3>
          <p class="product-meta">${escapeHtml(item.category)} | ${escapeHtml(item.location)}</p>
          <p class="product-meta">${formatDateString(item.itemDate)} | ${escapeHtml(match.confidence)}</p>
          <div class="match-signal-grid" aria-label="Match signal scores">
            <span>Location<strong>${getMatchSignalLabel(match.signals?.location || 0)}</strong></span>
            <span>Category<strong>${getMatchSignalLabel(match.signals?.category || 0)}</strong></span>
            <span>Description<strong>${getMatchSignalLabel(match.signals?.text || 0)}</strong></span>
            <span>Date<strong>${getMatchSignalLabel(match.signals?.date || 0)}</strong></span>
          </div>
          <ul class="match-reasons">
            ${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
          </ul>
          <div class="product-actions">
            <button type="button" class="secondary-action" data-view-match="${index}">View Item</button>
            <button type="button" class="primary-action" data-contact-match="${index}">Contact Owner</button>
          </div>
        </div>
      </article>
    `;
  }).join("");

  container.querySelectorAll("[data-view-match]").forEach((button) => {
    button.addEventListener("click", () => {
      const match = matches[Number(button.getAttribute("data-view-match"))];
      if (match?.item) openLostFoundDetail(match.item);
    });
  });

  container.querySelectorAll("[data-contact-match]").forEach((button) => {
    button.addEventListener("click", async () => {
      const match = matches[Number(button.getAttribute("data-contact-match"))];
      if (match?.item) await contactLostFoundOwner(match.item.id);
    });
  });
}

async function apiRequest(path, options = {}) {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Request failed.");
    }

    return data;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Cannot reach the server. Start the app with 'npm start' and open http://localhost:3000.");
    }
    throw error;
  }
}

async function loadLostFound() {
  const type = document.getElementById("lostFoundType")?.value || "";
  const category = document.getElementById("lostFoundCategory")?.value.trim() || "";
  const date = document.getElementById("lostFoundDate")?.value || "";
  
  const params = new URLSearchParams();
  if (type) params.append("type", type);
  if (category) params.append("category", category);
  if (date) params.append("date", date);
  
  try {
    const data = await apiRequest(`/lost-found?${params.toString()}`);
    allLostFoundItems = data.items || [];
    renderLostFoundItems(allLostFoundItems);
    if (!latestMatches.length) {
      renderMatchEmpty();
    }
  } catch (error) {
    const list = document.getElementById("lostFoundList");
    if (list) {
      list.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
    }
  }
}

function renderLostFoundItems(items) {
  const list = document.getElementById("lostFoundList");
  const currentUser = getCurrentUser();
  
  if (!list) {
    return;
  }
  
  if (!items || !items.length) {
    list.innerHTML = '<p class="empty-state">No lost or found items match your filters.</p>';
    return;
  }
  
  list.innerHTML = items.map((item) => {
    const isResolved = item.status === "resolved";
    const isOwner = currentUser && item.userId === currentUser.id;
    const resolvedBadge = isResolved ? '<span class="pill" style="background:var(--mint);color:#0c6b52">Resolved</span>' : "";
    
    return `
      <article class="product-card lost-found-item">
        <button type="button" class="product-image product-image-button" data-view-item-id="${item.id}" aria-label="View details for ${escapeHtml(item.title)}">
          ${item.imageUrl
            ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" loading="lazy">`
            : `<div class="product-placeholder">${escapeHtml(item.itemType)}</div>`}
        </button>
        <div class="product-header">
          <div>
            <h3><button type="button" class="product-title-button" data-view-item-id="${item.id}">${escapeHtml(item.title)}</button></h3>
            <p class="product-meta">${escapeHtml(item.category)} | ${escapeHtml(item.location)}</p>
            <p class="product-meta">Date: ${formatDateString(item.itemDate)}</p>
          </div>
          <div class="listing-badge-row">
            <span class="listing-pill ${escapeHtml(item.itemType)}">${escapeHtml(item.itemType)}</span>
            ${resolvedBadge}
          </div>
        </div>
        <p class="product-description">${escapeHtml(item.description)}</p>
        <div class="product-actions">
          <button type="button" class="secondary-action" data-view-item-id="${item.id}">View Item</button>
          ${!isOwner ? `<button type="button" class="primary-action" data-contact-item-id="${item.id}">Contact Owner</button>` : ""}
          ${isOwner && !isResolved
            ? `<button type="button" class="secondary-action" data-resolve-item-id="${item.id}">Mark Resolved</button>`
            : ""}
        </div>
      </article>
    `;
  }).join("");
  
  list.querySelectorAll("[data-resolve-item-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const itemId = Number(button.getAttribute("data-resolve-item-id"));
      await resolveLostFoundItem(itemId);
    });
  });

  list.querySelectorAll("[data-view-item-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const itemId = Number(button.getAttribute("data-view-item-id"));
      const item = allLostFoundItems.find((entry) => entry.id === itemId);
      if (item) openLostFoundDetail(item);
    });
  });

  list.querySelectorAll("[data-contact-item-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const itemId = Number(button.getAttribute("data-contact-item-id"));
      await contactLostFoundOwner(itemId);
    });
  });
}

async function resolveLostFoundItem(itemId) {
  const currentUser = getCurrentUser();
  
  if (!currentUser) {
    alert("Please log in first.");
    window.location.href = "login.html";
    return;
  }
  
  try {
    await apiRequest(`/lost-found/${itemId}/resolve`, {
      method: "PATCH",
      body: JSON.stringify({ userId: currentUser.id })
    });
    alert("Item marked as resolved.");
    await loadLostFound();
  } catch (error) {
    alert(error.message);
  }
}

async function handleLostFoundFormSubmit(event) {
  event.preventDefault();
  
  const currentUser = getCurrentUser();
  if (!currentUser) {
    alert("Please log in first.");
    window.location.href = "login.html";
    return;
  }
  
  const form = event.target;
  const formData = new FormData(form);
  
  const itemType = formData.get("itemType");
  const title = formData.get("title")?.trim() || "";
  const category = formData.get("category")?.trim() || "";
  const description = formData.get("description")?.trim() || "";
  const itemDate = formData.get("itemDate") || "";
  const location = formData.get("location")?.trim() || "";
  
  if (!itemType || !title || !category || !description || !itemDate || !location) {
    alert("Please fill in all Lost & Found fields.");
    return;
  }
  
  try {
    const data = await apiRequest("/lost-found", {
      method: "POST",
      body: JSON.stringify({
        userId: currentUser.id,
        itemType,
        title,
        category,
        description,
        itemDate,
        location,
        imageUrl: uploadedImageData || null
      })
    });
    
    alert("Lost & Found item posted!");
    latestMatches = data.matches || [];
    if (data.matchingError) {
      renderMatchEmpty("Your item was posted successfully. Possible matches could not be loaded right now.");
    } else {
      renderMatchCards(latestMatches);
    }
    form.reset();
    uploadedImageData = "";
    setImagePreview("");
    clearLostFoundFilters();
    await loadLostFound();
  } catch (error) {
    alert(error.message);
  }
}

async function contactLostFoundOwner(itemId) {
  const currentUser = getCurrentUser();

  if (!currentUser) {
    alert("Please log in first to contact the owner.");
    window.location.href = "login.html";
    return;
  }

  try {
    const data = await apiRequest(`/lost-found/${itemId}/contact`, {
      method: "POST",
      body: JSON.stringify({ userId: currentUser.id })
    });
    alert(data.message || "The owner has been notified.");
  } catch (error) {
    alert(error.message);
  }
}

async function loadMatchesForItem(itemId) {
  const data = await apiRequest(`/lost-found/${itemId}/matches`);
  return data.matches || [];
}

async function openLostFoundDetail(item) {
  const modal = document.getElementById("lostFoundDetailModal");
  const currentUser = getCurrentUser();
  if (!modal) return;

  const isOwner = currentUser && currentUser.id === item.userId;

  modal.innerHTML = `
    <article class="modal-card product-detail-card" role="dialog" aria-modal="true" aria-labelledby="lostFoundDetailTitle">
      <button type="button" class="modal-close" data-close-lost-found-detail aria-label="Close item details">Close</button>
      <div class="product-detail-layout">
        <div class="product-image detail-image">
          ${item.imageUrl
            ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" loading="lazy">`
            : `<div class="product-placeholder">${escapeHtml(item.itemType || "item")}</div>`}
        </div>
        <div class="product-detail-content">
          <span class="listing-pill ${escapeHtml(item.itemType)}">${escapeHtml(item.itemType)}</span>
          <h2 id="lostFoundDetailTitle">${escapeHtml(item.title)}</h2>
          <div class="detail-meta-grid">
            <span>Category<strong>${escapeHtml(item.category)}</strong></span>
            <span>Location<strong>${escapeHtml(item.location)}</strong></span>
            <span>Date<strong>${formatDateString(item.itemDate)}</strong></span>
            <span>Status<strong>${item.status === "resolved" ? "Resolved" : "Active"}</strong></span>
          </div>
          <p class="product-description">${escapeHtml(item.description)}</p>
          <div class="product-actions">
            ${!isOwner ? `<button type="button" class="primary-action" data-detail-contact-owner="${item.id}">Contact Owner</button>` : ""}
            ${isOwner && item.status !== "resolved" ? `<button type="button" class="secondary-action" data-detail-resolve="${item.id}">Mark Resolved</button>` : ""}
          </div>
          <section class="ai-match-section compact-ai-match">
            <div class="section-heading">
              <div>
                <p class="eyebrow">Possible AI Matches</p>
                <h2>Related ${item.itemType === "lost" ? "found" : "lost"} posts</h2>
              </div>
            </div>
            <div class="ai-match-grid detail-match-grid" id="detailMatchResults">
              <div class="home-empty-state"><p>Loading possible matches...</p></div>
            </div>
          </section>
        </div>
      </div>
    </article>
  `;

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");

  modal.querySelector("[data-close-lost-found-detail]")?.addEventListener("click", closeLostFoundDetail);
  modal.querySelector("[data-detail-contact-owner]")?.addEventListener("click", async () => {
    await contactLostFoundOwner(item.id);
  });
  modal.querySelector("[data-detail-resolve]")?.addEventListener("click", async () => {
    await resolveLostFoundItem(item.id);
    closeLostFoundDetail();
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeLostFoundDetail();
  }, { once: true });

  try {
    const matches = await loadMatchesForItem(item.id);
    renderMatchCards(matches, { container: document.getElementById("detailMatchResults") });
  } catch (error) {
    const container = document.getElementById("detailMatchResults");
    if (container) {
      container.innerHTML = `<div class="home-empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    }
  }
}

function closeLostFoundDetail() {
  const modal = document.getElementById("lostFoundDetailModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function setImagePreview(imageDataUrl) {
  const preview = document.getElementById("imagePreview");
  if (!preview) {
    return;
  }
  
  if (!imageDataUrl) {
    preview.classList.add("empty-state");
    preview.innerHTML = "<p>No image selected yet.</p>";
    return;
  }
  
  preview.classList.remove("empty-state");
  preview.innerHTML = `<img src="${imageDataUrl}" alt="Selected preview">`;
}

function initializeLostFoundForm() {
  const form = document.getElementById("lostFoundForm");
  if (!form) {
    return;
  }
  
  form.addEventListener("submit", handleLostFoundFormSubmit);
  
  const imageInput = form.querySelector('input[name="image"]');
  if (imageInput) {
    imageInput.addEventListener("change", (event) => {
      const [file] = event.target.files || [];
      if (!file) {
        uploadedImageData = "";
        setImagePreview("");
        return;
      }
      
      const reader = new FileReader();
      reader.onload = () => {
        uploadedImageData = typeof reader.result === "string" ? reader.result : "";
        setImagePreview(uploadedImageData);
      };
      reader.readAsDataURL(file);
    });
  }
}

function initializeLostFoundFilters() {
  const filterButton = document.querySelector('button[onclick="loadLostFound()"]');
  if (filterButton) {
    filterButton.addEventListener("click", (e) => {
      e.preventDefault();
      loadLostFound();
    });
  }
}

function initializeCampusTabs() {
  const tabs = document.querySelectorAll("[data-campus-tab]");
  const panels = document.querySelectorAll(".campus-panel");
  
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      
      const targetId = tab.getAttribute("data-campus-tab");
      panels.forEach((panel) => {
        panel.classList.remove("active");
        if (panel.id === targetId) {
          panel.classList.add("active");
        }
      });
    });
  });
}

function clearLostFoundFilters() {
  const type = document.getElementById("lostFoundType");
  const category = document.getElementById("lostFoundCategory");
  const date = document.getElementById("lostFoundDate");

  if (type) type.value = "";
  if (category) category.value = "";
  if (date) date.value = "";
}

window.loadLostFound = loadLostFound;
window.logout = function () {
  localStorage.removeItem("currentUser");
  window.location.href = "login.html";
};

window.addEventListener("DOMContentLoaded", () => {
  initializeCampusTabs();
  initializeLostFoundForm();
  initializeLostFoundFilters();
  loadLostFound();
});

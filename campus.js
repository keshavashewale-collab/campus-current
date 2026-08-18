import { API_BASE_URL } from "./config.js";

let allLostFoundItems = [];
let uploadedImageData = "";

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
        <div class="product-image">
          ${item.imageUrl
            ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}">`
            : `<div class="product-placeholder">${escapeHtml(item.itemType)}</div>`}
        </div>
        <div class="product-header">
          <div>
            <h3>${escapeHtml(item.title)}</h3>
            <p class="product-meta">${escapeHtml(item.category)} | ${escapeHtml(item.location)}</p>
            <p class="product-meta">Date: ${formatDateString(item.itemDate)} | User: ${escapeHtml(item.email)}</p>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="listing-pill ${escapeHtml(item.itemType)}">${escapeHtml(item.itemType)}</span>
            ${resolvedBadge}
          </div>
        </div>
        <p class="product-description">${escapeHtml(item.description)}</p>
        <div class="product-actions">
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
    await apiRequest("/lost-found", {
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
    form.reset();
    uploadedImageData = "";
    setImagePreview("");
    clearLostFoundFilters();
    await loadLostFound();
  } catch (error) {
    alert(error.message);
  }
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

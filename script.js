import { API_BASE_URL } from "./config.js";

let allProducts = [];
let activeFilter = "all";
let selectedProduct = null;
let selectedReceiverId = null;
let uploadedImageData = "";
let chatImageData = "";
let lostFoundItems = [];

// Validate URL to prevent SSRF - only allow same-origin or localhost
function isValidApiUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    
    // Allow same origin
    if (parsedUrl.origin === window.location.origin) {
      return true;
    }
    
    // Allow localhost for development
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }
    
    // Block private IP ranges
    const privateRanges = [
      /^10\./,              // 10.0.0.0/8
      /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.0.0/12
      /^192\.168\./,        // 192.168.0.0/16
      /^169\.254\./,        // 169.254.0.0/16 (link-local)
      /^127\./,             // 127.0.0.0/8 (loopback)
      /^0\./,               // 0.0.0.0
      /^::1$/,              // IPv6 loopback
      /^fc[0-9a-fA-F]:/,    // IPv6 unique local addr (fc00::/7)
      /^fd[0-9a-fA-F]:/,    // IPv6 unique local addr (fd00::/8)
      /^fe80:/              // IPv6 link-local (fe80::/10)
    ];
    
    for (const pattern of privateRanges) {
      if (pattern.test(hostname)) {
        return false;
      }
    }
    
    return false; // Block all other external URLs
  } catch (e) {
    return false; // Invalid URL
  }
}

function getValue(id) {
  return document.getElementById(id)?.value.trim() || "";
}

function setCurrentUser(user) {
  localStorage.setItem("currentUser", JSON.stringify(user));
}

function getCurrentUser() {
  const rawUser = localStorage.getItem("currentUser");
  return rawUser ? JSON.parse(rawUser) : null;
}
function clearCurrentUser() {
  localStorage.removeItem("currentUser");
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPrice(price) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0
  }).format(Number(price) || 0);
}

function formatListingType(type) {
  return type === "buy" ? "Buy request" : "Sell post";
}

function formatLostFoundType(type) {
  return type === "lost" ? "Lost" : "Found";
}

async function apiRequest(path, options = {}) {
  // Validate that path starts with / and doesn't contain dangerous patterns
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('Invalid API path');
  }
  
  // Construct the full URL safely
  const fullPath = `${API_BASE_URL}${path}`;
  
  // Validate URL to prevent SSRF
  if (!isValidApiUrl(fullPath)) {
    throw new Error('Invalid API endpoint. Access denied.');
  }
  
  try {
    const response = await fetch(fullPath, {
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

function protectPage() {
  const currentUser = getCurrentUser();
  const isProtectedPage = document.getElementById("products") || document.getElementById("title") || document.getElementById("listingFilters");

  if (isProtectedPage && !currentUser) {
    window.location.href = "login.html";
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
  preview.innerHTML = `<img src="${imageDataUrl}" alt="Selected product preview">`;
}

function initializeImageUpload() {
  const imageInput = document.getElementById("imageUpload");

  if (!imageInput) {
    return;
  }

  setImagePreview("");

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

function setChatImagePreview(imageDataUrl) {
  const preview = document.getElementById("chatImagePreview");

  if (!preview) {
    return;
  }

  if (!imageDataUrl) {
    preview.classList.add("empty-state");
    preview.innerHTML = "<p>No chat image selected.</p>";
    return;
  }

  preview.classList.remove("empty-state");
  preview.innerHTML = `<img src="${imageDataUrl}" alt="Selected chat attachment">`;
}

function initializeChatImageUpload() {
  const chatImageInput = document.getElementById("chatImageUpload");

  if (!chatImageInput) {
    return;
  }

  setChatImagePreview("");

  chatImageInput.addEventListener("change", (event) => {
    const [file] = event.target.files || [];

    if (!file) {
      chatImageData = "";
      setChatImagePreview("");
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      chatImageData = typeof reader.result === "string" ? reader.result : "";
      setChatImagePreview(chatImageData);
    };

    reader.readAsDataURL(file);
  });
}

function updateStats(products) {
  const listingCount = document.getElementById("listingCount");
  const sellCount = document.getElementById("sellCount");
  const buyCount = document.getElementById("buyCount");

  if (!listingCount || !sellCount || !buyCount) {
    return;
  }

  listingCount.textContent = String(products.length);
  sellCount.textContent = String(products.filter((product) => product.listingType === "sell").length);
  buyCount.textContent = String(products.filter((product) => product.listingType === "buy").length);
}

function getVisibleProducts() {
  const searchQuery = getValue("searchInput").toLowerCase();

  return allProducts.filter((product) => {
    const matchesFilter = activeFilter === "all" || product.listingType === activeFilter;
    const haystack = [
      product.title,
      product.category,
      product.description,
      product.email
    ].join(" ").toLowerCase();
    const matchesSearch = !searchQuery || haystack.includes(searchQuery);

    return matchesFilter && matchesSearch;
  });
}

function renderProducts() {
  const productDiv = document.getElementById("products");

  if (!productDiv) {
    return;
  }

  const currentUser = getCurrentUser();
  
  // If Lost & Found filter is active, show lost & found items instead of products
  if (activeFilter === "lostFound") {
    renderLostFoundItems(lostFoundItems);
    return;
  }
  
  const products = getVisibleProducts();
  updateStats(products);

  if (!products.length) {
    productDiv.innerHTML = `
      <div class="product-card empty-state">
        <p>No listings match this view yet. Try another filter or create a new post.</p>
      </div>
    `;
    return;
  }

  productDiv.innerHTML = products.map((product) => {
    const contactAction = product.listingType === "buy" ? "Offer Item" : "Message";
    const primaryAction = product.listingType === "buy" ? "Respond to Need" : "Buy Now";
    const ownListing = currentUser && currentUser.id === product.userId;
    const actionLabel = ownListing ? "Open Chat" : contactAction;

    return `
      <article class="product-card" data-listing-card="${product.id}">
        <button type="button" class="product-image product-image-button" data-open-detail="${product.id}" aria-label="View details for ${escapeHtml(product.title)}">
          ${product.imageUrl
            ? `<img src="${product.imageUrl}" alt="${escapeHtml(product.title)}" loading="lazy">`
            : `<div class="product-placeholder">${product.listingType === "buy" ? "WANT" : "SALE"}</div>`}
        </button>
        <div class="product-header">
          <div>
            <h3><button type="button" class="product-title-button" data-open-detail="${product.id}">${escapeHtml(product.title)}</button></h3>
            <p class="product-meta">${escapeHtml(product.category)} | ${escapeHtml(product.email)}</p>
          </div>
          <span class="listing-pill ${escapeHtml(product.listingType)}">${formatListingType(product.listingType)}</span>
        </div>
        <p class="product-price">Rs. ${formatPrice(product.price)}</p>
        <p class="product-description">${escapeHtml(product.description)}</p>
        <div class="product-actions">
          <button type="button" class="secondary-action" data-open-detail="${product.id}">View Details</button>
          <button type="button" class="primary-action" data-product-id="${product.id}">${primaryAction}</button>
          <button type="button" class="secondary-action" data-product-id="${product.id}">${actionLabel}</button>
          ${!ownListing ? `<button type="button" class="secondary-action" data-contact-email="${escapeHtml(product.email)}">Contact Person</button>` : ""}
          ${!ownListing ? `<button type="button" class="secondary-action" data-message-seller="${product.id}">Message Seller</button>` : ""}
        </div>
      </article>
    `;
  }).join("");

  productDiv.querySelectorAll("[data-product-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const productId = Number(button.getAttribute("data-product-id"));
      const product = allProducts.find((item) => item.id === productId);

      if (!product) {
        return;
      }

      if (button.classList.contains("primary-action")) {
        const safeEmail = escapeHtml(product.email);
        alert(product.listingType === "buy"
          ? `You can now message ${safeEmail} to offer this item.`
          : `You can now message ${safeEmail} to buy this item.`);
      }

      openChat(product);
    });
  });

  productDiv.querySelectorAll("[data-contact-email]").forEach((button) => {
    button.addEventListener("click", () => {
      const email = button.getAttribute("data-contact-email");
      contactLostFoundPoster(email);
    });
  });

  productDiv.querySelectorAll("[data-open-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      const productId = Number(button.getAttribute("data-open-detail"));
      const product = allProducts.find((item) => item.id === productId);
      if (product) {
        openProductDetail(product);
      }
    });
  });
}

function initializeFilters() {
  const filterButtons = document.querySelectorAll("[data-filter]");
  const searchInput = document.getElementById("searchInput");
  const categoryButtons = document.querySelectorAll("[data-category-search]");

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.getAttribute("data-filter") || "all";
      filterButtons.forEach((pill) => pill.classList.remove("active"));
      button.classList.add("active");

      if (activeFilter === "lostFound") {
        loadLostFound();
      } else {
        renderProducts();
      }
    });
  });

  searchInput?.addEventListener("input", () => {
    if (activeFilter === "lostFound") {
      renderLostFoundItems(lostFoundItems);
    } else {
      renderProducts();
    }
  });

  categoryButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!searchInput) {
        return;
      }
      searchInput.value = button.getAttribute("data-category-search") || "";
      searchInput.focus();
      if (activeFilter === "lostFound") {
        renderLostFoundItems(lostFoundItems);
      } else {
        renderProducts();
      }
    });
  });
}

function openProductDetail(product) {
  const modal = document.getElementById("productDetailModal");
  const currentUser = getCurrentUser();

  if (!modal) {
    return;
  }

  const ownListing = currentUser && currentUser.id === product.userId;
  const imageMarkup = product.imageUrl
    ? `<img src="${product.imageUrl}" alt="${escapeHtml(product.title)}" loading="lazy">`
    : `<div class="product-placeholder">${product.listingType === "buy" ? "WANT" : "SALE"}</div>`;

  modal.innerHTML = `
    <article class="modal-card product-detail-card" role="dialog" aria-modal="true" aria-labelledby="productDetailTitle">
      <button type="button" class="modal-close" data-close-detail aria-label="Close product details">Close</button>
      <div class="product-detail-layout">
        <div class="product-image detail-image">${imageMarkup}</div>
        <div class="product-detail-content">
          <span class="listing-pill ${escapeHtml(product.listingType)}">${formatListingType(product.listingType)}</span>
          <h2 id="productDetailTitle">${escapeHtml(product.title)}</h2>
          <p class="product-price">Rs. ${formatPrice(product.price)}</p>
          <div class="detail-meta-grid">
            <span>Category<strong>${escapeHtml(product.category)}</strong></span>
            <span>Seller<strong>${escapeHtml(product.email)}</strong></span>
          </div>
          <p class="product-description">${escapeHtml(product.description)}</p>
          <div class="product-actions">
            <button type="button" class="primary-action" data-detail-chat="${product.id}">${ownListing ? "Open Chat" : "Message Seller"}</button>
            ${!ownListing ? `<button type="button" class="secondary-action" data-detail-contact="${escapeHtml(product.email)}">Contact Person</button>` : ""}
          </div>
        </div>
      </div>
    </article>
  `;

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");

  modal.querySelector("[data-close-detail]")?.addEventListener("click", closeProductDetail);
  modal.querySelector("[data-detail-chat]")?.addEventListener("click", () => {
    closeProductDetail();
    openChat(product);
  });
  modal.querySelector("[data-detail-contact]")?.addEventListener("click", (event) => {
    contactLostFoundPoster(event.currentTarget.getAttribute("data-detail-contact"));
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeProductDetail();
    }
  }, { once: true });
}

function closeProductDetail() {
  const modal = document.getElementById("productDetailModal");
  if (!modal) {
    return;
  }

  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

async function loadProducts() {
  const productDiv = document.getElementById("products");

  if (!productDiv) {
    return;
  }

  try {
    const data = await apiRequest("/products");
    allProducts = data.products;
    renderProducts();
  } catch (error) {
    productDiv.innerHTML = `<div class="product-card empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function formatMessageTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } catch (_error) {
    return "";
  }
}

async function renderChat(product) {
  const currentUser = getCurrentUser();
  const chatMessages = document.getElementById("chatMessages");
  const chatTitle = document.getElementById("chatTitle");
  const chatStatus = document.getElementById("chatStatus");

  if (!currentUser || !chatMessages || !chatTitle || !chatStatus) {
    return;
  }

  chatTitle.textContent = product.title;
  chatStatus.textContent = currentUser.id === product.userId
    ? "You are the listing owner"
    : `Chat with ${product.email}`;

  try {
    const data = await apiRequest(`/messages/${product.id}?userId=${currentUser.id}`);
    const latestOtherMessage = [...data.messages].reverse().find((message) => message.senderId !== currentUser.id);

    if (currentUser.id === product.userId) {
      selectedReceiverId = latestOtherMessage?.senderId || null;
    }

    if (!data.messages.length) {
      chatMessages.className = "chat-messages empty-state";
      chatMessages.innerHTML = currentUser.id === product.userId
        ? "<p>No buyer messages yet. Once someone contacts you, their conversation will appear here.</p>"
        : "<p>No messages yet. Start the conversation from this chatbox.</p>";
      return;
    }

    chatMessages.className = "chat-messages";
    chatMessages.innerHTML = data.messages.map((message) => {
      const isSelf = message.senderId === currentUser.id;
      return `
        <article class="message ${isSelf ? "self" : "other"}">
          <div class="message-content">
            ${message.message ? `<div>${escapeHtml(message.message)}</div>` : ""}
            ${message.imageUrl ? `<img class="message-image" src="${message.imageUrl}" alt="Chat attachment" loading="lazy">` : ""}
          </div>
          <small>${isSelf ? "You" : escapeHtml(message.senderEmail || '')} | ${formatMessageTime(message.createdAt)}</small>
        </article>
      `;
    }).join("");

    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (error) {
    chatMessages.className = "chat-messages empty-state";
    chatMessages.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

function openChat(product) {
  const currentUser = getCurrentUser();
  const chatColumn = document.querySelector(".chat-column");

  if (!currentUser) {
    window.location.href = "login.html";
    return;
  }

  selectedProduct = product;
  selectedReceiverId = currentUser.id === product.userId ? null : product.userId;
  chatColumn?.classList.add("open");
  renderChat(product);
}

window.closeDashboardChat = function () {
  document.querySelector(".chat-column")?.classList.remove("open");
};

window.sendMessage = async function () {
  const currentUser = getCurrentUser();
  const message = getValue("chatInput");

  if (!currentUser) {
    alert("Please log in first.");
    return;
  }

  if (!selectedProduct) {
    alert("Please select a listing first.");
    return;
  }

  if (!message && !chatImageData) {
    alert("Please enter a message or add an image.");
    return;
  }

  const receiverId = selectedReceiverId || selectedProduct.userId;

  if (receiverId === currentUser.id) {
    alert("Open a buyer conversation first so your reply goes to the right person.");
    return;
  }

  try {
    await apiRequest("/messages", {
      method: "POST",
      body: JSON.stringify({
        productId: selectedProduct.id,
        senderId: currentUser.id,
        receiverId,
        message,
        imageUrl: chatImageData
      })
    });

    document.getElementById("chatInput").value = "";
    const chatImageInput = document.getElementById("chatImageUpload");
    if (chatImageInput) {
      chatImageInput.value = "";
    }
    chatImageData = "";
    setChatImagePreview("");
    await renderChat(selectedProduct);
  } catch (error) {
    alert(error.message);
  }
};

window.signup = async function () {
  const email = getValue("email");
  const password = getValue("password");

  if (!email || !password) {
    alert("Please enter email and password.");
    return;
  }

  try {
    await apiRequest("/signup", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    alert("Signup successful! Please log in.");
    window.location.href = "login.html";
  } catch (error) {
    alert(error.message);
  }
};

window.login = async function () {
  const email = getValue("email");
  const password = getValue("password");

  if (!email || !password) {
    alert("Please enter email and password.");
    return;
  }

  try {
    const data = await apiRequest("/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    setCurrentUser(data.user);
    alert("Login successful!");
    window.location.href = "dashboard.html";
  } catch (error) {
    alert(error.message);
  }
};

window.logout = function () {
  clearCurrentUser();
  window.location.href = "login.html";
};

window.addProduct = async function () {
  const currentUser = getCurrentUser();
  const title = getValue("title");
  const price = getValue("price");
  const category = getValue("category");
  const desc = getValue("desc");
  const listingType = document.querySelector('input[name="listingType"]:checked')?.value || "sell";

  if (!currentUser) {
    alert("Please log in first.");
    window.location.href = "login.html";
    return;
  }

  if (!title || !price || !category || !desc) {
    alert("Please fill in all product fields.");
    return;
  }

  try {
    await apiRequest("/products", {
      method: "POST",
      body: JSON.stringify({
        title,
        price,
        category,
        desc,
        userId: currentUser.id,
        listingType,
        imageUrl: uploadedImageData
      })
    });

    alert("Listing added!");
    window.location.href = "dashboard.html";
  } catch (error) {
    alert(error.message);
  }
};

let homepageData = {
  products: [],
  lostFound: [],
  studyMaterials: []
};

function safeText(value = "") {
  return escapeHtml(String(value ?? ""));
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

function getHomepageQuery() {
  return getValue("homepageSearch").toLowerCase();
}

function matchesHomepageQuery(values) {
  const query = getHomepageQuery();
  if (!query) {
    return true;
  }

  return values.join(" ").toLowerCase().includes(query);
}

function renderHomeEmpty(container, message) {
  container.innerHTML = `<div class="home-empty-state"><p>${safeText(message)}</p></div>`;
}

function renderHomeProductCards(containerId, products, emptyMessage) {
  const container = document.getElementById(containerId);
  if (!container) {
    return;
  }

  if (!products.length) {
    renderHomeEmpty(container, emptyMessage);
    return;
  }

  container.innerHTML = products.map((product) => {
    const listingLabel = formatListingType(product.listingType);
    const imageMarkup = product.imageUrl
      ? `<img src="${safeText(product.imageUrl)}" alt="${safeText(product.title)}" loading="lazy">`
      : `<div class="home-card-placeholder">${product.listingType === "buy" ? "WANT" : "SALE"}</div>`;

    return `
      <a class="home-product-card" href="dashboard.html" aria-label="Open ${safeText(product.title)} in marketplace">
        <div class="home-card-media">${imageMarkup}</div>
        <div class="home-card-body">
          <div class="home-card-kicker">
            <span class="listing-pill ${safeText(product.listingType)}">${safeText(listingLabel)}</span>
            <span class="home-card-price">Rs. ${formatPrice(product.price)}</span>
          </div>
          <h3 class="home-card-title">${safeText(product.title)}</h3>
          <p class="home-card-meta">${safeText(product.category)} | ${safeText(product.email)}</p>
          <p class="home-card-description">${safeText(product.description)}</p>
        </div>
      </a>
    `;
  }).join("");
}

function renderHomeLostFoundCards(items) {
  const container = document.getElementById("homeLostFound");
  if (!container) {
    return;
  }

  if (!items.length) {
    renderHomeEmpty(container, "No Lost & Found posts match this search yet.");
    return;
  }

  container.innerHTML = items.map((item) => {
    const imageMarkup = item.imageUrl
      ? `<img src="${safeText(item.imageUrl)}" alt="${safeText(item.title)}" loading="lazy">`
      : `<div class="home-card-placeholder">${item.itemType === "lost" ? "LOST" : "FOUND"}</div>`;

    return `
      <a class="home-product-card" href="campus.html" aria-label="Open ${safeText(item.title)} in Lost and Found">
        <div class="home-card-media">${imageMarkup}</div>
        <div class="home-card-body">
          <div class="home-card-kicker">
            <span class="listing-pill ${safeText(item.itemType)}">${formatLostFoundType(item.itemType)}</span>
            <span class="home-card-meta">${safeText(item.status || "open")}</span>
          </div>
          <h3 class="home-card-title">${safeText(item.title)}</h3>
          <p class="home-card-meta">${safeText(item.category)} | ${safeText(item.location)}</p>
          <p class="home-card-description">${safeText(item.description)}</p>
        </div>
      </a>
    `;
  }).join("");
}

function renderHomeStudyCards(materials) {
  const container = document.getElementById("homeStudyMaterials");
  if (!container) {
    return;
  }

  if (!materials.length) {
    renderHomeEmpty(container, "No study materials match this search yet.");
    return;
  }

  container.innerHTML = materials.map((material) => `
    <a class="home-product-card" href="campus.html" aria-label="Open ${safeText(material.title)} in study materials">
      <div class="home-card-media">
        <div class="home-card-placeholder">${safeText(material.materialType || "NOTES")}</div>
      </div>
      <div class="home-card-body">
        <div class="home-card-kicker">
          <span class="listing-pill buy">${safeText(material.subject || "Study")}</span>
          <span class="home-card-meta">${safeText(material.semester || "")}</span>
        </div>
        <h3 class="home-card-title">${safeText(material.title)}</h3>
        <p class="home-card-meta">${safeText(material.department)} | ${safeText(material.yearLabel)}</p>
        <p class="home-card-description">${safeText(material.description || material.fileName || "")}</p>
      </div>
    </a>
  `).join("");
}

function renderHomeHeroListing(products) {
  const heroListing = document.getElementById("homeHeroListing");
  if (!heroListing) {
    return;
  }

  const [latest] = products;
  if (!latest) {
    heroListing.innerHTML = `
      <p class="card-label">Live marketplace</p>
      <strong>No listings yet</strong>
      <span>Create the first campus post today</span>
    `;
    return;
  }

  heroListing.innerHTML = `
    <p class="card-label">Live marketplace</p>
    <strong>${safeText(latest.title)}</strong>
    <span>Rs. ${formatPrice(latest.price)} | ${safeText(latest.category)}</span>
  `;
}

function renderHomepageSections() {
  const activeProducts = homepageData.products.filter((product) => product.status !== "sold");
  const matchingProducts = activeProducts.filter((product) => matchesHomepageQuery([
    product.title,
    product.category,
    product.description,
    product.email,
    product.listingType
  ]));
  const matchingLostFound = homepageData.lostFound.filter((item) => matchesHomepageQuery([
    item.title,
    item.category,
    item.description,
    item.location,
    item.itemType
  ]));
  const matchingStudyMaterials = homepageData.studyMaterials.filter((material) => matchesHomepageQuery([
    material.title,
    material.department,
    material.subject,
    material.materialType,
    material.description,
    material.fileName
  ]));

  const trending = [...matchingProducts]
    .sort((a, b) => Number(b.sellerReviewCount || 0) - Number(a.sellerReviewCount || 0))
    .slice(0, 6);
  const recentlyAdded = matchingProducts.slice(0, 4);
  const nearby = matchingProducts.filter((product) => product.listingType === "sell").slice(0, 4);

  renderHomeProductCards("trendingListings", trending, "No trending listings match this search yet.");
  renderHomeProductCards("recentListings", recentlyAdded, "No recent listings match this search yet.");
  renderHomeProductCards("nearbyListings", nearby.length ? nearby : matchingProducts.slice(0, 4), "No nearby listings match this search yet.");
  renderHomeLostFoundCards(matchingLostFound.slice(0, 6));
  renderHomeStudyCards(matchingStudyMaterials.slice(0, 6));
}

async function initializeHomepage() {
  const homepageSearch = document.getElementById("homepageSearch");
  const homepageSearchForm = document.getElementById("homepageSearchForm");
  const hasHomepage = document.getElementById("trendingListings");

  if (!hasHomepage) {
    return;
  }

  ["trendingListings", "recentListings", "nearbyListings", "homeLostFound", "homeStudyMaterials"].forEach((id) => {
    const container = document.getElementById(id);
    if (container) {
      renderHomeEmpty(container, "Loading live campus data...");
    }
  });

  homepageSearch?.addEventListener("input", renderHomepageSections);
  homepageSearchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    renderHomepageSections();
  });

  try {
    const [productData, lostFoundData, studyData] = await Promise.all([
      apiRequest("/products"),
      apiRequest("/lost-found"),
      apiRequest("/study-materials")
    ]);

    homepageData = {
      products: productData.products || [],
      lostFound: lostFoundData.items || [],
      studyMaterials: studyData.materials || []
    };

    setText("homeListingTotal", homepageData.products.length);
    setText("homeLostFoundTotal", homepageData.lostFound.length);
    setText("homeStudyTotal", homepageData.studyMaterials.length);
    renderHomeHeroListing(homepageData.products);
    renderHomepageSections();
  } catch (error) {
    ["trendingListings", "recentListings", "nearbyListings", "homeLostFound", "homeStudyMaterials"].forEach((id) => {
      const container = document.getElementById(id);
      if (container) {
        renderHomeEmpty(container, error.message);
      }
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  protectPage();
  initializeImageUpload();
  initializeChatImageUpload();
  initializeFilters();
  initializeHomepage();
  loadProducts();
  initializeLostFound();
});

// Lost & Found functionality
window.loadLostFound = async function () {
  try {
    const data = await apiRequest("/lost-found");
    lostFoundItems = data.items || [];
    renderProducts();
  } catch (error) {
    const productDiv = document.getElementById("products");
    if (productDiv) {
      productDiv.innerHTML = `<div class="product-card empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    }
  }
};

function renderLostFoundItems(items) {
  const productDiv = document.getElementById("products");
  if (!productDiv) {
    return;
  }

  if (!items.length) {
    productDiv.innerHTML = `<div class="product-card empty-state"><p>No lost or found items posted yet.</p></div>`;
    return;
  }

  productDiv.innerHTML = items.map((item) => `
    <article class="product-card" data-item-id="${item.id}">
      <div class="product-image">
        ${item.imageUrl
          ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" loading="lazy">`
          : `<div class="product-placeholder">${item.itemType === "lost" ? "LOST" : "FOUND"}</div>`}
      </div>
      <div class="product-header">
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <p class="product-meta">${escapeHtml(item.category)} | ${escapeHtml(item.location)}</p>
        </div>
        <span class="listing-pill ${escapeHtml(item.itemType)}">${formatLostFoundType(item.itemType)}</span>
      </div>
      <p class="product-description">${escapeHtml(item.description)}</p>
      <div class="product-actions">
        <small>Reported: ${formatDateString(item.itemDate)} | Status: ${item.status === "resolved" ? "Resolved" : "Active"}</small>
        <button type="button" class="secondary-action" data-contact-lost-found="${item.id}">Contact Owner</button>
        ${item.status !== "resolved" && getCurrentUser()?.id === item.userId ? `
          <button type="button" class="secondary-action" data-resolve-item="${item.id}">Mark as Resolved</button>
        ` : ""}
      </div>
    </article>
  `).join("");

  // Attach event listeners after rendering
  productDiv.querySelectorAll("[data-contact-lost-found]").forEach((button) => {
    button.addEventListener("click", () => {
      const itemId = Number(button.getAttribute("data-contact-lost-found"));
      contactLostFoundOwner(itemId);
    });
  });

  productDiv.querySelectorAll("[data-message-seller]").forEach((button) => {
    button.addEventListener("click", () => {
      const productId = Number(button.getAttribute("data-message-seller"));
      const product = allProducts.find((item) => item.id === productId);
      if (product) {
        startNewConversation(product);
      }
    });
  });

  productDiv.querySelectorAll("[data-resolve-item]").forEach((button) => {
    button.addEventListener("click", async () => {
      const itemId = Number(button.getAttribute("data-resolve-item"));
      await resolveLostFoundItem(itemId);
    });
  });
}

window.resolveLostFoundItem = async function (id) {
  if (!confirm("Mark this item as resolved?")) return;
  const currentUser = getCurrentUser();
  if (!currentUser) { alert("Please log in first."); return; }

  try {
    await apiRequest(`/lost-found/${id}/resolve`, {
      method: "PATCH",
      body: JSON.stringify({ userId: currentUser.id })
    });
    loadLostFound();
  } catch (error) {
    alert(error.message);
  }
};

window.contactLostFoundPoster = function (email) {
  if (!getCurrentUser()) {
    alert("Please log in first to contact the person.");
    window.location.href = "login.html";
    return;
  }
  
  // Sanitize email before using in confirm/alert
  const sanitizedEmail = escapeHtml(email);
  
  if (confirm(`Contact ${sanitizedEmail} about this lost/found item?\n\nThey will be notified and can respond via chat.`)) {
    alert(`You can now contact ${sanitizedEmail} through the marketplace messaging system.`);
  }
};

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

function formatDateString(dateString) {
  if (!dateString) return "Unknown date";
  try {
    return new Date(dateString).toLocaleDateString("en-IN", {
      dateStyle: "medium"
    });
  } catch (_error) {
    return dateString;
  }
}

function initializeLostFound() {
}

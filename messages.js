import { API_BASE_URL } from "./config.js";

let currentUser = null;
let conversations = [];
let selectedConversation = null;
let unreadCounts = {};
let selectedReceiverId = null;

function getCurrentUser() {
  const rawUser = localStorage.getItem("currentUser");
  return rawUser ? JSON.parse(rawUser) : null;
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function formatRelativeTime(timestamp) {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return "Just now";
  } catch (_error) {
    return "";
  }
}

async function apiRequest(path, options = {}) {
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('Invalid API path');
  }
  
  const fullPath = `${API_BASE_URL}${path}`;
  
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
  currentUser = getCurrentUser();
  if (!currentUser) {
    window.location.href = "login.html";
  }
}

async function loadConversations() {
  try {
    const data = await apiRequest(`/conversations?userId=${currentUser.id}`);
    conversations = data.conversations || [];
    renderConversations(conversations);
  } catch (error) {
    const list = document.getElementById("messagesList");
    if (list) {
      list.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    }
  }
}

function renderConversations(convos) {
  const list = document.getElementById("messagesList");
  if (!list) return;

  if (!convos.length) {
    list.innerHTML = `
      <div class="empty-state">
        <p>No conversations yet. Start a conversation from a marketplace listing or Lost & Found item.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = convos.map((convo) => {
    const isSelected = selectedConversation && selectedConversation.productId === convo.productId;
    const unreadCount = unreadCounts[convo.productId] || 0;
    
    return `
      <div class="conversation-item ${isSelected ? 'active' : ''}" data-product-id="${convo.productId}">
        <div class="conversation-avatar">
          <span>${escapeHtml(convo.sellerEmail.charAt(0).toUpperCase())}</span>
        </div>
        <div class="conversation-info">
          <div class="conversation-header">
            <h3>${escapeHtml(convo.sellerEmail)}</h3>
            <small>${formatRelativeTime(convo.latestAt)}</small>
          </div>
          <p class="conversation-preview">${escapeHtml(convo.title)}</p>
          ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ''}
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".conversation-item").forEach((item) => {
    item.addEventListener("click", () => {
      const productId = Number(item.getAttribute("data-product-id"));
      selectConversation(productId);
    });
  });
}

function selectConversation(productId) {
  selectedConversation = conversations.find(c => c.productId === productId);
  selectedReceiverId = null;
  const chatHeader = document.getElementById("chatHeader");
  const chatTitle = document.getElementById("chatTitle");
  const chatSubtitle = document.getElementById("chatSubtitle");
  const chatMessages = document.getElementById("chatMessages");

  if (!selectedConversation || !chatHeader || !chatTitle || !chatSubtitle || !chatMessages) {
    return;
  }

  chatTitle.textContent = selectedConversation.title;
  chatSubtitle.textContent = `Chat with ${selectedConversation.sellerEmail}`;

  markConversationAsRead(productId);
  renderChatMessages(productId);
}

async function markConversationAsRead(productId) {
  try {
    await apiRequest(`/messages/${productId}?userId=${currentUser.id}`);
    
    if (unreadCounts[productId]) {
      delete unreadCounts[productId];
      updateUnreadCounts();
    }
  } catch (error) {
    console.error("Error marking as read:", error);
  }
}

async function renderChatMessages(productId) {
  const chatMessages = document.getElementById("chatMessages");
  if (!chatMessages) return;

  try {
    const data = await apiRequest(`/messages/${productId}?userId=${currentUser.id}`);
    const latestOtherMessage = [...data.messages].reverse().find((message) => message.senderId !== currentUser.id);

    if (latestOtherMessage) {
      selectedReceiverId = latestOtherMessage.senderId;
    } else if (selectedConversation?.sellerId !== currentUser.id) {
      selectedReceiverId = selectedConversation.sellerId;
    }
    
    if (!data.messages.length) {
      chatMessages.className = "chat-messages empty-state";
      chatMessages.innerHTML = `<p>No messages yet. Start the conversation!</p>`;
      return;
    }

    chatMessages.className = "chat-messages";
    chatMessages.innerHTML = data.messages.map((message) => {
      const isSelf = message.senderId === currentUser.id;
      return `
        <article class="message ${isSelf ? "self" : "other"}" data-message-id="${message.id}">
          <div class="message-content">
            ${message.message ? `<div>${escapeHtml(message.message)}</div>` : ""}
            ${message.imageUrl ? `<img class="message-image" src="${message.imageUrl}" alt="Message attachment">` : ""}
          </div>
          <small>${isSelf ? "You" : escapeHtml(message.senderEmail)} | ${formatMessageTime(message.createdAt)}</small>
        </article>
      `;
    }).join("");

    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (error) {
    chatMessages.className = "chat-messages empty-state";
    chatMessages.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

async function sendMessage() {
  const messageInput = document.getElementById("messageInput");
  const message = messageInput.value.trim();

  if (!currentUser) {
    alert("Please log in first.");
    window.location.href = "login.html";
    return;
  }

  if (!selectedConversation) {
    alert("Please select a conversation first.");
    return;
  }

  if (!message) {
    alert("Please enter a message.");
    return;
  }

  try {
    const receiverId = selectedReceiverId || (
      selectedConversation.sellerId !== currentUser.id ? selectedConversation.sellerId : null
    );

    if (!receiverId) {
      alert("Open a buyer conversation first so your reply goes to the right student.");
      return;
    }

    await apiRequest("/messages", {
      method: "POST",
      body: JSON.stringify({
        productId: selectedConversation.productId,
        senderId: currentUser.id,
        receiverId,
        message,
        imageUrl: null
      })
    });

    messageInput.value = "";
    await renderChatMessages(selectedConversation.productId);
  } catch (error) {
    alert(error.message);
  }
}

function updateUnreadCounts() {
  const items = document.querySelectorAll(".conversation-item");
  items.forEach((item) => {
    const productId = Number(item.getAttribute("data-product-id"));
    const badge = item.querySelector(".unread-badge");
    const count = unreadCounts[productId] || 0;
    
    if (count > 0) {
      if (!badge) {
        const info = item.querySelector(".conversation-info");
        if (info) {
          const badgeEl = document.createElement("span");
          badgeEl.className = "unread-badge";
          badgeEl.textContent = count;
          info.appendChild(badgeEl);
        }
      } else {
        badge.textContent = count;
      }
    } else if (badge) {
      badge.remove();
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  protectPage();
  
  const messageInput = document.getElementById("messageInput");
  const sendButton = document.getElementById("sendButton");
  
  if (messageInput && sendButton) {
    messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    
    sendButton.addEventListener("click", sendMessage);
  }
  
  const searchInput = document.getElementById("messageSearch");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.toLowerCase();
      const filtered = conversations.filter(c => 
        c.title.toLowerCase().includes(query) ||
        c.sellerEmail.toLowerCase().includes(query)
      );
      renderConversations(filtered);
    });
  }
  
  loadConversations();
});

window.logout = function () {
  localStorage.removeItem("currentUser");
  window.location.href = "login.html";
};

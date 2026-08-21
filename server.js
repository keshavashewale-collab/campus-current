const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { findBestMatches } = require("./lostFoundMatcher");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

// ========================================
// SUPABASE POSTGRESQL DATABASE CONNECTION
// ========================================

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Convert MySQL ? placeholders to PostgreSQL $1, $2, $3...
function convertPlaceholders(sql) {
  let index = 0;

  return sql.replace(/\?/g, () => {
    index++;
    return `$${index}`;
  });
}

// Preserve aliases such as productName, sellerName, buyerName, etc.
function restoreAliasCase(sql, rows) {
  const aliases = [
    ...sql.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)
  ].map((match) => match[1]);

  if (!aliases.length) {
    return rows;
  }

  return rows.map((row) => {
    const copy = { ...row };

    for (const alias of aliases) {
      const postgresAlias = alias.toLowerCase();

      if (
        postgresAlias !== alias &&
        Object.prototype.hasOwnProperty.call(copy, postgresAlias)
      ) {
        copy[alias] = copy[postgresAlias];
        delete copy[postgresAlias];
      }
    }

    return copy;
  });
}

// Convert special MySQL queries used by the existing project
function convertMysqlSql(sql) {
  let converted = sql;

  // MySQL INSERT IGNORE -> PostgreSQL ON CONFLICT
  converted = converted.replace(
    /INSERT\s+IGNORE\s+INTO\s+wishlist\s*\(user_id,\s*product_id\)\s*VALUES\s*\(\?,\s*\?\)/i,
    "INSERT INTO wishlist (user_id, product_id) VALUES (?, ?) ON CONFLICT (user_id, product_id) DO NOTHING"
  );

  // Product review upsert
  converted = converted.replace(
    /ON\s+DUPLICATE\s+KEY\s+UPDATE\s+rating\s*=\s*VALUES\(rating\),\s*review\s*=\s*VALUES\(review\),\s*created_at\s*=\s*CURRENT_TIMESTAMP/i,
    "ON CONFLICT (product_id, buyer_id) DO UPDATE SET rating = EXCLUDED.rating, review = EXCLUDED.review, created_at = CURRENT_TIMESTAMP"
  );

  // Book rental request upsert
  converted = converted.replace(
    /ON\s+DUPLICATE\s+KEY\s+UPDATE\s+status\s*=\s*'pending'/i,
    "ON CONFLICT (book_id, requester_id) DO UPDATE SET status = 'pending'"
  );

  // MySQL DATE_FORMAT -> PostgreSQL TO_CHAR
  converted = converted.replace(
    /DATE_FORMAT\(created_at,\s*'%Y-%m'\)/gi,
    "TO_CHAR(created_at, 'YYYY-MM')"
  );

  return convertPlaceholders(converted);
}

// Compatibility layer so existing pool.query() code can continue working
const pool = {
  async query(sql, params = []) {
    let convertedSql = convertMysqlSql(sql);

    const trimmed = convertedSql.trim();

    const isInsert = /^INSERT\b/i.test(trimmed);
    const isSelect = /^(SELECT|WITH)\b/i.test(trimmed);
    const isUpdate = /^UPDATE\b/i.test(trimmed);
    const isDelete = /^DELETE\b/i.test(trimmed);

    // Existing code expects result.insertId
    if (isInsert && !/\bRETURNING\b/i.test(convertedSql)) {
      convertedSql += " RETURNING id";
    }

    const result = await pgPool.query(convertedSql, params);

    if (isSelect) {
      return [restoreAliasCase(sql, result.rows), []];
    }

    if (isInsert) {
      return [
        {
          insertId: result.rows?.[0]?.id ?? null,
          affectedRows: result.rowCount
        },
        []
      ];
    }

    if (isUpdate || isDelete) {
      return [
        {
          affectedRows: result.rowCount
        },
        []
      ];
    }

    return [restoreAliasCase(sql, result.rows || []), []];
  }
};



const notificationClients = new Map();

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function normalizeText(value = "") {
  return String(value).trim();
}

function normalizePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function isAdminUser(user) {
  const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
  const userEmail = (user?.email || "").toLowerCase();
  return Boolean(userEmail && (userEmail === adminEmail || userEmail.includes("admin")));
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function pushToUser(userId, event, payload) {
  const clients = notificationClients.get(Number(userId)) || new Set();
  clients.forEach((client) => sendSse(client, event, payload));
}

async function createNotification(userId, type, title, body, link = "") {
  if (!userId) {
    return null;
  }

  const [result] = await pool.query(
    "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)",
    [userId, type, title, body, link]
  );

  const notification = {
    id: result.insertId,
    userId,
    type,
    title,
    body,
    link,
    readAt: null,
    createdAt: new Date().toISOString()
  };

  pushToUser(userId, "notification", notification);
  return notification;
}

async function initializeDatabase() {
  await pgPool.query("SELECT 1");
  console.log("Connected to Supabase PostgreSQL.");
}
app.post("/api/signup", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  try {
    const passwordHash = hashPassword(password);

    await pool.query(
      "INSERT INTO users (email, password_hash) VALUES (?, ?)",
      [email, passwordHash]
    );

    return res.json({ message: "Signup successful." });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "This email is already registered." });
    }

    return res.status(500).json({ message: "Unable to create account." });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  try {
    const passwordHash = hashPassword(password);
    const [rows] = await pool.query(
      "SELECT id, email FROM users WHERE email = ? AND password_hash = ?",
      [email, passwordHash]
    );

    if (!rows.length) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    return res.json({
      message: "Login successful.",
      user: rows[0]
    });
  } catch (error) {
    return res.status(500).json({ message: "Unable to log in." });
  }
});

app.get("/api/products", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        products.id,
        products.title,
        products.price,
        products.category,
        products.description,
        products.listing_type AS listingType,
        products.image_url AS imageUrl,
        products.condition_label AS conditionLabel,
        products.status,
        products.sold_to_id AS soldToId,
        products.sold_at AS soldAt,
        products.user_id AS userId,
        users.email,
        COALESCE(seller_reviews.averageRating, 0) AS sellerRating,
        COALESCE(seller_reviews.reviewCount, 0) AS sellerReviewCount
      FROM products
      INNER JOIN users ON users.id = products.user_id
      LEFT JOIN (
        SELECT seller_id, ROUND(AVG(rating), 1) AS averageRating, COUNT(*) AS reviewCount
        FROM reviews
        GROUP BY seller_id
      ) AS seller_reviews ON seller_reviews.seller_id = products.user_id
      ORDER BY products.created_at DESC
    `);

    return res.json({ products: rows });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load products." });
  }
});

app.post("/api/products", async (req, res) => {
  const { title, price, category, desc, userId, listingType = "sell", imageUrl = null, conditionLabel = "Good" } = req.body;

  if (!normalizeText(title) || !normalizePrice(price) || !normalizeText(category) || !normalizeText(desc) || !userId) {
    return res.status(400).json({ message: "All product fields are required." });
  }

  if (!["buy", "sell"].includes(listingType)) {
    return res.status(400).json({ message: "Listing type must be buy or sell." });
  }

  if (!normalizeText(conditionLabel)) {
    return res.status(400).json({ message: "Condition is required." });
  }

  try {
    const [users] = await pool.query("SELECT id FROM users WHERE id = ?", [userId]);

    if (!users.length) {
      return res.status(401).json({ message: "Please log in again." });
    }

    await pool.query(
      `INSERT INTO products (title, price, category, description, listing_type, image_url, condition_label, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
      [normalizeText(title), normalizePrice(price), normalizeText(category), normalizeText(desc), listingType, imageUrl, normalizeText(conditionLabel), userId]
    );

    return res.json({ message: "Product added." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to add product." });
  }
});

app.delete("/api/products/:productId", async (req, res) => {
  const productId = Number(req.params.productId);
  const userId = Number(req.body.userId);

  if (!productId || !userId) {
    return res.status(400).json({ message: "Product and user are required." });
  }

  try {
    const [rows] = await pool.query(
      "SELECT id, title, user_id AS userId FROM products WHERE id = ?",
      [productId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Listing not found." });
    }

    if (rows[0].userId !== userId) {
      return res.status(403).json({ message: "You can only delete your own listings." });
    }

    await pool.query("DELETE FROM products WHERE id = ?", [productId]);

    return res.json({ message: "Product deleted." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to delete product." });
  }
});

app.get("/api/messages/:productId", async (req, res) => {
  const productId = Number(req.params.productId);
  const userId = Number(req.query.userId);

  if (!productId || !userId) {
    return res.status(400).json({ message: "Product and user are required." });
  }

  try {
    const [membership] = await pool.query(
      `SELECT id FROM products WHERE id = ? AND (
        user_id = ? OR EXISTS (
          SELECT 1 FROM messages
          WHERE product_id = ? AND (sender_id = ? OR receiver_id = ?)
        )
      )`,
      [productId, userId, productId, userId, userId]
    );

    if (!membership.length) {
      return res.json({ messages: [] });
    }

    const [rows] = await pool.query(
      `SELECT
        messages.id,
        messages.sender_id AS senderId,
        messages.receiver_id AS receiverId,
        messages.message,
        messages.image_url AS imageUrl,
        messages.created_at AS createdAt,
        sender.email AS senderEmail,
        receiver.email AS receiverEmail
      FROM messages
      INNER JOIN users AS sender ON sender.id = messages.sender_id
      INNER JOIN users AS receiver ON receiver.id = messages.receiver_id
      WHERE messages.product_id = ?
        AND (messages.sender_id = ? OR messages.receiver_id = ? OR EXISTS (
          SELECT 1 FROM products WHERE id = ? AND user_id = ?
        ))
      ORDER BY messages.created_at ASC`,
      [productId, userId, userId, productId, userId]
    );

    await pool.query(
      "UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE product_id = ? AND receiver_id = ? AND read_at IS NULL",
      [productId, userId]
    );

    return res.json({ messages: rows });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load messages." });
  }
});

app.post("/api/messages", async (req, res) => {
  const { productId, senderId, receiverId, message = "", imageUrl = null } = req.body;

  if (!productId || !senderId || !receiverId) {
    return res.status(400).json({ message: "All chat fields are required." });
  }

  if (!message && !imageUrl) {
    return res.status(400).json({ message: "Send a text message or an image." });
  }

  if (senderId === receiverId) {
    return res.status(400).json({ message: "Choose a real buyer or seller to chat with." });
  }

  try {
    const [[product]] = await pool.query("SELECT id, title, user_id AS userId FROM products WHERE id = ?", [productId]);

    if (!product) {
      return res.status(404).json({ message: "Listing not found." });
    }

    const [users] = await pool.query(
      "SELECT id FROM users WHERE id IN (?, ?)",
      [senderId, receiverId]
    );

    if (users.length !== 2) {
      return res.status(404).json({ message: "Buyer or seller account was not found." });
    }

    const [result] = await pool.query(
      "INSERT INTO messages (product_id, sender_id, receiver_id, message, image_url) VALUES (?, ?, ?, ?, ?)",
      [productId, senderId, receiverId, normalizeText(message), imageUrl]
    );

    await createNotification(receiverId, "message", "New message", `New message about ${product.title}.`, "dashboard.html");
    pushToUser(receiverId, "chat-message", { id: result.insertId, productId, senderId, receiverId });

    return res.json({ message: "Message sent." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to send message." });
  }
});


app.get("/api/price-suggestion", async (req, res) => {
  const category = normalizeText(req.query.category);
  const conditionLabel = normalizeText(req.query.condition || "Good");

  if (!category) {
    return res.status(400).json({ message: "Category is required for price suggestion." });
  }

  const multipliers = {
    "Like New": 1.08,
    Good: 1,
    Fair: 0.82,
    Poor: 0.62
  };

  try {
    const [similar] = await pool.query(
      `SELECT price FROM products
       WHERE LOWER(category) = LOWER(?) AND listing_type = 'sell' AND price > 0
       ORDER BY created_at DESC
       LIMIT 20`,
      [category]
    );

    const prices = similar.map((item) => Number(item.price)).filter(Boolean);
    const baseline = prices.length
      ? prices.reduce((sum, value) => sum + value, 0) / prices.length
      : 500;
    const multiplier = multipliers[conditionLabel] || multipliers.Good;
    const suggestedPrice = Math.max(1, Math.round((baseline * multiplier) / 10) * 10);

    return res.json({
      suggestedPrice,
      similarCount: prices.length,
      basis: prices.length ? "similar listings" : "starter estimate"
    });
  } catch (error) {
    return res.status(500).json({ message: "Unable to suggest a price." });
  }
});

app.patch("/api/products/:productId/status", async (req, res) => {
  const productId = Number(req.params.productId);
  const userId = Number(req.body.userId);
  const soldToId = Number(req.body.soldToId);
  const status = normalizeText(req.body.status || "sold");

  if (!productId || !userId || !["active", "sold"].includes(status)) {
    return res.status(400).json({ message: "Valid product, user, and status are required." });
  }

  try {
    const [[product]] = await pool.query(
      "SELECT id, title, user_id AS userId, status FROM products WHERE id = ?",
      [productId]
    );

    if (!product) {
      return res.status(404).json({ message: "Listing not found." });
    }

    if (product.userId !== userId) {
      return res.status(403).json({ message: "Only the listing owner can change product status." });
    }

    if (status === "sold" && !soldToId) {
      return res.status(400).json({ message: "Choose the buyer before marking sold." });
    }

    await pool.query(
      "UPDATE products SET status = ?, sold_to_id = ?, sold_at = ? WHERE id = ?",
      [status, status === "sold" ? soldToId : null, status === "sold" ? new Date() : null, productId]
    );

    if (status === "sold") {
      await pool.query(
        `INSERT INTO orders (product_id, buyer_id, seller_id, status)
         SELECT ?, ?, ?, 'completed'
         WHERE NOT EXISTS (SELECT 1 FROM orders WHERE product_id = ? AND buyer_id = ?)`,
        [productId, soldToId, userId, productId, soldToId]
      );
      await createNotification(soldToId, "order", "Purchase completed", `Your purchase for ${product.title} was marked sold.`, "dashboard.html");
    }

    await createNotification(userId, "product", "Product status updated", `${product.title} is now ${status}.`, "dashboard.html");
    return res.json({ message: "Product status updated." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to update product status." });
  }
});

app.get("/api/conversations", async (req, res) => {
  const userId = Number(req.query.userId);

  if (!userId) {
    return res.status(400).json({ message: "User is required." });
  }

  try {
    const [rows] = await pool.query(
      `SELECT
        products.id AS productId,
        products.title,
        products.user_id AS sellerId,
        users.email AS sellerEmail,
        MAX(messages.created_at) AS latestAt,
        SUM(CASE WHEN messages.receiver_id = ? AND messages.read_at IS NULL THEN 1 ELSE 0 END) AS unreadCount
      FROM messages
      INNER JOIN products ON products.id = messages.product_id
      INNER JOIN users ON users.id = products.user_id
      WHERE messages.sender_id = ? OR messages.receiver_id = ? OR products.user_id = ?
      GROUP BY products.id, products.title, products.user_id, users.email
      ORDER BY latestAt DESC`,
      [userId, userId, userId, userId]
    );

    return res.json({ conversations: rows });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load conversations." });
  }
});

app.get("/api/conversations/direct", async (req, res) => {
  const userId = Number(req.query.userId);

  if (!userId) {
    return res.status(400).json({ message: "User is required." });
  }

  try {
    const [rows] = await pool.query(
      `SELECT
        m.id AS messageId,
        m.product_id AS productId,
        p.title,
        p.user_id AS sellerId,
        u.email AS sellerEmail,
        m.message,
        m.created_at AS latestAt,
        m.read_at
      FROM messages m
      INNER JOIN products p ON p.id = m.product_id
      INNER JOIN users u ON u.id = p.user_id
      WHERE (m.sender_id = ? AND m.receiver_id != ?) OR (m.receiver_id = ? AND m.sender_id != ?)
      GROUP BY m.product_id, p.title, p.user_id, u.email, m.id, m.message, m.created_at, m.read_at
      ORDER BY m.created_at DESC`,
      [userId, userId, userId, userId]
    );

    return res.json({ conversations: rows });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load conversations." });
  }
});

app.get("/api/sellers/:sellerId", async (req, res) => {
  const sellerId = Number(req.params.sellerId);

  if (!sellerId) {
    return res.status(400).json({ message: "Seller is required." });
  }

  try {
    const [[seller]] = await pool.query(
      `SELECT users.id, users.email, COALESCE(ROUND(AVG(reviews.rating), 1), 0) AS averageRating,
        COUNT(reviews.id) AS reviewCount
       FROM users
       LEFT JOIN reviews ON reviews.seller_id = users.id
       WHERE users.id = ?
       GROUP BY users.id, users.email`,
      [sellerId]
    );

    if (!seller) {
      return res.status(404).json({ message: "Seller not found." });
    }

    const [reviews] = await pool.query(
      `SELECT reviews.id, reviews.rating, reviews.review, reviews.created_at AS createdAt,
        buyers.email AS buyerEmail, products.title AS productTitle
       FROM reviews
       INNER JOIN users AS buyers ON buyers.id = reviews.buyer_id
       INNER JOIN products ON products.id = reviews.product_id
       WHERE reviews.seller_id = ?
       ORDER BY reviews.created_at DESC
       LIMIT 5`,
      [sellerId]
    );

    return res.json({ seller, reviews });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load seller profile." });
  }
});

app.post("/api/reviews", async (req, res) => {
  const buyerId = Number(req.body.buyerId);
  const productId = Number(req.body.productId);
  const rating = Number(req.body.rating);
  const review = normalizeText(req.body.review || "");

  if (!buyerId || !productId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Product, buyer, and a 1-5 star rating are required." });
  }

  try {
    const [[product]] = await pool.query(
      "SELECT id, title, user_id AS sellerId, sold_to_id AS soldToId, status FROM products WHERE id = ?",
      [productId]
    );

    if (!product) {
      return res.status(404).json({ message: "Listing not found." });
    }

    if (product.status !== "sold" || product.soldToId !== buyerId) {
      return res.status(403).json({ message: "You can review this seller after your purchase is completed." });
    }

    await pool.query(
      `INSERT INTO reviews (seller_id, buyer_id, product_id, rating, review)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), review = VALUES(review), created_at = CURRENT_TIMESTAMP`,
      [product.sellerId, buyerId, productId, rating, review]
    );

    await createNotification(product.sellerId, "review", "New seller review", `A buyer reviewed ${product.title}.`, "dashboard.html");
    return res.json({ message: "Review saved." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to save review." });
  }
});

app.post("/api/wishlist", async (req, res) => {
  const userId = Number(req.body.userId);
  const productId = Number(req.body.productId);

  if (!userId || !productId) {
    return res.status(400).json({ message: "User and product are required." });
  }

  try {
    const [[product]] = await pool.query(
      "SELECT id, title, user_id AS sellerId FROM products WHERE id = ?",
      [productId]
    );

    if (!product) {
      return res.status(404).json({ message: "Listing not found." });
    }

    if (product.sellerId === userId) {
      return res.status(400).json({ message: "You cannot wishlist your own listing." });
    }

    const [result] = await pool.query(
      "INSERT IGNORE INTO wishlist (user_id, product_id) VALUES (?, ?)",
      [userId, productId]
    );

    if (result.affectedRows) {
      await createNotification(product.sellerId, "wishlist", "Listing wishlisted", `Someone saved ${product.title} to their wishlist.`, "dashboard.html");
    }

    return res.json({ message: "Wishlist updated." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to update wishlist." });
  }
});

app.get("/api/notifications", async (req, res) => {
  const userId = Number(req.query.userId);

  if (!userId) {
    return res.status(400).json({ message: "User is required." });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, user_id AS userId, type, title, body, link, read_at AS readAt, created_at AS createdAt
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 30`,
      [userId]
    );
    const unreadCount = rows.filter((item) => !item.readAt).length;
    return res.json({ notifications: rows, unreadCount });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load notifications." });
  }
});

app.post("/api/notifications/read", async (req, res) => {
  const userId = Number(req.body.userId);

  if (!userId) {
    return res.status(400).json({ message: "User is required." });
  }

  try {
    await pool.query("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL", [userId]);
    pushToUser(userId, "notifications-read", { userId });
    return res.json({ message: "Notifications marked read." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to mark notifications read." });
  }
});

app.get("/api/notifications/stream", async (req, res) => {
  const userId = Number(req.query.userId);

  if (!userId) {
    return res.status(400).end();
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (!notificationClients.has(userId)) {
    notificationClients.set(userId, new Set());
  }

  notificationClients.get(userId).add(res);
  sendSse(res, "connected", { userId });

  req.on("close", () => {
    const clients = notificationClients.get(userId);
    clients?.delete(res);
    if (clients && !clients.size) {
      notificationClients.delete(userId);
    }
  });
});

app.get("/api/admin/analytics", async (req, res) => {
  const userId = Number(req.query.userId);

  if (!userId) {
    return res.status(400).json({ message: "Admin user is required." });
  }

  try {
    const [[user]] = await pool.query("SELECT id, email FROM users WHERE id = ?", [userId]);

    if (!isAdminUser(user)) {
      return res.status(403).json({ message: "Admin access is required. Set ADMIN_EMAIL or use an admin email account." });
    }

    const [[totals]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS totalUsers,
        (SELECT COUNT(*) FROM products WHERE status = 'active') AS activeListings,
        (SELECT COUNT(*) FROM products WHERE status = 'sold') AS soldProducts,
        (SELECT COUNT(*) FROM orders) AS totalOrders
    `);
    const [topCategories] = await pool.query(
      "SELECT category, COUNT(*) AS count FROM products GROUP BY category ORDER BY count DESC LIMIT 6"
    );
    const [topSellers] = await pool.query(
      `SELECT users.id, users.email, COUNT(DISTINCT products.id) AS listings, COALESCE(ROUND(AVG(reviews.rating), 1), 0) AS averageRating
       FROM users
       INNER JOIN products ON products.user_id = users.id
       LEFT JOIN reviews ON reviews.seller_id = users.id
       GROUP BY users.id, users.email
       ORDER BY listings DESC, averageRating DESC
       LIMIT 6`
    );
    const [monthlyUploads] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS uploads
       FROM products
       GROUP BY month
       ORDER BY month DESC
       LIMIT 12`
    );

    return res.json({ totals, topCategories, topSellers, monthlyUploads: monthlyUploads.reverse() });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load admin analytics." });
  }
});

async function userExists(userId) {
  const [users] = await pool.query("SELECT id FROM users WHERE id = ?", [userId]);
  return users.length > 0;
}

function requireFields(res, values, message) {
  if (values.some((value) => !normalizeText(value))) {
    res.status(400).json({ message });
    return false;
  }
  return true;
}

function serializeLostFoundMatch(match) {
  return {
    score: match.score,
    confidence: match.confidence,
    signals: {
      text: Math.round(match.signals.text * 100),
      category: Math.round(match.signals.category * 100),
      location: Math.round(match.signals.location * 100),
      date: Math.round(match.signals.date * 100),
      attributes: Math.round(match.signals.attributes * 100)
    },
    reasons: match.reasons,
    item: {
      id: match.item.id,
      itemType: match.item.itemType,
      title: match.item.title,
      category: match.item.category,
      description: match.item.description,
      itemDate: match.item.itemDate,
      location: match.item.location,
      imageUrl: match.item.imageUrl,
      status: match.item.status,
      userId: match.item.userId
    }
  };
}

async function getLostFoundItem(itemId) {
  const [[item]] = await pool.query(
    `SELECT lost_found_items.*, lost_found_items.item_type AS itemType, lost_found_items.item_date AS itemDate,
      lost_found_items.image_url AS imageUrl, lost_found_items.user_id AS userId
     FROM lost_found_items
     WHERE lost_found_items.id = ?`,
    [itemId]
  );

  return item || null;
}

async function findLostFoundMatchesForItem(item, options = {}) {
  if (!item || !["lost", "found"].includes(item.itemType)) {
    return [];
  }
  if (item.status === "resolved") {
    return [];
  }

  const oppositeType = item.itemType === "lost" ? "found" : "lost";
  const [candidates] = await pool.query(
    `SELECT lost_found_items.*, lost_found_items.item_type AS itemType, lost_found_items.item_date AS itemDate,
      lost_found_items.image_url AS imageUrl, lost_found_items.user_id AS userId
     FROM lost_found_items
     WHERE lost_found_items.item_type = ?
       AND lost_found_items.id != ?
       AND COALESCE(lost_found_items.status, 'active') != 'resolved'
     ORDER BY
       CASE WHEN LOWER(lost_found_items.category) = LOWER(?) THEN 0 ELSE 1 END,
       ABS(lost_found_items.item_date - ?::date),
       lost_found_items.created_at DESC
     LIMIT 150`,
    [oppositeType, item.id, item.category || "", item.itemDate]
  );

  return findBestMatches(item, candidates, options).map(serializeLostFoundMatch);
}

app.get("/api/lost-found", async (req, res) => {
  const type = normalizeText(req.query.type);
  const category = normalizeText(req.query.category);
  const date = normalizeText(req.query.date);
  const filters = [];
  const params = [];

  if (["lost", "found"].includes(type)) {
    filters.push("lost_found_items.item_type = ?");
    params.push(type);
  }
  if (category) {
    filters.push("LOWER(lost_found_items.category) LIKE LOWER(?)");
    params.push(`%${category}%`);
  }
  if (date) {
    filters.push("lost_found_items.item_date = ?");
    params.push(date);
  }

  try {
    const [items] = await pool.query(
      `SELECT lost_found_items.*, lost_found_items.item_type AS itemType, lost_found_items.item_date AS itemDate,
        lost_found_items.image_url AS imageUrl, lost_found_items.user_id AS userId
       FROM lost_found_items
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY lost_found_items.created_at DESC`,
      params
    );
    return res.json({ items });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load Lost & Found items." });
  }
});

app.post("/api/lost-found", async (req, res) => {
  const { userId, itemType, title, category, description, itemDate, location, imageUrl = null } = req.body;

  if (!["lost", "found"].includes(itemType)) {
    return res.status(400).json({ message: "Item type must be Lost or Found." });
  }
  if (!userId || !requireFields(res, [title, category, description, itemDate, location], "All Lost & Found fields are required.")) {
    return;
  }

  try {
    if (!(await userExists(userId))) {
      return res.status(401).json({ message: "Please log in again." });
    }
    const [result] = await pool.query(
      `INSERT INTO lost_found_items (item_type, title, category, description, item_date, location, image_url, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [itemType, normalizeText(title), normalizeText(category), normalizeText(description), itemDate, normalizeText(location), imageUrl, userId]
    );

    const item = await getLostFoundItem(result.insertId);
    let matches = [];
    let matchingError = "";

    try {
      matches = item ? await findLostFoundMatchesForItem(item, { limit: 5 }) : [];
    } catch (matchError) {
      matchingError = "Possible matches could not be loaded right now.";
    }

    return res.json({
      message: "Lost & Found item posted.",
      item,
      matches,
      matchingError
    });
  } catch (error) {
    return res.status(500).json({ message: "Unable to post Lost & Found item." });
  }
});

app.get("/api/lost-found/:id/matches", async (req, res) => {
  const itemId = Number(req.params.id);

  if (!itemId) {
    return res.status(400).json({ message: "Item is required." });
  }

  try {
    const item = await getLostFoundItem(itemId);
    if (!item) {
      return res.status(404).json({ message: "Item not found." });
    }

    const matches = await findLostFoundMatchesForItem(item, { limit: 6 });
    return res.json({ item, matches });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load possible matches." });
  }
});

app.post("/api/lost-found/:id/contact", async (req, res) => {
  const itemId = Number(req.params.id);
  const userId = Number(req.body.userId);

  if (!itemId || !userId) {
    return res.status(400).json({ message: "Item and user are required." });
  }

  try {
    const item = await getLostFoundItem(itemId);
    if (!item) {
      return res.status(404).json({ message: "Item not found." });
    }
    if (item.userId === userId) {
      return res.status(400).json({ message: "This is your own Lost & Found post." });
    }
    if (!(await userExists(userId))) {
      return res.status(401).json({ message: "Please log in again." });
    }

    await createNotification(
      item.userId,
      "lost-found",
      "Lost & Found contact request",
      `A student wants to contact you about "${item.title}".`,
      "campus.html"
    );

    return res.json({ message: "The owner has been notified." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to contact owner right now." });
  }
});

app.patch("/api/lost-found/:id/resolve", async (req, res) => {
  const itemId = Number(req.params.id);
  const userId = Number(req.body.userId);

  if (!itemId || !userId) {
    return res.status(400).json({ message: "Item and user are required." });
  }

  try {
    const [[item]] = await pool.query("SELECT id, user_id AS userId FROM lost_found_items WHERE id = ?", [itemId]);
    if (!item) {
      return res.status(404).json({ message: "Item not found." });
    }
    if (item.userId !== userId) {
      return res.status(403).json({ message: "Only the poster can resolve this item." });
    }
    await pool.query("UPDATE lost_found_items SET status = 'resolved' WHERE id = ?", [itemId]);
    return res.json({ message: "Item marked resolved." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to resolve item." });
  }
});

app.get("/api/study-materials", async (req, res) => {
  const search = normalizeText(req.query.search);
  const department = normalizeText(req.query.department);
  const year = normalizeText(req.query.year);
  const semester = normalizeText(req.query.semester);
  const subject = normalizeText(req.query.subject);
  const filters = [];
  const params = [];

  if (department) { filters.push("LOWER(department) LIKE LOWER(?)"); params.push(`%${department}%`); }
  if (year) { filters.push("year_label = ?"); params.push(year); }
  if (semester) { filters.push("semester = ?"); params.push(semester); }
  if (subject) { filters.push("LOWER(subject) LIKE LOWER(?)"); params.push(`%${subject}%`); }
  if (search) { filters.push("LOWER(CONCAT(title, ' ', subject, ' ', material_type)) LIKE LOWER(?)"); params.push(`%${search}%`); }

  try {
    const [materials] = await pool.query(
      `SELECT id, title, department, year_label AS yearLabel, semester, subject, material_type AS materialType,
        description, file_name AS fileName, file_data AS fileData, user_id AS userId, created_at AS createdAt
       FROM study_materials ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY created_at DESC`,
      params
    );
    return res.json({ materials });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load study materials." });
  }
});

app.post("/api/study-materials", async (req, res) => {
  const { userId, title, department, yearLabel, semester, subject, materialType, description = "", fileName, fileData } = req.body;

  if (!userId || !requireFields(res, [title, department, yearLabel, semester, subject, materialType, fileName, fileData], "All study material fields are required.")) {
    return;
  }

  try {
    if (!(await userExists(userId))) {
      return res.status(401).json({ message: "Please log in again." });
    }
    await pool.query(
      `INSERT INTO study_materials (title, department, year_label, semester, subject, material_type, description, file_name, file_data, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [normalizeText(title), normalizeText(department), normalizeText(yearLabel), normalizeText(semester), normalizeText(subject), normalizeText(materialType), normalizeText(description), normalizeText(fileName), fileData, userId]
    );
    return res.json({ message: "Study material uploaded." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to upload study material." });
  }
});

app.get("/api/book-rentals", async (_req, res) => {
  try {
    const [books] = await pool.query(
      `SELECT book_rentals.*, book_rentals.rental_price AS rentalPrice, book_rentals.security_deposit AS securityDeposit,
        book_rentals.rental_duration AS rentalDuration, book_rentals.return_date AS returnDate,
        book_rentals.image_url AS imageUrl, book_rentals.user_id AS userId, users.email
       FROM book_rentals INNER JOIN users ON users.id = book_rentals.user_id
       ORDER BY book_rentals.created_at DESC`
    );
    return res.json({ books });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load book rentals." });
  }
});

app.post("/api/book-rentals", async (req, res) => {
  const { userId, title, author, rentalPrice, securityDeposit, rentalDuration, returnDate = null, imageUrl = null } = req.body;

  if (!userId || !requireFields(res, [title, author, rentalDuration], "Book title, author, and duration are required.") || !normalizePrice(rentalPrice)) {
    return res.status(400).json({ message: "Valid rental price is required." });
  }

  try {
    if (!(await userExists(userId))) {
      return res.status(401).json({ message: "Please log in again." });
    }
    await pool.query(
      `INSERT INTO book_rentals (title, author, rental_price, security_deposit, rental_duration, return_date, image_url, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [normalizeText(title), normalizeText(author), normalizePrice(rentalPrice), normalizePrice(securityDeposit), normalizeText(rentalDuration), returnDate || null, imageUrl, userId]
    );
    return res.json({ message: "Book rental posted." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to post book rental." });
  }
});

app.post("/api/book-rentals/:id/request", async (req, res) => {
  const bookId = Number(req.params.id);
  const requesterId = Number(req.body.userId);

  if (!bookId || !requesterId) {
    return res.status(400).json({ message: "Book and requester are required." });
  }

  try {
    const [[book]] = await pool.query("SELECT id, title, user_id AS ownerId, availability FROM book_rentals WHERE id = ?", [bookId]);
    if (!book) {
      return res.status(404).json({ message: "Book not found." });
    }
    if (book.ownerId === requesterId) {
      return res.status(400).json({ message: "You cannot request your own book." });
    }
    if (book.availability !== "available") {
      return res.status(400).json({ message: "This book is not currently available." });
    }
    await pool.query(
      "INSERT INTO rental_requests (book_id, requester_id, owner_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE status = 'pending'",
      [bookId, requesterId, book.ownerId]
    );
    await createNotification(book.ownerId, "rental", "New rental request", `A student requested ${book.title}.`, "campus.html");
    return res.json({ message: "Rental request sent." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to request rental." });
  }
});

app.patch("/api/book-rentals/:id/availability", async (req, res) => {
  const bookId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const availability = normalizeText(req.body.availability || "rented");

  if (!bookId || !userId || !["available", "rented"].includes(availability)) {
    return res.status(400).json({ message: "Valid book, user, and availability are required." });
  }

  try {
    const [[book]] = await pool.query("SELECT id, user_id AS userId FROM book_rentals WHERE id = ?", [bookId]);
    if (!book) {
      return res.status(404).json({ message: "Book not found." });
    }
    if (book.userId !== userId) {
      return res.status(403).json({ message: "Only the owner can update availability." });
    }
    await pool.query("UPDATE book_rentals SET availability = ? WHERE id = ?", [availability, bookId]);
    return res.json({ message: "Book availability updated." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to update book availability." });
  }
});

app.get("/api/hostel-essentials", async (req, res) => {
  const hostel = normalizeText(req.query.hostel);
  const params = ["Hostel Essentials"];
  const hostelFilter = hostel ? "AND LOWER(products.hostel_name) LIKE LOWER(?)" : "";
  if (hostel) params.push(`%${hostel}%`);

  try {
    const [items] = await pool.query(
      `SELECT products.id, products.title, products.price, products.description, products.image_url AS imageUrl,
        products.hostel_name AS hostelName, products.status, products.user_id AS userId, users.email
       FROM products INNER JOIN users ON users.id = products.user_id
       WHERE products.category = ? ${hostelFilter}
       ORDER BY products.created_at DESC`,
      params
    );
    return res.json({ items });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load hostel essentials." });
  }
});

app.post("/api/hostel-essentials", async (req, res) => {
  const { userId, title, price, description, hostelName, imageUrl = null } = req.body;

  if (!userId || !requireFields(res, [title, description, hostelName], "Title, description, and hostel are required.") || !normalizePrice(price)) {
    return res.status(400).json({ message: "A valid price is required." });
  }

  try {
    if (!(await userExists(userId))) {
      return res.status(401).json({ message: "Please log in again." });
    }
    await pool.query(
      `INSERT INTO products (title, price, category, description, listing_type, image_url, condition_label, hostel_name, user_id)
       VALUES (?, ?, 'Hostel Essentials', ?, 'sell', ?, 'Good', ?, ?)`,
      [normalizeText(title), normalizePrice(price), normalizeText(description), imageUrl, normalizeText(hostelName), userId]
    );
    return res.json({ message: "Hostel essential posted." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to post hostel essential." });
  }
});

app.get("/api/event-tickets", async (_req, res) => {
  try {
    const [tickets] = await pool.query(
      `SELECT event_tickets.*, event_tickets.event_name AS eventName, event_tickets.event_date AS eventDate,
        event_tickets.valid_until AS validUntil, event_tickets.image_url AS imageUrl, event_tickets.user_id AS userId, users.email
       FROM event_tickets INNER JOIN users ON users.id = event_tickets.user_id
       ORDER BY event_tickets.created_at DESC`
    );
    return res.json({ tickets });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load event tickets." });
  }
});

app.post("/api/event-tickets", async (req, res) => {
  const { userId, eventName, eventDate, venue, quantity, price, validUntil, imageUrl = null } = req.body;

  if (!userId || !requireFields(res, [eventName, eventDate, venue, validUntil], "All event ticket fields are required.") || !Number(quantity) || !normalizePrice(price)) {
    return res.status(400).json({ message: "Valid quantity and price are required." });
  }

  try {
    if (!(await userExists(userId))) {
      return res.status(401).json({ message: "Please log in again." });
    }
    await pool.query(
      `INSERT INTO event_tickets (event_name, event_date, venue, quantity, price, valid_until, image_url, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [normalizeText(eventName), eventDate, normalizeText(venue), Number(quantity), normalizePrice(price), validUntil, imageUrl, userId]
    );
    return res.json({ message: "Event ticket posted." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to post event ticket." });
  }
});

app.patch("/api/event-tickets/:id/sold", async (req, res) => {
  const ticketId = Number(req.params.id);
  const userId = Number(req.body.userId);

  if (!ticketId || !userId) {
    return res.status(400).json({ message: "Ticket and user are required." });
  }

  try {
    const [[ticket]] = await pool.query("SELECT id, user_id AS userId FROM event_tickets WHERE id = ?", [ticketId]);
    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found." });
    }
    if (ticket.userId !== userId) {
      return res.status(403).json({ message: "Only the seller can mark this ticket sold." });
    }
    await pool.query("UPDATE event_tickets SET status = 'sold' WHERE id = ?", [ticketId]);
    return res.json({ message: "Ticket marked sold." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to update ticket." });
  }
});

app.get("/api/roommates", async (req, res) => {
  const hostel = normalizeText(req.query.hostel);
  const gender = normalizeText(req.query.gender);
  const filters = [];
  const params = [];
  if (hostel) { filters.push("LOWER(hostel) LIKE LOWER(?)"); params.push(`%${hostel}%`); }
  if (gender) { filters.push("LOWER(gender_preference) LIKE LOWER(?)"); params.push(`%${gender}%`); }

  try {
    const [posts] = await pool.query(
      `SELECT roommate_posts.*, roommate_posts.room_type AS roomType, roommate_posts.gender_preference AS genderPreference,
        roommate_posts.contact_details AS contactDetails, roommate_posts.user_id AS userId, users.email
       FROM roommate_posts INNER JOIN users ON users.id = roommate_posts.user_id
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY roommate_posts.created_at DESC`,
      params
    );
    return res.json({ posts });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load roommate posts." });
  }
});

app.post("/api/roommates", async (req, res) => {
  const { userId, hostel, roomType, budget, genderPreference, contactDetails, description } = req.body;

  if (!userId || !requireFields(res, [hostel, roomType, genderPreference, contactDetails, description], "All roommate fields are required.") || !normalizePrice(budget)) {
    return res.status(400).json({ message: "A valid budget is required." });
  }

  try {
    if (!(await userExists(userId))) {
      return res.status(401).json({ message: "Please log in again." });
    }
    await pool.query(
      `INSERT INTO roommate_posts (hostel, room_type, budget, gender_preference, contact_details, description, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [normalizeText(hostel), normalizeText(roomType), normalizePrice(budget), normalizeText(genderPreference), normalizeText(contactDetails), normalizeText(description), userId]
    );
    return res.json({ message: "Roommate requirement posted." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to post roommate requirement." });
  }
});

app.get("/api/club-merchandise", async (_req, res) => {
  try {
    const [items] = await pool.query(
      `SELECT club_merchandise.*, club_merchandise.club_name AS clubName, club_merchandise.item_name AS itemName,
        club_merchandise.item_type AS itemType, club_merchandise.image_url AS imageUrl, club_merchandise.user_id AS userId, users.email
       FROM club_merchandise INNER JOIN users ON users.id = club_merchandise.user_id
       ORDER BY club_merchandise.created_at DESC`
    );
    return res.json({ items });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load club merchandise." });
  }
});

app.post("/api/club-merchandise", async (req, res) => {
  const { userId, clubName, itemName, itemType, price, quantity, description, imageUrl = null } = req.body;

  if (!userId || !requireFields(res, [clubName, itemName, itemType, description], "All club merchandise fields are required.") || !normalizePrice(price) || !Number(quantity)) {
    return res.status(400).json({ message: "Valid price and quantity are required." });
  }

  try {
    if (!(await userExists(userId))) {
      return res.status(401).json({ message: "Please log in again." });
    }
    await pool.query(
      `INSERT INTO club_merchandise (club_name, item_name, item_type, price, quantity, image_url, description, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [normalizeText(clubName), normalizeText(itemName), normalizeText(itemType), normalizePrice(price), Number(quantity), imageUrl, normalizeText(description), userId]
    );
    return res.json({ message: "Club merchandise posted." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to post merchandise." });
  }
});

app.patch("/api/club-merchandise/:id/purchase", async (req, res) => {
  const itemId = Number(req.params.id);
  const userId = Number(req.body.userId);

  if (!itemId || !userId) {
    return res.status(400).json({ message: "Item and user are required." });
  }

  try {
    const [[item]] = await pool.query("SELECT id, item_name AS itemName, quantity, user_id AS ownerId FROM club_merchandise WHERE id = ?", [itemId]);
    if (!item || item.quantity < 1) {
      return res.status(404).json({ message: "Merchandise is unavailable." });
    }
    if (item.ownerId === userId) {
      return res.status(400).json({ message: "You cannot purchase your own merchandise." });
    }
    await pool.query("UPDATE club_merchandise SET quantity = quantity - 1, status = CASE WHEN quantity - 1 <= 0 THEN 'sold' ELSE status END WHERE id = ?", [itemId]);
    await createNotification(item.ownerId, "merchandise", "Merchandise purchase interest", `A student wants ${item.itemName}.`, "campus.html");
    return res.json({ message: "Purchase interest recorded." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to purchase merchandise." });
  }
});

app.get("/api/opportunities", async (req, res) => {
  const search = normalizeText(req.query.search);
  const type = normalizeText(req.query.type);
  const filters = [];
  const params = [];
  if (type) { filters.push("LOWER(opportunity_type) LIKE LOWER(?)"); params.push(`%${type}%`); }
  if (search) { filters.push("LOWER(CONCAT(company_name, ' ', role, ' ', location, ' ', eligibility)) LIKE LOWER(?)"); params.push(`%${search}%`); }

  try {
    const [jobs] = await pool.query(
      `SELECT id, company_name AS companyName, role, location, stipend, eligibility, deadline,
        apply_link AS applyLink, opportunity_type AS opportunityType, user_id AS userId, created_at AS createdAt
       FROM opportunities ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY deadline ASC, created_at DESC`,
      params
    );
    return res.json({ jobs });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load opportunities." });
  }
});

app.post("/api/opportunities", async (req, res) => {
  const { userId, companyName, role, location, stipend, eligibility, deadline, applyLink, opportunityType } = req.body;

  if (!userId || !requireFields(res, [companyName, role, location, stipend, eligibility, deadline, applyLink, opportunityType], "All opportunity fields are required.")) {
    return;
  }

  try {
    const [[user]] = await pool.query("SELECT id, email FROM users WHERE id = ?", [userId]);
    if (!user) {
      return res.status(401).json({ message: "Please log in again." });
    }
    await pool.query(
      `INSERT INTO opportunities (company_name, role, location, stipend, eligibility, deadline, apply_link, opportunity_type, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [normalizeText(companyName), normalizeText(role), normalizeText(location), normalizeText(stipend), normalizeText(eligibility), deadline, normalizeText(applyLink), normalizeText(opportunityType), userId]
    );
    return res.json({ message: "Opportunity posted." });
  } catch (error) {
    return res.status(500).json({ message: "Unable to post opportunity." });
  }
});
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database setup failed:", error.code || "UNKNOWN_ERROR", error.message || error);
    process.exit(1);
  });







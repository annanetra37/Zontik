require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { getPool, migrate } = require("./db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { Resend } = require("resend");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const JWT_SECRET = process.env.JWT_SECRET || "zontik-secret-change-in-prod";
if (!process.env.JWT_SECRET) {
  console.warn("⚠ WARNING: JWT_SECRET not set — using insecure default. Set JWT_SECRET in production!");
}

// ── Email setup ──
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const MAIL_FROM = process.env.MAIL_FROM || "onboarding@resend.dev";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// Non-blocking email send — logs errors but never blocks the request
function sendMailAsync({ from, to, subject, html }) {
  if (resend) {
    const recipient = Array.isArray(to) ? to : [to];
    console.log("Sending email via Resend to:", recipient.join(", "));
    resend.emails
      .send({ from: from || MAIL_FROM, to: recipient, subject, html })
      .then((result) => {
        console.log("Email sent successfully:", JSON.stringify(result));
      })
      .catch((err) => {
        console.error("Email send failed (Resend):", JSON.stringify(err));
      });
  } else {
    console.warn("⚠ No RESEND_API_KEY set — skipping email to", to);
  }
}

const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, GIF, and WebP images are allowed"));
  },
});

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com", "https://www.google-analytics.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.cloudinary.com", "https://res.cloudinary.com"],
      connectSrc: ["'self'", "https://www.google-analytics.com", "https://*.analytics.google.com", "https://*.google-analytics.com", "https://*.googletagmanager.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// ── Rate limiters ──
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again in 15 minutes" },
});

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions, please try again later" },
});

// Parse JSON bodies with size limit
app.use(express.json({ limit: "1mb" }));

// ── Request logging middleware ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Run migration on startup
migrate()
  .then(() => console.log("Database ready"))
  .catch((err) => console.error("Migration failed:", err.message));

// ── In-memory cache for businesses list ──
let businessesCache = null;
let businessesCacheTime = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

function invalidateBusinessesCache() {
  businessesCache = null;
  businessesCacheTime = 0;
}

// Blocked domains for website field — social media is not a business website
const SOCIAL_DOMAINS = [
  "instagram.com", "www.instagram.com",
  "facebook.com", "www.facebook.com", "fb.com", "m.facebook.com",
  "twitter.com", "www.twitter.com", "x.com", "www.x.com",
  "tiktok.com", "www.tiktok.com",
  "linkedin.com", "www.linkedin.com",
  "youtube.com", "www.youtube.com", "youtu.be",
  "pinterest.com", "www.pinterest.com",
  "snapchat.com", "www.snapchat.com",
  "reddit.com", "www.reddit.com",
  "tumblr.com", "www.tumblr.com",
  "threads.net", "www.threads.net",
];

function isSocialMediaUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return SOCIAL_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

// Normalize website URL — auto-prepend https:// if missing
function normalizeUrl(url) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return url;
}

// Validate URL protocol (reject javascript:, data:, etc.)
function isSafeUrl(url) {
  if (!url || !url.trim()) return true; // empty is ok (optional field)
  try {
    const p = new URL(url.trim().startsWith("http") ? url.trim() : "https://" + url.trim());
    return p.protocol === "https:" || p.protocol === "http:";
  } catch {
    return false;
  }
}

const VALID_CATEGORIES = ["food", "tech", "craft", "health", "fashion", "education", "travel", "home", "toys"];

// ── Cloudinary setup ──
const cloudinary = require("cloudinary").v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Helper: upload file buffer to Cloudinary and return the public URL
async function uploadToCloudinary(file, bizId, fieldName, index) {
  const suffix = index !== undefined ? `_${index}` : "";
  const publicId = `zontik/${bizId}_${fieldName}${suffix}_${Date.now()}`;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: publicId, resource_type: "image", overwrite: true },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(file.buffer);
  });
}

// Helper: delete an image from Cloudinary given its public URL
function deleteFromCloudinary(url) {
  if (!url || !/^https?:\/\//.test(url)) return;
  // Don't delete legacy base64 or local paths
  if (!url.includes("cloudinary.com") && !url.includes("res.cloudinary")) return;
  // Extract public_id from URL: .../upload/v123/zontik/filename.ext
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
  if (match) {
    cloudinary.uploader.destroy(match[1], { resource_type: "image" }).catch(() => {});
  }
}

// Helper: resolve image field to a public URL for the frontend.
// For listings we use a prefix (LEFT(col, 512)) to avoid loading full base64 blobs.
function resolveImageUrl(id, field, valueOrPrefix, bustCache) {
  if (!valueOrPrefix) return null;
  // External/Cloudinary URL — return directly
  if (/^https?:\/\//i.test(valueOrPrefix)) return valueOrPrefix;
  // Local file path (legacy) — return directly
  if (valueOrPrefix.startsWith("/uploads/")) return valueOrPrefix;
  // base64 data URL (legacy) — serve through our image endpoint
  const url = `/api/images/${id}/${field}`;
  return bustCache ? `${url}?v=${Date.now()}` : url;
}

// ── API: Serve images from DB as public URLs ──
app.get("/api/images/:id/:field", async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).end();
  const id = parseInt(req.params.id, 10);
  const field = req.params.field;
  if (isNaN(id) || !["logo", "product_photo"].includes(field)) return res.status(400).end();

  try {
    const { rows } = await pool.query(`SELECT ${field} FROM businesses WHERE id = $1`, [id]);
    if (!rows.length || !rows[0][field]) return res.status(404).end();

    const dataUrl = rows[0][field];

    // If the stored value is an external URL, redirect to it
    if (/^https?:\/\//i.test(dataUrl)) {
      res.set("Cache-Control", "public, max-age=86400");
      return res.redirect(dataUrl);
    }

    // Otherwise treat as base64 data URL
    const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,([\s\S]+)$/);
    if (!match) return res.status(404).end();

    res.set("Content-Type", match[1]);
    res.set("Cache-Control", "public, max-age=300");
    res.send(Buffer.from(match[2], "base64"));
  } catch {
    res.status(500).end();
  }
});

// ── API: Serve additional product photos ──
app.get("/api/images/:bizId/photos/:photoId", async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).end();
  const bizId = parseInt(req.params.bizId, 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (isNaN(bizId) || isNaN(photoId)) return res.status(400).end();
  try {
    const { rows } = await pool.query("SELECT photo FROM product_photos WHERE id = $1 AND business_id = $2", [photoId, bizId]);
    if (!rows.length || !rows[0].photo) return res.status(404).end();
    const dataUrl = rows[0].photo;
    if (/^https?:\/\//i.test(dataUrl)) { res.set("Cache-Control", "public, max-age=86400"); return res.redirect(dataUrl); }
    const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,([\s\S]+)$/);
    if (!match) return res.status(404).end();
    res.set("Content-Type", match[1]);
    res.set("Cache-Control", "public, max-age=300");
    res.send(Buffer.from(match[2], "base64"));
  } catch { res.status(500).end(); }
});

// Health check
app.get("/health", async (_req, res) => {
  const pool = getPool();
  const status = { status: "ok", timestamp: new Date().toISOString() };
  if (pool) {
    try {
      await pool.query("SELECT 1");
      status.database = "connected";
    } catch {
      status.database = "disconnected";
    }
  } else {
    status.database = "not configured";
  }
  res.json(status);
});

// ── Auth middleware ──
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Login required" });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function authOptional(req, _res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try { req.user = jwt.verify(header.slice(7), JWT_SECRET); } catch {}
  }
  next();
}

async function adminRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Login required" });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const { rows } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.user.id]);
  if (!rows.length || !rows[0].is_admin) return res.status(403).json({ error: "Admin access required" });
  next();
}

// ── Auth: Register ──
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });

  const { email, password, name } = req.body;
  if (!email?.trim() || !password || !name?.trim()) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const { rows } = await pool.query(
      "INSERT INTO users (email, password_hash, name, verification_token, email_verified) VALUES ($1, $2, $3, $4, FALSE) RETURNING id, email, name",
      [email.trim().toLowerCase(), hash, name.trim(), verificationToken]
    );
    const user = rows[0];

    // Send verification email (non-blocking)
    const verifyUrl = `${BASE_URL}/api/auth/verify?token=${verificationToken}`;
    sendMailAsync({
      from: MAIL_FROM,
      to: user.email,
      subject: "Verify your Zontik account",
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
        <h2 style="color:#7c6ff0">Welcome to Zontik!</h2>
        <p>Hi ${name.trim()},</p>
        <p>Please verify your email address to start listing businesses and writing reviews.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#7c6ff0;color:#fff;padding:0.75rem 1.5rem;border-radius:0.5rem;text-decoration:none;font-weight:600;margin:1rem 0">Verify My Email</a>
        <p style="color:#888;font-size:0.85rem">If you didn't create this account, you can ignore this email.</p>
      </div>`,
    });

    res.status(201).json({ message: "Account created! Please check your email to verify your account." });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "An account with this email already exists" });
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ── Auth: Verify email ──
app.get("/api/auth/verify", async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).send("Database not available");
  const { token } = req.query;
  if (!token) return res.status(400).send("Missing verification token");
  try {
    const { rows } = await pool.query(
      "UPDATE users SET email_verified = TRUE, verification_token = NULL WHERE verification_token = $1 RETURNING id, email, name",
      [token]
    );
    if (!rows.length) return res.status(400).send("Invalid or expired verification link");
    res.redirect("/?verified=1");
  } catch (err) {
    console.error("Verify error:", err.message);
    res.status(500).send("Verification failed");
  }
});

// ── Auth: Resend verification email ──
app.post("/api/auth/resend-verification", authLimiter, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const { email } = req.body;
  if (!email?.trim()) return res.status(400).json({ error: "Email is required" });
  try {
    const { rows } = await pool.query("SELECT id, name, email_verified, verification_token FROM users WHERE email = $1", [email.trim().toLowerCase()]);
    if (!rows.length) return res.json({ message: "If that email exists, a verification link has been sent." });
    if (rows[0].email_verified) return res.json({ message: "Email is already verified. You can log in." });
    let vToken = rows[0].verification_token;
    if (!vToken) {
      vToken = crypto.randomBytes(32).toString("hex");
      await pool.query("UPDATE users SET verification_token = $1 WHERE id = $2", [vToken, rows[0].id]);
    }
    const verifyUrl = `${BASE_URL}/api/auth/verify?token=${vToken}`;
    sendMailAsync({
      from: MAIL_FROM,
      to: email.trim().toLowerCase(),
      subject: "Verify your Zontik account",
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
        <h2 style="color:#7c6ff0">Verify your email</h2>
        <p>Hi ${rows[0].name},</p>
        <p>Click below to verify your email address:</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#7c6ff0;color:#fff;padding:0.75rem 1.5rem;border-radius:0.5rem;text-decoration:none;font-weight:600;margin:1rem 0">Verify My Email</a>
      </div>`,
    });
    res.json({ message: "If that email exists, a verification link has been sent." });
  } catch (err) {
    console.error("Resend verification error:", err.message);
    res.status(500).json({ error: "Failed to resend verification email" });
  }
});

// ── Auth: Forgot password ──
app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const { email } = req.body;
  if (!email?.trim()) return res.status(400).json({ error: "Email is required" });
  try {
    const { rows } = await pool.query("SELECT id, name FROM users WHERE email = $1", [email.trim().toLowerCase()]);
    // Always return success to prevent email enumeration
    if (!rows.length) return res.json({ message: "If that email exists, a reset link has been sent." });
    const resetToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query("UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3", [resetToken, expires, rows[0].id]);
    const resetUrl = `${BASE_URL}/reset-password.html?token=${resetToken}`;
    sendMailAsync({
      from: MAIL_FROM,
      to: email.trim().toLowerCase(),
      subject: "Reset your Zontik password",
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
        <h2 style="color:#7c6ff0">Reset your password</h2>
        <p>Hi ${rows[0].name},</p>
        <p>We received a request to reset your password. Click the button below to choose a new one:</p>
        <a href="${resetUrl}" style="display:inline-block;background:#7c6ff0;color:#fff;padding:0.75rem 1.5rem;border-radius:0.5rem;text-decoration:none;font-weight:600;margin:1rem 0">Reset Password</a>
        <p style="color:#888;font-size:0.85rem">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
      </div>`,
    });
    res.json({ message: "If that email exists, a reset link has been sent." });
  } catch (err) {
    console.error("Forgot password error:", err.message);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// ── Auth: Reset password ──
app.post("/api/auth/reset-password", authLimiter, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and new password are required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  try {
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()",
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: "Invalid or expired reset link. Please request a new one." });
    const hash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2", [hash, rows[0].id]);
    res.json({ message: "Password has been reset! You can now log in." });
  } catch (err) {
    console.error("Reset password error:", err.message);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ── Auth: Login ──
app.post("/api/auth/login", authLimiter, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });

  const { email, password } = req.body;
  if (!email?.trim() || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email.trim().toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: "Invalid email or password" });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });

    if (!user.email_verified) {
      return res.status(403).json({ error: "Please verify your email before logging in. Check your inbox for the verification link.", unverified: true, email: user.email });
    }

    const isAdmin = !!user.is_admin;
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, is_admin: isAdmin }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, is_admin: isAdmin } });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Auth: Get current user ──
app.get("/api/auth/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

// ── Auth: Get user's businesses ──
app.get("/api/auth/my-businesses", authRequired, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.category, b.description, b.website, b.city, b.country,
              b.price_range, b.tags, b.emoji,
              LEFT(b.logo, 512) AS logo_prefix,
              LEFT(b.product_photo, 512) AS photo_prefix,
              COALESCE(r.avg_rating, 0) AS avg_rating,
              COALESCE(r.review_count, 0) AS review_count
       FROM businesses b
       LEFT JOIN (
         SELECT business_id,
                ROUND(AVG(rating)::numeric, 1) AS avg_rating,
                COUNT(*) AS review_count
         FROM reviews GROUP BY business_id
       ) r ON r.business_id = b.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    rows.forEach(r => {
      r.logo = resolveImageUrl(r.id, 'logo', r.logo_prefix, true);
      r.product_photo = resolveImageUrl(r.id, 'product_photo', r.photo_prefix, true);
      delete r.logo_prefix; delete r.photo_prefix;
    });
    res.json(rows);
  } catch (err) {
    console.error("GET my-businesses error:", err.message);
    res.status(500).json({ error: "Failed to fetch your businesses" });
  }
});

// countries.json is served statically from public/

// ── API: Get all approved businesses (cached) ──
app.get("/api/businesses", async (_req, res) => {
  // Serve from cache if still fresh
  if (businessesCache && (Date.now() - businessesCacheTime) < CACHE_TTL_MS) {
    return res.json(businessesCache);
  }
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.category, b.description, b.website, b.city, b.country,
              b.address, b.price_range, b.tags, b.emoji, b.featured, b.pin_order, b.year_founded,
              b.owner_name, b.short_tagline, b.instagram, b.facebook, b.linkedin, b.tiktok,
              LEFT(b.logo, 512) AS logo_prefix,
              LEFT(b.product_photo, 512) AS photo_prefix,
              b.user_id,
              COALESCE(r.avg_rating, 0) AS avg_rating,
              COALESCE(r.review_count, 0) AS review_count
       FROM businesses b
       LEFT JOIN (
         SELECT business_id,
                ROUND(AVG(rating)::numeric, 1) AS avg_rating,
                COUNT(*) AS review_count
         FROM reviews
         GROUP BY business_id
       ) r ON r.business_id = b.id
       WHERE b.approved = TRUE
       ORDER BY b.featured DESC, b.pin_order DESC, COALESCE(r.review_count, 0) DESC, b.created_at DESC`
    );
    rows.forEach(r => {
      r.logo = resolveImageUrl(r.id, 'logo', r.logo_prefix, false);
      r.product_photo = resolveImageUrl(r.id, 'product_photo', r.photo_prefix, false);
      delete r.logo_prefix; delete r.photo_prefix;
    });

    // Attach additional product photo URLs to each business
    const bizIds = rows.map(r => r.id);
    if (bizIds.length) {
      const { rows: photos } = await pool.query(
        "SELECT id, business_id, LEFT(photo, 512) AS photo_prefix FROM product_photos WHERE business_id = ANY($1::int[]) ORDER BY sort_order, id",
        [bizIds]
      );
      const photosByBiz = {};
      photos.forEach(p => {
        if (!photosByBiz[p.business_id]) photosByBiz[p.business_id] = [];
        // Use direct URL for Cloudinary/external/local, fallback to API endpoint for legacy base64
        const prefix = p.photo_prefix || "";
        const url = /^https?:\/\//i.test(prefix) || prefix.startsWith("/uploads/")
          ? prefix
          : `/api/images/${p.business_id}/photos/${p.id}`;
        photosByBiz[p.business_id].push({ id: p.id, url });
      });
      rows.forEach(r => { r.product_photos = photosByBiz[r.id] || []; });
    }

    // Update cache
    businessesCache = rows;
    businessesCacheTime = Date.now();
    res.json(rows);
  } catch (err) {
    console.error("GET /api/businesses error:", err.message);
    res.status(500).json({ error: "Failed to fetch businesses" });
  }
});

// ── API: Submit a new business listing (auth required, with image uploads) ──
app.post("/api/businesses", authRequired, submitLimiter, upload.fields([
  { name: "logo", maxCount: 1 },
  { name: "product_photo", maxCount: 1 },
  { name: "product_photos", maxCount: 10 },
]), async (req, res) => {
  const pool = getPool();
  if (!pool) {
    console.error("POST /api/businesses — DATABASE_URL not set, cannot save");
    return res.status(503).json({ error: "Database is not available. Please try again later." });
  }

  const {
    name, category, description, city, country, address,
    contact_email, contact_phone, price_range, tags, emoji,
    year_founded, owner_name, short_tagline,
    instagram, facebook, linkedin, tiktok,
  } = req.body;

  let { website } = req.body;

  // Validate required fields
  const missing = [];
  if (!name?.trim()) missing.push("name");
  if (!category?.trim()) missing.push("category");
  if (!description?.trim()) missing.push("description");
  if (!website?.trim()) missing.push("website");
  if (!city?.trim()) missing.push("city");
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
  }

  // Basic email format check (only if provided)
  if (contact_email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email.trim())) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  // Normalize and validate website URL
  website = normalizeUrl(website);

  // Reject social media URLs as website
  if (isSocialMediaUrl(website)) {
    return res.status(400).json({
      error: "Please enter your business domain, not a social media page. Add social links in the Social Media section.",
    });
  }

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Category must be one of: ${VALID_CATEGORIES.join(", ")}` });
  }

  // Validate all URL fields
  const urlFields = { instagram, facebook, linkedin, tiktok };
  for (const [field, val] of Object.entries(urlFields)) {
    if (val && !isSafeUrl(val)) {
      return res.status(400).json({ error: `Invalid URL for ${field}` });
    }
  }

  const tagArray = Array.isArray(tags)
    ? tags.map((t) => t.trim()).filter(Boolean)
    : (tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  // Extract domain from website for uniqueness check
  let websiteDomain;
  try {
    websiteDomain = new URL(website).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    websiteDomain = website.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
  }

  console.log(`New business submission: "${name}" (${category}) from ${city}, ${country} — domain: ${websiteDomain}`);

  try {
    // First insert without images to get the business ID
    const result = await pool.query(
      `INSERT INTO businesses
        (name, category, description, website, website_domain, city, country, address,
         contact_email, contact_phone, price_range, tags, emoji,
         year_founded, owner_name, short_tagline,
         instagram, facebook, linkedin, tiktok, approved,
         user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,TRUE,$21)
       RETURNING id`,
      [
        name.trim(), category.trim(), description.trim(), website, websiteDomain,
        city.trim(), (country || "").trim(), address?.trim() || null,
        contact_email?.trim() || null, contact_phone?.trim() || null,
        price_range || "€",
        tagArray, emoji || "🏪",
        year_founded ? parseInt(year_founded, 10) : null,
        owner_name?.trim() || null, short_tagline?.trim() || null,
        instagram?.trim() || null, facebook?.trim() || null,
        linkedin?.trim() || null, tiktok?.trim() || null,
        req.user.id,
      ]
    );
    const newBizId = result.rows[0].id;

    // Upload images to Cloudinary and store public URLs in DB
    let logoUrl = null;
    let productPhotoUrl = null;
    if (req.files?.logo?.[0]) logoUrl = await uploadToCloudinary(req.files.logo[0], newBizId, "logo");
    if (req.files?.product_photo?.[0]) productPhotoUrl = await uploadToCloudinary(req.files.product_photo[0], newBizId, "product_photo");
    if (logoUrl || productPhotoUrl) {
      await pool.query("UPDATE businesses SET logo = $1, product_photo = $2 WHERE id = $3", [logoUrl, productPhotoUrl, newBizId]);
    }

    // Upload additional product photos
    if (req.files?.product_photos?.length) {
      for (let i = 0; i < req.files.product_photos.length; i++) {
        const photoUrl = await uploadToCloudinary(req.files.product_photos[i], newBizId, "photo", i);
        await pool.query("INSERT INTO product_photos (business_id, photo, sort_order) VALUES ($1, $2, $3)", [newBizId, photoUrl, i]);
      }
    }

    console.log(`Business "${name}" saved and live (owner: user #${req.user.id})`);
    invalidateBusinessesCache();
    res.status(201).json({ message: "Business listed successfully! It's now live on Zoncik." });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: `A business with the domain "${websiteDomain}" is already listed. Each domain can only be listed once.` });
    }
    console.error("POST /api/businesses error:", err.message);
    res.status(500).json({ error: "Failed to submit business" });
  }
});

// ── API: Edit a business (owner only) ──
app.put("/api/businesses/:id", authRequired, upload.fields([
  { name: "logo", maxCount: 1 },
  { name: "product_photo", maxCount: 1 },
  { name: "product_photos", maxCount: 10 },
]), async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid business ID" });

  // Check ownership
  const { rows: biz } = await pool.query("SELECT user_id, logo, product_photo FROM businesses WHERE id = $1", [id]);
  if (!biz.length) return res.status(404).json({ error: "Business not found" });
  if (biz[0].user_id !== req.user.id) return res.status(403).json({ error: "You can only edit your own businesses" });

  const {
    name, category, description, city, country, address,
    contact_email, contact_phone, price_range, tags, emoji,
    year_founded, owner_name, short_tagline,
    instagram, facebook, linkedin, tiktok,
  } = req.body;

  let { website } = req.body;

  // Validate required fields
  const missing = [];
  if (!name?.trim()) missing.push("name");
  if (!category?.trim()) missing.push("category");
  if (!description?.trim()) missing.push("description");
  if (!website?.trim()) missing.push("website");
  if (!city?.trim()) missing.push("city");
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });

  if (contact_email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email.trim())) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  website = normalizeUrl(website);
  if (isSocialMediaUrl(website)) {
    return res.status(400).json({ error: "Please enter your business domain, not a social media page." });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Category must be one of: ${VALID_CATEGORIES.join(", ")}` });
  }

  const tagArray = Array.isArray(tags)
    ? tags.map((t) => t.trim()).filter(Boolean)
    : (tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  let websiteDomain;
  try {
    websiteDomain = new URL(website).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    websiteDomain = website.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
  }

  // Handle image uploads — new upload replaces, otherwise keep existing
  let logoUrl = req.body.keep_logo === "true" ? biz[0].logo : null;
  let productPhotoUrl = req.body.keep_product_photo === "true" ? biz[0].product_photo : null;
  if (req.files?.logo?.[0]) {
    deleteFromCloudinary(biz[0].logo);
    logoUrl = await uploadToCloudinary(req.files.logo[0], id, "logo");
  } else if (!logoUrl) {
    deleteFromCloudinary(biz[0].logo);
  }
  if (req.files?.product_photo?.[0]) {
    deleteFromCloudinary(biz[0].product_photo);
    productPhotoUrl = await uploadToCloudinary(req.files.product_photo[0], id, "product_photo");
  } else if (!productPhotoUrl) {
    deleteFromCloudinary(biz[0].product_photo);
  }

  try {
    await pool.query(
      `UPDATE businesses SET
        name=$1, category=$2, description=$3, website=$4, website_domain=$5,
        city=$6, country=$7, address=$8, contact_email=$9, contact_phone=$10,
        price_range=$11, tags=$12, emoji=$13, year_founded=$14,
        owner_name=$15, short_tagline=$16, instagram=$17, facebook=$18,
        linkedin=$19, tiktok=$20, logo=$21, product_photo=$22
       WHERE id=$23`,
      [
        name.trim(), category.trim(), description.trim(), website, websiteDomain,
        city.trim(), (country || "").trim(), address?.trim() || null,
        contact_email?.trim() || null, contact_phone?.trim() || null,
        price_range || "€", tagArray, emoji || "🏪",
        year_founded ? parseInt(year_founded, 10) : null,
        owner_name?.trim() || null, short_tagline?.trim() || null,
        instagram?.trim() || null, facebook?.trim() || null,
        linkedin?.trim() || null, tiktok?.trim() || null,
        logoUrl, productPhotoUrl, id,
      ]
    );
    // Handle additional product photos
    // Delete photos the user removed (clean up from Cloudinary)
    const keepPhotoIds = req.body.keep_photo_ids;
    if (keepPhotoIds !== undefined) {
      const idsToKeep = (Array.isArray(keepPhotoIds) ? keepPhotoIds : [keepPhotoIds]).filter(Boolean).map(Number);
      let delQuery, delParams;
      if (idsToKeep.length) {
        delQuery = "SELECT id, photo FROM product_photos WHERE business_id = $1 AND id != ALL($2::int[])";
        delParams = [id, idsToKeep];
      } else {
        delQuery = "SELECT id, photo FROM product_photos WHERE business_id = $1";
        delParams = [id];
      }
      const { rows: toDelete } = await pool.query(delQuery, delParams);
      toDelete.forEach(p => deleteFromCloudinary(p.photo));
      if (idsToKeep.length) {
        await pool.query("DELETE FROM product_photos WHERE business_id = $1 AND id != ALL($2::int[])", [id, idsToKeep]);
      } else {
        await pool.query("DELETE FROM product_photos WHERE business_id = $1", [id]);
      }
    }
    // Upload new photos to Cloudinary
    if (req.files?.product_photos?.length) {
      const { rows: maxOrder } = await pool.query("SELECT COALESCE(MAX(sort_order), -1) AS mx FROM product_photos WHERE business_id = $1", [id]);
      let order = (maxOrder[0]?.mx ?? -1) + 1;
      for (let i = 0; i < req.files.product_photos.length; i++) {
        const photoUrl = await uploadToCloudinary(req.files.product_photos[i], id, "photo", order);
        await pool.query("INSERT INTO product_photos (business_id, photo, sort_order) VALUES ($1, $2, $3)", [id, photoUrl, order++]);
      }
    }

    console.log(`Business #${id} updated by user #${req.user.id}`);
    invalidateBusinessesCache();
    res.json({ message: "Business updated successfully!" });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "A business with this domain already exists." });
    console.error("PUT /api/businesses error:", err.message);
    res.status(500).json({ error: "Failed to update business" });
  }
});

// ── API: Delete a business (owner only) ──
app.delete("/api/businesses/:id", authRequired, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid business ID" });
  try {
    const { rows } = await pool.query("SELECT user_id, logo, product_photo FROM businesses WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Business not found" });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: "You can only delete your own businesses" });
    // Clean up from Cloudinary
    deleteFromCloudinary(rows[0].logo);
    deleteFromCloudinary(rows[0].product_photo);
    const { rows: photos } = await pool.query("SELECT photo FROM product_photos WHERE business_id = $1", [id]);
    photos.forEach(p => deleteFromCloudinary(p.photo));
    await pool.query("DELETE FROM reviews WHERE business_id = $1", [id]);
    await pool.query("DELETE FROM businesses WHERE id = $1", [id]);
    console.log(`Business #${id} deleted by user #${req.user.id}`);
    invalidateBusinessesCache();
    res.json({ message: "Business deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/businesses error:", err.message);
    res.status(500).json({ error: "Failed to delete business" });
  }
});

// ── API: Get single business (for edit form) ──
app.get("/api/businesses/:id", async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid business ID" });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, category, description, website, city, country, address,
              contact_email, contact_phone, price_range, tags, emoji,
              year_founded, owner_name, short_tagline,
              instagram, facebook, linkedin, tiktok, user_id,
              LEFT(logo, 512) AS logo_prefix,
              LEFT(product_photo, 512) AS photo_prefix
       FROM businesses WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Business not found" });
    const b = rows[0];
    b.logo = resolveImageUrl(b.id, 'logo', b.logo_prefix, true);
    b.product_photo = resolveImageUrl(b.id, 'product_photo', b.photo_prefix, true);
    delete b.logo_prefix; delete b.photo_prefix;

    // Fetch additional product photos
    const { rows: photos } = await pool.query(
      "SELECT id, LEFT(photo, 512) AS photo_prefix, sort_order FROM product_photos WHERE business_id = $1 ORDER BY sort_order, id",
      [id]
    );
    b.product_photos = photos.map(p => {
      const prefix = p.photo_prefix || "";
      const url = /^https?:\/\//i.test(prefix)
        ? prefix
        : prefix.startsWith("/uploads/")
          ? prefix
          : `/api/images/${id}/photos/${p.id}?v=${Date.now()}`;
      return { id: p.id, url };
    });

    res.json(b);
  } catch (err) {
    console.error("GET /api/businesses/:id error:", err.message);
    res.status(500).json({ error: "Failed to fetch business" });
  }
});

// ── Admin API: Toggle featured flag ──
app.put("/api/admin/businesses/:id/featured", adminRequired, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid business ID" });
  const featured = req.body.featured === true || req.body.featured === "true";
  try {
    const { rowCount } = await pool.query("UPDATE businesses SET featured = $1 WHERE id = $2", [featured, id]);
    if (!rowCount) return res.status(404).json({ error: "Business not found" });
    console.log(`Admin (user #${req.user.id}) set business #${id} featured=${featured}`);
    invalidateBusinessesCache();
    res.json({ message: `Business ${featured ? "marked as featured" : "unfeatured"}`, featured });
  } catch (err) {
    console.error("Admin featured toggle error:", err.message);
    res.status(500).json({ error: "Failed to update" });
  }
});

// ── Admin API: Set pin_order ──
app.put("/api/admin/businesses/:id/pin", adminRequired, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid business ID" });
  const pinOrder = parseInt(req.body.pin_order, 10) || 0;
  try {
    const { rowCount } = await pool.query("UPDATE businesses SET pin_order = $1 WHERE id = $2", [pinOrder, id]);
    if (!rowCount) return res.status(404).json({ error: "Business not found" });
    console.log(`Admin (user #${req.user.id}) set business #${id} pin_order=${pinOrder}`);
    invalidateBusinessesCache();
    res.json({ message: "Pin order updated", pin_order: pinOrder });
  } catch (err) {
    console.error("Admin pin error:", err.message);
    res.status(500).json({ error: "Failed to update" });
  }
});

// ── Admin API: List all businesses (including unapproved) ──
app.get("/api/admin/businesses", adminRequired, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.category, b.city, b.country, b.featured, b.pin_order,
              b.approved, b.created_at,
              COALESCE(r.review_count, 0) AS review_count
       FROM businesses b
       LEFT JOIN (SELECT business_id, COUNT(*) AS review_count FROM reviews GROUP BY business_id) r
         ON r.business_id = b.id
       ORDER BY b.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Admin list error:", err.message);
    res.status(500).json({ error: "Failed to fetch" });
  }
});

// ── API: Get reviews for a business ──
app.get("/api/businesses/:id/reviews", async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid business ID" });

  try {
    const { rows } = await pool.query(
      `SELECT id, reviewer_name, rating, comment, photo, created_at
       FROM reviews
       WHERE business_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET reviews error:", err.message);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// ── API: Submit a review (with optional photo) ──
app.post("/api/businesses/:id/reviews", submitLimiter, upload.single("photo"), async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database is not available. Please try again later." });

  const businessId = parseInt(req.params.id, 10);
  if (isNaN(businessId)) return res.status(400).json({ error: "Invalid business ID" });

  const { reviewer_name, rating, comment } = req.body;

  if (!reviewer_name?.trim()) {
    return res.status(400).json({ error: "Your name is required" });
  }
  const r = parseInt(rating, 10);
  if (isNaN(r) || r < 1 || r > 5) {
    return res.status(400).json({ error: "Rating must be between 1 and 5" });
  }

  // Save uploaded photo as base64 in DB
  let photoData = null;
  if (req.file) {
    const mime = req.file.mimetype;
    photoData = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
  }

  try {
    const { rows } = await pool.query(
      "SELECT id FROM businesses WHERE id = $1 AND approved = TRUE",
      [businessId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "Business not found" });
    }

    await pool.query(
      `INSERT INTO reviews (business_id, reviewer_name, rating, comment, photo)
       VALUES ($1, $2, $3, $4, $5)`,
      [businessId, reviewer_name.trim(), r, comment?.trim() || null, photoData]
    );

    const stats = await pool.query(
      `SELECT ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*) AS review_count
       FROM reviews WHERE business_id = $1`,
      [businessId]
    );

    console.log(`Review submitted for business #${businessId}: ${r} stars by "${reviewer_name.trim()}"${photoData ? " (with photo)" : ""}`);
    invalidateBusinessesCache();

    res.status(201).json({
      message: "Review submitted!",
      avg_rating: parseFloat(stats.rows[0].avg_rating),
      review_count: parseInt(stats.rows[0].review_count, 10),
    });
  } catch (err) {
    console.error("POST review error:", err.message);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// Multer error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File is too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: 'File upload error: ' + err.message });
  }
  if (err && err.message && err.message.includes('image')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Database: ${process.env.DATABASE_URL ? "configured" : "NOT configured — set DATABASE_URL"}`);
});

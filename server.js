require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { getPool, migrate } = require("./db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "zontik-secret-change-in-prod";

const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 }, // 5MB files, 10MB fields (for base64 data URLs)
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, GIF, and WebP images are allowed"));
  },
});

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

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

const VALID_CATEGORIES = ["food", "tech", "craft", "health", "fashion", "education", "travel", "experiences"];

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

// Helper: convert uploaded file buffer to base64 data URL
function fileToDataUrl(file) {
  const base64 = file.buffer.toString("base64");
  return `data:${file.mimetype};base64,${base64}`;
}

// ── Auth: Register ──
app.post("/api/auth/register", async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });

  const { email, password, name } = req.body;
  if (!email?.trim() || !password || !name?.trim()) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name",
      [email.trim().toLowerCase(), hash, name.trim()]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "An account with this email already exists" });
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ── Auth: Login ──
app.post("/api/auth/login", async (req, res) => {
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

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
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
              b.price_range, b.tags, b.emoji, b.logo, b.product_photo,
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
    res.json(rows);
  } catch (err) {
    console.error("GET my-businesses error:", err.message);
    res.status(500).json({ error: "Failed to fetch your businesses" });
  }
});

// countries.json is served statically from public/

// ── API: Get all approved businesses ──
app.get("/api/businesses", async (_req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.category, b.description, b.website, b.city, b.country,
              b.price_range, b.tags, b.emoji, b.featured, b.year_founded,
              b.owner_name, b.short_tagline, b.instagram, b.facebook, b.linkedin, b.tiktok,
              b.logo, b.product_photo, b.user_id,
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
       ORDER BY b.featured DESC, b.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/businesses error:", err.message);
    res.status(500).json({ error: "Failed to fetch businesses" });
  }
});

// ── API: Submit a new business listing (auth required, with image uploads) ──
app.post("/api/businesses", authRequired, upload.fields([
  { name: "logo", maxCount: 1 },
  { name: "product_photo", maxCount: 1 },
]), async (req, res) => {
  const pool = getPool();
  if (!pool) {
    console.error("POST /api/businesses — DATABASE_URL not set, cannot save");
    return res.status(503).json({ error: "Database is not available. Please try again later." });
  }

  const {
    name, category, description, city, country,
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
  if (!contact_email?.trim()) missing.push("contact_email");
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email.trim())) {
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

  // Handle image uploads
  let logoPath = null;
  let productPhotoPath = null;
  if (req.files?.logo?.[0]) logoPath = fileToDataUrl(req.files.logo[0]);
  if (req.files?.product_photo?.[0]) productPhotoPath = fileToDataUrl(req.files.product_photo[0]);

  console.log(`New business submission: "${name}" (${category}) from ${city}, ${country} — domain: ${websiteDomain}`);

  try {
    await pool.query(
      `INSERT INTO businesses
        (name, category, description, website, website_domain, city, country,
         contact_email, contact_phone, price_range, tags, emoji,
         year_founded, owner_name, short_tagline,
         instagram, facebook, linkedin, tiktok, approved,
         user_id, logo, product_photo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,TRUE,$20,$21,$22)`,
      [
        name.trim(), category.trim(), description.trim(), website, websiteDomain,
        city.trim(), (country || "").trim(),
        contact_email.trim(), contact_phone?.trim() || null,
        price_range || "€",
        tagArray, emoji || "🏪",
        year_founded ? parseInt(year_founded, 10) : null,
        owner_name?.trim() || null, short_tagline?.trim() || null,
        instagram?.trim() || null, facebook?.trim() || null,
        linkedin?.trim() || null, tiktok?.trim() || null,
        req.user.id, logoPath, productPhotoPath,
      ]
    );
    console.log(`Business "${name}" saved and live (owner: user #${req.user.id})`);
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
]), async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid business ID" });

  // Check ownership
  const { rows: biz } = await pool.query("SELECT user_id FROM businesses WHERE id = $1", [id]);
  if (!biz.length) return res.status(404).json({ error: "Business not found" });
  if (biz[0].user_id !== req.user.id) return res.status(403).json({ error: "You can only edit your own businesses" });

  const {
    name, category, description, city, country,
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
  if (!contact_email?.trim()) missing.push("contact_email");
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });

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

  // Handle image uploads (keep existing if not re-uploaded)
  let logoPath = req.body.existing_logo || null;
  let productPhotoPath = req.body.existing_product_photo || null;
  if (req.files?.logo?.[0]) logoPath = fileToDataUrl(req.files.logo[0]);
  if (req.files?.product_photo?.[0]) productPhotoPath = fileToDataUrl(req.files.product_photo[0]);

  try {
    await pool.query(
      `UPDATE businesses SET
        name=$1, category=$2, description=$3, website=$4, website_domain=$5,
        city=$6, country=$7, contact_email=$8, contact_phone=$9,
        price_range=$10, tags=$11, emoji=$12, year_founded=$13,
        owner_name=$14, short_tagline=$15, instagram=$16, facebook=$17,
        linkedin=$18, tiktok=$19, logo=$20, product_photo=$21
       WHERE id=$22`,
      [
        name.trim(), category.trim(), description.trim(), website, websiteDomain,
        city.trim(), (country || "").trim(),
        contact_email.trim(), contact_phone?.trim() || null,
        price_range || "€", tagArray, emoji || "🏪",
        year_founded ? parseInt(year_founded, 10) : null,
        owner_name?.trim() || null, short_tagline?.trim() || null,
        instagram?.trim() || null, facebook?.trim() || null,
        linkedin?.trim() || null, tiktok?.trim() || null,
        logoPath, productPhotoPath, id,
      ]
    );
    console.log(`Business #${id} updated by user #${req.user.id}`);
    res.json({ message: "Business updated successfully!" });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "A business with this domain already exists." });
    console.error("PUT /api/businesses error:", err.message);
    res.status(500).json({ error: "Failed to update business" });
  }
});

// ── API: Get single business (for edit form) ──
app.get("/api/businesses/:id", async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not available" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid business ID" });
  try {
    const { rows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Business not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/businesses/:id error:", err.message);
    res.status(500).json({ error: "Failed to fetch business" });
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
app.post("/api/businesses/:id/reviews", upload.single("photo"), async (req, res) => {
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

  // Save uploaded photo
  let photoPath = null;
  if (req.file) photoPath = fileToDataUrl(req.file);

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
      [businessId, reviewer_name.trim(), r, comment?.trim() || null, photoPath]
    );

    const stats = await pool.query(
      `SELECT ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*) AS review_count
       FROM reviews WHERE business_id = $1`,
      [businessId]
    );

    console.log(`Review submitted for business #${businessId}: ${r} stars by "${reviewer_name.trim()}"${photoPath ? " (with photo)" : ""}`);

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

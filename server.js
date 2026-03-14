const express = require("express");
const path = require("path");
const { getPool, migrate } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Run migration on startup
migrate().catch((err) => console.error("Migration failed:", err.message));

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

// ── API: Get all approved businesses ──
app.get("/api/businesses", async (_req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT id, name, category, description, website, city, country,
              price_range, tags, emoji, featured, year_founded,
              short_tagline, instagram, facebook, linkedin
       FROM businesses
       WHERE approved = TRUE
       ORDER BY featured DESC, created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/businesses error:", err.message);
    res.status(500).json({ error: "Failed to fetch businesses" });
  }
});

// ── API: Submit a new business listing ──
app.post("/api/businesses", async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not configured" });

  const {
    name, category, description, website, city, country,
    contact_email, contact_phone, price_range, tags, emoji,
    year_founded, owner_name, short_tagline,
    instagram, facebook, linkedin,
  } = req.body;

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

  // Basic URL format check
  const urlPattern = /^https?:\/\/.+/i;
  if (!urlPattern.test(website.trim())) {
    return res.status(400).json({ error: "Website must start with http:// or https://" });
  }

  const validCategories = ["food", "tech", "craft", "health", "fashion"];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: `Category must be one of: ${validCategories.join(", ")}` });
  }

  const tagArray = Array.isArray(tags)
    ? tags.map((t) => t.trim()).filter(Boolean)
    : (tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  try {
    await pool.query(
      `INSERT INTO businesses
        (name, category, description, website, city, country,
         contact_email, contact_phone, price_range, tags, emoji,
         year_founded, owner_name, short_tagline,
         instagram, facebook, linkedin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        name.trim(), category.trim(), description.trim(), website.trim(),
        city.trim(), (country || "AT").trim(),
        contact_email.trim(), contact_phone?.trim() || null,
        price_range || "€",
        tagArray, emoji || "🏪",
        year_founded ? parseInt(year_founded, 10) : null,
        owner_name?.trim() || null, short_tagline?.trim() || null,
        instagram?.trim() || null, facebook?.trim() || null, linkedin?.trim() || null,
      ]
    );
    res.status(201).json({ message: "Business submitted successfully! It will appear after review." });
  } catch (err) {
    console.error("POST /api/businesses error:", err.message);
    res.status(500).json({ error: "Failed to submit business" });
  }
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

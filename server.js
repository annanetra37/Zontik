const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection pool — connects automatically when DATABASE_URL is set
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  pool.on("error", (err) => {
    console.error("Unexpected PostgreSQL error:", err);
  });

  pool
    .query("SELECT NOW()")
    .then(() => console.log("PostgreSQL connected"))
    .catch((err) => console.error("PostgreSQL connection failed:", err.message));
}

// Make pool accessible to routes
app.locals.pool = pool;

// Parse JSON bodies
app.use(express.json());

// Health check endpoint (useful for Railway)
app.get("/health", async (_req, res) => {
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

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// SPA fallback — serve index.html for any unmatched route
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

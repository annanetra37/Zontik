const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => {
      console.error("Unexpected PostgreSQL error:", err);
    });
  }
  return pool;
}

async function migrate() {
  const p = getPool();
  if (!p) return;

  await p.query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id            SERIAL PRIMARY KEY,

      -- Essential info
      name          VARCHAR(200)  NOT NULL,
      category      VARCHAR(50)   NOT NULL,
      description   TEXT          NOT NULL,
      website       VARCHAR(500)  NOT NULL,

      -- Location
      city          VARCHAR(100)  NOT NULL,
      country       VARCHAR(100)  NOT NULL DEFAULT 'AT',

      -- Contact
      contact_email VARCHAR(254)  NOT NULL,
      contact_phone VARCHAR(40),

      -- Filtering / display
      price_range   VARCHAR(10)   DEFAULT '€',
      tags          TEXT[]        DEFAULT '{}',
      emoji         VARCHAR(10)   DEFAULT '🏪',
      featured      BOOLEAN       DEFAULT FALSE,

      -- Good to have
      year_founded  INTEGER,
      owner_name    VARCHAR(200),
      short_tagline VARCHAR(300),

      -- Social
      instagram     VARCHAR(500),
      facebook      VARCHAR(500),
      linkedin      VARCHAR(500),
      tiktok        VARCHAR(500),

      -- Meta
      created_at    TIMESTAMPTZ   DEFAULT NOW(),
      approved      BOOLEAN       DEFAULT TRUE
    );
  `);

  // Add tiktok column if missing (for existing DBs)
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tiktok VARCHAR(500);
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id            SERIAL PRIMARY KEY,
      business_id   INTEGER       NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      reviewer_name VARCHAR(100)  NOT NULL,
      rating        INTEGER       NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment       TEXT,
      created_at    TIMESTAMPTZ   DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_reviews_business_id ON reviews(business_id);
  `);

  console.log("Database migration complete");
}

module.exports = { getPool, migrate };

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

  // Ensure approved defaults to TRUE (fixes tables created with old default)
  await p.query(`ALTER TABLE businesses ALTER COLUMN approved SET DEFAULT TRUE;`);

  // Add website_domain column for domain-based uniqueness
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website_domain VARCHAR(500);
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // Backfill website_domain for existing rows
  await p.query(`
    UPDATE businesses
    SET website_domain = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(website, '^https?://', ''), '^www\\.', ''))
    WHERE website_domain IS NULL AND website IS NOT NULL;
  `);

  // Drop old name+website constraint if it exists
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE businesses DROP CONSTRAINT IF EXISTS uq_business_name_website;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // Unique constraint on website_domain to prevent duplicates
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE businesses ADD CONSTRAINT uq_business_domain UNIQUE (website_domain);
    EXCEPTION WHEN duplicate_table THEN NULL;
              WHEN duplicate_object THEN NULL;
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

  // Add photo column to reviews if missing (TEXT for base64 data URLs)
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS photo TEXT;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await p.query(`ALTER TABLE reviews ALTER COLUMN photo TYPE TEXT;`);

  // ── Users table ──
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         VARCHAR(254) NOT NULL UNIQUE,
      password_hash VARCHAR(200) NOT NULL,
      name          VARCHAR(200) NOT NULL,
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  // Add user_id to businesses (nullable for backwards compat)
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // Add logo and product_photo columns to businesses (TEXT for base64 data URLs)
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo TEXT;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS product_photo TEXT;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  // Widen columns to TEXT if they were previously VARCHAR
  await p.query(`ALTER TABLE businesses ALTER COLUMN logo TYPE TEXT;`);
  await p.query(`ALTER TABLE businesses ALTER COLUMN product_photo TYPE TEXT;`);

  // Add pin_order column for pinning certain brands to top
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pin_order INTEGER DEFAULT 0;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  // One-time cleanup: remove seed/example businesses
  const SEED_DOMAINS = [
    "thespiceroute.at", "pixelsmith.de", "atelierloom.at",
    "verdurewellness.at", "foldandform.at", "claritybookkeeping.at",
    "morningroast.at", "woodcraftco.at", "mindspacestudio.at",
  ];
  const del = await p.query(
    "DELETE FROM businesses WHERE website_domain = ANY($1::text[])",
    [SEED_DOMAINS]
  );
  if (del.rowCount > 0) {
    console.log(`Removed ${del.rowCount} seed/example business(es)`);
  }

  console.log("Database migration complete");
}

module.exports = { getPool, migrate };

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `
CREATE TABLE IF NOT EXISTS businesses (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category    VARCHAR(50) NOT NULL,
  category_label VARCHAR(100) NOT NULL,
  emoji       VARCHAR(10) NOT NULL DEFAULT '🏪',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  city        VARCHAR(100) NOT NULL,
  country     VARCHAR(10) NOT NULL DEFAULT 'AT',
  website     VARCHAR(500),
  featured    BOOLEAN NOT NULL DEFAULT false,
  price_range INTEGER NOT NULL DEFAULT 1,
  rating      NUMERIC(2,1) NOT NULL DEFAULT 4.0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category);
CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
CREATE INDEX IF NOT EXISTS idx_businesses_featured ON businesses(featured);
`;

const seed = `
INSERT INTO businesses (name, description, category, category_label, emoji, tags, city, country, featured, price_range, rating) VALUES
  ('The Spice Route', 'Premium artisan spices and organic pantry essentials sourced directly from small farms around the world.', 'food', 'Food & Retail', '🫙', ARRAY['Organic','Artisan','Grocery'], 'Vienna', 'AT', true, 2, 4.8),
  ('Pixelsmith Studio', 'A boutique digital design studio specialising in brand identity, UI/UX, and motion graphics for growing businesses.', 'tech', 'Tech & Services', '🖥️', ARRAY['Branding','UI/UX','Motion'], 'Berlin', 'DE', false, 3, 4.2),
  ('Atelier Loom', 'Handwoven textiles and home décor made using traditional techniques passed down through three generations of weavers.', 'craft', 'Crafts & Local', '🪡', ARRAY['Handmade','Textile','Home Décor'], 'Graz', 'AT', true, 2, 4.9),
  ('Verdure Wellness', 'Natural herbal supplements and wellness products crafted with certified organic ingredients for everyday vitality.', 'health', 'Health & Wellness', '🧴', ARRAY['Herbal','Organic','Supplements'], 'Salzburg', 'AT', false, 2, 4.5),
  ('Fold & Form', 'Slow fashion essentials made from sustainable fabrics. Timeless silhouettes designed to last seasons, not just trends.', 'fashion', 'Fashion', '🧣', ARRAY['Sustainable','Slow Fashion','Clothing'], 'Linz', 'AT', false, 3, 4.3),
  ('Clarity Bookkeeping', 'Friendly, cloud-based bookkeeping and financial consulting for small businesses who want clarity without complexity.', 'tech', 'Tech & Services', '🗂️', ARRAY['Finance','Accounting','Cloud'], 'Vienna', 'AT', false, 2, 4.1),
  ('Morning Roast Co.', 'Specialty single-origin coffee roasted in small batches. Sourced ethically, roasted locally, delivered fresh to your door.', 'food', 'Food & Retail', '🫖', ARRAY['Coffee','Specialty','Ethical'], 'Vienna', 'AT', true, 1, 4.7),
  ('Woodcraft & Co.', 'Custom-made wooden furniture and home objects. Each piece is unique, hand-finished, and built to become a family heirloom.', 'craft', 'Crafts & Local', '🪑', ARRAY['Furniture','Handmade','Custom'], 'Innsbruck', 'AT', false, 3, 4.6),
  ('MindSpace Studio', 'Online and in-person yoga, breathwork, and meditation classes for individuals and corporate teams seeking balance.', 'health', 'Health & Wellness', '🫧', ARRAY['Yoga','Meditation','Corporate'], 'Vienna', 'AT', false, 2, 4.4)
ON CONFLICT DO NOTHING;
`;

async function init() {
  console.log('Connecting to database...');
  await pool.query(schema);
  console.log('Schema created.');

  const { rowCount } = await pool.query('SELECT 1 FROM businesses LIMIT 1');
  if (rowCount === 0) {
    await pool.query(seed);
    console.log('Seed data inserted.');
  } else {
    console.log('Data already exists, skipping seed.');
  }

  await pool.end();
  console.log('Database initialized successfully.');
}

init().catch(err => {
  console.error('Database initialization failed:', err.message);
  process.exit(1);
});

require("dotenv").config();
const { getPool, migrate } = require("./db");

const SEED_BUSINESSES = [
  {
    name: "The Spice Route", category: "food",
    description: "Premium artisan spices and organic pantry essentials sourced directly from small farms around the world.",
    website: "https://thespiceroute.at", city: "Vienna", country: "Austria",
    contact_email: "hello@thespiceroute.at", emoji: "🫙", featured: true,
    tags: ["Organic", "Artisan", "Grocery"], price_range: "€€",
  },
  {
    name: "Pixelsmith Studio", category: "tech",
    description: "A boutique digital design studio specialising in brand identity, UI/UX, and motion graphics for growing businesses.",
    website: "https://pixelsmith.de", city: "Berlin", country: "Germany",
    contact_email: "studio@pixelsmith.de", emoji: "🖥️", featured: false,
    tags: ["Branding", "UI/UX", "Motion"], price_range: "€€€",
  },
  {
    name: "Atelier Loom", category: "craft",
    description: "Handwoven textiles and home décor made using traditional techniques passed down through three generations of weavers.",
    website: "https://atelierloom.at", city: "Graz", country: "Austria",
    contact_email: "info@atelierloom.at", emoji: "🪡", featured: true,
    tags: ["Handmade", "Textile", "Home Décor"], price_range: "€€",
  },
  {
    name: "Verdure Wellness", category: "health",
    description: "Natural herbal supplements and wellness products crafted with certified organic ingredients for everyday vitality.",
    website: "https://verdurewellness.at", city: "Salzburg", country: "Austria",
    contact_email: "care@verdurewellness.at", emoji: "🧴", featured: false,
    tags: ["Herbal", "Organic", "Supplements"], price_range: "€€",
  },
  {
    name: "Fold & Form", category: "fashion",
    description: "Slow fashion essentials made from sustainable fabrics. Timeless silhouettes designed to last seasons, not just trends.",
    website: "https://foldandform.at", city: "Linz", country: "Austria",
    contact_email: "hello@foldandform.at", emoji: "🧣", featured: false,
    tags: ["Sustainable", "Slow Fashion", "Clothing"], price_range: "€€€",
  },
  {
    name: "Clarity Bookkeeping", category: "tech",
    description: "Friendly, cloud-based bookkeeping and financial consulting for small businesses who want clarity without complexity.",
    website: "https://claritybookkeeping.at", city: "Vienna", country: "Austria",
    contact_email: "hi@claritybookkeeping.at", emoji: "🗂️", featured: false,
    tags: ["Finance", "Accounting", "Cloud"], price_range: "€€",
  },
  {
    name: "Morning Roast Co.", category: "food",
    description: "Specialty single-origin coffee roasted in small batches. Sourced ethically, roasted locally, delivered fresh to your door.",
    website: "https://morningroast.at", city: "Vienna", country: "Austria",
    contact_email: "beans@morningroast.at", emoji: "🫖", featured: true,
    tags: ["Coffee", "Specialty", "Ethical"], price_range: "€€",
  },
  {
    name: "Woodcraft & Co.", category: "craft",
    description: "Custom-made wooden furniture and home objects. Each piece is unique, hand-finished, and built to become a family heirloom.",
    website: "https://woodcraftco.at", city: "Innsbruck", country: "Austria",
    contact_email: "orders@woodcraftco.at", emoji: "🪑", featured: false,
    tags: ["Furniture", "Handmade", "Custom"], price_range: "€€€",
  },
  {
    name: "MindSpace Studio", category: "health",
    description: "Online and in-person yoga, breathwork, and meditation classes for individuals and corporate teams seeking balance.",
    website: "https://mindspacestudio.at", city: "Vienna", country: "Austria",
    contact_email: "namaste@mindspacestudio.at", emoji: "🫧", featured: false,
    tags: ["Yoga", "Meditation", "Corporate"], price_range: "€",
  },
];

async function seed() {
  await migrate();
  const pool = getPool();
  if (!pool) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  for (const b of SEED_BUSINESSES) {
    // Check if already exists
    const { rows } = await pool.query(
      "SELECT id FROM businesses WHERE name = $1",
      [b.name]
    );
    if (rows.length) {
      console.log(`  Skipping "${b.name}" (already exists)`);
      continue;
    }

    await pool.query(
      `INSERT INTO businesses
        (name, category, description, website, city, country,
         contact_email, emoji, featured, tags, price_range, approved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,
      [
        b.name, b.category, b.description, b.website,
        b.city, b.country, b.contact_email, b.emoji,
        b.featured, b.tags, b.price_range,
      ]
    );
    console.log(`  Seeded "${b.name}"`);
  }

  // Also approve any existing user-submitted businesses
  const { rowCount } = await pool.query(
    "UPDATE businesses SET approved = TRUE WHERE approved = FALSE"
  );
  if (rowCount > 0) {
    console.log(`  Approved ${rowCount} pending business(es)`);
  }

  console.log("Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

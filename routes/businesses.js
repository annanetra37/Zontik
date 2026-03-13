const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/businesses — list with search & filters
router.get('/', async (req, res) => {
  try {
    const { category, city, search, featured, price_min, price_max, rating_min, sort } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (category && category !== 'all') {
      conditions.push(`category = $${idx++}`);
      params.push(category);
    }

    if (city) {
      conditions.push(`city ILIKE $${idx++}`);
      params.push(city);
    }

    if (search) {
      conditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx} OR $${idx + 1} ILIKE ANY(SELECT LOWER(t) FROM unnest(tags) t))`);
      params.push(`%${search}%`, `%${search}%`);
      idx += 2;
    }

    if (featured === 'true') {
      conditions.push(`featured = true`);
    }

    if (price_min) {
      conditions.push(`price_range >= $${idx++}`);
      params.push(parseInt(price_min, 10));
    }

    if (price_max) {
      conditions.push(`price_range <= $${idx++}`);
      params.push(parseInt(price_max, 10));
    }

    if (rating_min) {
      conditions.push(`rating >= $${idx++}`);
      params.push(parseFloat(rating_min));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let orderBy = 'ORDER BY featured DESC, created_at DESC';
    if (sort === 'name') orderBy = 'ORDER BY name ASC';
    if (sort === 'rating') orderBy = 'ORDER BY rating DESC';

    const query = `SELECT * FROM businesses ${where} ${orderBy}`;
    const { rows } = await pool.query(query, params);

    res.json({ count: rows.length, businesses: rows });
  } catch (err) {
    console.error('GET /api/businesses error:', err.message);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

// GET /api/businesses/:id — single business
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Business not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/businesses/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch business' });
  }
});

// POST /api/businesses — create (List Your Business form)
router.post('/', async (req, res) => {
  try {
    const { name, description, category, category_label, emoji, tags, city, country, website, price_range } = req.body;

    if (!name || !description || !category || !category_label || !city) {
      return res.status(400).json({ error: 'Missing required fields: name, description, category, category_label, city' });
    }

    const { rows } = await pool.query(
      `INSERT INTO businesses (name, description, category, category_label, emoji, tags, city, country, website, price_range)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        name,
        description,
        category,
        category_label,
        emoji || '🏪',
        tags || [],
        city,
        country || 'AT',
        website || null,
        price_range || 1
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/businesses error:', err.message);
    res.status(500).json({ error: 'Failed to create business' });
  }
});

// PUT /api/businesses/:id — update
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, category, category_label, emoji, tags, city, country, website, featured, price_range, rating } = req.body;

    const { rows } = await pool.query(
      `UPDATE businesses SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        category = COALESCE($3, category),
        category_label = COALESCE($4, category_label),
        emoji = COALESCE($5, emoji),
        tags = COALESCE($6, tags),
        city = COALESCE($7, city),
        country = COALESCE($8, country),
        website = COALESCE($9, website),
        featured = COALESCE($10, featured),
        price_range = COALESCE($11, price_range),
        rating = COALESCE($12, rating)
      WHERE id = $13
      RETURNING *`,
      [name, description, category, category_label, emoji, tags, city, country, website, featured, price_range, rating, id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Business not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/businesses/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update business' });
  }
});

// DELETE /api/businesses/:id — delete
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM businesses WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Business not found' });
    res.json({ message: 'Business deleted' });
  } catch (err) {
    console.error('DELETE /api/businesses/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete business' });
  }
});

module.exports = router;

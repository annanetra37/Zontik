const express = require('express');
const path = require('path');
require('dotenv').config();

const businessRoutes = require('./routes/businesses');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname)));

// API routes
app.use('/api/businesses', businessRoutes);

// Fallback to index.html for non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`Zoncik server running on http://localhost:${PORT}`);
});

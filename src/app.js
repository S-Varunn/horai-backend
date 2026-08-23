require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const orgRoutes = require('./routes/orgs');
const eventRoutes = require('./routes/events');
const sessionRoutes = require('./routes/sessions');
const expenseRoutes = require('./routes/expenses');
const summaryRoutes = require('./routes/summary');
const { whatsappRouter } = require('./routes/whatsapp');
const discordRoutes = require('./routes/discord');
const agentRoutes = require('./routes/agent');
const { initDiscordBot } = require('./services/discordBotService');
const { initWhatsAppBot } = require('./services/whatsappBotService');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────
app.use(cors());
app.options('*', cors());

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api', orgRoutes);
app.use('/api', eventRoutes);
app.use('/api', sessionRoutes);
app.use('/api', expenseRoutes);
app.use('/api', summaryRoutes);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/discord', discordRoutes);
app.use('/api/agent', agentRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${err.message}`, err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n⏳ Horai API`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);

  // Initialize Discord Bot
  initDiscordBot();

  // Initialize Native WhatsApp Bot
  initWhatsAppBot();
});

module.exports = app;

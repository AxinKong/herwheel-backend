require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const coachesRoutes = require('./routes/coaches');
const bookingsRoutes = require('./routes/bookings');
const adminRoutes = require('./routes/admin');
const stripeWebhook = require('./webhooks/stripe');

const app = express();

// In production, only allow your real frontend domain(s) to call this API.
// Set ALLOWED_ORIGINS in .env as a comma-separated list, e.g.:
//   ALLOWED_ORIGINS=https://app.herwheel.kinc.jp
// Falls back to allowing all origins if unset (fine for local dev only).
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null;

app.use(cors({
  origin: allowedOrigins
    ? function (origin, callback) {
        // Allow requests with no origin (curl, server-to-server, health checks)
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      }
    : true, // local dev: allow everything
}));

// Stripe webhook needs the raw body for signature verification, so it
// must be mounted BEFORE express.json() and excluded from it.
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/coaches', coachesRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/admin/review', adminRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`HerWheel API listening on port ${PORT}`));

// Last line of defense: log instead of crashing the whole process when
// something unexpected slips through (e.g. a rejected promise nobody
// awaited, or a sync error outside Express's request handling). Crashing
// here means every in-flight request fails and the server stays down
// until Railway notices and restarts it.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
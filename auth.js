// ── Auth module ──────────────────────────────────────────────
// Self-contained session-based auth with two roles: admin (full access)
// and guest (read-only). Sessions live in MongoDB (via connect-mongo) so
// logins survive Render restarts/redeploys, not just server memory.
//
// On first boot, if the "users" collection is empty, a single admin user
// is seeded from ADMIN_USERNAME / ADMIN_PASSWORD env vars (see .env.example).
// Change the password any time by calling POST /api/auth/change-password
// while logged in as admin.
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { getDB } = require('./db');

function usersCol() { return getDB().collection('users'); }

// Called once at startup, after connectDB() but before the server accepts
// requests — creates the default admin account only if no users exist yet,
// so it never overwrites a password someone has already changed.
async function seedAdminIfNeeded() {
  const col = usersCol();
  const count = await col.countDocuments();
  if (count > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  const passwordHash = await bcrypt.hash(password, 10);
  await col.insertOne({ username, passwordHash, role: 'admin', createdAt: new Date().toISOString() });
  console.log(`[auth] Seeded default admin user "${username}" — change this password after first login (POST /api/auth/change-password).`);
}

// Session middleware — call sessionMiddleware() once MONGODB_URI is known
// to be connected, and app.use() it before mounting any routes.
function sessionMiddleware() {
  const store = MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 60 * 60 * 24 * 14 // 14 days
  });
  // Without this, a transient connection hiccup emits an 'error' event with
  // no listener, which Node treats as an unhandled exception and crashes the
  // whole process — logging it here keeps the app alive instead.
  store.on('error', (err) => console.error('[session-store]', err.message));

  return session({
    secret: process.env.SESSION_SECRET || 'missed-chat-tracker-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    store,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 14,
      httpOnly: true,
      sameSite: 'lax',
      // Render terminates TLS at the edge and forwards plain HTTP internally,
      // so "secure" cookies need `app.set('trust proxy', 1)` upstream — done
      // in server.js — for this to work correctly in production.
      secure: process.env.NODE_ENV === 'production'
    }
  });
}

// ── Middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ success: false, message: 'Please log in to continue.' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  if (req.session && req.session.user) return res.status(403).json({ success: false, message: 'Guests have read-only access — admin login required for this action.' });
  return res.status(401).json({ success: false, message: 'Please log in to continue.' });
}

// ── Routes — mount with app.use('/api/auth', authRoutes()) ────
function authRoutes() {
  const router = require('express').Router();

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password are required.' });

    const user = await usersCol().findOne({ username: String(username).trim() });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid username or password.' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid username or password.' });

    req.session.user = { username: user.username, role: user.role };
    res.json({ success: true, user: req.session.user });
  });

  // One-click Guest access — no password, view-only. Matches the "tap a
  // card, get in" pattern of your Shift Roster app's role picker.
  router.post('/guest-login', (req, res) => {
    req.session.user = { username: 'Guest', role: 'guest' };
    res.json({ success: true, user: req.session.user });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  router.get('/me', (req, res) => {
    if (req.session && req.session.user) return res.json({ success: true, user: req.session.user });
    res.json({ success: true, user: null });
  });

  // Lets an admin add a Guest login (e.g. for a manager who should only view
  // reports) without needing direct database access.
  router.post('/users', requireAdmin, async (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password are required.' });
    if (!['admin', 'guest'].includes(role)) return res.status(400).json({ success: false, message: 'role must be "admin" or "guest".' });

    const existing = await usersCol().findOne({ username: String(username).trim() });
    if (existing) return res.status(409).json({ success: false, message: 'That username already exists.' });

    const passwordHash = await bcrypt.hash(password, 10);
    await usersCol().insertOne({ username: String(username).trim(), passwordHash, role, createdAt: new Date().toISOString() });
    res.json({ success: true });
  });

  router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'currentPassword and newPassword are required.' });

    const user = await usersCol().findOne({ username: req.session.user.username });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await usersCol().updateOne({ username: user.username }, { $set: { passwordHash } });
    res.json({ success: true });
  });

  // Recovery path for a forgotten Admin password — doesn't require knowing
  // the old password, but requires the ADMIN_RESET_KEY env var set on
  // Render (Environment tab), which only you can see/set. Anyone without
  // that key cannot reset the account, so it's safe to expose publicly.
  router.post('/forgot-password', async (req, res) => {
    const { username, resetKey, newPassword } = req.body || {};
    if (!username || !resetKey || !newPassword) {
      return res.status(400).json({ success: false, message: 'username, resetKey, and newPassword are all required.' });
    }
    const expectedKey = process.env.ADMIN_RESET_KEY;
    if (!expectedKey) {
      return res.status(500).json({ success: false, message: 'No ADMIN_RESET_KEY is configured on the server — set one in Render\'s Environment tab first.' });
    }
    if (resetKey !== expectedKey) {
      return res.status(401).json({ success: false, message: 'Incorrect reset key.' });
    }
    const user = await usersCol().findOne({ username: String(username).trim() });
    if (!user) return res.status(404).json({ success: false, message: `No user named "${username}" exists.` });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await usersCol().updateOne({ username: user.username }, { $set: { passwordHash } });
    res.json({ success: true });
  });

  return router;
}

module.exports = { seedAdminIfNeeded, sessionMiddleware, requireAuth, requireAdmin, authRoutes };

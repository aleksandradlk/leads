const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { log } = require('../helpers/logger');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Felder fehlen' });

  const [[user]] = await db.query(
    'SELECT * FROM users WHERE username = ? AND is_active = 1', [username]
  );
  if (!user) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });

  // Upsert session
  await db.query(
    `INSERT INTO sessions (user_id, token, login_at, last_active, click_count, ip)
     VALUES (?, ?, NOW(), NOW(), 0, ?)
     ON DUPLICATE KEY UPDATE token=VALUES(token), login_at=NOW(), last_active=NOW(), click_count=0, ip=VALUES(ip)`,
    [user.id, token, req.ip]
  );
  await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
  await log(user.id, 'login', 'system', null, null, req.ip);

  res.json({
    token,
    user: {
      id: user.id, username: user.username, full_name: user.full_name, role: user.role,
      can_edit_contacts:  !!user.can_edit_contacts,
      can_archive_leads:  !!user.can_archive_leads,
      can_reassign_leads: !!user.can_reassign_leads,
      can_view_all_leads: !!user.can_view_all_leads,
      can_create_users:   !!user.can_create_users,
      can_generate_leads: !!user.can_generate_leads,
    }
  });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const header = req.headers['authorization'];
  const { reason } = req.body || {};
  if (header) {
    try {
      const token = header.startsWith('Bearer ') ? header.slice(7) : header;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      await db.query('DELETE FROM sessions WHERE user_id = ?', [payload.id]);
      const action = reason === 'inactivity' ? 'logout_inactivity' : 'logout';
      await log(payload.id, action, 'system', null,
        reason === 'inactivity' ? { reason: 'Automatisch nach 5 Min Inaktivität' } : null,
        req.ip);
    } catch {}
  }
  res.json({ ok: true });
});

// POST /api/auth/setup — einmalig ersten Admin anlegen (nur wenn noch kein User existiert)
router.post('/setup', async (req, res) => {
  const [[{ cnt }]] = await db.query('SELECT COUNT(*) as cnt FROM users');
  if (cnt > 0) return res.status(403).json({ error: 'Setup bereits abgeschlossen' });

  const { username, password, full_name, email } = req.body;
  if (!username || !password || !full_name || !email)
    return res.status(400).json({ error: 'Alle Felder erforderlich' });

  const hash = await bcrypt.hash(password, 12);
  await db.query(
    'INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?,?,?,?,?)',
    [username, hash, full_name, email, 'admin']
  );
  res.json({ ok: true, message: 'Admin-Account erstellt' });
});

// POST /api/auth/heartbeat — Aktivität + Klick-Tracking
router.post('/heartbeat', async (req, res) => {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Kein Token' });
  try {
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { clicks } = req.body;
    await db.query(
      'UPDATE sessions SET last_active = NOW(), click_count = click_count + ? WHERE user_id = ?',
      [clicks || 0, payload.id]
    );
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Token ungültig' });
  }
});

// PATCH /api/auth/password — eigenes Passwort ändern
router.patch('/password', async (req, res) => {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    const token   = header.startsWith('Bearer ') ? header.slice(7) : header;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Aktuelles und neues Passwort erforderlich' });
    if (new_password.length < 6)
      return res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen haben' });

    const [[user]] = await db.query('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Aktuelles Passwort falsch' });

    const hash = await bcrypt.hash(new_password, 12);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, payload.id]);
    await log(payload.id, 'password_change', 'user', payload.id, null, req.ip);
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Token ungültig' });
  }
});

// GET /api/auth/me — eigenes Profil incl. Benachrichtigungs-Prefs
const { auth } = require('../middleware/auth');
router.get('/me', auth, async (req, res) => {
  try {
    const [[user]] = await db.query(
      'SELECT id, username, full_name, email, role, notify_email, notify_sms, phone, can_edit_contacts, can_archive_leads, can_reassign_leads, can_view_all_leads, can_create_users, can_generate_leads FROM users WHERE id=?',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

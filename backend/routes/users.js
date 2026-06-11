const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const db       = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log }  = require('../helpers/logger');

// GET /api/users — alle User (Admin)
router.get('/', auth, adminOnly, async (req, res) => {
  const [users] = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.role, u.is_active,
            u.last_login, u.created_at,
            s.last_active, s.click_count, s.login_at AS session_start
     FROM users u
     LEFT JOIN sessions s ON s.user_id = u.id
     ORDER BY u.created_at DESC`
  );
  res.json(users);
});

// POST /api/users — neuen Closer anlegen (Admin)
router.post('/', auth, adminOnly, async (req, res) => {
  const { username, password, full_name, email, role } = req.body;
  if (!username || !password || !full_name)
    return res.status(400).json({ error: 'Name, Benutzername und Passwort sind erforderlich' });

  const emailVal = email && email.trim() ? email.trim() : null;

  const [[existsUser]] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
  if (existsUser) return res.status(409).json({ error: 'Benutzername bereits vergeben' });

  if (emailVal) {
    const [[existsEmail]] = await db.query('SELECT id FROM users WHERE email = ?', [emailVal]);
    if (existsEmail) return res.status(409).json({ error: 'E-Mail bereits vergeben' });
  }

  const hash = await bcrypt.hash(password, 12);
  const [result] = await db.query(
    'INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?,?,?,?,?)',
    [username, hash, full_name, emailVal, role === 'admin' ? 'admin' : 'closer']
  );
  await log(req.user.id, 'user_create', 'user', result.insertId, { username, role }, req.ip);
  res.status(201).json({ ok: true, id: result.insertId });
});

// PATCH /api/users/:id — User bearbeiten (Admin)
router.patch('/:id', auth, adminOnly, async (req, res) => {
  const { full_name, email, password, is_active, role } = req.body;
  const id = parseInt(req.params.id);

  if (full_name) await db.query('UPDATE users SET full_name=? WHERE id=?', [full_name, id]);
  if (email)     await db.query('UPDATE users SET email=? WHERE id=?', [email, id]);
  if (role)      await db.query('UPDATE users SET role=? WHERE id=?', [role, id]);
  if (is_active !== undefined)
    await db.query('UPDATE users SET is_active=? WHERE id=?', [is_active ? 1 : 0, id]);
  if (password) {
    const hash = await bcrypt.hash(password, 12);
    await db.query('UPDATE users SET password_hash=? WHERE id=?', [hash, id]);
  }
  await log(req.user.id, 'user_update', 'user', id, req.body, req.ip);
  res.json({ ok: true });
});

// DELETE /api/users/:id (Admin, kann sich nicht selbst löschen)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Eigenen Account nicht löschbar' });
  await db.query('DELETE FROM users WHERE id = ?', [id]);
  await log(req.user.id, 'user_delete', 'user', id, null, req.ip);
  res.json({ ok: true });
});

// GET /api/users/tracking — Echtzeit-Tracking aller Closer (Admin)
router.get('/tracking', auth, adminOnly, async (req, res) => {
  const [rows] = await db.query(
    `SELECT u.id, u.username, u.full_name, u.role,
            s.login_at, s.last_active, s.click_count,
            TIMESTAMPDIFF(MINUTE, s.last_active, NOW()) as inactive_minutes,
            TIMESTAMPDIFF(MINUTE, s.login_at, NOW()) as session_minutes
     FROM users u
     JOIN sessions s ON s.user_id = u.id
     ORDER BY s.last_active DESC`
  );
  res.json(rows);
});

// GET /api/users/activity — komplettes Audit Log (Admin)
router.get('/activity', auth, adminOnly, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 100, 500);
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
  let q = `SELECT a.*, u.username, u.full_name FROM activity_log a
           JOIN users u ON u.id = a.user_id`;
  const params = [];
  if (userId) { q += ' WHERE a.user_id = ?'; params.push(userId); }
  q += ' ORDER BY a.created_at DESC LIMIT ?';
  params.push(limit);
  const [rows] = await db.query(q, params);
  res.json(rows);
});

module.exports = router;

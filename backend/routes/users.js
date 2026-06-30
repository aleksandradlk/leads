const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const db       = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log }  = require('../helpers/logger');

const PERM_FIELDS = ['can_edit_contacts','can_archive_leads','can_reassign_leads','can_view_all_leads','can_create_users','can_generate_leads','can_manage_email_templates'];

// GET /api/users — alle User (Admin)
router.get('/', auth, adminOnly, async (req, res) => {
  const [users] = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role, u.is_active,
            u.last_login, u.created_at,
            u.can_edit_contacts, u.can_archive_leads, u.can_reassign_leads,
            u.can_view_all_leads, u.can_create_users, u.can_generate_leads,
            s.last_active, s.click_count, s.login_at AS session_start,
            c.full_name AS creator_name, c.email AS creator_email
     FROM users u
     LEFT JOIN sessions s ON s.user_id = u.id
     LEFT JOIN users c ON c.id = u.created_by
     ORDER BY u.created_at DESC`
  );
  res.json(users);
});

// GET /api/users/assignable — Kurzliste für Zuweisung
// Admin: alle; Closer: nur Closer (außer closer_sees_admins=true)
router.get('/assignable', auth, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const [rows] = await db.query('SELECT id, full_name, role FROM users WHERE is_active=1 ORDER BY full_name');
      return res.json(rows);
    }
    const [[setting]] = await db.query("SELECT value FROM app_settings WHERE key_name='closer_sees_admins'");
    const closerSeesAdmins = setting?.value === 'true';
    const q = closerSeesAdmins
      ? 'SELECT id, full_name, role FROM users WHERE is_active=1 ORDER BY full_name'
      : "SELECT id, full_name, role FROM users WHERE is_active=1 AND role='closer' ORDER BY full_name";
    const [rows] = await db.query(q);
    res.json(rows);
  } catch(e) {
    console.error('Assignable error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// GET /api/users/list — Kurzliste aller aktiven User (für Chat-Einladungen, alle Auth-User)
router.get('/list', auth, async (req, res) => {
  const [users] = await db.query(
    `SELECT id, full_name, role FROM users WHERE is_active = 1 ORDER BY full_name ASC`
  );
  res.json(users);
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

// GET /api/users/activity/download — CSV Export (Admin)
router.get('/activity/download', auth, adminOnly, async (req, res) => {
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
  let q = `SELECT a.created_at, u.full_name, u.username, a.action,
                  a.target_type, a.target_id, a.detail, a.ip
           FROM activity_log a JOIN users u ON u.id = a.user_id`;
  const params = [];
  if (userId) { q += ' WHERE a.user_id = ?'; params.push(userId); }
  q += ' ORDER BY a.created_at DESC';
  const [rows] = await db.query(q, params);

  const esc = v => `"${String(v||'').replace(/"/g,'""').replace(/;/g,',')}"`;
  const csv = [
    'Zeitstempel;Benutzer;Username;Aktion;Ziel;Ziel-ID;Details;IP',
    ...rows.map(r => [
      r.created_at, r.full_name, r.username, r.action,
      r.target_type||'', r.target_id||'', r.detail||'', r.ip||''
    ].map(esc).join(';'))
  ].join('\n');

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="aktivitaetslog.csv"');
  res.send('﻿' + csv);
});

// POST /api/users — neuen User anlegen (Admin oder can_create_users)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_create_users)
    return res.status(403).json({ error: 'Keine Berechtigung' });

  const { username, password, full_name, email, phone } = req.body;
  if (!username || !password || !full_name)
    return res.status(400).json({ error: 'Name, Benutzername und Passwort sind erforderlich' });

  // Closer mit can_create_users darf nur einfache Closer anlegen — keine Rolle, keine Rechte wählbar
  const finalRole = req.user.role === 'admin' && req.body.role === 'admin' ? 'admin' : 'closer';

  const emailVal = email && email.trim() ? email.trim() : null;
  const phoneVal = phone && phone.trim() ? phone.trim() : null;

  const [[existsUser]] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
  if (existsUser) return res.status(409).json({ error: 'Benutzername bereits vergeben' });

  if (emailVal) {
    const [[existsEmail]] = await db.query('SELECT id FROM users WHERE email = ?', [emailVal]);
    if (existsEmail) return res.status(409).json({ error: 'E-Mail bereits vergeben' });
  }

  const hash = await bcrypt.hash(password, 12);
  const [result] = await db.query(
    'INSERT INTO users (username, password_hash, full_name, email, phone, role, created_by) VALUES (?,?,?,?,?,?,?)',
    [username, hash, full_name, emailVal, phoneVal, finalRole, req.user.id]
  );

  // Berechtigungen nur Admin darf setzen
  if (req.user.role === 'admin') {
    for (const f of PERM_FIELDS) {
      if (req.body[f] !== undefined)
        await db.query(`UPDATE users SET ${f}=? WHERE id=?`, [req.body[f] ? 1 : 0, result.insertId]);
    }
  }

  await log(req.user.id, 'user_create', 'user', result.insertId, { username, role: finalRole }, req.ip);
  res.status(201).json({ ok: true, id: result.insertId });
});

// PATCH /api/users/:id — User bearbeiten (Admin)
router.patch('/:id', auth, adminOnly, async (req, res) => {
  const { username, full_name, email, password, is_active, role } = req.body;
  const id = parseInt(req.params.id);

  if (username) {
    const [[exists]] = await db.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, id]);
    if (exists) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
    await db.query('UPDATE users SET username=? WHERE id=?', [username, id]);
  }
  if (full_name) await db.query('UPDATE users SET full_name=? WHERE id=?', [full_name, id]);
  if (email !== undefined) await db.query('UPDATE users SET email=? WHERE id=?', [email || null, id]);
  if (req.body.phone !== undefined) await db.query('UPDATE users SET phone=? WHERE id=?', [req.body.phone || null, id]);
  if (role) {
    if (!['admin', 'closer'].includes(role))
      return res.status(400).json({ error: 'Ungültige Rolle' });
    await db.query('UPDATE users SET role=? WHERE id=?', [role, id]);
  }
  if (is_active !== undefined)
    await db.query('UPDATE users SET is_active=? WHERE id=?', [is_active ? 1 : 0, id]);
  if (password) {
    const hash = await bcrypt.hash(password, 12);
    await db.query('UPDATE users SET password_hash=? WHERE id=?', [hash, id]);
  }

  for (const f of PERM_FIELDS) {
    if (req.body[f] !== undefined)
      await db.query(`UPDATE users SET ${f}=? WHERE id=?`, [req.body[f] ? 1 : 0, id]);
  }

  const logBody = { ...req.body };
  delete logBody.password;
  await log(req.user.id, 'user_update', 'user', id, logBody, req.ip);
  res.json({ ok: true });
});

// PATCH /api/users/:id/notify — Benachrichtigungs-Präferenzen speichern
router.patch('/:id/notify', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (req.user.id !== id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Nicht berechtigt' });
  const { notify_email, notify_sms, phone } = req.body;
  const updates = [];
  const params  = [];
  if (notify_email !== undefined) { updates.push('notify_email=?'); params.push(notify_email ? 1 : 0); }
  if (notify_sms   !== undefined) { updates.push('notify_sms=?');   params.push(notify_sms   ? 1 : 0); }
  if (phone        !== undefined) { updates.push('phone=?');        params.push(phone || null); }
  if (!updates.length) return res.status(400).json({ error: 'Nichts zu aktualisieren' });
  params.push(id);
  await db.query(`UPDATE users SET ${updates.join(',')} WHERE id=?`, params);
  res.json({ ok: true });
});

// DELETE /api/users/:id (Admin, kann sich nicht selbst löschen)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Eigenen Account nicht löschbar' });

  try {
    await db.query('DELETE FROM activity_log WHERE user_id = ?', [id]);
    await db.query('DELETE FROM reminders    WHERE user_id = ?', [id]);
    await db.query('DELETE FROM comments     WHERE user_id = ?', [id]);
    await db.query('UPDATE leads SET created_by  = ? WHERE created_by  = ?', [req.user.id, id]);
    await db.query('UPDATE leads SET assigned_to = NULL WHERE assigned_to = ?', [id]);
    await db.query('DELETE FROM users WHERE id = ?', [id]);
    await log(req.user.id, 'user_delete', 'user', id, null, req.ip);
    res.json({ ok: true });
  } catch (e) {
    console.error('User delete error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// GET /api/users/admin-contact — Kontaktdaten des ersten aktiven Admins (fuer Closer)
router.get('/admin-contact', auth, async (req, res) => {
  try {
    const [[admin]] = await db.query(
      "SELECT full_name, phone, email FROM users WHERE role='admin' AND is_active=1 ORDER BY id ASC LIMIT 1"
    );
    res.json(admin || { full_name: 'Aleksandra Dalak', phone: null });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// POST /api/users/onboarding-done — Onboarding als gesehen markieren
router.post('/onboarding-done', auth, async (req, res) => {
  try {
    await db.query('UPDATE users SET onboarding_shown=1 WHERE id=?', [req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;

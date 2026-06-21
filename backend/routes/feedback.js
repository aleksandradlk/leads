const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');

const VALID_TAGS = ['offen','in_planung','erledigt','nicht_moeglich'];

// GET /api/feedback — alle Einträge (Admin: alle; Closer: eigene)
router.get('/', auth, async (req, res) => {
  try {
    let q = `SELECT f.*, u.full_name AS author_name
             FROM feedback f
             LEFT JOIN users u ON u.id = f.user_id
             ORDER BY f.created_at DESC`;
    if (req.user.role !== 'admin') {
      q = `SELECT f.*, u.full_name AS author_name
           FROM feedback f
           LEFT JOIN users u ON u.id = f.user_id
           WHERE f.user_id = ?
           ORDER BY f.created_at DESC`;
      const [rows] = await db.query(q, [req.user.id]);
      return res.json(rows);
    }
    const [rows] = await db.query(q);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/feedback — neuen Eintrag erstellen (alle)
router.post('/', auth, async (req, res) => {
  const { title, description, type } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel ist erforderlich' });
  try {
    const [r] = await db.query(
      `INSERT INTO feedback (user_id, title, description, type, tag)
       VALUES (?, ?, ?, ?, 'offen')`,
      [req.user.id, title.trim(), description?.trim() || null, type || 'wunsch']
    );
    await log(req.user.id, 'feedback_create', 'feedback', r.insertId, { title }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/feedback/:id — Tag + interne Notiz (Admin)
router.patch('/:id', auth, adminOnly, async (req, res) => {
  const { tag, admin_note } = req.body;
  if (tag && !VALID_TAGS.includes(tag))
    return res.status(400).json({ error: 'Ungültiger Tag' });

  const id = parseInt(req.params.id);
  try {
    const updates = [];
    const params  = [];
    if (tag)        { updates.push('tag=?');        params.push(tag); }
    if (admin_note !== undefined) { updates.push('admin_note=?'); params.push(admin_note || null); }
    if (!updates.length) return res.status(400).json({ error: 'Nichts zu aktualisieren' });
    params.push(id);
    await db.query(`UPDATE feedback SET ${updates.join(',')} WHERE id=?`, params);
    await log(req.user.id, 'feedback_update', 'feedback', id, { tag, admin_note }, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/feedback/:id (Admin oder eigener Eintrag)
router.delete('/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[fb]] = await db.query('SELECT user_id FROM feedback WHERE id=?', [id]);
    if (!fb) return res.status(404).json({ error: 'Nicht gefunden' });
    if (req.user.role !== 'admin' && fb.user_id !== req.user.id)
      return res.status(403).json({ error: 'Kein Zugriff' });
    await db.query('DELETE FROM feedback WHERE id=?', [id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

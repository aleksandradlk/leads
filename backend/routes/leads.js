const router  = require('express').Router();
const db      = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const { sendLeadEmail } = require('../helpers/mailer');

const VALID_STATUSES = ['neu','kontaktiert','nicht_erreicht','kein_interesse','rueckruf','kunde'];

// ── GET /api/leads ──────────────────────────────────────────
// Admin: alle Leads | Closer: nur eigene (assigned_to)
router.get('/', auth, async (req, res) => {
  const { status, search } = req.query;
  let q = `SELECT l.id, l.company, l.ceo, l.phone, l.email, l.location,
                  l.status, l.assigned_to, l.created_by,
                  l.created_at, l.updated_at, l.confidence,
                  u1.full_name AS assigned_name,
                  u2.full_name AS created_name
           FROM leads l
           LEFT JOIN users u1 ON u1.id = l.assigned_to
           LEFT JOIN users u2 ON u2.id = l.created_by`;
  const params = [];
  const where  = [];

  // Closer sehen alle Leads (können aber nicht löschen)
  if (status && VALID_STATUSES.includes(status)) {
    where.push('l.status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(l.company LIKE ? OR l.ceo LIKE ? OR l.location LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY l.created_at DESC';

  const limit  = Math.min(parseInt(req.query.limit)  || 500, 1000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  q += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [leads] = await db.query(q, params);
  res.json(leads);
});

// ── POST /api/leads — einzelnen Lead manuell anlegen (alle User) ────
router.post('/', auth, async (req, res) => {
  const { company, ceo, email, phone, location, website, industry, notes } = req.body;
  if (!company?.trim()) return res.status(400).json({ error: 'Firmenname ist erforderlich' });
  try {
    const [r] = await db.query(
      `INSERT INTO leads (company, ceo, email, phone, location, website, industry, notes,
        status, assigned_to, created_by, source, confidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [company.trim(), ceo||null, email||null, phone||null, location||null,
       website||null, industry||null, notes||null,
       'neu', req.user.role === 'closer' ? req.user.id : null,
       req.user.id, 'manuell', 80]
    );
    await log(req.user.id, 'lead_create_manual', 'lead', r.insertId, { company }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) {
    console.error('Lead create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/leads/bulk — mehrere Leads auf einmal speichern (Admin) ──
router.post('/bulk', auth, adminOnly, async (req, res) => {
  const { leads, assigned_to } = req.body;
  if (!Array.isArray(leads) || !leads.length)
    return res.status(400).json({ error: 'Keine Leads übergeben' });

  try {
    const inserted = [];
    for (const l of leads) {
      const [r] = await db.query(
        `INSERT INTO leads
          (company, ceo, email, phone, location, website, linkedin_url,
           industry, employees, revenue, source, confidence, notes,
           status, assigned_to, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [l.company||null, l.ceo||null, l.email||null, l.phone||null,
         l.location||null, l.website||null, l.linkedin_url||null,
         l.industry||null, l.employees||null, l.revenue||null,
         l.source||'web', l.confidence||50, l.notes||null,
         'neu', assigned_to||null, req.user.id]
      );
      inserted.push(r.insertId);
    }
    await log(req.user.id, 'leads_bulk_create', 'lead', null,
      { count: inserted.length, assigned_to }, req.ip);
    res.status(201).json({ ok: true, ids: inserted });
  } catch(e) {
    console.error('Bulk insert error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/leads/reminders — eigene offene Reminder ────────
router.get('/reminders', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT r.id, r.note, r.remind_at, r.lead_id, l.company, l.status, l.phone
       FROM reminders r JOIN leads l ON l.id = r.lead_id
       WHERE r.user_id = ? AND r.sent = 0 ORDER BY r.remind_at ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/leads/:id ──────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const [[lead]] = await db.query(
    `SELECT l.*, u1.full_name AS assigned_name, u2.full_name AS created_name
     FROM leads l
     LEFT JOIN users u1 ON u1.id = l.assigned_to
     LEFT JOIN users u2 ON u2.id = l.created_by
     WHERE l.id = ?`, [id]
  );
  if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });

  // Comments
  const [comments] = await db.query(
    `SELECT c.*, u.full_name, u.username FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.lead_id = ? ORDER BY c.created_at ASC`, [id]
  );
  // Reminders
  const [reminders] = await db.query(
    `SELECT r.*, u.full_name FROM reminders r
     JOIN users u ON u.id = r.user_id
     WHERE r.lead_id = ? ORDER BY r.remind_at ASC`, [id]
  );
  res.json({ ...lead, comments, reminders });
});

// ── PATCH /api/leads/:id/status ──────────────────────────────
router.patch('/:id/status', auth, async (req, res) => {
  const id     = parseInt(req.params.id);
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status))
    return res.status(400).json({ error: 'Ungültiger Status' });

  const [[lead]] = await db.query('SELECT * FROM leads WHERE id = ?', [id]);
  if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });

  if (req.user.role !== 'admin' && lead.assigned_to !== null && lead.assigned_to !== req.user.id)
    return res.status(403).json({ error: 'Nur eigene oder unzugewiesene Leads dürfen geändert werden' });

  await db.query('UPDATE leads SET status = ? WHERE id = ?', [status, id]);
  await log(req.user.id, 'status_change', 'lead', id,
    { from: lead.status, to: status }, req.ip);
  res.json({ ok: true });
});

// ── PATCH /api/leads/:id — allgemeines Update (Admin) ────────
router.patch('/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  const allowed = ['company','ceo','email','phone','location','website',
                   'linkedin_url','industry','employees','revenue','notes',
                   'assigned_to','confidence'];
  const updates = [];
  const params  = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { updates.push(`${k}=?`); params.push(req.body[k]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nichts zu aktualisieren' });
  params.push(id);
  await db.query(`UPDATE leads SET ${updates.join(',')} WHERE id=?`, params);
  await log(req.user.id, 'lead_update', 'lead', id, req.body, req.ip);
  res.json({ ok: true });
});

// ── DELETE /api/leads/:id (Admin) ────────────────────────────
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  await db.query('DELETE FROM leads WHERE id = ?', [id]);
  await log(req.user.id, 'lead_delete', 'lead', id, null, req.ip);
  res.json({ ok: true });
});

// ── POST /api/leads/:id/comments ────────────────────────────
router.post('/:id/comments', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text fehlt' });

  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });

  const [r] = await db.query(
    'INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
    [leadId, req.user.id, text.trim()]
  );
  await log(req.user.id, 'comment_add', 'lead', leadId, { text: text.trim() }, req.ip);
  res.status(201).json({ ok: true, id: r.insertId });
});

// ── POST /api/leads/:id/reminders ───────────────────────────
router.post('/:id/reminders', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { remind_at, note } = req.body;
  if (!remind_at) return res.status(400).json({ error: 'remind_at fehlt' });

  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });

  const [r] = await db.query(
    'INSERT INTO reminders (lead_id, user_id, remind_at, note) VALUES (?,?,?,?)',
    [leadId, req.user.id, remind_at, note || null]
  );
  await log(req.user.id, 'reminder_set', 'lead', leadId, { remind_at, note }, req.ip);
  res.status(201).json({ ok: true, id: r.insertId });
});

// ── DELETE /api/leads/:id/reminders/:rid ────────────────────
router.delete('/:id/reminders/:rid', auth, async (req, res) => {
  await db.query(
    'DELETE FROM reminders WHERE id=? AND user_id=?',
    [parseInt(req.params.rid), req.user.id]
  );
  res.json({ ok: true });
});

// ── PATCH /api/leads/:id/assign — Closer übernimmt Lead ─────
router.patch('/:id/assign', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query('SELECT id, assigned_to FROM leads WHERE id=?', [id]);
    if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });

    if (req.user.role !== 'admin' && lead.assigned_to !== null)
      return res.status(403).json({ error: 'Lead ist bereits zugewiesen' });

    await db.query('UPDATE leads SET assigned_to=? WHERE id=?', [req.user.id, id]);
    await log(req.user.id, 'lead_assign', 'lead', id, { assigned_to: req.user.id }, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/leads/:id/comments/:cid — Kommentar bearbeiten ──
router.patch('/:id/comments/:cid', auth, async (req, res) => {
  const cid = parseInt(req.params.cid);
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text fehlt' });
  try {
    const [[c]] = await db.query('SELECT * FROM comments WHERE id=?', [cid]);
    if (!c) return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    if (req.user.role !== 'admin' && c.user_id !== req.user.id)
      return res.status(403).json({ error: 'Nur eigene Kommentare bearbeitbar' });
    await db.query('UPDATE comments SET text=?, edited_at=NOW() WHERE id=?', [text.trim(), cid]);
    await log(req.user.id, 'comment_edit', 'lead', parseInt(req.params.id), { cid }, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/leads/:id/comments/:cid — Kommentar löschen ──
router.delete('/:id/comments/:cid', auth, async (req, res) => {
  const cid = parseInt(req.params.cid);
  try {
    const [[c]] = await db.query('SELECT * FROM comments WHERE id=?', [cid]);
    if (!c) return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    if (req.user.role !== 'admin' && c.user_id !== req.user.id)
      return res.status(403).json({ error: 'Nur eigene Kommentare löschbar' });
    await db.query('DELETE FROM comments WHERE id=?', [cid]);
    await log(req.user.id, 'comment_delete', 'lead', parseInt(req.params.id), { cid }, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/leads/:id/email — E-Mail an Lead senden ────────
router.post('/:id/email', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { to, subject, body } = req.body;
  if (!to || !subject || !body)
    return res.status(400).json({ error: 'to, subject und body sind erforderlich' });
  try {
    const [[lead]] = await db.query('SELECT * FROM leads WHERE id=?', [id]);
    if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });

    if (req.user.role !== 'admin' && lead.assigned_to !== null && lead.assigned_to !== req.user.id)
      return res.status(403).json({ error: 'E-Mail nur bei eigenen oder unzugewiesenen Leads erlaubt' });

    const [[user]] = await db.query('SELECT full_name FROM users WHERE id=?', [req.user.id]);
    await sendLeadEmail({ to, subject, body, fromName: user?.full_name || 'NovaFlow' });

    await db.query(
      'INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [id, req.user.id, `📧 E-Mail gesendet: ${subject}`]
    );
    await log(req.user.id, 'lead_email_sent', 'lead', id, { to, subject }, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Email send error:', e.message);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden: ' + e.message });
  }
});

module.exports = router;

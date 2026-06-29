const router  = require('express').Router();
const db      = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const { sendLeadEmail } = require('../helpers/mailer');

const VALID_STATUSES = ['neu','kontaktiert','nicht_erreicht','kein_interesse','rueckruf','kunde'];

function canView(user, lead) {
  if (user.role === 'admin') return true;
  if (user.can_view_all_leads) return true;
  return lead.assigned_to === user.id || lead.assigned_to === null;
}

// ── GET /api/leads ──────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const { status, search, assigned_to } = req.query;
  let q = `SELECT l.id, l.company, l.ceo, l.phone, l.email, l.location,
                  l.status, l.assigned_to, l.created_by,
                  l.created_at, l.updated_at, l.confidence,
                  u1.full_name AS assigned_name,
                  u2.full_name AS created_name
           FROM leads l
           LEFT JOIN users u1 ON u1.id = l.assigned_to
           LEFT JOIN users u2 ON u2.id = l.created_by`;
  const params = [];
  const where  = ['l.archived_at IS NULL'];

  if (status && VALID_STATUSES.includes(status)) {
    where.push('l.status = ?');
    params.push(status);
  }
  if (assigned_to === 'none') {
    where.push('l.assigned_to IS NULL');
  } else if (assigned_to && /^\d+$/.test(assigned_to)) {
    where.push('l.assigned_to = ?');
    params.push(parseInt(assigned_to));
  }
  if (search) {
    if (search.length >= 3) {
      const term = search.replace(/[+\-><()*~"@]/g, ' ').trim().split(/\s+/).filter(Boolean).map(w => w + '*').join(' ');
      where.push('MATCH(l.company, l.ceo, l.location) AGAINST (? IN BOOLEAN MODE)');
      params.push(term);
    } else {
      where.push('(l.company LIKE ? OR l.ceo LIKE ? OR l.location LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }
  }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY l.created_at DESC';

  const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  q += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [leads] = await db.query(q, params);
  res.json(leads);
});

// ── POST /api/leads — einzelnen Lead manuell anlegen ────
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
    console.error('Lead create error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/dashboard — Tages-Dashboard (Admin only) ──────────────────
router.get('/dashboard', auth, adminOnly, async (req, res) => {
  try {
    const [[{ callsToday }]] = await db.query(
      `SELECT COUNT(*) AS callsToday FROM call_logs WHERE DATE(started_at) = CURDATE()`
    );
    const [[{ winsThisWeek }]] = await db.query(
      `SELECT COUNT(*) AS winsThisWeek FROM leads WHERE status='kunde' AND YEARWEEK(updated_at, 1) = YEARWEEK(NOW(), 1)`
    );
    const [[{ leadsTotal }]] = await db.query(
      `SELECT COUNT(*) AS leadsTotal FROM leads WHERE archived_at IS NULL`
    );
    const [[{ leadsNew }]] = await db.query(
      `SELECT COUNT(*) AS leadsNew FROM leads WHERE status='neu' AND archived_at IS NULL`
    );
    const [perCloser] = await db.query(
      `SELECT u.full_name,
         COUNT(DISTINCT CASE WHEN DATE(cl.started_at) = CURDATE() THEN cl.id END) AS callsToday,
         COUNT(DISTINCT l.id) AS totalLeads
       FROM users u
       LEFT JOIN call_logs cl ON cl.user_id = u.id
       LEFT JOIN leads l ON l.assigned_to = u.id AND l.archived_at IS NULL
       WHERE u.role = 'closer' AND u.is_active = 1
       GROUP BY u.id, u.full_name
       ORDER BY callsToday DESC`
    );
    res.json({ callsToday, winsThisWeek, leadsTotal, leadsNew, perCloser });
  } catch(e) {
    console.error('Dashboard error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/dashboard/closer — eigene Tagesstatistik (Closer) ──────────
router.get('/dashboard/closer', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [[{ callsToday }]] = await db.query(
      'SELECT COUNT(*) as callsToday FROM call_logs WHERE user_id=? AND DATE(started_at)=CURDATE()', [uid]);
    const [[{ callsWeek }]] = await db.query(
      'SELECT COUNT(*) as callsWeek FROM call_logs WHERE user_id=? AND YEARWEEK(started_at,1)=YEARWEEK(NOW(),1)', [uid]);
    const [[{ winsTotal }]] = await db.query(
      "SELECT COUNT(*) as winsTotal FROM leads WHERE assigned_to=? AND status='kunde' AND archived_at IS NULL", [uid]);
    const [[{ myLeads }]] = await db.query(
      'SELECT COUNT(*) as myLeads FROM leads WHERE assigned_to=? AND archived_at IS NULL', [uid]);
    const [[{ avgCalls }]] = await db.query(
      `SELECT ROUND(AVG(daily_count),1) as avgCalls FROM (
        SELECT COUNT(*) as daily_count FROM call_logs
        WHERE user_id=? AND started_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY DATE(started_at)
      ) t`, [uid]);
    res.json({ callsToday, callsWeek, winsTotal, myLeads, avgCalls: avgCalls || 0 });
  } catch(e) { console.error('Dashboard closer error:', e); res.status(500).json({ error: 'Fehler' }); }
});

// ── GET /api/leads/next — nächster unbearbeiteter Lead des Closers (Feature 3) ──
router.get('/next', auth, async (req, res) => {
  const uid = req.user.id;
  const currentId = parseInt(req.query.current_id) || 0;
  try {
    let [[lead]] = await db.query(
      `SELECT id FROM leads WHERE assigned_to=? AND archived_at IS NULL
       AND status NOT IN ('kunde','kein_interesse') AND id > ?
       ORDER BY id ASC LIMIT 1`, [uid, currentId]
    );
    if (!lead) {
      [[lead]] = await db.query(
        `SELECT id FROM leads WHERE assigned_to=? AND archived_at IS NULL
         AND status NOT IN ('kunde','kein_interesse') ORDER BY id ASC LIMIT 1`, [uid]
      );
    }
    res.json({ id: lead?.id || null });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── GET /api/leads/activity-feed — letzte Aktivitäten (Admin, Feature 7) ──
router.get('/activity-feed', auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details,
              a.created_at, u.full_name, l.company
       FROM activity_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN leads l ON l.id = a.entity_id AND a.entity_type = 'lead'
       ORDER BY a.created_at DESC LIMIT 40`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── POST /api/leads/import — CSV-Import (Admin, Feature 8) ──────────────────
const multerMem = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 5*1024*1024 } });
router.post('/import', auth, adminOnly, multerMem.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  const assignTo = parseInt(req.body.assigned_to) || null;
  try {
    const text = req.file.buffer.toString('utf-8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return res.status(400).json({ error: 'Leere CSV' });
    const delim = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(delim).map(h => h.trim().toLowerCase().replace(/[^a-z]/g,''));
    const idx = (names) => { for (const n of names) { const i = headers.indexOf(n); if (i>=0) return i; } return -1; };
    const iComp = idx(['firmenname','company','name','unternehmen']);
    const iIndu = idx(['branche','industry','kategorie']);
    const iLoc  = idx(['ort','location','standort','stadt']);
    const iPhone = idx(['telefonnummer','phone','telefon','tel']);
    const iMail = idx(['email','e-mail','mail']);
    const iWeb  = idx(['website','web','url','homepage']);
    if (iComp < 0) return res.status(400).json({ error: 'Spalte "Firmenname" nicht gefunden' });
    let imported = 0, skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delim).map(c => c.trim().replace(/^"|"$/g,'').trim());
      const company = iComp >= 0 ? cols[iComp] : '';
      if (!company) { skipped++; continue; }
      const phone = iPhone >= 0 ? cols[iPhone] : null;
      const email = iMail >= 0 ? cols[iMail] : null;
      const exists = phone || email ? await db.query(
        `SELECT id FROM leads WHERE archived_at IS NULL AND (${phone?'phone=?':'1=0'}${email?' OR email=?':''})`,
        [phone, email].filter(Boolean)
      ).then(([r]) => r.length > 0).catch(() => false) : false;
      if (exists) { skipped++; continue; }
      await db.query(
        `INSERT INTO leads (company, industry, location, phone, email, website, status, assigned_to, created_by, source)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [company, iIndu>=0?cols[iIndu]||null:null, iLoc>=0?cols[iLoc]||null:null,
         phone||null, email||null, iWeb>=0?cols[iWeb]||null:null,
         'neu', assignTo, req.user.id, 'csv-import']
      ).catch(() => { skipped++; return null; });
      imported++;
    }
    await log(req.user.id, 'leads_csv_import', 'lead', null, { imported, skipped }, req.ip);
    res.json({ ok: true, imported, skipped });
  } catch(e) { console.error('CSV import error:', e); res.status(500).json({ error: 'Importfehler: ' + e.message }); }
});

// ── POST /api/leads/bulk — mehrere Leads auf einmal speichern (Admin oder can_generate_leads) ──
router.post('/bulk', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_generate_leads)
    return res.status(403).json({ error: 'Keine Berechtigung' });
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
    console.error('Bulk insert error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
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
  } catch(e) { console.error('Reminders error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── GET /api/leads/archived — archivierte Leads (Admin) ─────
router.get('/archived', auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT l.id, l.company, l.ceo, l.phone, l.email, l.location, l.status,
              l.archived_at, l.archive_reason,
              u1.full_name AS assigned_name,
              u2.full_name AS archived_by_name
       FROM leads l
       LEFT JOIN users u1 ON u1.id = l.assigned_to
       LEFT JOIN users u2 ON u2.id = l.archived_by
       WHERE l.archived_at IS NOT NULL
       ORDER BY l.archived_at DESC
       LIMIT 500`
    );
    res.json(rows);
  } catch(e) {
    console.error('Archived leads error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/leads/:id/restore — Lead wiederherstellen (Admin) ──
router.post('/:id/restore', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query('SELECT id FROM leads WHERE id=? AND archived_at IS NOT NULL', [id]);
    if (!lead) return res.status(404).json({ error: 'Archivierter Lead nicht gefunden' });
    await db.query('UPDATE leads SET archived_at=NULL, archived_by=NULL, archive_reason=NULL WHERE id=?', [id]);
    await log(req.user.id, 'lead_restore', 'lead', id, {}, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Lead restore error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── DELETE /api/leads/:id/permanent — endgültig löschen (Admin) ─
router.delete('/:id/permanent', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query('SELECT id FROM leads WHERE id=? AND archived_at IS NOT NULL', [id]);
    if (!lead) return res.status(404).json({ error: 'Nur archivierte Leads können endgültig gelöscht werden' });
    await db.query('DELETE FROM reminders WHERE lead_id=?', [id]);
    await db.query('DELETE FROM comments  WHERE lead_id=?', [id]);
    await db.query('DELETE FROM call_logs WHERE lead_id=?', [id]).catch(() => {});
    await db.query('DELETE FROM leads     WHERE id=?', [id]);
    await log(req.user.id, 'lead_delete_permanent', 'lead', id, {}, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Lead permanent delete error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── GET /api/leads/:id ──────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const [[lead]] = await db.query(
    `SELECT l.*, u1.full_name AS assigned_name, u2.full_name AS created_name
     FROM leads l
     LEFT JOIN users u1 ON u1.id = l.assigned_to
     LEFT JOIN users u2 ON u2.id = l.created_by
     WHERE l.id = ? AND l.archived_at IS NULL`, [id]
  );
  if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });

  const [comments] = await db.query(
    `SELECT c.*, u.full_name, u.username FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.lead_id = ? ORDER BY c.created_at ASC`, [id]
  );
  const [reminders] = await db.query(
    `SELECT r.*, u.full_name FROM reminders r
     JOIN users u ON u.id = r.user_id
     WHERE r.lead_id = ? ORDER BY r.remind_at ASC`, [id]
  );
  const [call_logs] = await db.query(
    `SELECT cl.*, u.full_name FROM call_logs cl
     JOIN users u ON u.id = cl.user_id
     WHERE cl.lead_id = ? ORDER BY cl.started_at DESC`, [id]
  ).catch(() => [[]]);
  const [email_thread] = await db.query(
    `SELECT id, direction, from_address, to_address, subject, body_text, received_at, created_at
     FROM lead_emails WHERE lead_id = ? ORDER BY COALESCE(received_at, created_at) ASC`, [id]
  ).catch(() => [[]]);
  res.json({ ...lead, comments, reminders, call_logs, email_thread });
});

// ── PATCH /api/leads/:id/status ──────────────────────────────
router.patch('/:id/status', auth, async (req, res) => {
  const id     = parseInt(req.params.id);
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status))
    return res.status(400).json({ error: 'Ungültiger Status' });

  const [[lead]] = await db.query('SELECT * FROM leads WHERE id = ?', [id]);
  if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!canView(req.user, lead))
    return res.status(403).json({ error: 'Kein Zugriff' });

  await db.query('UPDATE leads SET status = ? WHERE id = ?', [status, id]);
  await log(req.user.id, 'status_change', 'lead', id,
    { from: lead.status, to: status }, req.ip);
  res.json({ ok: true });
});

// ── PATCH /api/leads/:id — Update ──────────────────────────
router.patch('/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const isAdmin = req.user.role === 'admin';
  const canEditContacts = req.user.can_edit_contacts;
  const canReassign = req.user.can_reassign_leads;

  if (!isAdmin && !canEditContacts && !canReassign)
    return res.status(403).json({ error: 'Kein Zugriff' });

  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [id]);
  if (!lead) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!isAdmin && !canView(req.user, lead))
    return res.status(403).json({ error: 'Kein Zugriff' });

  const allowed = isAdmin
    ? ['company','ceo','email','phone','location','website','linkedin_url','industry','employees','revenue','notes','assigned_to','confidence']
    : [
        ...(canEditContacts ? ['email','phone'] : []),
        ...(canReassign     ? ['assigned_to']   : []),
      ];

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

// ── DELETE /api/leads/:id — Soft-Archivierung (kein physisches Löschen) ─────
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_archive_leads)
    return res.status(403).json({ error: 'Keine Berechtigung' });

  const id = parseInt(req.params.id);
  const reason = req.body?.reason || null;
  try {
    const [[lead]] = await db.query('SELECT id FROM leads WHERE id = ? AND archived_at IS NULL', [id]);
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    await db.query(
      'UPDATE leads SET archived_at = NOW(), archived_by = ?, archive_reason = ? WHERE id = ?',
      [req.user.id, reason, id]
    );
    await log(req.user.id, 'lead_archive', 'lead', id, { reason }, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Lead archive error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ── POST /api/leads/:id/comments ────────────────────────────
router.post('/:id/comments', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text fehlt' });

  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
  if (!canView(req.user, lead))
    return res.status(403).json({ error: 'Kein Zugriff' });

  const [r] = await db.query(
    'INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
    [leadId, req.user.id, text.trim()]
  );
  await log(req.user.id, 'comment_add', 'lead', leadId, { text: text.trim() }, req.ip);
  res.status(201).json({ ok: true, id: r.insertId });
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
  } catch(e) { console.error('Comment edit error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
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
  } catch(e) { console.error('Comment delete error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── POST /api/leads/:id/reminders ───────────────────────────
router.post('/:id/reminders', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { remind_at, note } = req.body;
  if (!remind_at) return res.status(400).json({ error: 'remind_at fehlt' });

  const [[lead]] = await db.query('SELECT assigned_to FROM leads WHERE id=?', [leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
  if (!canView(req.user, lead))
    return res.status(403).json({ error: 'Kein Zugriff' });

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

    if (req.user.role !== 'admin') {
      const [result] = await db.query(
        'UPDATE leads SET assigned_to=? WHERE id=? AND assigned_to IS NULL',
        [req.user.id, id]
      );
      if (result.affectedRows === 0)
        return res.status(409).json({ error: 'Dieser Lead wurde bereits übernommen.' });
    } else {
      await db.query('UPDATE leads SET assigned_to=? WHERE id=?', [req.user.id, id]);
    }
    await log(req.user.id, 'lead_assign', 'lead', id, { assigned_to: req.user.id }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Lead assign error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
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
    if (!canView(req.user, lead))
      return res.status(403).json({ error: 'E-Mail nur bei eigenen oder unzugewiesenen Leads erlaubt' });

    const [[user]] = await db.query('SELECT full_name FROM users WHERE id=?', [req.user.id]);
    const realMessageId = await sendLeadEmail({ to, subject, body, leadId: id });

    await db.query(
      'INSERT INTO comments (lead_id, user_id, text) VALUES (?,?,?)',
      [id, req.user.id, `📧 E-Mail gesendet: ${subject}`]
    );
    // Gesendete E-Mail mit echter Message-ID speichern — wird für Antwort-Zuordnung benötigt
    await db.query(
      `INSERT IGNORE INTO lead_emails (lead_id, direction, from_address, to_address, subject, body_text, message_id, received_at)
       VALUES (?, 'outbound', ?, ?, ?, ?, ?, NOW())`,
      [id, process.env.SMTP_USER || 'info@novaflowservices.de', to, subject,
       body.replace(/<[^>]+>/g, '').trim().slice(0, 10000),
       realMessageId]
    ).catch(() => {});
    await log(req.user.id, 'lead_email_sent', 'lead', id, { to, subject }, req.ip);
    res.json({ ok: true });
  } catch(e) {
    console.error('Email send error:', e);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden.' });
  }
});

// ── POST /api/leads/:id/calls/start — Anruf starten ─
router.post('/:id/calls/start', auth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  try {
    const [[lead]] = await db.query(
      'SELECT id, phone, assigned_to FROM leads WHERE id=?', [leadId]
    );
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    if (!lead.phone) return res.status(400).json({ error: 'Keine Telefonnummer gespeichert' });
    if (!canView(req.user, lead))
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Lead' });

    const [r] = await db.query(
      `INSERT INTO call_logs (lead_id, user_id, phone_number, direction, started_at, status)
       VALUES (?, ?, ?, 'outbound', NOW(), 'started')`,
      [leadId, req.user.id, lead.phone]
    );
    await log(req.user.id, 'call_started', 'lead', leadId, { phone: lead.phone }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) {
    console.error('call start error:', e);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

module.exports = router;

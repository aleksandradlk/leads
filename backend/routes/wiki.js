const router  = require('express').Router();
const db      = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

// Außerhalb des App-Verzeichnisses — überlebt Neustarts und Deployments
const UPLOAD_DIR = process.env.WIKI_UPLOAD_DIR
  || path.join(require('os').homedir(), 'uploads', 'wiki');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.docx', '.xlsx', '.txt'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Nur PDF, Bilder, Word, Excel und TXT erlaubt'));
  }
});

// GET /api/wiki/files
router.get('/files', auth, async (req, res) => {
  try {
    const [files] = await db.query(
      `SELECT f.*, u.full_name AS uploaded_by_name
       FROM wiki_files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       ORDER BY f.category, f.created_at DESC`
    );
    res.json(files);
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// POST /api/wiki/files (admin)
router.post('/files', auth, adminOnly, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { name, category, note } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  if (!category) return res.status(400).json({ error: 'Kategorie fehlt' });
  try {
    const [r] = await db.query(
      `INSERT INTO wiki_files (name, category, filename, mimetype, size, uploaded_by, note)
       VALUES (?,?,?,?,?,?,?)`,
      [name || req.file.originalname, category, req.file.filename,
       req.file.mimetype, req.file.size, req.user.id, note?.trim() || null]
    );
    await log(req.user.id, 'wiki_upload', 'wiki', r.insertId, { name, category }, req.ip);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// PATCH /api/wiki/files/:id — Notiz bearbeiten (admin)
router.patch('/files/:id', auth, adminOnly, async (req, res) => {
  try {
    const { note } = req.body;
    const [[file]] = await db.query('SELECT id FROM wiki_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'Nicht gefunden' });
    await db.query('UPDATE wiki_files SET note=? WHERE id=?', [note?.trim() || null, req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// PUT /api/wiki/files/:id/replace — Datei austauschen (admin)
router.put('/files/:id/replace', auth, adminOnly, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  try {
    const [[file]] = await db.query('SELECT * FROM wiki_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'Nicht gefunden' });
    // alte Datei löschen
    const oldPath = path.join(UPLOAD_DIR, file.filename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    await db.query(
      'UPDATE wiki_files SET filename=?, mimetype=?, size=?, uploaded_by=? WHERE id=?',
      [req.file.filename, req.file.mimetype, req.file.size, req.user.id, req.params.id]
    );
    await log(req.user.id, 'wiki_replace', 'wiki', req.params.id, { name: file.name }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

router.delete('/files/:id', auth, adminOnly, async (req, res) => {
  try {
    const [[file]] = await db.query('SELECT * FROM wiki_files WHERE id=?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'Nicht gefunden' });
    const filepath = path.join(UPLOAD_DIR, file.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    await db.query('DELETE FROM wiki_files WHERE id=?', [req.params.id]);
    await log(req.user.id, 'wiki_delete', 'wiki', req.params.id, { name: file.name }, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// GET /api/wiki/template
router.get('/template', auth, async (req, res) => {
  try {
    const [[tmpl]] = await db.query('SELECT * FROM email_template WHERE id=1');
    res.json(tmpl || { subject: '', body: '' });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// PUT /api/wiki/template (admin)
router.put('/template', auth, adminOnly, async (req, res) => {
  const { subject, body } = req.body;
  try {
    await db.query(
      `INSERT INTO email_template (id, subject, body, updated_by) VALUES (1,?,?,?)
       ON DUPLICATE KEY UPDATE subject=VALUES(subject), body=VALUES(body), updated_by=VALUES(updated_by)`,
      [subject || '', body || '', req.user.id]
    );
    await log(req.user.id, 'wiki_template_update', 'wiki', 1, {}, req.ip);
    res.json({ ok: true });
  } catch(e) { console.error('Wiki error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// GET /api/wiki/files/:filename — authenticated file delivery
// Akzeptiert Auth-Token wahlweise als Bearer-Header ODER ?token= Query-Param (für direkte Tab-Öffnung)
const jwt = require('jsonwebtoken');
router.get('/files/:filename', async (req, res) => {
  try {
    const raw = req.headers['authorization'] || '';
    const tokenStr = raw.startsWith('Bearer ') ? raw.slice(7) : (req.query.token || '');
    if (!tokenStr) return res.status(401).json({ error: 'Kein Token' });
    const payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
    const [[user]] = await db.query('SELECT id, is_active FROM users WHERE id=?', [payload.id]);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Nicht berechtigt' });
  } catch {
    return res.status(401).json({ error: 'Token ungültig' });
  }

  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!filepath.startsWith(path.resolve(UPLOAD_DIR) + path.sep))
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Nicht gefunden' });

  const [[file]] = await db.query('SELECT mimetype, name FROM wiki_files WHERE filename=?', [filename]).catch(() => [[]]);
  const EXT_MIME = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.txt': 'text/plain', '.html': 'text/html',
  };
  const ext = path.extname(filename).toLowerCase();
  const mime = (file?.mimetype && file.mimetype !== 'application/octet-stream')
    ? file.mimetype
    : (EXT_MIME[ext] || 'application/octet-stream');
  const displayName = file?.name || filename;
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(displayName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.sendFile(filepath);
});

module.exports = router;

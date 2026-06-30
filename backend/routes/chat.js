const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');

// ── GET /api/chats — eigene Chats (Admin sieht alle) ─────────
router.get('/', auth, async (req, res) => {
  try {
    let q;
    if (req.user.role === 'admin') {
      q = `SELECT r.id, r.title, r.is_closed, r.created_at,
                  u.full_name AS created_by_name,
                  COUNT(DISTINCT m.id) AS msg_count,
                  MAX(m.created_at) AS last_msg_at,
                  GROUP_CONCAT(DISTINCT up.full_name ORDER BY up.full_name SEPARATOR ', ') AS participants
           FROM chat_rooms r
           JOIN users u ON u.id = r.created_by
           LEFT JOIN chat_messages m ON m.chat_id = r.id
           LEFT JOIN chat_participants cp ON cp.chat_id = r.id
           LEFT JOIN users up ON up.id = cp.user_id
           GROUP BY r.id ORDER BY COALESCE(MAX(m.created_at), r.created_at) DESC`;
      const [rows] = await db.query(q);
      return res.json(rows);
    }
    // Closer: nur eigene Chats
    q = `SELECT r.id, r.title, r.is_closed, r.created_at,
                u.full_name AS created_by_name,
                COUNT(DISTINCT m.id) AS msg_count,
                MAX(m.created_at) AS last_msg_at,
                GROUP_CONCAT(DISTINCT up.full_name ORDER BY up.full_name SEPARATOR ', ') AS participants
         FROM chat_rooms r
         JOIN users u ON u.id = r.created_by
         JOIN chat_participants cp2 ON cp2.chat_id = r.id AND cp2.user_id = ?
         LEFT JOIN chat_messages m ON m.chat_id = r.id
         LEFT JOIN chat_participants cp ON cp.chat_id = r.id
         LEFT JOIN users up ON up.id = cp.user_id
         GROUP BY r.id ORDER BY COALESCE(MAX(m.created_at), r.created_at) DESC`;
    const [rows] = await db.query(q, [req.user.id]);
    res.json(rows);
  } catch(e) { console.error('Chat error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── POST /api/chats — Neuen Chat anlegen ─────────────────────
router.post('/', auth, async (req, res) => {
  const { title, invite_ids, lead_id } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel fehlt' });
  try {
    const [r] = await db.query(
      'INSERT INTO chat_rooms (title, created_by, lead_id) VALUES (?,?,?)',
      [title.trim(), req.user.id, lead_id || null]
    );
    const chatId = r.insertId;
    // Creator automatisch hinzufügen
    await db.query('INSERT INTO chat_participants (chat_id, user_id) VALUES (?,?)', [chatId, req.user.id]);
    // Eingeladene Nutzer
    if (Array.isArray(invite_ids)) {
      for (const uid of invite_ids) {
        if (uid !== req.user.id) {
          await db.query(
            'INSERT IGNORE INTO chat_participants (chat_id, user_id) VALUES (?,?)',
            [chatId, uid]
          );
        }
      }
    }
    res.status(201).json({ ok: true, id: chatId });
  } catch(e) { console.error('Chat error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── GET /api/chats/:id — Chat mit Nachrichten ─────────────────
router.get('/:id', auth, async (req, res) => {
  const chatId = parseInt(req.params.id);
  try {
    const [[room]] = await db.query(
      `SELECT r.*, u.full_name AS created_by_name,
              l.company AS lead_company, l.phone AS lead_phone,
              l.email AS lead_email, l.status AS lead_status, l.ceo AS lead_ceo
       FROM chat_rooms r
       JOIN users u ON u.id = r.created_by
       LEFT JOIN leads l ON l.id = r.lead_id
       WHERE r.id=?`, [chatId]
    );
    if (!room) return res.status(404).json({ error: 'Chat nicht gefunden' });

    // Zugriffsprüfung (Admin sieht alle)
    if (req.user.role !== 'admin') {
      const [[part]] = await db.query(
        'SELECT 1 FROM chat_participants WHERE chat_id=? AND user_id=?',
        [chatId, req.user.id]
      );
      if (!part) return res.status(403).json({ error: 'Kein Zugriff' });
    }

    const [messages] = await db.query(
      `SELECT m.id, m.text, m.created_at, u.full_name, u.id AS user_id
       FROM chat_messages m JOIN users u ON u.id = m.user_id
       WHERE m.chat_id=? ORDER BY m.created_at ASC`, [chatId]
    );
    const [participants] = await db.query(
      `SELECT u.id, u.full_name, u.role FROM chat_participants cp
       JOIN users u ON u.id = cp.user_id WHERE cp.chat_id=?`, [chatId]
    );
    res.json({ ...room, messages, participants });
  } catch(e) { console.error('Chat error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── POST /api/chats/:id/messages — Nachricht senden ──────────
router.post('/:id/messages', auth, async (req, res) => {
  const chatId = parseInt(req.params.id);
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Nachricht leer' });
  if (text.trim().length > 10000) return res.status(400).json({ error: 'Nachricht zu lang (max. 10.000 Zeichen)' });
  try {
    const [[room]] = await db.query('SELECT * FROM chat_rooms WHERE id=?', [chatId]);
    if (!room) return res.status(404).json({ error: 'Chat nicht gefunden' });
    if (room.is_closed) return res.status(400).json({ error: 'Chat ist geschlossen' });

    if (req.user.role !== 'admin') {
      const [[part]] = await db.query(
        'SELECT 1 FROM chat_participants WHERE chat_id=? AND user_id=?',
        [chatId, req.user.id]
      );
      if (!part) return res.status(403).json({ error: 'Nicht Teilnehmer' });
    }

    const [r] = await db.query(
      'INSERT INTO chat_messages (chat_id, user_id, text) VALUES (?,?,?)',
      [chatId, req.user.id, text.trim()]
    );
    res.status(201).json({ ok: true, id: r.insertId });
  } catch(e) { console.error('Chat error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── POST /api/chats/:id/invite — Nutzer einladen ─────────────
router.post('/:id/invite', auth, async (req, res) => {
  const chatId = parseInt(req.params.id);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id fehlt' });
  try {
    const [[room]] = await db.query('SELECT * FROM chat_rooms WHERE id=?', [chatId]);
    if (!room) return res.status(404).json({ error: 'Chat nicht gefunden' });
    if (room.is_closed) return res.status(400).json({ error: 'Chat ist geschlossen' });

    if (req.user.role !== 'admin') {
      const [[part]] = await db.query(
        'SELECT 1 FROM chat_participants WHERE chat_id=? AND user_id=?',
        [chatId, req.user.id]
      );
      if (!part) return res.status(403).json({ error: 'Kein Zugriff' });
    }
    const [[invitedUser]] = await db.query(
      'SELECT id FROM users WHERE id=? AND is_active=1', [user_id]
    );
    if (!invitedUser) return res.status(404).json({ error: 'Benutzer nicht gefunden oder inaktiv' });
    await db.query(
      'INSERT IGNORE INTO chat_participants (chat_id, user_id) VALUES (?,?)',
      [chatId, user_id]
    );
    res.json({ ok: true });
  } catch(e) { console.error('Chat error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

// ── PATCH /api/chats/:id/close — Chat schließen ──────────────
router.patch('/:id/close', auth, async (req, res) => {
  const chatId = parseInt(req.params.id);
  try {
    const [[room]] = await db.query('SELECT * FROM chat_rooms WHERE id=?', [chatId]);
    if (!room) return res.status(404).json({ error: 'Chat nicht gefunden' });
    if (req.user.role !== 'admin' && room.created_by !== req.user.id)
      return res.status(403).json({ error: 'Nur Ersteller oder Admin kann schließen' });
    await db.query('UPDATE chat_rooms SET is_closed=1 WHERE id=?', [chatId]);
    res.json({ ok: true });
  } catch(e) { console.error('Chat error:', e); res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' }); }
});

module.exports = router;

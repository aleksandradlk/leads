const jwt = require('jsonwebtoken');
const db  = require('../db');

// Verify JWT and attach user to req
async function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Kein Token' });
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const [[user]] = await db.query(
      'SELECT id, username, full_name, email, role, is_active, can_edit_contacts, can_archive_leads, can_reassign_leads, can_view_all_leads, can_create_users, can_generate_leads FROM users WHERE id = ?',
      [payload.id]
    );
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account gesperrt oder nicht gefunden' });
    req.user = user;

    // Update last_active in sessions
    await db.query(
      'UPDATE sessions SET last_active = NOW() WHERE user_id = ?',
      [user.id]
    );
    next();
  } catch {
    return res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
}

// Only allow admins
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' });
  next();
}

module.exports = { auth, adminOnly };

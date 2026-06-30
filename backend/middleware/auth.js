const jwt = require('jsonwebtoken');
const db  = require('../db');

// In-Memory-Cache für Wartungsmodus (30-Sekunden-TTL)
let _maintCache = { active: false, until: '', fetchedAt: 0 };

async function getMaintenanceStatus() {
  const now = Date.now();
  if (now - _maintCache.fetchedAt < 30_000) return _maintCache;
  try {
    const [rows] = await db.query(
      "SELECT key_name, value FROM app_settings WHERE key_name IN ('maintenance_mode','maintenance_until')"
    );
    const s = {};
    rows.forEach(r => { s[r.key_name] = r.value; });
    _maintCache = { active: s.maintenance_mode === 'true', until: s.maintenance_until || '', fetchedAt: now };
  } catch (_) {}
  return _maintCache;
}

// Cache sofort ungültig machen (nach Settings-Änderung aufrufen)
function invalidateMaintenanceCache() {
  _maintCache.fetchedAt = 0;
}

// Verify JWT and attach user to req
async function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Kein Token' });
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const [[user]] = await db.query(
      'SELECT id, username, full_name, email, role, is_active, can_edit_contacts, can_archive_leads, can_reassign_leads, can_view_all_leads, can_create_users, can_generate_leads, can_manage_email_templates FROM users WHERE id = ?',
      [payload.id]
    );
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account gesperrt oder nicht gefunden' });
    req.user = user;

    // Wartungsmodus: Closer werden blockiert, Admin kommt immer durch
    if (user.role !== 'admin') {
      const maint = await getMaintenanceStatus();
      // Automatisches Ablaufen: wenn until-Zeit in der Vergangenheit liegt → Wartung beendet
      const isExpired = maint.until && new Date(maint.until) <= new Date();
      if (maint.active && !isExpired) {
        return res.status(503).json({
          error: 'maintenance',
          message: 'Das System befindet sich aktuell in Wartung.',
          until: maint.until || null,
        });
      }
    }

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

module.exports = { auth, adminOnly, invalidateMaintenanceCache };

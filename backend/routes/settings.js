const router = require('express').Router();
const db     = require('../db');
const { auth, adminOnly, invalidateMaintenanceCache } = require('../middleware/auth');

// GET /api/settings/status — öffentlicher Endpunkt (kein Auth) für Wartungsmodus-Abfrage
router.get('/status', async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT key_name, value FROM app_settings WHERE key_name IN ('maintenance_mode','maintenance_until')"
    );
    const s = {};
    rows.forEach(r => { s[r.key_name] = r.value; });
    const until = s.maintenance_until || null;
    const isExpired = until && new Date(until) <= new Date();
    res.json({
      maintenance: s.maintenance_mode === 'true' && !isExpired,
      until,
    });
  } catch (e) {
    res.json({ maintenance: false, until: null });
  }
});

// GET /api/settings — öffentliche Einstellungen (alle Auth-User)
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT key_name, value FROM app_settings');
    const obj = {};
    rows.forEach(r => { obj[r.key_name] = r.value; });
    res.json(obj);
  } catch(e) { res.status(500).json({ error: 'Fehler beim Laden der Einstellungen' }); }
});

// PATCH /api/settings/:key — Einstellung setzen (Admin)
router.patch('/:key', auth, adminOnly, async (req, res) => {
  const key   = req.params.key;
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value fehlt' });
  try {
    await db.query(
      'INSERT INTO app_settings (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?',
      [key, String(value), String(value)]
    );
    // Bei Wartungsmodus-Änderung Cache sofort invalidieren
    if (key === 'maintenance_mode' || key === 'maintenance_until') {
      invalidateMaintenanceCache();
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Fehler beim Speichern' }); }
});

module.exports = router;

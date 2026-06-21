const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');

const VALID_STATUSES = ['completed','no-answer','busy','failed','manual'];

// ── PATCH /api/calls/:id — Call-Log nach Gespräch aktualisieren
router.patch('/:id', auth, async (req, res) => {
  const callId = parseInt(req.params.id);
  const { status, duration_seconds, note } = req.body;

  try {
    const [[call]] = await db.query('SELECT * FROM call_logs WHERE id=?', [callId]);
    if (!call) return res.status(404).json({ error: 'Call nicht gefunden' });

    // Nur Admin oder der User der den Anruf gestartet hat
    if (req.user.role !== 'admin' && call.user_id !== req.user.id)
      return res.status(403).json({ error: 'Nur eigene Anrufe bearbeitbar' });

    const updates = [];
    const params  = [];

    if (status && VALID_STATUSES.includes(status)) {
      updates.push('status=?'); params.push(status);
      if (status !== 'started') { updates.push('ended_at=NOW()'); }
    }
    if (duration_seconds != null) {
      updates.push('duration_seconds=?');
      params.push(parseInt(duration_seconds) || null);
    }
    if (note !== undefined) {
      updates.push('note=?');
      params.push(note?.trim() || null);
    }

    if (!updates.length) return res.status(400).json({ error: 'Nichts zu aktualisieren' });
    params.push(callId);
    await db.query(`UPDATE call_logs SET ${updates.join(',')} WHERE id=?`, params);
    res.json({ ok: true });
  } catch(e) {
    console.error('call update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/calls/lead/:leadId — Call-Historie eines Leads ──
router.get('/lead/:leadId', auth, async (req, res) => {
  const leadId = parseInt(req.params.leadId);
  try {
    const [rows] = await db.query(
      `SELECT cl.*, u.full_name FROM call_logs cl
       JOIN users u ON u.id = cl.user_id
       WHERE cl.lead_id=? ORDER BY cl.started_at DESC`,
      [leadId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

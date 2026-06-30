const { ImapFlow } = require('imapflow');
const db = require('../db');

async function pollIncomingEmails() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) return;

  // Letzten Abfrage-Zeitpunkt aus DB lesen
  const [[lastPollRow]] = await db.query(
    "SELECT value FROM app_settings WHERE key_name='imap_last_poll'"
  ).catch(() => [[null]]);

  // Erster Lauf: nur letzte 30 Tage; sonst: seit letztem Poll minus 10 min Puffer
  const since = lastPollRow
    ? new Date(new Date(lastPollRow.value).getTime() - 10 * 60 * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const client = new ImapFlow({
    host,
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: process.env.IMAP_SECURE !== 'false',
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Nur neue Nachrichten seit dem letzten Poll abrufen (nicht alle)
      const uids = await client.search({ since }, { uid: true });

      for await (const msg of client.fetch(uids.length ? uids : [], {
        envelope: true,
        bodyParts: ['TEXT'],
        headers: ['in-reply-to', 'references', 'x-crm-lead-id'],
      }, { uid: true })) {
        const messageId = msg.envelope?.messageId;
        if (!messageId) continue;

        // Bereits verarbeitet?
        const [[existing]] = await db.query(
          'SELECT id FROM lead_emails WHERE message_id=?', [messageId]
        ).catch(() => [[null]]);
        if (existing) continue;

        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() || '';
        const subject  = msg.envelope?.subject || '';

        // ── 4-stufige Lead-Zuordnung ─────────────────────────────
        let leadId = null;

        // Stufe 1: X-CRM-Lead-ID Header (direkter Treffer)
        const crmHeader = msg.headers?.get('x-crm-lead-id');
        if (crmHeader) {
          const cid = parseInt(String(crmHeader).trim());
          if (!isNaN(cid)) {
            const [[row]] = await db.query(
              'SELECT id FROM leads WHERE id=? AND archived_at IS NULL LIMIT 1', [cid]
            ).catch(() => [[null]]);
            if (row) leadId = row.id;
          }
        }

        // Stufe 2: In-Reply-To / References gegen gesendete Message-IDs
        if (!leadId) {
          const inReplyTo  = msg.headers?.get('in-reply-to') || '';
          const references = msg.headers?.get('references')  || '';
          const refIds = [
            ...String(inReplyTo).matchAll(/<([^>]+)>/g),
            ...String(references).matchAll(/<([^>]+)>/g),
          ].map(m => `<${m[1]}>`);
          if (refIds.length) {
            const placeholders = refIds.map(() => '?').join(',');
            const [[row]] = await db.query(
              `SELECT lead_id FROM lead_emails WHERE message_id IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
              refIds
            ).catch(() => [[null]]);
            if (row) leadId = row.lead_id;
          }
        }

        // Stufe 3: [NF-{id}] im Betreff
        if (!leadId) {
          const match = subject.match(/\[NF-(\d+)\]/i);
          if (match) {
            const sid = parseInt(match[1]);
            const [[row]] = await db.query(
              'SELECT id FROM leads WHERE id=? AND archived_at IS NULL LIMIT 1', [sid]
            ).catch(() => [[null]]);
            if (row) leadId = row.id;
          }
        }

        // Stufe 4: E-Mail-Adresse des Absenders (Fallback)
        if (!leadId && fromAddr) {
          const [[row]] = await db.query(
            'SELECT id FROM leads WHERE LOWER(email)=? AND archived_at IS NULL LIMIT 1', [fromAddr]
          ).catch(() => [[null]]);
          if (row) leadId = row.id;
        }

        // Body-Text extrahieren
        let bodyText = '';
        if (msg.bodyParts) {
          for (const [, part] of msg.bodyParts) {
            bodyText += Buffer.isBuffer(part) ? part.toString('utf8') : String(part);
          }
        }
        bodyText = bodyText.replace(/<[^>]+>/g, '').replace(/\r\n/g, '\n').trim();

        const receivedAt = msg.envelope?.date || new Date();
        const toAddr     = msg.envelope?.to?.[0]?.address || user;

        if (!leadId) {
          // Kein Lead gefunden → in unmatched_emails speichern (Admin-Liste)
          await db.query(
            `INSERT IGNORE INTO unmatched_emails (from_address, to_address, subject, body_text, message_id, received_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [fromAddr, toAddr, subject, bodyText.slice(0, 10000), messageId, receivedAt]
          ).catch(() => {});
          continue;
        }

        await db.query(
          `INSERT INTO lead_emails (lead_id, direction, from_address, to_address, subject, body_text, message_id, received_at)
           VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?)`,
          [leadId, fromAddr, toAddr, subject, bodyText.slice(0, 10000), messageId, receivedAt]
        ).catch(() => {});
      }
    } finally {
      lock.release();
    }
    await client.logout();

    // Letzten Poll-Zeitpunkt aktualisieren
    await db.query(
      "INSERT INTO app_settings (key_name, value) VALUES ('imap_last_poll',?) ON DUPLICATE KEY UPDATE value=?",
      [new Date().toISOString(), new Date().toISOString()]
    ).catch(() => {});

  } catch (e) {
    if (e.code !== 'ECONNREFUSED') {
      console.error('[IMAP Poller]', e.message);
    }
  }
}

module.exports = { pollIncomingEmails };

const { ImapFlow } = require('imapflow');
const db = require('../db');

async function pollIncomingEmails() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) return;

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
      for await (const msg of client.fetch('1:*', {
        envelope: true,
        bodyParts: ['text'],
        headers: ['in-reply-to', 'references', 'x-crm-lead-id'],
      })) {
        const messageId = msg.envelope?.messageId;
        if (!messageId) continue;

        // Bereits verarbeitet?
        const [[existing]] = await db.query(
          'SELECT id FROM lead_emails WHERE message_id=?', [messageId]
        ).catch(() => [[null]]);
        if (existing) continue;

        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() || '';
        const subject  = msg.envelope?.subject || '';

        // ── 3-stufige Lead-Zuordnung ─────────────────────────────
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
          const inReplyTo = msg.headers?.get('in-reply-to') || '';
          const references = msg.headers?.get('references') || '';
          // Alle referenzierten Message-IDs extrahieren
          const refIds = [...String(inReplyTo).matchAll(/<([^>]+)>/g), ...String(references).matchAll(/<([^>]+)>/g)]
            .map(m => `<${m[1]}>`);
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

        // Stufe 4: E-Mail-Adresse des Absenders (klassischer Fallback)
        if (!leadId && fromAddr) {
          const [[row]] = await db.query(
            'SELECT id FROM leads WHERE LOWER(email)=? AND archived_at IS NULL LIMIT 1', [fromAddr]
          ).catch(() => [[null]]);
          if (row) leadId = row.id;
        }

        if (!leadId) continue; // keiner der 4 Wege hat einen Lead gefunden

        // Body-Text extrahieren
        let bodyText = '';
        if (msg.bodyParts) {
          for (const [, part] of msg.bodyParts) {
            bodyText += Buffer.isBuffer(part) ? part.toString('utf8') : String(part);
          }
        }
        bodyText = bodyText.replace(/<[^>]+>/g, '').replace(/\r\n/g, '\n').trim();

        const receivedAt = msg.envelope?.date || new Date();
        const toAddr = msg.envelope?.to?.[0]?.address || user;

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
  } catch (e) {
    if (e.code !== 'ECONNREFUSED') {
      console.error('[IMAP Poller]', e.message);
    }
  }
}

module.exports = { pollIncomingEmails };

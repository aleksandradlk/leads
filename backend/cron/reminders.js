const cron          = require('node-cron');
const db            = require('../db');
const { sendReminder } = require('../helpers/mailer');

// Läuft jede Minute — prüft fällige Reminder
function startReminderCron() {
  cron.schedule('* * * * *', async () => {
    try {
      const [due] = await db.query(
        `SELECT r.id, r.note, r.remind_at,
                l.company,
                u.email, u.full_name
         FROM reminders r
         JOIN leads l ON l.id = r.lead_id
         JOIN users u ON u.id = r.user_id
         WHERE r.sent = 0 AND r.remind_at <= NOW()`
      );

      for (const r of due) {
        if (!r.email) {
          await db.query('UPDATE reminders SET sent = 1 WHERE id = ?', [r.id]);
          console.log(`Reminder (id=${r.id}) als in-App zugestellt markiert — User hat keine E-Mail-Adresse`);
          continue;
        }
        try {
          await sendReminder({
            to:          r.email,
            toName:      r.full_name,
            leadCompany: r.company,
            note:        r.note,
            remindAt:    r.remind_at,
          });
          await db.query('UPDATE reminders SET sent = 1 WHERE id = ?', [r.id]);
          console.log(`Reminder sent: ${r.company} → ${r.email}`);
        } catch (e) {
          console.error(`Reminder mail error (id=${r.id}):`, e.message);
        }
      }
    } catch (e) {
      console.error('Cron error:', e.message);
    }
  });

  console.log('Reminder cron gestartet (jede Minute)');
}

module.exports = { startReminderCron };

const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const LOGO_PATH = path.join(__dirname, '../public_html/LogoKomplett-klein.PNG');
const LOGO_CID  = 'novaflow-logo@crm';

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const LOGO_ATTACHMENT = {
  filename: 'LogoKomplett-klein.PNG',
  path: LOGO_PATH,
  cid: LOGO_CID,
};

async function sendReminder({ to, toName, leadCompany, note, remindAt }) {
  const dateStr = new Date(remindAt).toLocaleString('de-DE');
  await transporter.sendMail({
    from: `"NovaFlow Services" <${process.env.SMTP_USER}>`,
    to,
    subject: `⏰ Reminder: ${leadCompany}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:8px">
        <img src="cid:${LOGO_CID}" alt="NovaFlow Services" width="160" style="display:block;margin-bottom:20px">
        <h2 style="color:#4f8ef7;margin-bottom:8px">Erinnerung</h2>
        <p style="color:#333;margin-bottom:16px">Hallo ${toName},</p>
        <div style="background:#fff;border-left:4px solid #4f8ef7;padding:16px;border-radius:4px;margin-bottom:16px">
          <strong>Lead:</strong> ${leadCompany}<br>
          <strong>Fällig:</strong> ${dateStr}<br>
          ${note ? `<strong>Notiz:</strong> ${note}` : ''}
        </div>
        <p style="color:#888;font-size:12px">NovaFlow Services · info@novaflowservices.de</p>
      </div>
    `,
    attachments: [LOGO_ATTACHMENT],
  });
}

// Sendet eine Lead-E-Mail und gibt die echte Message-ID zurück.
// Betrifft subject wird "[NF-{leadId}]" angehängt damit Antworten sicher zugeordnet werden können.
async function sendLeadEmail({ to, subject, body, leadId }) {
  const domain = (process.env.SMTP_USER || 'info@novaflowservices.de').split('@')[1] || 'novaflowservices.de';
  const msgId  = `<crm-lead-${leadId}-${Date.now()}@${domain}>`;
  const taggedSubject = subject.includes('[NF-') ? subject : `${subject} [NF-${leadId}]`;

  const info = await transporter.sendMail({
    from:    `"NovaFlow Services" <${process.env.SMTP_USER}>`,
    to,
    subject: taggedSubject,
    messageId: msgId,
    headers: { 'X-CRM-Lead-ID': String(leadId) },
    html: `
      <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#141f34">
        ${body.includes('<') ? body : body.split('\n').map(l => l.trim() ? `<p style="margin:0 0 12px">${l}</p>` : '<br>').join('')}
        <hr style="border:none;border-top:1px solid #e2e7f0;margin:24px 0">
        <img src="cid:${LOGO_CID}" alt="NovaFlow Services" width="160" style="display:block;margin-bottom:12px">
        <p style="color:#8e9ab5;font-size:12px">NovaFlow Services · info@novaflowservices.de</p>
      </div>
    `,
    attachments: [LOGO_ATTACHMENT],
  });
  // Nodemailer gibt die tatsächlich verwendete Message-ID zurück
  return info.messageId || msgId;
}

module.exports = { sendReminder, sendLeadEmail };

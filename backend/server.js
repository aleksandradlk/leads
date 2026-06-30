require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const path        = require('path');

const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const leadRoutes     = require('./routes/leads');
const generateRoutes = require('./routes/generate');
const wikiRoutes     = require('./routes/wiki');
const chatRoutes     = require('./routes/chat');
const callRoutes     = require('./routes/calls');
const feedbackRoutes  = require('./routes/feedback');
const settingsRoutes       = require('./routes/settings');
const emailTemplateRoutes  = require('./routes/emailtemplates');
const toolRoutes           = require('./routes/tools');
const { startReminderCron } = require('./cron/reminders');
const { pollIncomingEmails } = require('./cron/emailPoller');
const cron           = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc:      ["'self'", "data:", "blob:"],
      connectSrc:  ["'self'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
      frameAncestors: ["'none'"],
    }
  }
}));
app.use(compression());
app.use(cors({
  origin: process.env.BASE_URL || '*',
  methods: ['GET','POST','PATCH','DELETE','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.set('trust proxy', 1);
app.use(express.json());

// Rate limiting
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 20 }));
app.use('/api/generate',   rateLimit({ windowMs: 60*1000, max: 5 }));

// ── Static Frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public_html'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));


// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/leads',    leadRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/wiki',     wikiRoutes);
app.use('/api/chats',    chatRoutes);
app.use('/api/calls',    callRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/settings',        settingsRoutes);
app.use('/api/email-templates', emailTemplateRoutes);
app.use('/api/tools',           toolRoutes);

// ── SPA Fallback ──────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public_html/login.html'), (err) => { if (err) res.status(404).end(); });
});

// ── Auto-Migration ────────────────────────────────────────────
const db = require('./db');
db.query("ALTER TABLE users MODIFY COLUMN email VARCHAR(150) NULL")
  .then(() => console.log('Migration: email nullable'))
  .catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS wiki_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mimetype VARCHAR(100),
  size INT,
  uploaded_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS email_template (
  id INT PRIMARY KEY,
  subject VARCHAR(500),
  body TEXT,
  updated_by INT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).catch(() => {});

// ── Neue DB-Migrationen ───────────────────────────────────────
db.query('ALTER TABLE comments ADD COLUMN edited_at DATETIME NULL').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN notify_email TINYINT(1) NOT NULL DEFAULT 1').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN notify_sms   TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN phone        VARCHAR(50) NULL').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN onboarding_shown TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS chat_rooms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  created_by INT NOT NULL,
  is_closed TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id INT NOT NULL,
  user_id INT NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id)
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS chat_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  chat_id INT NOT NULL,
  user_id INT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

db.query('ALTER TABLE chat_rooms ADD COLUMN lead_id INT NULL').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN can_edit_contacts  TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN can_archive_leads  TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN can_reassign_leads TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN can_view_all_leads TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN can_create_users   TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN can_generate_leads TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS feedback (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  title       VARCHAR(300) NOT NULL,
  description TEXT NULL,
  type        ENUM('bug','wunsch') DEFAULT 'wunsch',
  tag         ENUM('offen','in_planung','erledigt','nicht_moeglich') DEFAULT 'offen',
  admin_note  TEXT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

// ── Call Logs ─────────────────────────────────────────────────
db.query(`CREATE TABLE IF NOT EXISTS call_logs (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  lead_id          INT NOT NULL,
  user_id          INT NOT NULL,
  phone_number     VARCHAR(50),
  direction        ENUM('outbound','inbound') DEFAULT 'outbound',
  started_at       DATETIME,
  ended_at         DATETIME NULL,
  duration_seconds INT NULL,
  status           ENUM('started','reached','no-answer','busy','failed','wrong_number','completed','manual') DEFAULT 'started',
  note             TEXT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
// ENUM erweitern — enthält alte Werte (completed, manual) für Rückwärtskompatibilität
// Bestehende Zeilen bleiben erhalten; neue Einträge nutzen die neuen Werte
db.query(`ALTER TABLE call_logs MODIFY COLUMN status ENUM('started','reached','no-answer','busy','failed','wrong_number','completed','manual') DEFAULT 'started'`).catch(() => {});

// ── Index-Migrationen (idempotent — Fehler = Index existiert bereits) ────────
db.query('CREATE INDEX idx_leads_status     ON leads (status)').catch(() => {});
db.query('CREATE INDEX idx_leads_created_at ON leads (created_at)').catch(() => {});
db.query('CREATE INDEX idx_leads_updated_at ON leads (updated_at)').catch(() => {});
db.query('CREATE INDEX idx_rem_user_sent_time ON reminders (user_id, sent, remind_at)').catch(() => {});
db.query('CREATE INDEX idx_activity_created_at ON activity_log (created_at)').catch(() => {});
db.query('CREATE INDEX idx_leads_assigned_status ON leads (assigned_to, status)').catch(() => {});
db.query('CREATE INDEX idx_leads_status_created  ON leads (status, created_at)').catch(() => {});

// ── E-Mail-Vorlagen-Tabelle + Seed ───────────────────────────
db.query(`CREATE TABLE IF NOT EXISTS email_templates (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  subject    VARCHAR(500) NOT NULL,
  body       TEXT NOT NULL,
  category   VARCHAR(100) NULL,
  is_active  TINYINT(1)  NOT NULL DEFAULT 1,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).then(() => {
  db.query('SELECT COUNT(*) AS cnt FROM email_templates').then(([[{ cnt }]]) => {
    if (cnt > 0) return;
    const seeds = [
      ['Allgemeine Informationen', 'Weitere Informationen zu {{firma}}',
       'Hallo {{kunde}},\n\nwie besprochen sende ich Ihnen hier die wichtigsten Informationen.\n\nWenn Sie Fragen haben oder etwas unklar ist, können wir das gerne kurz telefonisch besprechen.\n\nViele Grüße\n{{closer}}',
       'Allgemein'],
      ['Interesse vorhanden', 'Nächster Schritt für {{firma}}',
       'Hallo {{kunde}},\n\nvielen Dank für das Gespräch. Da grundsätzlich Interesse besteht, würde ich als nächsten Schritt gerne kurz abstimmen, welche Lösung für {{firma}} am sinnvollsten ist.\n\nWann passt es Ihnen für eine kurze Rücksprache?\n\nViele Grüße\n{{closer}}',
       'Vertrieb'],
      ['Nachfassen', 'Kurze Rückfrage zu unserem Gespräch',
       'Hallo {{kunde}},\n\nich wollte kurz nachfragen, ob Sie sich die Informationen bereits anschauen konnten.\n\nGerne können wir die offenen Punkte kurz telefonisch klären.\n\nViele Grüße\n{{closer}}',
       'Nachfassen'],
      ['Termin bestätigen', 'Bestätigung unseres Termins',
       'Hallo {{kunde}},\n\nhiermit bestätige ich unseren Termin.\n\nFalls sich bei Ihnen etwas ändert, geben Sie mir bitte kurz Bescheid.\n\nViele Grüße\n{{closer}}',
       'Termin'],
      ['Mehr Infos senden', 'Weitere Details für {{firma}}',
       'Hallo {{kunde}},\n\ngerne sende ich Ihnen weitere Informationen zu den besprochenen Punkten.\n\nWenn Sie möchten, können wir danach kurz telefonieren und prüfen, was für {{firma}} konkret sinnvoll ist.\n\nViele Grüße\n{{closer}}',
       'Info'],
      ['Keine Antwort', 'Kurze Erinnerung',
       'Hallo {{kunde}},\n\nich wollte mich kurz in Erinnerung bringen, da ich bisher keine Rückmeldung erhalten habe.\n\nBesteht das Thema für {{firma}} aktuell noch?\n\nViele Grüße\n{{closer}}',
       'Nachfassen'],
    ];
    Promise.all(seeds.map(([name, subject, body, category]) =>
      db.query('INSERT INTO email_templates (name, subject, body, category) VALUES (?,?,?,?)',
        [name, subject, body, category])
    )).catch(() => {});
  }).catch(() => {});
}).catch(() => {});

// ── E-Mail-Eingang-Tabelle ────────────────────────────────────
db.query(`CREATE TABLE IF NOT EXISTS lead_emails (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  lead_id      INT NOT NULL,
  direction    ENUM('inbound','outbound') DEFAULT 'inbound',
  from_address VARCHAR(255),
  to_address   VARCHAR(255),
  subject      VARCHAR(500),
  body_text    TEXT,
  message_id   VARCHAR(500),
  received_at  DATETIME,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_message_id (message_id(250))
)`).catch(() => {});

// ── Unzugeordnete eingehende E-Mails ─────────────────────────
db.query(`CREATE TABLE IF NOT EXISTS unmatched_emails (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  from_address VARCHAR(255),
  to_address   VARCHAR(255),
  subject      VARCHAR(500),
  body_text    TEXT,
  message_id   VARCHAR(500),
  received_at  DATETIME,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_unmatched_mid (message_id(250))
)`).catch(() => {});

// ── Settings-Tabelle ─────────────────────────────────────────
db.query(`CREATE TABLE IF NOT EXISTS app_settings (
  key_name VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL
)`).catch(() => {});
db.query("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('closer_sees_admins','false')").catch(() => {});
db.query("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('closer_sees_tool','false')").catch(() => {});
db.query("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('maintenance_mode','false')").catch(() => {});
db.query("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('maintenance_until','')").catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS tools (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  url            VARCHAR(500) NOT NULL,
  closer_visible TINYINT(1)  NOT NULL DEFAULT 0,
  sort_order     INT         NOT NULL DEFAULT 0,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).then(() => {
  db.query('SELECT COUNT(*) AS cnt FROM tools').then(([[{ cnt }]]) => {
    if (cnt === 0) {
      db.query("INSERT INTO tools (name, url, closer_visible) VALUES ('Angebots-Tool', 'https://tool.novaflowservices.de', 0)").catch(() => {});
    }
  }).catch(() => {});
}).catch(() => {});
db.query("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('call_script','')").catch(() => {});
db.query("INSERT IGNORE INTO app_settings (key_name, value) VALUES ('daily_call_goal','50')").catch(() => {});

// ── Audit-Migrationen ─────────────────────────────────────────
db.query('ALTER TABLE users ADD COLUMN created_by INT NULL').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN can_manage_email_templates TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
db.query('ALTER TABLE leads ADD COLUMN archived_at DATETIME NULL').catch(() => {});
db.query('ALTER TABLE leads ADD COLUMN archived_by INT NULL').catch(() => {});
db.query('ALTER TABLE leads ADD COLUMN archive_reason VARCHAR(500) NULL').catch(() => {});
db.query('CREATE INDEX idx_leads_archived ON leads (archived_at)').catch(() => {});
db.query('ALTER TABLE leads ADD FULLTEXT INDEX ft_leads_search (company, ceo, location)').catch(() => {});

// ── Cron: Activity Log nach 7 Tagen bereinigen ───────────────
cron.schedule('0 3 * * *', async () => {
  try {
    const [r] = await db.query(
      'DELETE FROM activity_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)'
    );
    console.log(`Activity cleanup: ${r.affectedRows} Einträge gelöscht`);
  } catch(e) { console.error('Activity cleanup error:', e.message); }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LeadHunter Pro läuft auf Port ${PORT}`);
  console.log(`Umgebung: ${process.env.NODE_ENV || 'development'}`);
  startReminderCron();
  // IMAP-Polling alle 5 Minuten
  cron.schedule('*/2 * * * *', pollIncomingEmails);
  pollIncomingEmails(); // Sofort beim Start einmal prüfen
});

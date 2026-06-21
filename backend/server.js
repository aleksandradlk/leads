require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const path        = require('path');

const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const leadRoutes     = require('./routes/leads');
const generateRoutes = require('./routes/generate');
const wikiRoutes     = require('./routes/wiki');
const chatRoutes          = require('./routes/chat');
const callRoutes          = require('./routes/calls');
const { startReminderCron } = require('./cron/reminders');
const cron           = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
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
db.query('ALTER TABLE users ADD COLUMN can_edit_contacts TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});

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
  status           ENUM('started','reached','no-answer','busy','failed','wrong_number') DEFAULT 'started',
  note             TEXT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
// ENUM erweitern falls Tabelle bereits existiert (idempotent — Fehler = bereits aktuell)
db.query(`ALTER TABLE call_logs MODIFY COLUMN status ENUM('started','reached','no-answer','busy','failed','wrong_number') DEFAULT 'started'`).catch(() => {});

// ── Index-Migrationen (idempotent — Fehler = Index existiert bereits) ────────
db.query('CREATE INDEX idx_leads_status     ON leads (status)').catch(() => {});
db.query('CREATE INDEX idx_leads_created_at ON leads (created_at)').catch(() => {});
db.query('CREATE INDEX idx_leads_updated_at ON leads (updated_at)').catch(() => {});
db.query('CREATE INDEX idx_rem_user_sent_time ON reminders (user_id, sent, remind_at)').catch(() => {});
db.query('CREATE INDEX idx_activity_created_at ON activity_log (created_at)').catch(() => {});
db.query('CREATE INDEX idx_leads_assigned_status ON leads (assigned_to, status)').catch(() => {});
db.query('CREATE INDEX idx_leads_status_created  ON leads (status, created_at)').catch(() => {});

// ── Cron: Activity Log nach 7 Tagen bereinigen ───────────────
cron.schedule('0 3 * * *', async () => {
  try {
    const [r] = await db.query(
      'DELETE FROM activity_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)'
    );
    console.log(`Activity cleanup: ${r.affectedRows} Einträge gelöscht`);
  } catch(e) { console.error('Activity cleanup error:', e.message); }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LeadHunter Pro läuft auf Port ${PORT}`);
  console.log(`Umgebung: ${process.env.NODE_ENV || 'development'}`);
  startReminderCron();
});

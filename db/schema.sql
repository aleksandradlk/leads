-- ============================================================
-- LeadHunter Pro — Datenbank-Schema
-- Ausführen: mysql -u root -p leadhunter < schema.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS leadhunter CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE leadhunter;

-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  role          ENUM('admin','closer') NOT NULL DEFAULT 'closer',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login    DATETIME
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- LEADS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company       VARCHAR(200),
  ceo           VARCHAR(150),
  email         VARCHAR(150),
  phone         VARCHAR(60),
  location      VARCHAR(150),
  website       VARCHAR(255),
  linkedin_url  VARCHAR(255),
  industry      VARCHAR(100),
  employees     VARCHAR(50),
  revenue       VARCHAR(100),
  source        VARCHAR(50),
  confidence    TINYINT UNSIGNED DEFAULT 50,
  notes         TEXT,
  status        ENUM('neu','kontaktiert','nicht_erreicht','kein_interesse','rueckruf','kunde') NOT NULL DEFAULT 'neu',
  assigned_to   INT,               -- user.id des Closers
  created_by    INT NOT NULL,       -- user.id des Admins
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by)  REFERENCES users(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- COMMENTS (Kommentare + Verlauf pro Lead)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  lead_id    INT NOT NULL,
  user_id    INT NOT NULL,
  text       TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- REMINDERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminders (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  lead_id      INT NOT NULL,
  user_id      INT NOT NULL,
  remind_at    DATETIME NOT NULL,
  note         TEXT,
  sent         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- ACTIVITY LOG (Tracking — nur Admin sichtbar)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  action      VARCHAR(100) NOT NULL,   -- z.B. 'status_change', 'comment_add', 'login'
  target_type VARCHAR(50),             -- 'lead', 'user', 'system'
  target_id   INT,
  detail      TEXT,                    -- JSON-String mit Details
  ip          VARCHAR(45),
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- SESSIONS (Echtzeit-Tracking)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL UNIQUE,
  token         VARCHAR(512) NOT NULL,
  login_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  click_count   INT UNSIGNED NOT NULL DEFAULT 0,
  ip            VARCHAR(45),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- INDEXES (Performance bei 10.000+ Leads)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_status        ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_created_at    ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_updated_at    ON leads (updated_at);
CREATE INDEX IF NOT EXISTS idx_rem_user_sent_time  ON reminders (user_id, sent, remind_at);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log (created_at);

-- ------------------------------------------------------------
-- Standard-Admin anlegen (Passwort wird beim ersten Start gesetzt)
-- ------------------------------------------------------------
-- Admin-Account wird über /api/setup erstellt beim ersten Start

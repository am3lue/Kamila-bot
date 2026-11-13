// SQLite storage for the Kamila AI bot (the owner's personal assistant on the
// "default" WhatsApp number): contacts, chat history, tasks, evaluations,
// drafts, feedback, registrations and conversation memory.
import Database from 'better-sqlite3';
import logger from '../utils/logger.js';
import { initMemoryTable, prepareMemoryStmts } from './memory.js';

export function openBotStore(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      phone_number TEXT PRIMARY KEY,
      name TEXT,
      auto_reply_mode TEXT CHECK(auto_reply_mode IN ('AUTO','DRAFT','OFF')) DEFAULT 'AUTO',
      wa_name TEXT,
      on_whatsapp INTEGER DEFAULT 1,
      registered INTEGER DEFAULT 0,
      source TEXT DEFAULT 'import'
    );
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL UNIQUE,
      submitted_name TEXT,
      status TEXT CHECK(status IN ('PENDING','APPROVED','REJECTED')) DEFAULT 'PENDING',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender TEXT,
      text TEXT,
      timestamp INTEGER DEFAULT (unixepoch()),
      is_ai INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      task_description TEXT,
      urgency TEXT CHECK(urgency IN ('HIGH','MEDIUM','LOW')) DEFAULT 'MEDIUM',
      status TEXT CHECK(status IN ('PENDING','DONE')) DEFAULT 'PENDING',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS evaluations (
      chat_id TEXT PRIMARY KEY,
      resolution_score INTEGER CHECK(resolution_score BETWEEN 1 AND 10),
      sentiment TEXT,
      needs_human_help INTEGER DEFAULT 0,
      summary TEXT,
      last_updated INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      to_number TEXT,
      text TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_ts INTEGER,
      rating INTEGER CHECK(rating IN (-1, 1)),
      comment TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_chat ON registrations(chat_id);
  `);

  // Columns added after the first release (idempotent).
  const cols = db.prepare(`PRAGMA table_info(contacts)`).all().map((c) => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE contacts ADD COLUMN ${ddl}`); };
  try {
    add('wa_name', 'wa_name TEXT');
    add('on_whatsapp', 'on_whatsapp INTEGER DEFAULT 1');
    add('registered', 'registered INTEGER DEFAULT 0');
    add('source', "source TEXT DEFAULT 'import'");
    // Imported contacts stay silent until they actually write in.
    db.exec(`UPDATE contacts SET auto_reply_mode = 'OFF' WHERE auto_reply_mode = 'AUTO' AND phone_number NOT IN (SELECT DISTINCT chat_id FROM messages)`);
  } catch (err) {
    logger.error('BotDB', `Migration failed: ${err.message}`);
  }

  initMemoryTable(db);
  const memStmts = prepareMemoryStmts(db);

  const nameMerge = `name = CASE WHEN excluded.name = '' THEN contacts.name ELSE excluded.name END`;
  const stmts = {
    upsertContact: db.prepare(`INSERT INTO contacts (phone_number, name, source, on_whatsapp) VALUES (?, ?, 'import', 1) ON CONFLICT(phone_number) DO UPDATE SET ${nameMerge}`),
    upsertContactBatch: db.prepare(`INSERT INTO contacts (phone_number, name) VALUES (@phone, @name) ON CONFLICT(phone_number) DO UPDATE SET ${nameMerge}`),
    upsertContactFromChat: db.prepare(`INSERT INTO contacts (phone_number, name, source, on_whatsapp, auto_reply_mode) VALUES (?, ?, 'chat', 1, 'AUTO') ON CONFLICT(phone_number) DO UPDATE SET ${nameMerge}`),
    getContact: db.prepare(`SELECT * FROM contacts WHERE phone_number = ?`),
    getAllContacts: db.prepare(`SELECT * FROM contacts ORDER BY name ASC, phone_number ASC`),
    getChattedContacts: db.prepare(`SELECT c.*, MAX(m.timestamp) AS last_message_ts FROM contacts c JOIN messages m ON m.chat_id = c.phone_number GROUP BY c.phone_number ORDER BY last_message_ts DESC, c.name ASC`),
    setContactMode: db.prepare(`UPDATE contacts SET auto_reply_mode = ? WHERE phone_number = ?`),
    setOnWhatsapp: db.prepare(`UPDATE contacts SET on_whatsapp = ? WHERE phone_number = ?`),
    setWaName: db.prepare(`UPDATE contacts SET wa_name = ?, name = CASE WHEN ? = '' THEN name ELSE ? END WHERE phone_number = ?`),

    insertRegistration: db.prepare(`INSERT INTO registrations (chat_id, submitted_name, status) VALUES (?, ?, 'PENDING') ON CONFLICT(chat_id) DO UPDATE SET submitted_name = excluded.submitted_name, status = 'PENDING'`),
    getPendingRegistrations: db.prepare(`SELECT * FROM registrations WHERE status = 'PENDING' ORDER BY created_at ASC`),
    getRegistration: db.prepare(`SELECT * FROM registrations WHERE chat_id = ?`),
    approveRegistration: db.prepare(`UPDATE registrations SET status = 'APPROVED' WHERE chat_id = ?`),
    rejectRegistration: db.prepare(`UPDATE registrations SET status = 'REJECTED' WHERE chat_id = ?`),
    registerContact: db.prepare(`UPDATE contacts SET registered = 1 WHERE phone_number = ?`),

    insertMessage: db.prepare(`INSERT INTO messages (chat_id, sender, text, is_ai) VALUES (?, ?, ?, ?)`),
    getRecentMessages: db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 50`),
    getContactMessages: db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`),

    insertTask: db.prepare(`INSERT INTO tasks (chat_id, task_description, urgency) VALUES (?, ?, ?)`),
    getOpenTasks: db.prepare(`SELECT * FROM tasks WHERE status = 'PENDING' ORDER BY CASE urgency WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`),
    getAllTasks: db.prepare(`SELECT * FROM tasks ORDER BY CASE urgency WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`),
    completeTask: db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`),

    upsertEvaluation: db.prepare(`INSERT OR REPLACE INTO evaluations (chat_id, resolution_score, sentiment, needs_human_help, summary, last_updated) VALUES (?, ?, ?, ?, ?, unixepoch())`),
    resolveEvaluation: db.prepare(`UPDATE evaluations SET needs_human_help = 0, last_updated = unixepoch() WHERE chat_id = ?`),
    getEvaluation: db.prepare(`SELECT * FROM evaluations WHERE chat_id = ?`),
    getAllEvaluations: db.prepare(`SELECT * FROM evaluations ORDER BY last_updated DESC`),

    insertDraft: db.prepare(`INSERT INTO drafts (chat_id, to_number, text) VALUES (?, ?, ?)`),
    getDraftsByChat: db.prepare(`SELECT * FROM drafts WHERE chat_id = ? ORDER BY created_at DESC`),
    getDraftById: db.prepare(`SELECT * FROM drafts WHERE id = ?`),
    deleteDraft: db.prepare(`DELETE FROM drafts WHERE id = ?`),

    insertFeedback: db.prepare(`INSERT INTO feedback (chat_id, message_ts, rating, comment) VALUES (?, ?, ?, ?)`),
    getFeedbackStats: db.prepare(`SELECT chat_id, COUNT(*) AS count, SUM(rating) AS total, AVG(rating) AS avg_rating FROM feedback GROUP BY chat_id`),

    stats: {
      contacts: db.prepare(`SELECT COUNT(*) AS n FROM contacts`),
      messages: db.prepare(`SELECT COUNT(*) AS n FROM messages`),
      aiMessages: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE is_ai = 1`),
      openTasks: db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'PENDING'`),
      doneTasks: db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'DONE'`),
      needsHelp: db.prepare(`SELECT COUNT(*) AS n FROM evaluations WHERE needs_human_help = 1`),
      volume: db.prepare(`SELECT date(timestamp, 'unixepoch') AS day, COUNT(*) AS messages, SUM(is_ai) AS ai FROM messages GROUP BY day ORDER BY day DESC LIMIT 14`),
      sentiment: db.prepare(`SELECT sentiment, COUNT(*) AS n FROM evaluations GROUP BY sentiment`),
      modes: db.prepare(`SELECT auto_reply_mode AS mode, COUNT(*) AS n FROM contacts GROUP BY auto_reply_mode`),
      avgScore: db.prepare(`SELECT AVG(resolution_score) AS avg FROM evaluations`),
    },
  };

  // Removes a contact and everything stored about them.
  const deleteContactCascade = db.transaction((id) => {
    for (const table of ['messages', 'evaluations', 'tasks', 'drafts', 'feedback', 'registrations', 'conversations']) {
      db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).run(id);
    }
    db.prepare(`DELETE FROM contacts WHERE phone_number = ?`).run(id);
  });

  return { db, stmts, memStmts, deleteContactCascade };
}

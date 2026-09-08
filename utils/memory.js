import logger from './logger.js';

const MOD = 'Memory';
const SUMMARY_INTERVAL = 10;

export function initMemoryTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      chat_id TEXT PRIMARY KEY,
      summary TEXT,
      key_topics TEXT,
      last_msg_count INTEGER DEFAULT 0,
      last_updated INTEGER DEFAULT (unixepoch())
    );
  `);
  logger.info(MOD, 'Conversations table initialized');
}

export function prepareMemoryStmts(db) {
  return {
    getConversation: db.prepare(`SELECT * FROM conversations WHERE chat_id = ?`),
    upsertConversation: db.prepare(`
      INSERT INTO conversations (chat_id, summary, key_topics, last_msg_count, last_updated)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(chat_id) DO UPDATE SET
        summary = excluded.summary,
        key_topics = excluded.key_topics,
        last_msg_count = excluded.last_msg_count,
        last_updated = unixepoch()
    `),
    getAllConversations: db.prepare(`SELECT * FROM conversations ORDER BY last_updated DESC`),
  };
}

export function buildMemoryContext(chatId, stmts) {
  const row = stmts.getConversation.get(chatId);
  if (!row || !row.summary) return null;
  return {
    role: 'system',
    content: `Memory of past conversations with this user:\n${row.summary}\n${row.key_topics ? 'Key topics: ' + row.key_topics : ''}\nReference this naturally. Do not mention that you have memory — just continue naturally as if you remember.`,
  };
}

export async function updateMemory(chatId, stmts, callOllama, db) {
  try {
    const messages = db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 30`).all(chatId);
    if (messages.length < 3) return;
    const transcript = messages.map((m) => `${m.sender}: ${m.text}`).join('\n').slice(-2000);
    const raw = await callOllama([{
      role: 'user',
      content: `Summarize this conversation in 2-3 short sentences. Include: what they discussed, any decisions made, any pending topics. Return ONLY the summary text, no labels.\n\nConversation:\n${transcript}`,
    }], 1);
    const summary = raw?.trim() || '';
    if (!summary) return;
    const topics = summary.split('.')[0]?.slice(0, 200) || '';
    stmts.upsertConversation.run(chatId, summary, topics, messages.length);
    logger.info(MOD, `Memory updated for ${chatId}`, { summaryLen: summary.length });
  } catch (err) {
    logger.error(MOD, `Memory update failed for ${chatId}`, { error: err.message });
  }
}

export function maybeUpdateMemory(chatId, stmts, callOllama, db) {
  const row = stmts.getConversation.get(chatId);
  const lastCount = row?.last_msg_count || 0;
  const current = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`).get(chatId)?.n || 0;
  if (current - lastCount >= SUMMARY_INTERVAL) {
    updateMemory(chatId, stmts, callOllama, db);
    return true;
  }
  return false;
}

export function getMemoryStats(stmts) {
  return stmts.getAllConversations.all();
}

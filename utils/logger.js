import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toUpperCase() || 'DEBUG'];
const DEV_MODE = process.env.NODE_ENV !== 'production';

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function writeLine(level, module, msg) {
  const ts = formatDate(new Date());
  const line = `[${ts}] [${level}] [${module}] ${msg}`;
  if (DEV_MODE) {
    const colors = { DEBUG: '\x1b[90m', INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m' };
    console.log(`${colors[level] || ''}${line}\x1b[0m`);
  }
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function formatObj(obj) {
  try { return JSON.stringify(obj).slice(0, 500); } catch { return String(obj); }
}

const logger = {
  debug(mod, msg, data) {
    if (MIN_LEVEL > LEVELS.DEBUG) return;
    const extra = data !== undefined ? ' | ' + formatObj(data) : '';
    writeLine('DEBUG', mod, msg + extra);
  },
  info(mod, msg, data) {
    if (MIN_LEVEL > LEVELS.INFO) return;
    const extra = data !== undefined ? ' | ' + formatObj(data) : '';
    writeLine('INFO', mod, msg + extra);
  },
  warn(mod, msg, data) {
    if (MIN_LEVEL > LEVELS.WARN) return;
    const extra = data !== undefined ? ' | ' + formatObj(data) : '';
    writeLine('WARN', mod, msg + extra);
  },
  error(mod, msg, data) {
    if (MIN_LEVEL > LEVELS.ERROR) return;
    const extra = data !== undefined ? ' | ' + formatObj(data) : '';
    writeLine('ERROR', mod, msg + extra);
  },
};

export default logger;

// Small structured logger.
// - Always writes to stdout/stderr (what Docker, systemd and PaaS hosts collect).
// - Colours only when attached to a terminal.
// - LOG_LEVEL: debug | info | warn | error (default: info in production, debug otherwise).
// - LOG_FILE: optional path to also append every line to.
import fs from 'fs';
import path from 'path';

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const PROD = process.env.NODE_ENV === 'production';
const MIN = LEVELS[(process.env.LOG_LEVEL || (PROD ? 'info' : 'debug')).toUpperCase()] ?? LEVELS.INFO;
const COLORS = { DEBUG: '\x1b[90m', INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m' };
const TTY = process.stdout.isTTY;

let fileStream = null;
if (process.env.LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(process.env.LOG_FILE), { recursive: true });
    fileStream = fs.createWriteStream(process.env.LOG_FILE, { flags: 'a' });
  } catch (err) {
    process.stderr.write(`[logger] cannot open LOG_FILE: ${err.message}\n`);
  }
}

function fmt(data) {
  if (data === undefined) return '';
  try { return ' | ' + JSON.stringify(data).slice(0, 500); } catch { return ' | ' + String(data); }
}

function write(level, mod, msg, data) {
  if (LEVELS[level] < MIN) return;
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${mod}] ${msg}${fmt(data)}`;
  const out = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
  out.write((TTY ? `${COLORS[level]}${line}\x1b[0m` : line) + '\n');
  fileStream?.write(line + '\n');
}

const logger = {
  debug: (mod, msg, data) => write('DEBUG', mod, msg, data),
  info: (mod, msg, data) => write('INFO', mod, msg, data),
  warn: (mod, msg, data) => write('WARN', mod, msg, data),
  error: (mod, msg, data) => write('ERROR', mod, msg, data),
};

export default logger;

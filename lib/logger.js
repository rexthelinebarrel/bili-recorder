const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'app.log');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  _write(level, msg) {
    const line = `[${timestamp()}] ${level} ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_PATH, line + '\n', 'utf-8'); } catch {}
  },
  info(msg) { this._write('INFO', msg); },
  warn(msg) { this._write('WARN', msg); },
  error(msg) { this._write('ERROR', msg); }
};

module.exports = logger;

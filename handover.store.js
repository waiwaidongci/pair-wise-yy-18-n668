const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

const SLIP_STATUS = {
  ACTIVE: '有效',
  RETURNED: '已交回',
  VOID: '失效'
};

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runSql(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return execFileSync('sqlite3', [DB_FILE], {
    input: sql,
    encoding: 'utf8'
  });
}

function select(sql) {
  const output = runSql('.mode json\n' + sql);
  if (!output.trim()) return [];
  return JSON.parse(output);
}

function now() {
  return new Date().toISOString();
}

function initHandoverDb() {
  runSql(`
CREATE TABLE IF NOT EXISTS handover_slips (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL,
  show_time TEXT,
  play TEXT,
  box_no TEXT NOT NULL,
  status TEXT NOT NULL,
  heads TEXT NOT NULL DEFAULT '[]',
  accessories TEXT NOT NULL DEFAULT '[]',
  damages TEXT NOT NULL DEFAULT '[]',
  replacements TEXT NOT NULL DEFAULT '[]',
  actor TEXT,
  note TEXT,
  idempotency_key TEXT,
  supersedes TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  returned_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_slips_box ON handover_slips(box_no, status);
CREATE INDEX IF NOT EXISTS idx_slips_show ON handover_slips(show_id, status);
CREATE TABLE IF NOT EXISTS handover_receipts (
  endpoint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (endpoint, idempotency_key)
);
`);
}

function rowToSlip(row) {
  return {
    id: row.id,
    showId: row.show_id,
    showTime: row.show_time || '',
    play: row.play || '',
    boxNo: row.box_no,
    status: row.status,
    heads: JSON.parse(row.heads || '[]'),
    accessories: JSON.parse(row.accessories || '[]'),
    damages: JSON.parse(row.damages || '[]'),
    replacements: JSON.parse(row.replacements || '[]'),
    actor: row.actor || '',
    note: row.note || '',
    idempotencyKey: row.idempotency_key || '',
    supersedes: row.supersedes || null,
    voidReason: row.void_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    returnedAt: row.returned_at || null
  };
}

function insertSlip(slip) {
  const id = slip.id || randomUUID();
  const createdAt = now();
  runSql(
    'INSERT INTO handover_slips (id, show_id, show_time, play, box_no, status, heads, accessories, damages, replacements, actor, note, idempotency_key, supersedes, void_reason, created_at, updated_at, returned_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(slip.showId),
      sqlValue(slip.showTime || ''),
      sqlValue(slip.play || ''),
      sqlValue(slip.boxNo),
      sqlValue(slip.status),
      sqlValue(JSON.stringify(slip.heads || [])),
      sqlValue(JSON.stringify(slip.accessories || [])),
      sqlValue(JSON.stringify(slip.damages || [])),
      sqlValue(JSON.stringify(slip.replacements || [])),
      sqlValue(slip.actor || ''),
      sqlValue(slip.note || ''),
      sqlValue(slip.idempotencyKey || ''),
      sqlValue(slip.supersedes || null),
      sqlValue(slip.voidReason || null),
      sqlValue(createdAt),
      sqlValue(createdAt),
      sqlValue(slip.returnedAt || null)
    ].join(', ') +
    ');'
  );
  return getSlip(id);
}

function updateSlip(slip) {
  runSql(
    'UPDATE handover_slips SET status = ' + sqlValue(slip.status) +
    ', show_time = ' + sqlValue(slip.showTime || '') +
    ', heads = ' + sqlValue(JSON.stringify(slip.heads || [])) +
    ', accessories = ' + sqlValue(JSON.stringify(slip.accessories || [])) +
    ', damages = ' + sqlValue(JSON.stringify(slip.damages || [])) +
    ', replacements = ' + sqlValue(JSON.stringify(slip.replacements || [])) +
    ', void_reason = ' + sqlValue(slip.voidReason || null) +
    ', returned_at = ' + sqlValue(slip.returnedAt || null) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE id = ' + sqlValue(slip.id) + ';'
  );
  return getSlip(slip.id);
}

function getSlip(id) {
  const rows = select('SELECT * FROM handover_slips WHERE id = ' + sqlValue(id) + ' LIMIT 1;');
  return rows[0] ? rowToSlip(rows[0]) : null;
}

function listSlips(filters) {
  const clauses = [];
  if (filters.showId) clauses.push('show_id = ' + sqlValue(filters.showId));
  if (filters.boxNo) clauses.push('box_no = ' + sqlValue(filters.boxNo));
  if (filters.status) clauses.push('status = ' + sqlValue(filters.status));
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  return select('SELECT * FROM handover_slips' + where + ' ORDER BY created_at DESC, rowid DESC;').map(rowToSlip);
}

function findActiveSlipByBox(boxNo) {
  const rows = select(
    'SELECT * FROM handover_slips WHERE box_no = ' + sqlValue(boxNo) +
    ' AND status = ' + sqlValue(SLIP_STATUS.ACTIVE) +
    ' ORDER BY rowid DESC LIMIT 1;'
  );
  return rows[0] ? rowToSlip(rows[0]) : null;
}

function findActiveSlipsByShow(showId) {
  return select(
    'SELECT * FROM handover_slips WHERE show_id = ' + sqlValue(showId) +
    ' AND status = ' + sqlValue(SLIP_STATUS.ACTIVE) +
    ' ORDER BY rowid ASC;'
  ).map(rowToSlip);
}

function findLatestSlipByShowAndBox(showId, boxNo) {
  const rows = select(
    'SELECT * FROM handover_slips WHERE show_id = ' + sqlValue(showId) +
    ' AND box_no = ' + sqlValue(boxNo) +
    ' ORDER BY rowid DESC LIMIT 1;'
  );
  return rows[0] ? rowToSlip(rows[0]) : null;
}

function findActiveSlipsWithHead(headId) {
  return select('SELECT * FROM handover_slips WHERE status = ' + sqlValue(SLIP_STATUS.ACTIVE) + ';')
    .map(rowToSlip)
    .filter((slip) => slip.heads.includes(headId));
}

function getPuppetHead(id) {
  const rows = select(
    "SELECT * FROM records WHERE collection = 'puppetHeads' AND id = " + sqlValue(id) + ' LIMIT 1;'
  );
  if (!rows[0]) return null;
  const data = JSON.parse(rows[0].data || '{}');
  return { id: rows[0].id, ...data, status: rows[0].status };
}

function setPuppetHeadStatus(id, status) {
  const rows = select(
    "SELECT * FROM records WHERE collection = 'puppetHeads' AND id = " + sqlValue(id) + ' LIMIT 1;'
  );
  if (!rows[0]) return null;
  const data = JSON.parse(rows[0].data || '{}');
  data.status = status;
  runSql(
    'UPDATE records SET status = ' + sqlValue(status) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    " WHERE collection = 'puppetHeads' AND id = " + sqlValue(id) + ';'
  );
  return getPuppetHead(id);
}

function getReceipt(endpoint, key) {
  const rows = select(
    'SELECT * FROM handover_receipts WHERE endpoint = ' + sqlValue(endpoint) +
    ' AND idempotency_key = ' + sqlValue(key) + ' LIMIT 1;'
  );
  if (!rows[0]) return null;
  return {
    statusCode: rows[0].status_code,
    body: JSON.parse(rows[0].body),
    createdAt: rows[0].created_at
  };
}

function saveReceipt(endpoint, key, statusCode, body) {
  runSql(
    'INSERT OR IGNORE INTO handover_receipts (endpoint, idempotency_key, status_code, body, created_at) VALUES (' +
    [
      sqlValue(endpoint),
      sqlValue(key),
      sqlValue(statusCode),
      sqlValue(JSON.stringify(body)),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

initHandoverDb();

module.exports = {
  SLIP_STATUS,
  now,
  insertSlip,
  updateSlip,
  getSlip,
  listSlips,
  findActiveSlipByBox,
  findActiveSlipsByShow,
  findLatestSlipByShowAndBox,
  findActiveSlipsWithHead,
  getPuppetHead,
  setPuppetHeadStatus,
  getReceipt,
  saveReceipt
};

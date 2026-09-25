// 交接单存取层：巡演场次、交接单、裂损待检报告、补件记录的 SQLite 持久化。
// 只负责读写，不做业务判定；多步写入统一走 execTx 保证同批落库或同批不写。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const SHIM = path.join(__dirname, '..', '..', 'scripts', 'sqlite3');

function resolveSqlite3Bin() {
  if (process.env.SQLITE3_BIN) return process.env.SQLITE3_BIN;
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'pipe' });
    return 'sqlite3';
  } catch (error) {
    return SHIM;
  }
}

const SQLITE3_BIN = resolveSqlite3Bin();

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runSql(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return execFileSync(SQLITE3_BIN, [DB_FILE], {
    input: sql,
    encoding: 'utf8'
  });
}

function select(sql) {
  const output = runSql('.mode json\n' + sql);
  if (!output.trim()) return [];
  return JSON.parse(output);
}

// 同一进程内同步执行，BEGIN IMMEDIATE 保证一批语句要么全写要么全不写。
function execTx(statements) {
  runSql('BEGIN IMMEDIATE;\n' + statements.join('\n') + '\nCOMMIT;');
}

function now() {
  return new Date().toISOString();
}

function initStore() {
  runSql(`
CREATE TABLE IF NOT EXISTS tour_sessions (
  id TEXT PRIMARY KEY,
  show_name TEXT,
  play TEXT,
  venue TEXT,
  start_time TEXT,
  box_no TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handover_slips (
  id TEXT PRIMARY KEY,
  slip_no TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_time TEXT,
  box_no TEXT NOT NULL,
  type TEXT NOT NULL,
  pair_id TEXT,
  item_ids TEXT NOT NULL DEFAULT '[]',
  actor TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT '有效',
  supersedes TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slips_session ON handover_slips(session_id);
CREATE INDEX IF NOT EXISTS idx_slips_box ON handover_slips(box_no);
CREATE INDEX IF NOT EXISTS idx_slips_status ON handover_slips(status);
CREATE TABLE IF NOT EXISTS damage_reports (
  id TEXT PRIMARY KEY,
  head_id TEXT NOT NULL,
  session_id TEXT,
  box_no TEXT,
  problem TEXT,
  actor TEXT,
  status TEXT NOT NULL DEFAULT '待检',
  replacement_head_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replacements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  box_no TEXT,
  damaged_head_id TEXT NOT NULL,
  replacement_head_id TEXT NOT NULL,
  actor TEXT,
  status TEXT NOT NULL DEFAULT '有效',
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  receipt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
}

initStore();

// ---------- 行映射 ----------

function rowToSession(row) {
  return {
    id: row.id,
    showName: row.show_name,
    play: row.play,
    venue: row.venue,
    startTime: row.start_time,
    boxNo: row.box_no,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToSlip(row) {
  return {
    id: row.id,
    slipNo: row.slip_no,
    sessionId: row.session_id,
    sessionTime: row.session_time,
    boxNo: row.box_no,
    type: row.type,
    pairId: row.pair_id,
    itemIds: JSON.parse(row.item_ids || '[]'),
    actor: row.actor,
    note: row.note,
    status: row.status,
    supersedes: row.supersedes,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  };
}

function rowToDamageReport(row) {
  return {
    id: row.id,
    headId: row.head_id,
    sessionId: row.session_id,
    boxNo: row.box_no,
    problem: row.problem,
    actor: row.actor,
    status: row.status,
    replacementHeadId: row.replacement_head_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  };
}

function rowToReplacement(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    boxNo: row.box_no,
    damagedHeadId: row.damaged_head_id,
    replacementHeadId: row.replacement_head_id,
    actor: row.actor,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  };
}

function rowToHead(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

// ---------- 语句构造 ----------

function insertSessionStmt(session) {
  return 'INSERT INTO tour_sessions (id, show_name, play, venue, start_time, box_no, created_at, updated_at) VALUES (' +
    [
      sqlValue(session.id),
      sqlValue(session.showName || ''),
      sqlValue(session.play || ''),
      sqlValue(session.venue || ''),
      sqlValue(session.startTime || null),
      sqlValue(session.boxNo || null),
      sqlValue(session.createdAt),
      sqlValue(session.updatedAt || session.createdAt)
    ].join(', ') + ');';
}

function updateSessionStmt(id, fields) {
  const sets = [];
  if (fields.showName !== undefined) sets.push('show_name = ' + sqlValue(fields.showName));
  if (fields.play !== undefined) sets.push('play = ' + sqlValue(fields.play));
  if (fields.venue !== undefined) sets.push('venue = ' + sqlValue(fields.venue));
  if (fields.startTime !== undefined) sets.push('start_time = ' + sqlValue(fields.startTime));
  if (fields.boxNo !== undefined) sets.push('box_no = ' + sqlValue(fields.boxNo));
  sets.push('updated_at = ' + sqlValue(now()));
  return 'UPDATE tour_sessions SET ' + sets.join(', ') + ' WHERE id = ' + sqlValue(id) + ';';
}

function insertSlipStmt(slip) {
  return 'INSERT INTO handover_slips (id, slip_no, session_id, session_time, box_no, type, pair_id, item_ids, actor, note, status, supersedes, idempotency_key, created_at) VALUES (' +
    [
      sqlValue(slip.id),
      sqlValue(slip.slipNo),
      sqlValue(slip.sessionId),
      sqlValue(slip.sessionTime || null),
      sqlValue(slip.boxNo),
      sqlValue(slip.type),
      sqlValue(slip.pairId || null),
      sqlValue(JSON.stringify(slip.itemIds || [])),
      sqlValue(slip.actor || ''),
      sqlValue(slip.note || ''),
      sqlValue(slip.status || '有效'),
      sqlValue(slip.supersedes || null),
      sqlValue(slip.idempotencyKey || null),
      sqlValue(slip.createdAt)
    ].join(', ') + ');';
}

function invalidateSessionSlipsStmt(sessionId, reason) {
  return 'UPDATE handover_slips SET status = ' + sqlValue('已失效') +
    ', note = note || ' + sqlValue('（' + reason + '）') +
    ' WHERE session_id = ' + sqlValue(sessionId) + ' AND status = ' + sqlValue('有效') + ';';
}

function insertDamageReportStmt(report) {
  return 'INSERT INTO damage_reports (id, head_id, session_id, box_no, problem, actor, status, replacement_head_id, idempotency_key, created_at) VALUES (' +
    [
      sqlValue(report.id),
      sqlValue(report.headId),
      sqlValue(report.sessionId || null),
      sqlValue(report.boxNo || null),
      sqlValue(report.problem || ''),
      sqlValue(report.actor || ''),
      sqlValue(report.status || '待检'),
      sqlValue(report.replacementHeadId || null),
      sqlValue(report.idempotencyKey || null),
      sqlValue(report.createdAt)
    ].join(', ') + ');';
}

function closeDamageReportStmt(reportId, replacementHeadId) {
  return 'UPDATE damage_reports SET status = ' + sqlValue('已补件') +
    ', replacement_head_id = ' + sqlValue(replacementHeadId) +
    ' WHERE id = ' + sqlValue(reportId) + ';';
}

function insertReplacementStmt(replacement) {
  return 'INSERT INTO replacements (id, session_id, box_no, damaged_head_id, replacement_head_id, actor, status, idempotency_key, created_at) VALUES (' +
    [
      sqlValue(replacement.id),
      sqlValue(replacement.sessionId),
      sqlValue(replacement.boxNo || null),
      sqlValue(replacement.damagedHeadId),
      sqlValue(replacement.replacementHeadId),
      sqlValue(replacement.actor || ''),
      sqlValue(replacement.status || '有效'),
      sqlValue(replacement.idempotencyKey || null),
      sqlValue(replacement.createdAt)
    ].join(', ') + ');';
}

function insertReceiptStmt(key, receipt) {
  return 'INSERT INTO idempotency_keys (key, receipt, created_at) VALUES (' +
    [sqlValue(key), sqlValue(JSON.stringify(receipt)), sqlValue(now())].join(', ') + ');';
}

function updateHeadStatusStmt(headId, status, data) {
  return 'UPDATE records SET status = ' + sqlValue(status) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue('puppetHeads') + ' AND id = ' + sqlValue(headId) + ';';
}

function insertHeadEventStmt(headId, action, status, actor, note, data) {
  return 'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(require('crypto').randomUUID()),
      sqlValue(headId),
      sqlValue('puppetHeads'),
      sqlValue(action),
      sqlValue(status),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') + ');';
}

// ---------- 场次 ----------

function insertSession(session) {
  execTx([insertSessionStmt(session)]);
  return getSession(session.id);
}

function getSession(id) {
  const rows = select('SELECT * FROM tour_sessions WHERE id = ' + sqlValue(id) + ' LIMIT 1;');
  return rows[0] ? rowToSession(rows[0]) : null;
}

function listSessions() {
  return select('SELECT * FROM tour_sessions ORDER BY created_at ASC;').map(rowToSession);
}

function updateSession(id, fields) {
  execTx([updateSessionStmt(id, fields)]);
  return getSession(id);
}

// 场次时间或箱号变更：更新场次、作废旧单、写入重新占位的新单，同一事务完成。
function applySessionChange({ sessionId, updates, invalidateReason, newSlips }) {
  const statements = [updateSessionStmt(sessionId, updates)];
  statements.push(invalidateSessionSlipsStmt(sessionId, invalidateReason));
  for (const slip of newSlips || []) statements.push(insertSlipStmt(slip));
  execTx(statements);
  return getSession(sessionId);
}

// ---------- 交接单 ----------

function getSlip(id) {
  const rows = select('SELECT * FROM handover_slips WHERE id = ' + sqlValue(id) + ' LIMIT 1;');
  return rows[0] ? rowToSlip(rows[0]) : null;
}

function listSlips(filter = {}) {
  const where = [];
  if (filter.sessionId) where.push('session_id = ' + sqlValue(filter.sessionId));
  if (filter.boxNo) where.push('box_no = ' + sqlValue(filter.boxNo));
  if (filter.status) where.push('status = ' + sqlValue(filter.status));
  if (filter.type) where.push('type = ' + sqlValue(filter.type));
  const sql = 'SELECT * FROM handover_slips' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC, rowid DESC;';
  return select(sql).map(rowToSlip);
}

// 判定层用：有效单按时间正序取出，用于重放占用状态。
function listActiveSlipsAsc() {
  return select(
    'SELECT * FROM handover_slips WHERE status = ' + sqlValue('有效') +
    ' ORDER BY created_at ASC, rowid ASC;'
  ).map(rowToSlip);
}

// 领取落库：可同时带上场次建档/补登箱号语句，与回执同一事务。
function recordPickup({ slip, sessionInsert, sessionBoxAdopt, receiptKey, receipt }) {
  const statements = [];
  if (sessionInsert) statements.push(insertSessionStmt(sessionInsert));
  if (sessionBoxAdopt) {
    statements.push(
      'UPDATE tour_sessions SET box_no = ' + sqlValue(sessionBoxAdopt.boxNo) +
      ', updated_at = ' + sqlValue(now()) +
      ' WHERE id = ' + sqlValue(sessionBoxAdopt.id) + ' AND box_no IS NULL;'
    );
  }
  statements.push(insertSlipStmt(slip));
  if (receiptKey) statements.push(insertReceiptStmt(receiptKey, receipt));
  execTx(statements);
}

// 交回落库：交回单与随单发现的裂损待检同一事务。
function recordReturn({ slip, damageReports, receiptKey, receipt }) {
  const statements = [insertSlipStmt(slip)];
  for (const item of damageReports || []) {
    statements.push(insertDamageReportStmt(item.report));
    statements.push(updateHeadStatusStmt(item.report.headId, '待检', item.headData));
    statements.push(insertHeadEventStmt(item.report.headId, '裂损待检', '待检', item.report.actor, item.report.problem, { reportId: item.report.id }));
  }
  if (receiptKey) statements.push(insertReceiptStmt(receiptKey, receipt));
  execTx(statements);
}

// 跨场交接落库：交出方的交回单与接收方的领取单成对写入，要么都写要么都不写。
function recordTransfer({ returnSlip, pickupSlip, toSessionInsert, toSessionBoxAdopt, receiptKey, receipt }) {
  const statements = [];
  if (toSessionInsert) statements.push(insertSessionStmt(toSessionInsert));
  if (toSessionBoxAdopt) {
    statements.push(
      'UPDATE tour_sessions SET box_no = ' + sqlValue(toSessionBoxAdopt.boxNo) +
      ', updated_at = ' + sqlValue(now()) +
      ' WHERE id = ' + sqlValue(toSessionBoxAdopt.id) + ' AND box_no IS NULL;'
    );
  }
  statements.push(insertSlipStmt(returnSlip));
  statements.push(insertSlipStmt(pickupSlip));
  if (receiptKey) statements.push(insertReceiptStmt(receiptKey, receipt));
  execTx(statements);
}

// ---------- 裂损待检与补件 ----------

function recordDamage({ report, headData, receiptKey, receipt }) {
  const statements = [
    insertDamageReportStmt(report),
    updateHeadStatusStmt(report.headId, '待检', headData),
    insertHeadEventStmt(report.headId, '裂损待检', '待检', report.actor, report.problem, { reportId: report.id })
  ];
  if (receiptKey) statements.push(insertReceiptStmt(receiptKey, receipt));
  execTx(statements);
}

function getDamageReport(id) {
  const rows = select('SELECT * FROM damage_reports WHERE id = ' + sqlValue(id) + ' LIMIT 1;');
  return rows[0] ? rowToDamageReport(rows[0]) : null;
}

function findOpenDamageReport(headId) {
  const rows = select(
    'SELECT * FROM damage_reports WHERE head_id = ' + sqlValue(headId) +
    ' AND status = ' + sqlValue('待检') + ' ORDER BY created_at DESC LIMIT 1;'
  );
  return rows[0] ? rowToDamageReport(rows[0]) : null;
}

function listDamageReports(filter = {}) {
  const where = [];
  if (filter.sessionId) where.push('session_id = ' + sqlValue(filter.sessionId));
  if (filter.status) where.push('status = ' + sqlValue(filter.status));
  const sql = 'SELECT * FROM damage_reports' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC;';
  return select(sql).map(rowToDamageReport);
}

function recordReplacement({ replacement, closeReportId, receiptKey, receipt }) {
  const statements = [insertReplacementStmt(replacement)];
  if (closeReportId) statements.push(closeDamageReportStmt(closeReportId, replacement.replacementHeadId));
  if (receiptKey) statements.push(insertReceiptStmt(receiptKey, receipt));
  execTx(statements);
}

function listActiveReplacements() {
  return select(
    'SELECT * FROM replacements WHERE status = ' + sqlValue('有效') + ' ORDER BY created_at ASC;'
  ).map(rowToReplacement);
}

// ---------- 偶头档案（records 表只读 + 状态改写） ----------

function getPuppetHead(id) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue('puppetHeads') +
    ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return rows[0] ? rowToHead(rows[0]) : null;
}

function listPuppetHeads() {
  return select(
    'SELECT * FROM records WHERE collection = ' + sqlValue('puppetHeads') + ' ORDER BY updated_at DESC;'
  ).map(rowToHead);
}

// ---------- 幂等回执 ----------

function findReceipt(key) {
  const rows = select('SELECT * FROM idempotency_keys WHERE key = ' + sqlValue(key) + ' LIMIT 1;');
  return rows[0] ? JSON.parse(rows[0].receipt) : null;
}

module.exports = {
  now,
  insertSession,
  getSession,
  listSessions,
  updateSession,
  applySessionChange,
  getSlip,
  listSlips,
  listActiveSlipsAsc,
  recordPickup,
  recordReturn,
  recordTransfer,
  recordDamage,
  getDamageReport,
  findOpenDamageReport,
  listDamageReports,
  recordReplacement,
  listActiveReplacements,
  getPuppetHead,
  listPuppetHeads,
  findReceipt
};

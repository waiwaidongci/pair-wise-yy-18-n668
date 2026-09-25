// 交接单路由层：HTTP 入参校验、幂等回执、调用判定层与存取层。
const express = require('express');
const { randomUUID } = require('crypto');
const store = require('./store');
const rules = require('./rules');

const router = express.Router();

function newSlipNo() {
  return 'HD-' + randomUUID().slice(0, 13).toUpperCase();
}

function newReceiptNo() {
  return 'RC-' + randomUUID().slice(0, 13).toUpperCase();
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === '');
  if (missing.length) throw rules.badRequest('缺少必填字段: ' + missing.join(', '));
}

function normalizeItemIds(body) {
  if (body.itemIds === undefined || body.itemIds === null) return [];
  if (!Array.isArray(body.itemIds)) throw rules.badRequest('itemIds 必须是数组');
  return body.itemIds.map(String);
}

// 重复投递沿用第一次回执：命中幂等键直接返回首次回执，不再执行写入。
function replayIfSeen(idempotencyKey, res) {
  if (!idempotencyKey) return false;
  const receipt = store.findReceipt(String(idempotencyKey));
  if (!receipt) return false;
  res.status(200).json(receipt);
  return true;
}

function occupancyNow() {
  return rules.computeOccupancy(store.listActiveSlipsAsc(), store.listActiveReplacements());
}

// 场次建档/补登箱号：领取或交接时场次不存在则按请求建档，已建档但箱号不符则 409。
function ensureSession(sessionId, boxNo, extra = {}) {
  const existing = store.getSession(sessionId);
  if (existing) {
    if (existing.boxNo && boxNo && existing.boxNo !== boxNo) {
      throw rules.conflict('场次' + sessionId + '登记箱号为' + existing.boxNo + '，与请求箱号' + boxNo + '不符', {
        sessionId,
        boxNo: existing.boxNo
      });
    }
    return { session: existing, insert: null, adopt: existing.boxNo || !boxNo ? null : { id: sessionId, boxNo } };
  }
  const createdAt = store.now();
  const session = {
    id: sessionId,
    showName: extra.showName || '',
    play: extra.play || '',
    venue: extra.venue || '',
    startTime: extra.startTime || null,
    boxNo: boxNo || null,
    createdAt,
    updatedAt: createdAt
  };
  return { session, insert: session, adopt: null };
}

// ---------- 场次 ----------

router.post('/sessions', (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['id', 'boxNo']);
    if (store.getSession(body.id)) throw rules.conflict('场次' + body.id + '已存在', { sessionId: body.id });
    const createdAt = store.now();
    const session = {
      id: String(body.id),
      showName: body.showName || '',
      play: body.play || '',
      venue: body.venue || '',
      startTime: body.startTime || null,
      boxNo: body.boxNo,
      createdAt,
      updatedAt: createdAt
    };
    res.status(201).json(store.insertSession(session));
  } catch (error) {
    next(error);
  }
});

router.get('/sessions', (req, res, next) => {
  try {
    res.json(store.listSessions());
  } catch (error) {
    next(error);
  }
});

router.get('/sessions/:id', (req, res, next) => {
  try {
    const session = store.getSession(req.params.id);
    if (!session) throw rules.notFound('场次不存在: ' + req.params.id);
    res.json(session);
  } catch (error) {
    next(error);
  }
});

router.get('/sessions/:id/slips', (req, res, next) => {
  try {
    const session = store.getSession(req.params.id);
    if (!session) throw rules.notFound('场次不存在: ' + req.params.id);
    res.json(store.listSlips({ sessionId: session.id }));
  } catch (error) {
    next(error);
  }
});

// 改动场次时间或箱号：原交接单一律失效（旧单只读留档），仍持有的共用件按新场次信息重新占位。
router.patch('/sessions/:id', (req, res, next) => {
  try {
    const session = store.getSession(req.params.id);
    if (!session) throw rules.notFound('场次不存在: ' + req.params.id);
    const body = req.body || {};
    const changes = {};
    for (const field of ['showName', 'play', 'venue', 'startTime', 'boxNo']) {
      if (body[field] !== undefined) changes[field] = body[field];
    }
    const plan = rules.planSessionChange({ session, changes, occupancy: occupancyNow() });
    if (!plan.changed) {
      return res.json({ session: store.updateSession(session.id, changes), invalidatedSlips: [], reoccupancy: null });
    }
    const activeSlips = store.listSlips({ sessionId: session.id, status: '有效' });
    let reoccupancy = null;
    if (plan.reoccupy) {
      const lastPickup = activeSlips.filter((slip) => slip.type === '领取')[0];
      reoccupancy = {
        id: randomUUID(),
        slipNo: newSlipNo(),
        sessionId: session.id,
        sessionTime: plan.reoccupy.startTime,
        boxNo: plan.reoccupy.boxNo,
        type: '领取',
        pairId: null,
        itemIds: plan.reoccupy.itemIds,
        actor: body.actor || '',
        note: '场次时间或箱号变更，重新占位',
        status: '有效',
        supersedes: lastPickup ? lastPickup.id : null,
        idempotencyKey: null,
        createdAt: store.now()
      };
    }
    const updated = store.applySessionChange({
      sessionId: session.id,
      updates: changes,
      invalidateReason: '场次时间或箱号变更，原交接失效',
      newSlips: reoccupancy ? [reoccupancy] : []
    });
    res.json({
      session: updated,
      invalidatedSlips: activeSlips.map((slip) => ({ ...slip, status: '已失效' })),
      reoccupancy
    });
  } catch (error) {
    next(error);
  }
});

// ---------- 交接单 ----------

// 领取：跨场共用件尚未交回交接区时返回 409，一张单都不写。
router.post('/handovers/pickup', (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['sessionId', 'boxNo']);
    if (replayIfSeen(body.idempotencyKey, res)) return;
    const itemIds = normalizeItemIds(body);
    const ensured = ensureSession(String(body.sessionId), String(body.boxNo), body);
    rules.checkPickup({
      occupancy: occupancyNow(),
      sessionId: ensured.session.id,
      boxNo: String(body.boxNo),
      itemIds
    });
    const slip = {
      id: randomUUID(),
      slipNo: newSlipNo(),
      sessionId: ensured.session.id,
      sessionTime: ensured.session.startTime,
      boxNo: String(body.boxNo),
      type: '领取',
      pairId: null,
      itemIds,
      actor: body.actor || '',
      note: body.note || '',
      status: '有效',
      supersedes: null,
      idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
      createdAt: store.now()
    };
    const receipt = { receiptNo: newReceiptNo(), slip };
    store.recordPickup({
      slip,
      sessionInsert: ensured.insert,
      sessionBoxAdopt: ensured.adopt,
      receiptKey: slip.idempotencyKey,
      receipt
    });
    res.status(201).json(receipt);
  } catch (error) {
    next(error);
  }
});

// 交回：写交回单；随单可上报裂损偶头，一并转待检。
router.post('/handovers/return', (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['sessionId', 'boxNo']);
    if (replayIfSeen(body.idempotencyKey, res)) return;
    const itemIds = normalizeItemIds(body);
    const sessionId = String(body.sessionId);
    const boxNo = String(body.boxNo);
    const itemsToReturn = rules.checkReturn({ occupancy: occupancyNow(), sessionId, boxNo, itemIds });
    const session = store.getSession(sessionId);
    const damages = [];
    for (const damage of body.damages || []) {
      if (!damage.headId) throw rules.badRequest('damages 中的 headId 必填');
      const head = store.getPuppetHead(String(damage.headId));
      if (!head) throw rules.notFound('偶头不存在: ' + damage.headId);
      const report = {
        id: randomUUID(),
        headId: head.id,
        sessionId,
        boxNo,
        problem: damage.problem || '裂损',
        actor: body.actor || '',
        status: '待检',
        replacementHeadId: null,
        idempotencyKey: null,
        createdAt: store.now()
      };
      const headData = { ...head, status: '待检', currentUsable: false };
      delete headData.id;
      delete headData.collection;
      delete headData.createdAt;
      delete headData.updatedAt;
      damages.push({ report, headData });
    }
    const slip = {
      id: randomUUID(),
      slipNo: newSlipNo(),
      sessionId,
      sessionTime: session ? session.startTime : null,
      boxNo,
      type: '交回',
      pairId: null,
      itemIds: itemsToReturn,
      actor: body.actor || '',
      note: body.note || '',
      status: '有效',
      supersedes: null,
      idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
      createdAt: store.now()
    };
    const receipt = { receiptNo: newReceiptNo(), slip, damages: damages.map((item) => item.report) };
    store.recordReturn({
      slip,
      damageReports: damages,
      receiptKey: slip.idempotencyKey,
      receipt
    });
    res.status(201).json(receipt);
  } catch (error) {
    next(error);
  }
});

// 跨场交接：交出方交回单与接收方领取单成对写入；共用件尚未交回交接区时 409，两张单都不写。
router.post('/handovers/transfer', (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['fromSessionId', 'toSessionId', 'boxNo']);
    if (replayIfSeen(body.idempotencyKey, res)) return;
    const itemIds = normalizeItemIds(body);
    const fromSessionId = String(body.fromSessionId);
    const toSessionId = String(body.toSessionId);
    const boxNo = String(body.boxNo);
    const fromSession = store.getSession(fromSessionId);
    if (!fromSession) throw rules.notFound('交出方场次不存在: ' + fromSessionId);
    const ensured = ensureSession(toSessionId, boxNo, body);
    const items = rules.checkTransfer({
      occupancy: occupancyNow(),
      fromSessionId,
      toSessionId,
      boxNo,
      itemIds
    });
    const pairId = randomUUID();
    const createdAt = store.now();
    const base = {
      boxNo,
      itemIds: items,
      actor: body.actor || '',
      note: body.note || '',
      status: '有效',
      supersedes: null,
      idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
      createdAt
    };
    const returnSlip = {
      ...base,
      id: randomUUID(),
      slipNo: newSlipNo(),
      sessionId: fromSessionId,
      sessionTime: fromSession.startTime,
      type: '交回',
      pairId
    };
    const pickupSlip = {
      ...base,
      id: randomUUID(),
      slipNo: newSlipNo(),
      sessionId: toSessionId,
      sessionTime: ensured.session.startTime,
      type: '领取',
      pairId
    };
    const receipt = { receiptNo: newReceiptNo(), slips: { return: returnSlip, pickup: pickupSlip } };
    store.recordTransfer({
      returnSlip,
      pickupSlip,
      toSessionInsert: ensured.insert,
      toSessionBoxAdopt: ensured.adopt,
      receiptKey: base.idempotencyKey,
      receipt
    });
    res.status(201).json(receipt);
  } catch (error) {
    next(error);
  }
});

// 交接区看板：每只木箱谁在持有、哪些共用件还在外，一眼看清可领用状态。
router.get('/handovers/board', (req, res, next) => {
  try {
    const occupancy = occupancyNow();
    const boxNos = new Set(Object.keys(occupancy.boxes));
    for (const session of store.listSessions()) {
      if (session.boxNo) boxNos.add(session.boxNo);
    }
    const boxes = [...boxNos].sort().map((boxNo) => {
      const box = occupancy.boxes[boxNo];
      return {
        boxNo,
        state: box && box.holder ? '在外' : '在交接区',
        holder: box ? box.holder : null,
        heldItems: box ? box.items : []
      };
    });
    const items = Object.entries(occupancy.items)
      .map(([itemId, holder]) => ({ itemId, holder }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId));
    res.json({ boxes, items, generatedAt: store.now() });
  } catch (error) {
    next(error);
  }
});

router.get('/handovers', (req, res, next) => {
  try {
    res.json(store.listSlips({
      sessionId: req.query.sessionId,
      boxNo: req.query.boxNo,
      status: req.query.status,
      type: req.query.type
    }));
  } catch (error) {
    next(error);
  }
});

router.get('/handovers/:id', (req, res, next) => {
  try {
    const slip = store.getSlip(req.params.id);
    if (!slip) throw rules.notFound('交接单不存在: ' + req.params.id);
    res.json(slip);
  } catch (error) {
    next(error);
  }
});

// 裂损上报：偶头转待检，并给出同剧目同角色且未被占用的候选补件。
router.post('/handovers/damage', (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['headId']);
    if (replayIfSeen(body.idempotencyKey, res)) return;
    const head = store.getPuppetHead(String(body.headId));
    if (!head) throw rules.notFound('偶头不存在: ' + body.headId);
    const sessionId = body.sessionId ? String(body.sessionId) : null;
    const occupancy = occupancyNow();
    const candidates = rules.candidateReplacements({
      heads: store.listPuppetHeads(),
      damaged: head,
      occupancy,
      sessionId
    });
    const report = {
      id: randomUUID(),
      headId: head.id,
      sessionId,
      boxNo: body.boxNo ? String(body.boxNo) : null,
      problem: body.problem || '裂损',
      actor: body.actor || '',
      status: '待检',
      replacementHeadId: null,
      idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
      createdAt: store.now()
    };
    const headData = { ...head, status: '待检', currentUsable: false };
    delete headData.id;
    delete headData.collection;
    delete headData.createdAt;
    delete headData.updatedAt;
    const receipt = {
      receiptNo: newReceiptNo(),
      report,
      head: { ...head, status: '待检', currentUsable: false },
      candidates
    };
    store.recordDamage({ report, headData, receiptKey: report.idempotencyKey, receipt });
    res.status(201).json(receipt);
  } catch (error) {
    next(error);
  }
});

// 补件：须与损件同剧目同角色，且未被其他场次占用。
router.post('/handovers/replacement', (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['damagedHeadId', 'replacementHeadId', 'sessionId']);
    if (replayIfSeen(body.idempotencyKey, res)) return;
    const sessionId = String(body.sessionId);
    const damaged = store.getPuppetHead(String(body.damagedHeadId));
    const replacementHead = store.getPuppetHead(String(body.replacementHeadId));
    rules.checkReplacement({
      damaged,
      replacement: replacementHead,
      occupancy: occupancyNow(),
      sessionId
    });
    const replacement = {
      id: randomUUID(),
      sessionId,
      boxNo: body.boxNo ? String(body.boxNo) : null,
      damagedHeadId: damaged.id,
      replacementHeadId: replacementHead.id,
      actor: body.actor || '',
      status: '有效',
      idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
      createdAt: store.now()
    };
    let report = body.damageReportId
      ? store.getDamageReport(String(body.damageReportId))
      : store.findOpenDamageReport(damaged.id);
    if (body.damageReportId && !report) throw rules.notFound('裂损报告不存在: ' + body.damageReportId);
    const receipt = { receiptNo: newReceiptNo(), replacement };
    store.recordReplacement({
      replacement,
      closeReportId: report ? report.id : null,
      receiptKey: replacement.idempotencyKey,
      receipt
    });
    if (report) report = store.getDamageReport(report.id);
    res.status(201).json({ ...receipt, damageReport: report || null });
  } catch (error) {
    next(error);
  }
});

router.get('/damage-reports', (req, res, next) => {
  try {
    res.json(store.listDamageReports({ sessionId: req.query.sessionId, status: req.query.status }));
  } catch (error) {
    next(error);
  }
});

// 路由级错误处理：附带判定细节（持有人、箱号等），与主应用错误格式保持一致。
router.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error', ...(error.details || {}) });
});

module.exports = router;

const { randomUUID } = require('crypto');
const store = require('./handover.store');

const SLIP = store.SLIP_STATUS;

// 裂损待检及修补中的偶头不可用作补件
const UNUSABLE_HEAD_STATUS = ['待检', '待修补', '修补中', '不可演出'];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function normalizeBoxes(input) {
  const raw = input.boxes || input.boxNos || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => (typeof item === 'string' ? { boxNo: item } : item || {}));
}

// 领取：按场次占位木箱。跨场共用件未交回交接区时整批 409，一张单都不写入
function claim(input) {
  const showId = input.showId;
  if (!showId) fail(400, '缺少场次 showId');
  const boxes = normalizeBoxes(input);
  if (!boxes.length) fail(400, '缺少箱号 boxes');

  const seen = new Set();
  const prepared = boxes.map((box, index) => {
    const boxNo = box.boxNo;
    if (!boxNo) fail(400, '第 ' + (index + 1) + ' 项缺少箱号 boxNo');
    if (seen.has(boxNo)) fail(400, '同一批内箱号重复: ' + boxNo);
    seen.add(boxNo);
    const heads = box.heads || box.headIds || [];
    const accessories = box.accessories || box.accessoryIds || [];
    const occupying = store.findActiveSlipByBox(boxNo);
    if (occupying) {
      fail(409, '木箱 ' + boxNo + ' 尚未交回交接区（场次 ' + occupying.showId + ' 占用中），本批交接单均未写入');
    }
    for (const headId of heads) {
      if (!store.getPuppetHead(headId)) fail(404, '偶头不存在: ' + headId);
      const holders = store.findActiveSlipsWithHead(headId);
      if (holders.length) {
        fail(409, '偶头 ' + headId + ' 尚未交回交接区（场次 ' + holders[0].showId + ' 占用中），本批交接单均未写入');
      }
    }
    return { boxNo, heads, accessories };
  });

  const slips = prepared.map((box) =>
    store.insertSlip({
      id: randomUUID(),
      showId,
      showTime: input.showTime || '',
      play: input.play || '',
      boxNo: box.boxNo,
      status: SLIP.ACTIVE,
      heads: box.heads,
      accessories: box.accessories,
      damages: [],
      replacements: [],
      actor: input.actor || '',
      note: input.note || '',
      idempotencyKey: input.idempotencyKey || ''
    })
  );
  return { slips };
}

// 交回：木箱回交接区，占位释放；登记的裂损偶头转待检
function returnBoxes(input) {
  const showId = input.showId;
  if (!showId) fail(400, '缺少场次 showId');
  const boxNos = normalizeBoxes(input).map((box) => box.boxNo).filter(Boolean);
  if (!boxNos.length) fail(400, '缺少箱号 boxNos');
  const damages = input.damages || [];
  for (const damage of damages) {
    if (!damage.headId) fail(400, '缺损登记缺少 headId');
    if (!store.getPuppetHead(damage.headId)) fail(404, '偶头不存在: ' + damage.headId);
  }

  const slips = boxNos.map((boxNo) => {
    const slip = store.findLatestSlipByShowAndBox(showId, boxNo);
    if (!slip) fail(404, '场次 ' + showId + ' 没有箱号 ' + boxNo + ' 的交接单');
    if (slip.status === SLIP.VOID) fail(409, '箱号 ' + boxNo + ' 的原交接单已失效（旧单只读），请按新单交回');
    if (slip.status === SLIP.RETURNED) fail(409, '箱号 ' + boxNo + ' 已交回交接区，没有待交回的交接单');
    return slip;
  });

  const at = store.now();
  const updated = slips.map((slip, index) => {
    const own = damages.filter((damage) => slip.heads.includes(damage.headId));
    const unassigned = index === 0
      ? damages.filter((damage) => !slips.some((item) => item.heads.includes(damage.headId)))
      : [];
    slip.status = SLIP.RETURNED;
    slip.returnedAt = at;
    slip.damages = slip.damages.concat(
      own.concat(unassigned).map((damage) => ({
        headId: damage.headId,
        problem: damage.problem || '裂损',
        actor: input.actor || '',
        at
      }))
    );
    return store.updateSlip(slip);
  });
  for (const damage of damages) {
    store.setPuppetHeadStatus(damage.headId, '待检');
  }
  return { slips: updated };
}

// 补件：替换损件。须同剧目同角色，且补件未被其他场次占用
function replaceHead(input) {
  const { showId, damagedHeadId, replacementHeadId } = input;
  if (!showId || !damagedHeadId || !replacementHeadId) {
    fail(400, '缺少 showId / damagedHeadId / replacementHeadId');
  }
  if (damagedHeadId === replacementHeadId) fail(400, '补件不能与损件相同');
  const damaged = store.getPuppetHead(damagedHeadId);
  if (!damaged) fail(404, '损件偶头不存在: ' + damagedHeadId);
  const replacement = store.getPuppetHead(replacementHeadId);
  if (!replacement) fail(404, '补件偶头不存在: ' + replacementHeadId);
  if (damaged.play !== replacement.play || damaged.role !== replacement.role) {
    fail(
      400,
      '补件须与损件同剧目同角色（损件 ' + (damaged.play || '?') + '/' + (damaged.role || '?') +
      '，补件 ' + (replacement.play || '?') + '/' + (replacement.role || '?') + '）'
    );
  }
  if (UNUSABLE_HEAD_STATUS.includes(replacement.status)) {
    fail(409, '补件偶头状态为「' + replacement.status + '」，不可用作补件');
  }
  const holders = store.findActiveSlipsWithHead(replacementHeadId).filter((slip) => slip.showId !== showId);
  if (holders.length) {
    fail(409, '补件 ' + replacementHeadId + ' 已被场次 ' + holders[0].showId + ' 占用');
  }
  const slip = store.findActiveSlipsByShow(showId).find((item) => item.heads.includes(damagedHeadId));
  if (!slip) fail(409, '场次 ' + showId + ' 的有效交接单中未找到损件 ' + damagedHeadId);

  slip.heads = slip.heads.map((headId) => (headId === damagedHeadId ? replacementHeadId : headId));
  slip.replacements = slip.replacements.concat([
    {
      damagedHeadId,
      replacementHeadId,
      actor: input.actor || '',
      note: input.note || '',
      at: store.now()
    }
  ]);
  store.updateSlip(slip);
  store.setPuppetHeadStatus(damagedHeadId, '待检');
  return { slip: store.getSlip(slip.id), damagedHeadId, replacementHeadId };
}

// 改动场次时间或箱号：原交接单失效（旧单只读），按新时间/新箱号重新占位
function reviseShow(input) {
  const showId = input.showId;
  if (!showId) fail(400, '缺少场次 showId');
  const boxChanges = input.boxChanges || [];
  if (!input.showTime && !boxChanges.length) fail(400, '没有改动：需提供 showTime 或 boxChanges');
  const actives = store.findActiveSlipsByShow(showId);
  if (!actives.length) fail(404, '场次 ' + showId + ' 没有有效交接单（旧单只读，不可改动）');

  const changeMap = new Map();
  for (const change of boxChanges) {
    if (!change.from || !change.to) fail(400, 'boxChanges 每项需要 from 和 to');
    if (change.from === change.to) fail(400, '箱号未变化: ' + change.from);
    changeMap.set(change.from, change.to);
  }
  for (const from of changeMap.keys()) {
    if (!actives.some((slip) => slip.boxNo === from)) {
      fail(404, '场次 ' + showId + ' 没有箱号 ' + from + ' 的有效交接单');
    }
  }

  const plan = actives.map((slip) => {
    const toBox = changeMap.get(slip.boxNo) || slip.boxNo;
    const toTime = input.showTime || slip.showTime;
    return { slip, toBox, toTime, boxChanged: toBox !== slip.boxNo, timeChanged: toTime !== slip.showTime };
  });
  if (plan.every((item) => !item.boxChanged && !item.timeChanged)) fail(400, '没有实际改动');

  const targets = new Set();
  for (const item of plan) {
    if (targets.has(item.toBox)) fail(400, '改动后箱号重复: ' + item.toBox);
    targets.add(item.toBox);
  }
  for (const item of plan) {
    if (!item.boxChanged) continue;
    const occupying = store.findActiveSlipByBox(item.toBox);
    if (!occupying) continue;
    if (occupying.showId !== showId) {
      fail(409, '木箱 ' + item.toBox + ' 尚未交回交接区（场次 ' + occupying.showId + ' 占用中），改动未写入');
    }
    const own = plan.find((other) => other.slip.id === occupying.id);
    if (!own || !own.boxChanged) fail(409, '木箱 ' + item.toBox + ' 仍被本场次另一张有效交接单占用');
  }

  const voided = [];
  const slips = [];
  for (const item of plan) {
    item.slip.status = SLIP.VOID;
    item.slip.voidReason = item.boxChanged ? '换箱' : '改期';
    voided.push(store.updateSlip(item.slip));
    slips.push(
      store.insertSlip({
        id: randomUUID(),
        showId,
        showTime: item.toTime,
        play: item.slip.play,
        boxNo: item.toBox,
        status: SLIP.ACTIVE,
        heads: item.slip.heads,
        accessories: item.slip.accessories,
        damages: item.slip.damages,
        replacements: item.slip.replacements,
        actor: input.actor || item.slip.actor,
        note: input.note || '',
        idempotencyKey: input.idempotencyKey || '',
        supersedes: item.slip.id
      })
    );
  }
  return { voided, slips };
}

function getSlip(id) {
  const slip = store.getSlip(id);
  if (!slip) fail(404, '交接单不存在: ' + id);
  return slip;
}

function listSlips(query) {
  return store.listSlips({
    showId: query.showId,
    boxNo: query.boxNo,
    status: query.status
  });
}

module.exports = {
  claim,
  returnBoxes,
  replaceHead,
  reviseShow,
  getSlip,
  listSlips
};

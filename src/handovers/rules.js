// 交接单判定层：纯业务规则，不直接读写数据库。
// 输入由路由层从存取层取好，输出为判定结果或带 status 的错误。

function makeError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function badRequest(message) {
  return makeError(400, message);
}

function notFound(message) {
  return makeError(404, message);
}

function conflict(message, details) {
  return makeError(409, message, details);
}

function unprocessable(message, details) {
  return makeError(422, message, details);
}

// 由有效交接单重放当前占用：木箱被谁持有、跨场共用件被哪个场次占用。
// 已失效的旧单不参与判定（旧单只读，仅留档）。
function computeOccupancy(activeSlipsAsc, activeReplacements) {
  const boxes = {};
  const items = {};
  for (const slip of activeSlipsAsc) {
    if (slip.type === '领取') {
      boxes[slip.boxNo] = { holder: slip.sessionId, items: [...slip.itemIds] };
      for (const itemId of slip.itemIds) items[itemId] = slip.sessionId;
    } else if (slip.type === '交回') {
      const box = boxes[slip.boxNo];
      if (!box || box.holder !== slip.sessionId) continue;
      const returned = slip.itemIds.length ? slip.itemIds : box.items;
      box.items = box.items.filter((itemId) => !returned.includes(itemId));
      for (const itemId of returned) {
        if (items[itemId] === slip.sessionId) delete items[itemId];
      }
      if (!box.items.length) box.holder = null;
    }
  }
  for (const replacement of activeReplacements || []) {
    items[replacement.replacementHeadId] = replacement.sessionId;
  }
  return { boxes, items };
}

// 领取判定：木箱或共用件尚未交回交接区时报 409，调用方保证一张单都不写。
function checkPickup({ occupancy, sessionId, boxNo, itemIds }) {
  const box = occupancy.boxes[boxNo];
  if (box && box.holder) {
    if (box.holder === sessionId) {
      throw conflict('木箱' + boxNo + '已由场次' + sessionId + '领取，请勿重复领取', {
        boxNo,
        holder: box.holder
      });
    }
    throw conflict('木箱' + boxNo + '的跨场共用件尚未交回交接区，暂不能领取', {
      boxNo,
      holder: box.holder
    });
  }
  for (const itemId of itemIds || []) {
    const holder = occupancy.items[itemId];
    if (holder && holder !== sessionId) {
      throw conflict('跨场共用件' + itemId + '尚未交回交接区，暂不能领取', {
        itemId,
        holder
      });
    }
    if (holder === sessionId) {
      throw conflict('跨场共用件' + itemId + '已在场次' + sessionId + '名下', {
        itemId,
        holder
      });
    }
  }
}

// 交回判定：必须有本人未交回的领取记录，返回本次应交的共用件清单。
function checkReturn({ occupancy, sessionId, boxNo, itemIds }) {
  const box = occupancy.boxes[boxNo];
  if (!box || !box.holder) {
    throw conflict('木箱' + boxNo + '没有未交回的领取记录', { boxNo });
  }
  if (box.holder !== sessionId) {
    throw conflict('木箱' + boxNo + '由场次' + box.holder + '领取，场次' + sessionId + '无权交回', {
      boxNo,
      holder: box.holder
    });
  }
  const itemsToReturn = itemIds && itemIds.length ? itemIds : box.items;
  for (const itemId of itemsToReturn) {
    if (!box.items.includes(itemId)) {
      throw conflict('共用件' + itemId + '不在场次' + sessionId + '的持有清单中', {
        itemId,
        holder: box.holder
      });
    }
  }
  return itemsToReturn;
}

// 跨场交接判定：共用件还在别人手里（未交回交接区）时报 409，两张单都不写。
// 判定通过时返回本次交接的共用件清单。
function checkTransfer({ occupancy, fromSessionId, toSessionId, boxNo, itemIds }) {
  if (fromSessionId === toSessionId) {
    throw badRequest('交出方与接收方不能是同一场次');
  }
  const box = occupancy.boxes[boxNo];
  if (!box || !box.holder) {
    throw conflict('木箱' + boxNo + '的共用件已在交接区，无需交接，请直接领取', { boxNo });
  }
  if (box.holder !== fromSessionId) {
    throw conflict('木箱' + boxNo + '的跨场共用件尚未交回交接区，无法交接给场次' + toSessionId, {
      boxNo,
      holder: box.holder
    });
  }
  const items = itemIds && itemIds.length ? itemIds : box.items;
  for (const itemId of items) {
    if (!box.items.includes(itemId)) {
      throw conflict('共用件' + itemId + '不在场次' + fromSessionId + '的持有清单中', {
        itemId,
        holder: box.holder
      });
    }
    const holder = occupancy.items[itemId];
    if (holder && holder !== fromSessionId) {
      throw conflict('跨场共用件' + itemId + '尚未交回交接区，无法交接', {
        itemId,
        holder
      });
    }
  }
  return items;
}

// 补件判定：须与损件同剧目同角色，且未被其他场次占用。
function checkReplacement({ damaged, replacement, occupancy, sessionId }) {
  if (!damaged) throw notFound('损件偶头不存在');
  if (!replacement) throw notFound('补件偶头不存在');
  if (damaged.id === replacement.id) {
    throw unprocessable('补件不能是损件本身');
  }
  if (damaged.play !== replacement.play || damaged.role !== replacement.role) {
    throw unprocessable(
      '补件须与损件同剧目同角色（损件：' + damaged.play + '/' + damaged.role +
      '，补件：' + replacement.play + '/' + replacement.role + '）',
      { damagedHeadId: damaged.id, replacementHeadId: replacement.id }
    );
  }
  const holder = occupancy.items[replacement.id];
  if (holder && holder !== sessionId) {
    throw conflict('补件' + replacement.id + '已被场次' + holder + '占用', {
      replacementHeadId: replacement.id,
      holder
    });
  }
}

// 候选补件：同剧目同角色、未被其他场次占用的偶头。
function candidateReplacements({ heads, damaged, occupancy, sessionId }) {
  return heads.filter((head) => {
    if (head.id === damaged.id) return false;
    if (head.play !== damaged.play || head.role !== damaged.role) return false;
    const holder = occupancy.items[head.id];
    return !holder || holder === sessionId;
  });
}

// 场次变更判定：时间或箱号变化时，旧交接全部失效；若仍持有共用件则按新时间/箱号重新占位。
// 目标箱被其他场次占用时整体报 409，变更不落库。
function planSessionChange({ session, changes, occupancy }) {
  const timeChanged = changes.startTime !== undefined && changes.startTime !== session.startTime;
  const boxChanged = changes.boxNo !== undefined && changes.boxNo !== session.boxNo;
  if (!timeChanged && !boxChanged) {
    return { changed: false, reoccupy: null };
  }
  const newBoxNo = boxChanged ? changes.boxNo : session.boxNo;
  const newStartTime = timeChanged ? changes.startTime : session.startTime;
  const heldBox = session.boxNo ? occupancy.boxes[session.boxNo] : null;
  const heldItems = heldBox && heldBox.holder === session.id ? heldBox.items : [];
  if (boxChanged && newBoxNo) {
    const target = occupancy.boxes[newBoxNo];
    if (target && target.holder && target.holder !== session.id) {
      throw conflict('木箱' + newBoxNo + '的跨场共用件尚未交回交接区，无法改派给场次' + session.id, {
        boxNo: newBoxNo,
        holder: target.holder
      });
    }
    for (const itemId of heldItems) {
      const holder = occupancy.items[itemId];
      if (holder && holder !== session.id) {
        throw conflict('共用件' + itemId + '已被场次' + holder + '占用，无法随场次改派', {
          itemId,
          holder
        });
      }
    }
  }
  return {
    changed: true,
    reoccupy: heldItems.length && newBoxNo
      ? { boxNo: newBoxNo, startTime: newStartTime, itemIds: [...heldItems] }
      : null
  };
}

module.exports = {
  badRequest,
  notFound,
  conflict,
  unprocessable,
  computeOccupancy,
  checkPickup,
  checkReturn,
  checkTransfer,
  checkReplacement,
  candidateReplacements,
  planSessionChange
};

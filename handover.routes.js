const express = require('express');
const service = require('./handover.service');
const store = require('./handover.store');

const router = express.Router();

// 重复投递沿用第一次回执：同一 idempotencyKey 直接返回首个成功响应，不再执行
function respond(endpoint, req, res, next, successStatus, handler) {
  try {
    const key = req.body && req.body.idempotencyKey;
    if (key) {
      const receipt = store.getReceipt(endpoint, key);
      if (receipt) {
        res.set('X-Idempotent-Replay', 'true');
        return res.status(receipt.statusCode).json(receipt.body);
      }
    }
    const body = handler();
    if (key) store.saveReceipt(endpoint, key, successStatus, body);
    res.status(successStatus).json(body);
  } catch (error) {
    next(error);
  }
}

router.post('/claim', (req, res, next) =>
  respond('claim', req, res, next, 201, () => service.claim(req.body || {}))
);

router.post('/return', (req, res, next) =>
  respond('return', req, res, next, 200, () => service.returnBoxes(req.body || {}))
);

router.post('/replace', (req, res, next) =>
  respond('replace', req, res, next, 200, () => service.replaceHead(req.body || {}))
);

router.post('/revise', (req, res, next) =>
  respond('revise', req, res, next, 201, () => service.reviseShow(req.body || {}))
);

router.get('/', (req, res, next) => {
  try {
    res.json(service.listSlips(req.query || {}));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    res.json(service.getSlip(req.params.id));
  } catch (error) {
    next(error);
  }
});

module.exports = router;

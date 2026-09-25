# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。若环境没有`sqlite3`命令行，会自动回退到`scripts/sqlite3`（python3实现），也可用`SQLITE3_BIN`指定。

## 巡演交接单（按场次+箱号）

路由、判定、存取分别在 `src/handovers/routes.js`、`rules.js`、`store.js`。

- `POST /api/sessions` 建场次（`id`、`boxNo` 必填，可带 `startTime`）
- `PATCH /api/sessions/:id` 改动场次时间或箱号：原交接单一律失效（旧单只读留档），仍持有的共用件按新信息重新占位；目标箱被占用时整体 409
- `POST /api/handovers/pickup` 领取（`sessionId`、`boxNo`、`itemIds`）；共用件尚未交回交接区时返回 409，一张单都不写
- `POST /api/handovers/return` 交回；可随单传 `damages:[{headId,problem}]`，裂损偶头一并转待检
- `POST /api/handovers/transfer` 跨场交接（`fromSessionId`、`toSessionId`、`boxNo`）：交回单与领取单成对写入，冲突时 409 两张单都不写
- `POST /api/handovers/damage` 裂损上报：偶头转待检并返回同剧目同角色的候选补件
- `POST /api/handovers/replacement` 补件：须与损件同剧目同角色，且未被其他场次占用（否则 422/409）
- `GET /api/handovers/board` 交接区看板：各箱谁在持有、哪些共用件还在外
- `GET /api/handovers?sessionId=&boxNo=&status=&type=` 交接单查询（含已失效旧单）

写接口均支持 `idempotencyKey`：重复投递沿用第一次回执，不重复落单。

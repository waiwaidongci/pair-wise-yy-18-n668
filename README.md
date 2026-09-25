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

## 场次交接单（按场次 + 箱号）

- `POST /api/handovers/claim` 领取木箱：`{ showId, showTime, play, boxes: [{ boxNo, heads, accessories }], idempotencyKey }`。跨场共用件尚未交回交接区时整批返回 409，一张单都不写入。
- `POST /api/handovers/return` 交回交接区：`{ showId, boxNos, damages: [{ headId, problem }] }`。登记的裂损偶头自动转「待检」。
- `POST /api/handovers/replace` 补件：`{ showId, damagedHeadId, replacementHeadId }`。补件须与损件同剧目同角色，且未被其他场次占用。
- `POST /api/handovers/revise` 改动场次时间或箱号：`{ showId, showTime, boxChanges: [{ from, to }] }`。原交接单失效只读，新单重新占位。
- `GET /api/handovers?showId=&boxNo=&status=` 查看哪些已交回、哪些还能领用（`有效` / `已交回` / `失效`）。
- 重复投递：携带相同 `idempotencyKey` 的请求沿用第一次回执，不重复写单。

SQLite数据库文件会在首次启动时创建到`data/app.db`。

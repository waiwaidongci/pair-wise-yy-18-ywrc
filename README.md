# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 装箱与返场流程

箱单不再只存编号，装箱时会逐件核对物品，装箱、返场、结束全部连成一个有状态的流程。

### 1. 创建装箱单 `POST /api/tourBoxes`

请求体：

```json
{
  "showName": "泉州巡演",
  "venue": "泉州大剧院",
  "play": "火焰山",
  "headIds": ["head-1", "head-2"],
  "accessoryIds": ["acc-1"],
  "clientId": "可选-客户端幂等号",
  "actor": "装箱人",
  "note": ""
}
```

创建前先核对每件物品：

- 偶头必须是 `可演出` 且 `currentUsable` 不为 false；配件必须是 `在库`；
- 已装入其他**未返场箱单**（`已装箱`/`巡演中`）的物品视为占用；
- 物品不存在、同一箱单内重复装入，同样视为冲突。

只要存在任何冲突，返回 **409**，响应里逐项列出冲突（`itemType`、`itemId`、`reason`，占用冲突还带 `boxId/boxName/boxStatus`），**箱单不创建、物品状态不写入**。

全部可用时，在一个事务内把箱单和所有物品统一转为 `已装箱`，并在箱单上记录每件物品的装箱前状态（`priorStatus`）供返场恢复。

**幂等**：重复提交同一箱单不会再次改动物品状态。满足以下任一条件即判定为重复，直接返回原单（`200`，带 `idempotent: true`）：

- `clientId` 与某张已有箱单相同；
- 演出名、场馆、剧目与物品集合（与顺序无关）与一张**未闭环**箱单完全一致。

### 2. 返场清点 `POST /api/tourBoxes/:id/return`

上报每件物品的清点结果，支持两种写法：

```json
{
  "heads": { "head-1": "normal", "head-2": "repair" },
  "accessories": { "acc-1": "damage" }
}
```

```json
{
  "items": [
    { "itemType": "puppetHead", "itemId": "head-1", "outcome": "lost" }
  ]
}
```

`outcome` 支持 `normal/repair/damage/lost`（也接受中文"正常/需修补/缺损/遗失"）。未上报的物品按正常处理；不属于本箱单的物品返回 400。

处理结果：

- **正常**：物品恢复装箱前状态（偶头回 `可演出`、配件回 `在库`）；
- **需修补**：偶头转为 `待修补`（`currentUsable=false`）并生成一条 `repairRecords`；配件没有修补流转，转为 `缺损` 并生成 `lossReports`（问题=需修补）；
- **缺损**：偶头转为 `不可演出`、配件转为 `缺损`，生成 `lossReports`；
- **遗失**：偶头转为 `不可演出`、配件转为 `遗失`，生成 `lossReports`。

需修补/缺损/遗失的物品即"停止装箱"——再次装箱会因状态不对被 409 拦截。以上所有状态变更与追踪记录在同一事务内完成，箱单进入 `返场清点中`。重复提交返场为幂等操作，不会二次改动物品状态或重复生成记录。

### 3. 结束箱单 `POST /api/tourBoxes/:id/close`

箱单关联的修补记录全部 `已完成`、缺损追踪全部 `已补齐` 或 `确认为遗失` 后，才能闭环为 `已闭环`。否则返回 **409** 并在 `pending` 中列出未处理完的追踪记录。重复闭环为幂等操作。

闭环后箱单不再占用物品，恢复正常的物品可用于下一张箱单。

## 其他常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`（也可由返场自动生成）
- `POST /api/lossReports`（也可由返场自动生成）
- `POST /api/repairRecords/:id/events`、`POST /api/lossReports/:id/events`：推进/完结追踪记录
- `GET /api/:collection/:id/timeline`：查看装箱、返场等全部事件

SQLite数据库文件会在首次启动时创建到`data/app.db`。

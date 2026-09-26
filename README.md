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
- `POST /api/tourBoxes` 创建装箱单：先核对每件偶头/配件，已占用或状态不对返回 409 并列出冲突项（箱单与物品均不落库）；全部可用时统一转为已装箱。重复提交可带 `Idempotency-Key` 头，命中直接返回原箱单、不再改动物品状态
- `POST /api/tourBoxes/:id/return` 返场清点：正常物品恢复可演出/在库；需修补、缺损、遗失的生成修补记录或缺损追踪并停止装箱。重复提交不再改动物品状态
- `POST /api/tourBoxes/:id/close` 闭环箱单：返场产生的追踪记录全部处理完才允许结束，否则 409 列出未结项
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

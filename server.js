const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const config = require('./project.config');

const app = express();
const PORT = process.env.PORT || config.port;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

app.use(express.json({ limit: '2mb' }));

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

function toRecord(row) {
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

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function eventInsertSql({ recordId, collection, action, status, actor, note, data }) {
  return (
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function insertEvent(options) {
  runSql(eventInsertSql(options));
}

function initDb() {
  runSql(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
`);

  const count = select('SELECT COUNT(*) AS count FROM records;')[0].count;
  if (count > 0) return;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(seed.collection),
        sqlValue(status),
        sqlValue(titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(seed.updatedAt || createdAt)
      ].join(', ') +
      ');'
    );
    insertEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
}

function loadRecord(collection, id) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function recordUpdateSql(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  return (
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(titleFor(collectionConfig, data)) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function saveRecord(collection, id, data, status) {
  runSql(recordUpdateSql(collection, id, data, status));
}

function recordInsertSql(collection, id, data, createdAt) {
  const collectionConfig = findCollection(collection);
  const status = data.status || collectionConfig.defaultStatus || '';
  return (
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(titleFor(collectionConfig, data)),
      sqlValue(JSON.stringify(data)),
      sqlValue(createdAt),
      sqlValue(createdAt)
    ].join(', ') +
    ');'
  );
}

function listRecords(collection) {
  return select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' ORDER BY updated_at DESC;'
  ).map(toRecord);
}

function runTransaction(statements) {
  runSql('.bail on\nBEGIN IMMEDIATE;\n' + statements.join('\n') + '\nCOMMIT;');
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

initDb();

// ---------- 巡演装箱与返场工作流 ----------

const BOX_COLLECTION = 'tourBoxes';
const ITEM_COLLECTIONS = { puppetHead: 'puppetHeads', accessory: 'accessories' };
const PACKABLE_STATUS = { puppetHead: '可演出', accessory: '在库' };
const RETURN_CONDITIONS = {
  puppetHead: ['正常', '需修补', '缺损', '遗失'],
  accessory: ['正常', '缺损', '遗失']
};
const LOSS_REPORT_FINAL = ['已补齐', '确认为遗失'];

function toData(record) {
  const data = { ...record };
  delete data.id;
  delete data.collection;
  delete data.createdAt;
  delete data.updatedAt;
  return data;
}

function normalizeIds(value, field) {
  if (!Array.isArray(value)) {
    const error = new Error(field + ' 必须是物品编号数组');
    error.status = 400;
    throw error;
  }
  const ids = [];
  for (const raw of value) {
    const id = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!id) {
      const error = new Error(field + ' 含有无效编号');
      error.status = 400;
      throw error;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function itemTitle(itemType, record) {
  if (!record) return '';
  if (itemType === 'puppetHead') return [record.role, record.play].filter(Boolean).join(' / ');
  return [record.name, record.role].filter(Boolean).join(' / ');
}

function packConflict(itemType, id, record) {
  if (!record) {
    return { itemType, itemId: id, title: '', status: '', reason: '物品不存在' };
  }
  const title = itemTitle(itemType, record);
  if (record.status === '已装箱') {
    return {
      itemType,
      itemId: id,
      title,
      status: record.status,
      tourBoxId: record.currentBoxId || '',
      reason: '已在未返场的箱单中'
    };
  }
  if (record.status !== PACKABLE_STATUS[itemType]) {
    return {
      itemType,
      itemId: id,
      title,
      status: record.status,
      reason: '状态为「' + record.status + '」，需为「' + PACKABLE_STATUS[itemType] + '」'
    };
  }
  if (itemType === 'puppetHead' && record.currentUsable === false) {
    return { itemType, itemId: id, title, status: record.status, reason: '偶头当前不可用' };
  }
  return null;
}

function workflowGuard(collection, record, nextStatus) {
  if (!nextStatus || nextStatus === record.status) return null;
  if (collection === BOX_COLLECTION) {
    // 已装箱 -> 巡演中 不动物品，放行；其余状态只能走装箱、返场、闭环接口
    if (record.status === '已装箱' && nextStatus === '巡演中') return null;
    return '箱单状态请通过装箱、返场、闭环接口流转';
  }
  if (collection === 'puppetHeads' || collection === 'accessories') {
    if (nextStatus === '已装箱') return '物品只能通过箱单装箱';
    if (record.status === '已装箱') return '物品在未返场箱单中，返场后才能变更状态';
  }
  return null;
}

// 创建装箱单：先核对每件物品，任一不可用则整体不落库；全部可用统一转为已装箱
app.post('/api/tourBoxes', (req, res, next) => {
  try {
    const collectionConfig = findCollection(BOX_COLLECTION);
    const body = req.body || {};
    const actor = body.actor || '';
    const idempotencyKey = String(req.get('idempotency-key') || body.idempotencyKey || '').trim();

    // 幂等：同一箱单重复提交直接返回原单，不再改动物品状态
    if (idempotencyKey) {
      const existing = listRecords(BOX_COLLECTION).find((box) => box.idempotencyKey === idempotencyKey);
      if (existing) return res.json({ ...existing, idempotentReplay: true });
    }

    const headIds = normalizeIds(body.headIds, 'headIds');
    const accessoryIds = normalizeIds(body.accessoryIds, 'accessoryIds');
    if (!headIds.length && !accessoryIds.length) {
      return res.status(400).json({ error: '箱单至少包含一件物品' });
    }

    const data = { ...collectionConfig.defaults, ...body, headIds, accessoryIds };
    validate(collectionConfig, data);

    const items = [
      ...headIds.map((id) => ({ itemType: 'puppetHead', id })),
      ...accessoryIds.map((id) => ({ itemType: 'accessory', id }))
    ];
    const loaded = items.map((item) => ({ ...item, record: loadRecord(ITEM_COLLECTIONS[item.itemType], item.id) }));
    const conflicts = loaded.map((item) => packConflict(item.itemType, item.id, item.record)).filter(Boolean);
    if (conflicts.length) {
      return res.status(409).json({ error: '存在不可装箱的物品，箱单未创建', conflicts });
    }

    const boxId = randomUUID();
    const createdAt = now();
    const boxData = { ...data, status: '已装箱', packedAt: createdAt, packedBy: actor };
    delete boxData.action;
    delete boxData.note;
    if (idempotencyKey) boxData.idempotencyKey = idempotencyKey;

    const statements = [
      recordInsertSql(BOX_COLLECTION, boxId, boxData, createdAt),
      eventInsertSql({
        recordId: boxId,
        collection: BOX_COLLECTION,
        action: '创建装箱单',
        status: '已装箱',
        actor,
        note: body.note || '',
        data: { headIds, accessoryIds }
      })
    ];
    for (const item of loaded) {
      const collection = ITEM_COLLECTIONS[item.itemType];
      const nextData = { ...toData(item.record), status: '已装箱', currentBoxId: boxId };
      statements.push(recordUpdateSql(collection, item.id, nextData, '已装箱'));
      statements.push(
        eventInsertSql({
          recordId: item.id,
          collection,
          action: '装箱',
          status: '已装箱',
          actor,
          note: '装入箱单 ' + boxId,
          data: { tourBoxId: boxId }
        })
      );
    }
    runTransaction(statements);
    res.status(201).json(loadRecord(BOX_COLLECTION, boxId));
  } catch (error) {
    next(error);
  }
});

// 返场清点：正常物品恢复状态；需修补、缺损、遗失的生成追踪记录并停止装箱
app.post('/api/tourBoxes/:id/return', (req, res, next) => {
  try {
    const box = loadRecord(BOX_COLLECTION, req.params.id);
    if (!box) return res.status(404).json({ error: 'not found' });

    // 幂等：已返场的箱单重复提交不再改动物品状态
    if (box.status === '返场清点中' || box.status === '已闭环') {
      return res.json({
        box,
        alreadyReturned: true,
        tracking: { repairRecordIds: box.repairRecordIds || [], lossReportIds: box.lossReportIds || [] }
      });
    }
    if (box.status !== '已装箱' && box.status !== '巡演中') {
      return res.status(409).json({ error: '箱单状态为「' + box.status + '」，不能办理返场' });
    }

    const body = req.body || {};
    const actor = body.actor || '';
    const entries = Array.isArray(body.items) ? body.items : [];

    const boxItems = [
      ...(box.headIds || []).map((id) => ({ itemType: 'puppetHead', id })),
      ...(box.accessoryIds || []).map((id) => ({ itemType: 'accessory', id }))
    ];
    const entryByKey = new Map();
    for (const entry of entries) {
      const allowed = RETURN_CONDITIONS[entry.itemType];
      if (!allowed) return res.status(400).json({ error: '未知物品类型: ' + entry.itemType });
      if (!allowed.includes(entry.condition)) {
        return res.status(400).json({
          error: entry.itemType + ' 不支持的清点结果: ' + entry.condition + '（可选：' + allowed.join('、') + '）'
        });
      }
      const key = entry.itemType + ':' + entry.itemId;
      if (!boxItems.some((item) => item.itemType + ':' + item.id === key)) {
        return res.status(400).json({ error: '物品不在箱单中: ' + key });
      }
      entryByKey.set(key, entry);
    }

    const statements = [];
    const problems = [];
    const repairRecordIds = [];
    const lossReportIds = [];
    const returnItems = [];
    const timestamp = now();

    for (const item of boxItems) {
      const collection = ITEM_COLLECTIONS[item.itemType];
      const record = loadRecord(collection, item.id);
      const entry = entryByKey.get(item.itemType + ':' + item.id) || {};
      const condition = record ? entry.condition || '正常' : '遗失';
      const note = entry.note || '';
      returnItems.push({ itemType: item.itemType, itemId: item.id, condition });

      if (!record) {
        // 档案缺失：按遗失登记追踪
        const lossId = randomUUID();
        const lossData = {
          tourBoxId: box.id,
          itemType: item.itemType,
          itemId: item.id,
          itemName: item.id,
          problem: '遗失',
          note: '档案缺失，按遗失处理',
          status: '待处理'
        };
        statements.push(recordInsertSql('lossReports', lossId, lossData, timestamp));
        statements.push(
          eventInsertSql({ recordId: lossId, collection: 'lossReports', action: '返场登记', status: '待处理', actor, note: lossData.note, data: lossData })
        );
        lossReportIds.push(lossId);
        problems.push({ itemType: item.itemType, itemId: item.id, condition: '遗失', lossReportId: lossId });
        continue;
      }

      const nextData = toData(record);
      delete nextData.currentBoxId;
      let nextStatus;
      if (condition === '正常') {
        nextStatus = item.itemType === 'puppetHead' ? '可演出' : '在库';
        if (item.itemType === 'puppetHead') nextData.currentUsable = true;
      } else if (condition === '需修补') {
        nextStatus = '待修补';
        nextData.currentUsable = false;
        const repairId = randomUUID();
        const repairData = {
          puppetHeadId: item.id,
          repairType: entry.repairType || '返场检修',
          handler: entry.handler || actor || '待指派',
          tourBoxId: box.id,
          source: '返场清点',
          note,
          status: '待处理'
        };
        statements.push(recordInsertSql('repairRecords', repairId, repairData, timestamp));
        statements.push(
          eventInsertSql({ recordId: repairId, collection: 'repairRecords', action: '返场登记', status: '待处理', actor, note, data: repairData })
        );
        repairRecordIds.push(repairId);
        problems.push({ itemType: item.itemType, itemId: item.id, condition, repairRecordId: repairId });
      } else {
        // 缺损 / 遗失
        if (item.itemType === 'puppetHead') {
          nextStatus = '不可演出';
          nextData.currentUsable = false;
        } else {
          nextStatus = condition;
        }
        const lossId = randomUUID();
        const lossData = {
          tourBoxId: box.id,
          itemType: item.itemType,
          itemId: item.id,
          itemName: itemTitle(item.itemType, record),
          problem: condition,
          note,
          status: '待处理'
        };
        statements.push(recordInsertSql('lossReports', lossId, lossData, timestamp));
        statements.push(
          eventInsertSql({ recordId: lossId, collection: 'lossReports', action: '返场登记', status: '待处理', actor, note, data: lossData })
        );
        lossReportIds.push(lossId);
        problems.push({ itemType: item.itemType, itemId: item.id, condition, lossReportId: lossId });
      }
      nextData.status = nextStatus;
      statements.push(recordUpdateSql(collection, item.id, nextData, nextStatus));
      statements.push(
        eventInsertSql({
          recordId: item.id,
          collection,
          action: '返场' + condition,
          status: nextStatus,
          actor,
          note,
          data: { tourBoxId: box.id, condition }
        })
      );
    }

    const boxData = toData(box);
    boxData.status = problems.length ? '返场清点中' : '已闭环';
    boxData.returnedAt = timestamp;
    boxData.returnedBy = actor;
    boxData.returnItems = returnItems;
    boxData.repairRecordIds = repairRecordIds;
    boxData.lossReportIds = lossReportIds;
    statements.push(recordUpdateSql(BOX_COLLECTION, box.id, boxData, boxData.status));
    statements.push(
      eventInsertSql({
        recordId: box.id,
        collection: BOX_COLLECTION,
        action: '返场清点',
        status: boxData.status,
        actor,
        note: body.note || '',
        data: { problems }
      })
    );
    runTransaction(statements);

    res.json({ box: loadRecord(BOX_COLLECTION, box.id), problems, tracking: { repairRecordIds, lossReportIds } });
  } catch (error) {
    next(error);
  }
});

// 闭环箱单：返场产生的追踪记录全部处理完才能结束
app.post('/api/tourBoxes/:id/close', (req, res, next) => {
  try {
    const box = loadRecord(BOX_COLLECTION, req.params.id);
    if (!box) return res.status(404).json({ error: 'not found' });
    if (box.status === '已闭环') return res.json(box);
    if (box.status !== '返场清点中') {
      return res.status(409).json({ error: '箱单状态为「' + box.status + '」，需先完成返场清点' });
    }

    const pending = [];
    for (const record of listRecords('repairRecords')) {
      if (record.tourBoxId === box.id && record.status !== '已完成') {
        pending.push({
          collection: 'repairRecords',
          id: record.id,
          title: [record.repairType, record.handler].filter(Boolean).join(' / '),
          status: record.status
        });
      }
    }
    for (const record of listRecords('lossReports')) {
      if (record.tourBoxId === box.id && !LOSS_REPORT_FINAL.includes(record.status)) {
        pending.push({
          collection: 'lossReports',
          id: record.id,
          title: [record.itemName, record.problem].filter(Boolean).join(' / '),
          status: record.status
        });
      }
    }
    if (pending.length) {
      return res.status(409).json({ error: '尚有未处理完的追踪记录，箱单不能闭环', pending });
    }

    const body = req.body || {};
    const boxData = toData(box);
    boxData.status = '已闭环';
    boxData.closedAt = now();
    runTransaction([
      recordUpdateSql(BOX_COLLECTION, box.id, boxData, '已闭环'),
      eventInsertSql({
        recordId: box.id,
        collection: BOX_COLLECTION,
        action: '箱单闭环',
        status: '已闭环',
        actor: body.actor || '',
        note: body.note || '',
        data: {}
      })
    ]);
    res.json(loadRecord(BOX_COLLECTION, box.id));
  } catch (error) {
    next(error);
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' ORDER BY updated_at DESC;'
    ).map(toRecord);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    const createdAt = now();
    runSql(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(req.params.collection),
        sqlValue(status),
        sqlValue(titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(createdAt)
      ].join(', ') +
      ');'
    );
    insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const blocked = workflowGuard(req.params.collection, record, req.body.status);
    if (blocked) return res.status(400).json({ error: blocked });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const blocked = workflowGuard(req.params.collection, record, status);
    if (blocked) return res.status(400).json({ error: blocked });
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = select(
      'SELECT * FROM events WHERE record_id = ' + sqlValue(req.params.id) + ' ORDER BY created_at ASC;'
    ).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (record && req.params.collection === BOX_COLLECTION && record.status !== '已闭环') {
      return res.status(409).json({ error: '箱单未闭环，不能删除' });
    }
    if (
      record &&
      (req.params.collection === 'puppetHeads' || req.params.collection === 'accessories') &&
      record.status === '已装箱'
    ) {
      return res.status(409).json({ error: '物品在未返场箱单中，不能删除' });
    }
    runSql('DELETE FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' AND id = ' + sqlValue(req.params.id) + ';');
    runSql('DELETE FROM events WHERE record_id = ' + sqlValue(req.params.id) + ';');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});

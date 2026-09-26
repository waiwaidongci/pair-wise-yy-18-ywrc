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

function runTransaction(statements) {
  runSql('BEGIN IMMEDIATE;\n' + statements.join('\n') + '\nCOMMIT;');
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

function insertEventSql({ recordId, collection, action, status, actor, note, data }) {
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

function insertEvent(payload) {
  runSql(insertEventSql(payload));
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

function saveRecordSql(collection, id, data, status) {
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
  runSql(saveRecordSql(collection, id, data, status));
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

const HEAD_COLLECTION = 'puppetHeads';
const ACCESSORY_COLLECTION = 'accessories';
const BOX_COLLECTION = 'tourBoxes';
const REPAIR_COLLECTION = 'repairRecords';
const LOSS_COLLECTION = 'lossReports';
// 已装箱/巡演中的箱单物品仍在外演出，不能再进别的箱子；
// 返场清点中的箱子物品已物理回库：正常物品可再装箱，问题物品由其自身状态拦截
const ACTIVE_BOX_STATUSES = ['已装箱', '巡演中'];
const PACKABLE_HEAD_STATUS = '可演出';
const PACKABLE_ACCESSORY_STATUS = '在库';
const PACKED_STATUS = '已装箱';

// 查找仍在外演出（未返场）的箱单中占用该物品的箱单
function findActiveBoxesHolding(itemCollection, itemId, excludeBoxId) {
  const field = itemCollection === HEAD_COLLECTION ? 'headIds' : 'accessoryIds';
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(BOX_COLLECTION) +
    " AND status IN ('" + ACTIVE_BOX_STATUSES.join("','") + "') ORDER BY created_at ASC;"
  ).map(toRecord);
  return rows.filter((box) => (!excludeBoxId || box.id !== excludeBoxId) && (box[field] || []).includes(itemId));
}

function insertRecordSql({ collection, id, status, data }) {
  const collectionConfig = findCollection(collection);
  const recordData = { ...data, status };
  return (
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(titleFor(collectionConfig, recordData)),
      sqlValue(JSON.stringify(recordData)),
      sqlValue(now()),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function rowRecord(row) {
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    title: row.title,
    data: JSON.parse(row.data || '{}')
  };
}

function loadRawRecords(collection, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  return select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) +
    ' AND id IN (' + unique.map(sqlValue).join(', ') + ');'
  ).map(rowRecord);
}

function sameItems(a, b) {
  const sortIds = (list) => [...new Set(list || [])].sort();
  const left = sortIds(a);
  const right = sortIds(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function createConflict(itemCollection, id, reason, box) {
  const conflict = {
    itemType: itemCollection === HEAD_COLLECTION ? 'puppetHead' : 'accessory',
    itemId: id,
    reason
  };
  if (box) {
    conflict.boxId = box.id;
    conflict.boxName = box.title;
    conflict.boxStatus = box.status;
  }
  return conflict;
}

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
  // tourBoxes 有专用的装箱校验流程（含 409 冲突检测与事务）
  if (req.params.collection === BOX_COLLECTION) return next('route');
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

// 创建巡演装箱单：先核对每件物品是否可用，任何冲突一律 409，箱单和物品状态均不写入；
// 全部可用时在同一事务里把箱单和所有物品统一转为「已装箱」。
app.post('/api/tourBoxes', (req, res, next) => {
  try {
    findCollection(BOX_COLLECTION);
    const body = req.body || {};
    const headIds = Array.isArray(body.headIds) ? body.headIds.map(String) : [];
    const accessoryIds = Array.isArray(body.accessoryIds) ? body.accessoryIds.map(String) : [];
    const actor = body.actor || '';
    const note = body.note || '';

    for (const field of ['showName', 'venue', 'play']) {
      if (body[field] === undefined || body[field] === '') {
        return res.status(400).json({ error: 'missing required field: ' + field });
      }
    }

    // 幂等：重复提交同一箱单（clientId 相同，或物品集合+演出信息完全一致且仍未闭环）直接返回原单，不再改动物品状态
    const existingBoxes = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue(BOX_COLLECTION) + ' ORDER BY created_at ASC;'
    ).map(toRecord);

    if (body.clientId) {
      const sameClient = existingBoxes.find((box) => box.clientId === body.clientId);
      if (sameClient) {
        return res.status(200).json({ resubmitted: true, idempotent: true, box: sameClient });
      }
    }
    const duplicate = existingBoxes.find((box) =>
      box.status !== '已闭环' &&
      box.showName === body.showName &&
      box.venue === body.venue &&
      box.play === body.play &&
      sameItems(box.headIds, headIds) &&
      sameItems(box.accessoryIds, accessoryIds)
    );
    if (duplicate) {
      return res.status(200).json({ resubmitted: true, idempotent: true, box: duplicate });
    }

    const conflicts = [];
    // 同一次装箱中重复出现的每个副本都列出冲突（第一次出现之外的每次装入都冲突）；
    // 唯一 ID 仍继续检查占用与状态，保证"已占用"和"重复装入"都能被看出来
    const findDuplicates = (ids, itemType) => {
      const seen = new Set();
      for (const id of ids) {
        if (seen.has(id)) {
          conflicts.push({ itemType, itemId: id, reason: '同一箱单内重复装入' });
        }
        seen.add(id);
      }
    };
    findDuplicates(headIds, 'puppetHead');
    findDuplicates(accessoryIds, 'accessory');

    const checkItems = (collection, ids, requiredStatus, packable) => {
      const uniqueIds = [...new Set(ids)];
      const rows = loadRawRecords(collection, uniqueIds);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const results = [];
      for (const id of uniqueIds) {
        const row = byId.get(id);
        if (!row) {
          conflicts.push(createConflict(collection, id, '物品不存在'));
          continue;
        }
        const holders = findActiveBoxesHolding(collection, id);
        if (holders.length) {
          conflicts.push(createConflict(collection, id, '已装入未返场箱单', holders[0]));
          continue;
        }
        if (!packable(row)) {
          conflicts.push(createConflict(collection, id, '状态不可装箱（当前：' + row.status + '，需为：' + requiredStatus + '）'));
          continue;
        }
        results.push(row);
      }
      return results;
    };

    const headRows = checkItems(
      HEAD_COLLECTION,
      headIds,
      PACKABLE_HEAD_STATUS,
      (row) => row.status === PACKABLE_HEAD_STATUS && row.data.currentUsable !== false
    );
    const accessoryRows = checkItems(
      ACCESSORY_COLLECTION,
      accessoryIds,
      PACKABLE_ACCESSORY_STATUS,
      (row) => row.status === PACKABLE_ACCESSORY_STATUS
    );

    if (conflicts.length) {
      return res.status(409).json({
        error: '存在不可装箱的物品，箱单未创建，物品状态未改动',
        conflicts
      });
    }

    // 全部可用：统一转为已装箱，并保存装箱前状态以便返场恢复
    const boxId = randomUUID();
    const packedAt = now();
    const priorStatus = {};
    const statements = [];

    for (const row of headRows) {
      priorStatus[row.id] = row.status;
      const data = { ...row.data, status: PACKED_STATUS, currentUsable: true };
      statements.push(saveRecordSql(HEAD_COLLECTION, row.id, data, PACKED_STATUS));
      statements.push(insertEventSql({
        recordId: row.id,
        collection: HEAD_COLLECTION,
        action: '装箱',
        status: PACKED_STATUS,
        actor,
        note: '装入巡演箱单 ' + body.showName + '（' + body.venue + '）' + (note ? '；' + note : ''),
        data: { tourBoxId: boxId }
      }));
    }
    for (const row of accessoryRows) {
      priorStatus[row.id] = row.status;
      const data = { ...row.data, status: PACKED_STATUS };
      statements.push(saveRecordSql(ACCESSORY_COLLECTION, row.id, data, PACKED_STATUS));
      statements.push(insertEventSql({
        recordId: row.id,
        collection: ACCESSORY_COLLECTION,
        action: '装箱',
        status: PACKED_STATUS,
        actor,
        note: '装入巡演箱单 ' + body.showName + '（' + body.venue + '）' + (note ? '；' + note : ''),
        data: { tourBoxId: boxId }
      }));
    }

    const boxData = {
      showName: body.showName,
      venue: body.venue,
      play: body.play,
      tourDate: body.tourDate || '',
      headIds: headRows.map((row) => row.id),
      accessoryIds: accessoryRows.map((row) => row.id),
      priorStatus,
      packedAt,
      returnedAt: null,
      status: PACKED_STATUS
    };
    if (body.clientId) boxData.clientId = body.clientId;
    statements.push(insertRecordSql({ collection: BOX_COLLECTION, id: boxId, status: PACKED_STATUS, data: boxData }));
    statements.push(insertEventSql({
      recordId: boxId,
      collection: BOX_COLLECTION,
      action: '装箱',
      status: PACKED_STATUS,
      actor,
      note,
      data: { headCount: headRows.length, accessoryCount: accessoryRows.length }
    }));

    runTransaction(statements);
    res.status(201).json(loadRecord(BOX_COLLECTION, boxId));
  } catch (error) {
    next(error);
  }
});

const RETURN_OUTCOMES = {
  normal: { alias: ['ok', 'good', 'fine', '正常', '完好', '无问题'], label: '正常' },
  repair: { alias: ['repair', 'needrepair', 'need_repair', 'fix', '需修补', '待修补', '修补'], label: '需修补' },
  damage: { alias: ['damaged', 'damage', 'broken', '缺损', '损坏', '残损'], label: '缺损' },
  lost: { alias: ['loss', 'lost', 'missing', '遗失', '丢失'], label: '遗失' }
};

function normalizeOutcome(value) {
  if (!value) return 'normal';
  const key = String(value).trim().toLowerCase();
  for (const [outcome, config] of Object.entries(RETURN_OUTCOMES)) {
    if (outcome === key || config.alias.includes(key)) return outcome;
  }
  return null;
}

// 入参支持：{ heads: {id: outcome}, accessories: {id: outcome} } 或 { items: [{itemType, itemId, outcome}] }
function parseReturnItems(body, box) {
  const outcomes = new Map();
  const setOutcome = (itemType, id, raw) => {
    if (id === undefined || id === null || id === '') return;
    const outcome = normalizeOutcome(raw);
    if (!outcome) {
      const error = new Error('invalid outcome: ' + raw);
      error.status = 400;
      throw error;
    }
    outcomes.set(itemType + ':' + String(id), { itemType, itemId: String(id), outcome });
  };

  if (Array.isArray(body.items)) {
    for (const item of body.items) {
      const itemType = item.itemType === 'accessory' ? 'accessory' : 'puppetHead';
      setOutcome(itemType, item.itemId || item.id, item.outcome || item.result);
    }
  }
  const headMap = body.heads || body.puppetHeads;
  if (headMap && typeof headMap === 'object' && !Array.isArray(headMap)) {
    for (const [id, raw] of Object.entries(headMap)) {
      setOutcome('puppetHead', id, typeof raw === 'string' ? raw : (raw && raw.outcome));
    }
  }
  if (body.accessories && typeof body.accessories === 'object' && !Array.isArray(body.accessories)) {
    for (const [id, raw] of Object.entries(body.accessories)) {
      setOutcome('accessory', id, typeof raw === 'string' ? raw : (raw && raw.outcome));
    }
  }

  // 未上报的物品按正常处理；不属于本箱单的物品直接拒绝
  const declared = new Set(outcomes.keys());
  for (const id of box.headIds || []) {
    if (!declared.has('puppetHead:' + id)) outcomes.set('puppetHead:' + id, { itemType: 'puppetHead', itemId: id, outcome: 'normal' });
  }
  for (const id of box.accessoryIds || []) {
    if (!declared.has('accessory:' + id)) outcomes.set('accessory:' + id, { itemType: 'accessory', itemId: id, outcome: 'normal' });
  }
  for (const key of outcomes.keys()) {
    const [itemType, id] = key.split(':');
    const belongs = itemType === 'puppetHead' ? (box.headIds || []).includes(id) : (box.accessoryIds || []).includes(id);
    if (!belongs) {
      const error = new Error('item not in this box: ' + key);
      error.status = 400;
      throw error;
    }
  }
  return [...outcomes.values()];
}

// 返场清点：正常物品恢复装箱前状态；需修补/缺损/遗失的生成追踪记录并停止装箱
app.post('/api/tourBoxes/:id/return', (req, res, next) => {
  try {
    const box = loadRecord(BOX_COLLECTION, req.params.id);
    if (!box) return res.status(404).json({ error: 'not found' });

    // 重复提交返场不允许再次改动物品状态或重复生成追踪记录
    if (box.status === '返场清点中' || box.status === '已闭环') {
      return res.status(200).json({ resubmitted: true, idempotent: true, box });
    }
    if (box.status !== '已装箱' && box.status !== '巡演中') {
      return res.status(409).json({ error: '当前箱单状态不可返场：' + box.status });
    }

    const body = req.body || {};
    const actor = body.actor || '';
    const note = body.note || '';
    const items = parseReturnItems(body, box);

    const headRows = new Map(loadRawRecords(HEAD_COLLECTION, box.headIds || []).map((row) => [row.id, row]));
    const accessoryRows = new Map(loadRawRecords(ACCESSORY_COLLECTION, box.accessoryIds || []).map((row) => [row.id, row]));

    const statements = [];
    const restored = [];
    const repairs = [];
    const losses = [];

    const restore = (collection, row) => {
      const priorStatus = (box.priorStatus || {})[row.id] || (collection === HEAD_COLLECTION ? PACKABLE_HEAD_STATUS : PACKABLE_ACCESSORY_STATUS);
      const data = { ...row.data, status: priorStatus };
      if (collection === HEAD_COLLECTION) data.currentUsable = true;
      statements.push(saveRecordSql(collection, row.id, data, priorStatus));
      statements.push(insertEventSql({
        recordId: row.id,
        collection,
        action: '返场',
        status: priorStatus,
        actor,
        note: '返场清点正常，恢复装箱前状态' + (note ? '；' + note : ''),
        data: { tourBoxId: box.id }
      }));
      restored.push({ itemType: collection === HEAD_COLLECTION ? 'puppetHead' : 'accessory', itemId: row.id, restoredStatus: priorStatus });
    };

    for (const item of items) {
      const collection = item.itemType === 'puppetHead' ? HEAD_COLLECTION : ACCESSORY_COLLECTION;
      const row = (item.itemType === 'puppetHead' ? headRows : accessoryRows).get(item.itemId);
      if (!row) continue; // 箱单内物品理应存在，防御性跳过

      if (item.outcome === 'normal') {
        restore(collection, row);
        continue;
      }

      const label = RETURN_OUTCOMES[item.outcome].label;
      const itemName = row.title || row.data.name || row.data.role || item.itemId;

      if (item.outcome === 'repair') {
        if (collection === HEAD_COLLECTION) {
          // 偶头需修补：生成修补记录，偶头转为待修补
          const repairId = randomUUID();
          const repairData = {
            puppetHeadId: row.id,
            repairType: '返场修补',
            handler: actor || '待指派',
            tourBoxId: box.id,
            itemName,
            problem: '巡演返场发现需修补'
          };
          statements.push(insertRecordSql({ collection: REPAIR_COLLECTION, id: repairId, status: '待处理', data: repairData }));
          statements.push(insertEventSql({
            recordId: repairId,
            collection: REPAIR_COLLECTION,
            action: '返场登记',
            status: '待处理',
            actor,
            note: '箱单 ' + box.showName + ' 返场发现需修补',
            data: repairData
          }));
          repairs.push({ itemType: 'puppetHead', itemId: row.id, trackingType: 'repairRecord', trackingId: repairId });
        }
        const nextStatus = collection === HEAD_COLLECTION ? '待修补' : '缺损';
        const nextData = { ...row.data, status: nextStatus };
        if (collection === HEAD_COLLECTION) nextData.currentUsable = false;
        const repairTrackingId = collection === HEAD_COLLECTION && repairs.length ? repairs[repairs.length - 1].trackingId : null;
        statements.push(saveRecordSql(collection, row.id, nextData, nextStatus));
        statements.push(insertEventSql({
          recordId: row.id,
          collection,
          action: '返场-需修补',
          status: nextStatus,
          actor,
          note: '返场发现需修补，停止装箱等待处理' + (note ? '；' + note : ''),
          data: { tourBoxId: box.id, outcome: label, trackingId: repairTrackingId }
        }));
        if (collection === ACCESSORY_COLLECTION) {
          // 配件没有修补流转，需修补统一进缺损追踪
          const lossId = randomUUID();
          const lossData = {
            tourBoxId: box.id,
            itemType: 'accessory',
            itemId: row.id,
            itemName,
            problem: '需修补',
            handler: actor || ''
          };
          statements.push(insertRecordSql({ collection: LOSS_COLLECTION, id: lossId, status: '待处理', data: lossData }));
          statements.push(insertEventSql({
            recordId: lossId,
            collection: LOSS_COLLECTION,
            action: '返场登记',
            status: '待处理',
            actor,
            note: '箱单 ' + box.showName + ' 返场发现配件需修补',
            data: lossData
          }));
          losses.push({ itemType: 'accessory', itemId: row.id, trackingType: 'lossReport', trackingId: lossId, outcome: label });
        }
        continue;
      }

      // 缺损 / 遗失：生成缺损追踪记录，物品停止装箱
      const nextStatus = collection === HEAD_COLLECTION
        ? '不可演出'
        : (item.outcome === 'lost' ? '遗失' : '缺损');
      const nextData = { ...row.data, status: nextStatus };
      if (collection === HEAD_COLLECTION) nextData.currentUsable = false;
      statements.push(saveRecordSql(collection, row.id, nextData, nextStatus));

      const lossId = randomUUID();
      const lossData = {
        tourBoxId: box.id,
        itemType: collection === HEAD_COLLECTION ? 'puppetHead' : 'accessory',
        itemId: row.id,
        itemName,
        problem: label,
        handler: actor || ''
      };
      statements.push(insertRecordSql({ collection: LOSS_COLLECTION, id: lossId, status: '待处理', data: lossData }));
      statements.push(insertEventSql({
        recordId: lossId,
        collection: LOSS_COLLECTION,
        action: '返场登记',
        status: '待处理',
        actor,
        note: '箱单 ' + box.showName + ' 返场发现' + label,
        data: lossData
      }));
      statements.push(insertEventSql({
        recordId: row.id,
        collection,
        action: '返场-' + label,
        status: nextStatus,
        actor,
        note: '返场' + label + '，停止装箱等待追踪处理' + (note ? '；' + note : ''),
        data: { tourBoxId: box.id, outcome: label, trackingId: lossId }
      }));
      losses.push({
        itemType: collection === HEAD_COLLECTION ? 'puppetHead' : 'accessory',
        itemId: row.id,
        trackingType: 'lossReport',
        trackingId: lossId,
        outcome: label
      });
    }

    const returnedAt = now();
    const boxData = { ...box, status: '返场清点中', returnedAt };
    delete boxData.id;
    delete boxData.collection;
    delete boxData.createdAt;
    delete boxData.updatedAt;
    statements.push(saveRecordSql(BOX_COLLECTION, box.id, boxData, '返场清点中'));
    statements.push(insertEventSql({
      recordId: box.id,
      collection: BOX_COLLECTION,
      action: '返场清点',
      status: '返场清点中',
      actor,
      note,
      data: { restored: restored.length, repairs: repairs.length, losses: losses.length }
    }));

    runTransaction(statements);
    res.json({
      box: loadRecord(BOX_COLLECTION, box.id),
      restored,
      repairRecords: repairs,
      lossReports: losses
    });
  } catch (error) {
    next(error);
  }
});

// 结束箱单：修补/缺损/遗失追踪记录全部处理完后才能闭环
app.post('/api/tourBoxes/:id/close', (req, res, next) => {
  try {
    const box = loadRecord(BOX_COLLECTION, req.params.id);
    if (!box) return res.status(404).json({ error: 'not found' });

    if (box.status === '已闭环') {
      return res.status(200).json({ resubmitted: true, idempotent: true, box });
    }

    const pendingLosses = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue(LOSS_COLLECTION) + ';'
    ).map(toRecord).filter((report) =>
      report.tourBoxId === box.id && !['已补齐', '确认为遗失'].includes(report.status)
    ).map((report) => ({
      trackingType: 'lossReport',
      trackingId: report.id,
      itemType: report.itemType,
      itemId: report.itemId,
      itemName: report.itemName,
      problem: report.problem,
      status: report.status
    }));

    const pendingRepairs = select(
      'SELECT * FROM records WHERE collection = ' + sqlValue(REPAIR_COLLECTION) + ';'
    ).map(toRecord).filter((repair) =>
      repair.tourBoxId === box.id && repair.status !== '已完成'
    ).map((repair) => ({
      trackingType: 'repairRecord',
      trackingId: repair.id,
      itemId: repair.puppetHeadId,
      repairType: repair.repairType,
      status: repair.status
    }));

    const pending = [...pendingRepairs, ...pendingLosses];
    if (pending.length) {
      return res.status(409).json({
        error: '仍有需修补、缺损或遗失物品的追踪记录未处理完，箱单不能结束',
        pending
      });
    }

    if (box.status !== '返场清点中' && box.status !== '巡演中') {
      return res.status(409).json({ error: '当前箱单状态不可闭环：' + box.status });
    }

    const body = req.body || {};
    const statements = [];
    const boxData = { ...box, status: '已闭环', closedAt: now() };
    delete boxData.id;
    delete boxData.collection;
    delete boxData.createdAt;
    delete boxData.updatedAt;
    statements.push(saveRecordSql(BOX_COLLECTION, box.id, boxData, '已闭环'));
    statements.push(insertEventSql({
      recordId: box.id,
      collection: BOX_COLLECTION,
      action: '闭环',
      status: '已闭环',
      actor: body.actor || '',
      note: body.note || '追踪记录全部处理完成，箱单结束',
      data: {}
    }));
    runTransaction(statements);
    res.json(loadRecord(BOX_COLLECTION, box.id));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
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

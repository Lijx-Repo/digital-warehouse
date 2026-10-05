#!/usr/bin/env node
/**
 * Digital Warehouse — 家庭礼品仓库（茶叶 / 酒品等送礼物品）
 * 精简版：只管「入库、出库、时间追踪」，不记价格。
 * 零依赖 Node.js HTTP 服务：静态页面 + JSON API，数据持久化到 data/items.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'items.json');

/* ---------------- 数据层 ---------------- */
function defaultCategories() {
  return ['茶叶', '白酒', '红酒', '洋酒', '保健品', '香烟', '礼品', '食品', '其他'];
}

function seedItems() {
  const now = new Date().toISOString();
  const mk = (name, category, spec, quantity, unit, inDate, location, notes) => ({
    id: crypto.randomUUID(),
    name,
    category,
    spec,
    quantity,
    unit,
    inDate,
    location,
    notes,
    createdAt: now,
    updatedAt: now,
  });
  return [
    mk('西湖狮峰明前龙井（特级）', '茶叶', '250g 罐装', 2, '罐', '2025-04-05', '茶室博古架', '绿茶讲究鲜爽，建议半年内饮完'),
    mk('贵州茅台酒', '白酒', '飞天 53%vol 500ml', 2, '瓶', '2024-12-10', '酒柜上层', '白酒越陈越香，适合长期存放'),
    mk('大益普洱茶七子饼', '茶叶', '7572 熟茶 357g/饼', 3, '饼', '2023-09-15', '储藏室茶架', '适合边存边喝'),
    mk('拉菲传奇波尔多红葡萄酒', '红酒', 'Légende 750ml', 6, '瓶', '2024-02-01', '酒柜下层', '日常宴请口粮酒'),
    mk('东阿阿胶糕', '保健品', '即食片剂 500g 礼盒', 1, '盒', '2024-06-18', '储藏室', '中秋送长辈'),
    mk('中华香烟', '香烟', '硬盒整条', 1, '条', '2025-01-20', '客厅柜子', '春节备礼'),
  ];
}

/* 出库记录种子数据（送给谁 / 事由） */
function seedOutbound() {
  const now = new Date().toISOString();
  const mk = (name, category, spec, quantity, unit, inDate, outDate, recipient, reason, notes) => ({
    id: crypto.randomUUID(),
    name, category, spec, quantity, unit, inDate, outDate, recipient, reason, notes,
    createdAt: now, updatedAt: now,
  });
  return [
    mk('奔富 BIN407 红葡萄酒', '红酒', '750ml × 6 原箱', 1, '箱', '2024-03-10', '2025-05-18', '表哥', '婚宴用酒', '婚礼宴席开箱'),
    mk('小罐茶·金骏眉', '茶叶', '100g 礼盒', 1, '盒', '2024-09-18', '2025-02-03', '李总', '送礼', ''),
    mk('陈年女儿红黄酒', '白酒', '500ml 坛装', 2, '坛', '2024-01-15', '2025-01-22', '王叔叔', '送礼', '春节拜访长辈'),
  ];
}

function migrate(db) {
  if (!Array.isArray(db.items)) db.items = [];
  if (!Array.isArray(db.outbound)) db.outbound = [];
  if (!Array.isArray(db.categories) || db.categories.length === 0) db.categories = defaultCategories();
  // 在库物品字段：出库即移入「出库记录」，items 里不保留 outDate
  const keep = ['id','name','category','spec','quantity','unit','inDate','location','notes','createdAt','updatedAt'];
  for (const it of db.items) {
    for (const k of Object.keys(it)) if (!keep.includes(k)) delete it[k];
    if (!it.inDate && it.purchaseDate) it.inDate = it.purchaseDate; // 从旧数据迁移入库日期
    if (!it.inDate) it.inDate = (it.createdAt || '').slice(0, 10);
    if (it.quantity == null) it.quantity = 1;
    if (!it.unit) it.unit = '件';
    if (!it.spec) it.spec = '';
    if (!it.category) it.category = '其他';
  }
  // 出库记录字段
  const keepOut = ['id','name','category','spec','quantity','unit','inDate','outDate','recipient','reason','notes','createdAt','updatedAt'];
  for (const it of db.outbound) {
    for (const k of Object.keys(it)) if (!keepOut.includes(k)) delete it[k];
    if (!it.outDate) it.outDate = (it.updatedAt || '').slice(0, 10);
    if (typeof it.recipient !== 'string') it.recipient = '';
    if (typeof it.reason !== 'string') it.reason = '';
    if (typeof it.notes !== 'string') it.notes = '';
    if (!it.spec) it.spec = '';
    if (it.quantity == null) it.quantity = 1;
    if (!it.unit) it.unit = '件';
    if (!it.category) it.category = '其他';
  }
  return db;
}

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return migrate(JSON.parse(raw));
  } catch (e) {
    return { items: seedItems(), outbound: seedOutbound(), categories: defaultCategories() };
  }
}

function saveDB(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

let db = loadDB();
saveDB(db); // 首次运行时落盘种子数据

/* ---------------- 工具函数 ---------------- */
function sanitizeItem(body) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const num = (v) => {
    const n = Number(v);
    return v === '' || v == null || isNaN(n) ? 1 : Math.max(0, Math.floor(n));
  };
  return {
    name: s(body.name),
    category: s(body.category) || '其他',
    spec: s(body.spec),
    quantity: num(body.quantity),
    unit: s(body.unit) || '件',
    inDate: s(body.inDate),
    location: s(body.location),
    notes: s(body.notes),
  };
}

/* 时间追踪：在库时长（天），入库日期到今天 */
function daysBetween(fromISO, toISO) {
  const a = new Date(fromISO);
  const b = toISO ? new Date(toISO) : new Date();
  if (isNaN(a) || (toISO && isNaN(b))) return null;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function timeInfo(item) {
  const daysIn = item.inDate ? daysBetween(item.inDate, null) : null;
  return { daysIn };
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ---------------- API ---------------- */
function withMeta(it) {
  return { ...it, meta: timeInfo(it) };
}

/* 出库记录附加信息：在外时长（出库日期距今） */
function outMeta(rec) {
  const daysOut = rec.outDate ? daysBetween(rec.outDate, null) : null;
  return { daysOut };
}

/* 通用列表查询：搜索 / 分类过滤 / 排序 */
function queryList(list, q, dateKey) {
  const kw = (q.get('q') || '').toLowerCase();
  const cat = q.get('category') || '';
  let out = list.slice();
  if (cat) out = out.filter((it) => it.category === cat);
  if (kw) {
    out = out.filter((it) =>
      [it.name, it.spec, it.location, it.recipient, it.reason, it.notes].join(' ').toLowerCase().includes(kw)
    );
  }
  const sort = q.get('sort') || '-' + dateKey;
  const dir = sort.startsWith('-') ? -1 : 1;
  const key = sort.replace(/^-/, '');
  out.sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || '')) * dir);
  return out;
}

function handleAPI(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'items', ':id', ...]
  const resource = parts[1];

  if (resource === 'categories' && req.method === 'GET') {
    return sendJSON(res, 200, db.categories);
  }

  if (resource === 'stats' && req.method === 'GET') {
    const byCategory = {};
    db.items.forEach((it) => {
      const c = it.category || '其他';
      const cur = byCategory[c] || { in: 0 };
      cur.in += it.quantity || 1;
      byCategory[c] = cur;
    });
    return sendJSON(res, 200, {
      total: db.items.length,
      outboundTotal: db.outbound.length,
      byCategory,
    });
  }

  if (resource === 'export' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="digital-warehouse-export.json"',
    });
    return res.end(JSON.stringify(db, null, 2));
  }

  /* ---------- 出库记录页 ---------- */
  if (resource === 'outbound') {
    const id = parts[2];

    if (req.method === 'GET' && !id) {
      const list = queryList(db.outbound, url.searchParams, 'outDate');
      return sendJSON(res, 200, list.map((r) => ({ ...r, meta: outMeta(r) })));
    }

    if (req.method === 'GET' && id) {
      const r = db.outbound.find((x) => x.id === id);
      if (!r) return sendJSON(res, 404, { error: '未找到该出库记录' });
      return sendJSON(res, 200, { ...r, meta: outMeta(r) });
    }

    if (req.method === 'PUT' && id) {
      const idx = db.outbound.findIndex((x) => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: '未找到该出库记录' });
      return readBody(req).then((body) => {
        const s = (v) => (typeof v === 'string' ? v.trim() : '');
        const old = db.outbound[idx];
        const clean = {
          recipient: s(body.recipient ?? old.recipient),
          reason: s(body.reason ?? old.reason),
          outDate: s(body.outDate ?? old.outDate),
          notes: s(body.notes ?? old.notes),
        };
        const item = { ...old, ...clean, id, updatedAt: new Date().toISOString() };
        db.outbound[idx] = item;
        saveDB(db);
        sendJSON(res, 200, { ...item, meta: outMeta(item) });
      }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
    }

    if (req.method === 'DELETE' && id) {
      const idx = db.outbound.findIndex((x) => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: '未找到该出库记录' });
      db.outbound.splice(idx, 1);
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (resource === 'items') {
    const id = parts[2];

    if (req.method === 'GET' && !id) {
      const list = queryList(db.items, url.searchParams, 'inDate');
      return sendJSON(res, 200, list.map(withMeta));
    }

    if (req.method === 'GET' && id) {
      const it = db.items.find((x) => x.id === id);
      if (!it) return sendJSON(res, 404, { error: '未找到该记录' });
      return sendJSON(res, 200, withMeta(it));
    }

    if (req.method === 'POST' && !id) {
      return readBody(req).then((body) => {
        const clean = sanitizeItem(body);
        if (!clean.name) return sendJSON(res, 400, { error: '名称为必填项' });
        if (!clean.inDate) clean.inDate = new Date().toISOString().slice(0, 10); // 默认今天入库
        const now = new Date().toISOString();
        const item = { id: crypto.randomUUID(), ...clean, createdAt: now, updatedAt: now };
        db.items.push(item);
        if (!db.categories.includes(item.category)) db.categories.push(item.category);
        saveDB(db);
        sendJSON(res, 201, withMeta(item));
      }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
    }

    if (req.method === 'PUT' && id) {
      const idx = db.items.findIndex((x) => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: '未找到该记录' });
      return readBody(req).then((body) => {
        const clean = sanitizeItem({ ...db.items[idx], ...body });
        if (!clean.name) return sendJSON(res, 400, { error: '名称为必填项' });
        const item = { ...db.items[idx], ...clean, id, updatedAt: new Date().toISOString() };
        db.items[idx] = item;
        if (!db.categories.includes(item.category)) db.categories.push(item.category);
        saveDB(db);
        sendJSON(res, 200, withMeta(item));
      }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
    }

    /* POST /api/items/:id/out —— 出库：从在库列表移入「出库记录」 */
    if (req.method === 'POST' && id && parts[3] === 'out') {
      const idx = db.items.findIndex((x) => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: '未找到该记录' });
      return readBody(req).then((body) => {
        const s = (v) => (typeof v === 'string' ? v.trim() : '');
        const src = db.items[idx];
        const now = new Date().toISOString();
        const record = {
          id: src.id,
          name: src.name,
          category: src.category,
          spec: src.spec,
          quantity: src.quantity,
          unit: src.unit,
          inDate: src.inDate,
          outDate: s(body.outDate) || now.slice(0, 10),
          recipient: s(body.recipient),
          reason: s(body.reason),
          notes: s(body.notes),
          createdAt: src.createdAt,
          updatedAt: now,
        };
        db.items.splice(idx, 1);
        db.outbound.unshift(record);
        saveDB(db);
        sendJSON(res, 200, { ...record, meta: outMeta(record) });
      }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
    }

    if (req.method === 'DELETE' && id) {
      const idx = db.items.findIndex((x) => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: '未找到该记录' });
      db.items.splice(idx, 1);
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }
  }

  sendJSON(res, 404, { error: '接口不存在' });
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleAPI(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`🏠 Digital Warehouse 已启动: http://localhost:${PORT}`);
});

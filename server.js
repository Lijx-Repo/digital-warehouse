#!/usr/bin/env node
/**
 * Digital Warehouse — 家庭数字仓库
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
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(raw);
    if (!Array.isArray(db.items)) db.items = [];
    if (!Array.isArray(db.categories) || db.categories.length === 0) {
      db.categories = defaultCategories();
    }
    return db;
  } catch (e) {
    return { items: seedItems(), categories: defaultCategories() };
  }
}

function saveDB(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function defaultCategories() {
  return ['电器', '数码', '家具', '厨具', '工具', '其他'];
}

function seedItems() {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      name: '戴森吸尘器 V12',
      category: '电器',
      brand: 'Dyson',
      model: 'V12 Detect Slim',
      serial: 'DY-V12-20240715',
      purchaseDate: '2024-07-15',
      price: 3699,
      currency: 'CNY',
      store: '京东自营',
      warrantyMonths: 24,
      location: '客厅储物间',
      quantity: 1,
      condition: '良好',
      notes: '含床褥吸头、缝隙吸头',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: 'MacBook Pro 14',
      category: '数码',
      brand: 'Apple',
      model: 'M3 Pro / 18G / 512G',
      serial: 'C02XP1MZMD6T',
      purchaseDate: '2024-01-20',
      price: 14999,
      currency: 'CNY',
      store: 'Apple 官网',
      warrantyMonths: 12,
      location: '书房',
      quantity: 1,
      condition: '良好',
      notes: '已购 AppleCare+ 至 2027-01',
      createdAt: now,
      updatedAt: now,
    },
  ];
}

let db = loadDB();
saveDB(db); // 首次运行时落盘种子数据

/* ---------------- 工具函数 ---------------- */
const CONDITIONS = ['全新', '良好', '一般', '故障', '已报废'];

function sanitizeItem(body) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const item = {
    name: s(body.name),
    category: s(body.category) || '其他',
    brand: s(body.brand),
    model: s(body.model),
    serial: s(body.serial),
    purchaseDate: s(body.purchaseDate),
    price: num(body.price),
    currency: s(body.currency) || 'CNY',
    store: s(body.store),
    warrantyMonths: num(body.warrantyMonths),
    location: s(body.location),
    quantity: num(body.quantity) ?? 1,
    condition: CONDITIONS.includes(s(body.condition)) ? s(body.condition) : '良好',
    notes: s(body.notes),
  };
  return item;
}

function warrantyInfo(item) {
  if (!item.purchaseDate || !item.warrantyMonths) return { status: '未知', daysLeft: null };
  const start = new Date(item.purchaseDate);
  if (isNaN(start)) return { status: '未知', daysLeft: null };
  const end = new Date(start);
  end.setMonth(end.getMonth() + Number(item.warrantyMonths));
  const daysLeft = Math.ceil((end - Date.now()) / 86400000);
  let status;
  if (daysLeft < 0) status = '已过保';
  else if (daysLeft <= 90) status = '即将过保';
  else status = '保修中';
  return { status, daysLeft, endDate: end.toISOString().slice(0, 10) };
}

function totalValue(items) {
  return items.reduce((sum, it) => sum + (it.price && it.quantity ? it.price * it.quantity : 0), 0);
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
function handleAPI(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'items', ':id']
  const resource = parts[1];

  if (resource === 'categories' && req.method === 'GET') {
    return sendJSON(res, 200, db.categories);
  }

  if (resource === 'stats' && req.method === 'GET') {
    const byCategory = {};
    db.items.forEach((it) => {
      const c = it.category || '其他';
      byCategory[c] = (byCategory[c] || 0) + (it.price && it.quantity ? it.price * it.quantity : 0);
    });
    const expiringSoon = db.items.filter((it) => warrantyInfo(it).status === '即将过保').length;
    const expired = db.items.filter((it) => warrantyInfo(it).status === '已过保').length;
    return sendJSON(res, 200, {
      count: db.items.length,
      totalValue: totalValue(db.items),
      byCategory,
      expiringSoon,
      expired,
    });
  }

  if (resource === 'export' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="digital-warehouse-export.json"',
    });
    return res.end(JSON.stringify(db, null, 2));
  }

  if (resource === 'items') {
    const id = parts[2];

    if (req.method === 'GET' && !id) {
      const q = url.searchParams;
      const kw = (q.get('q') || '').toLowerCase();
      const cat = q.get('category') || '';
      let list = db.items.slice();
      if (cat) list = list.filter((it) => it.category === cat);
      if (kw) {
        list = list.filter((it) =>
          [it.name, it.brand, it.model, it.serial, it.location, it.store, it.notes]
            .join(' ')
            .toLowerCase()
            .includes(kw)
        );
      }
      const sort = q.get('sort') || 'updatedAt';
      list.sort((a, b) => String(b[sort] || '').localeCompare(String(a[sort] || '')));
      return sendJSON(res, 200, list.map((it) => ({ ...it, warranty: warrantyInfo(it) })));
    }

    if (req.method === 'GET' && id) {
      const it = db.items.find((x) => x.id === id);
      if (!it) return sendJSON(res, 404, { error: '未找到该物品' });
      return sendJSON(res, 200, { ...it, warranty: warrantyInfo(it) });
    }

    if (req.method === 'POST') {
      return readBody(req).then((body) => {
        const clean = sanitizeItem(body);
        if (!clean.name) return sendJSON(res, 400, { error: '名称为必填项' });
        const now = new Date().toISOString();
        const item = { id: crypto.randomUUID(), ...clean, createdAt: now, updatedAt: now };
        db.items.push(item);
        if (!db.categories.includes(item.category)) {
          db.categories.push(item.category);
        }
        saveDB(db);
        sendJSON(res, 201, { ...item, warranty: warrantyInfo(item) });
      }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
    }

    if (req.method === 'PUT' && id) {
      const idx = db.items.findIndex((x) => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: '未找到该物品' });
      return readBody(req).then((body) => {
        const clean = sanitizeItem({ ...db.items[idx], ...body });
        if (!clean.name) return sendJSON(res, 400, { error: '名称为必填项' });
        const item = { ...db.items[idx], ...clean, id, updatedAt: new Date().toISOString() };
        db.items[idx] = item;
        if (!db.categories.includes(item.category)) db.categories.push(item.category);
        saveDB(db);
        sendJSON(res, 200, { ...item, warranty: warrantyInfo(item) });
      }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
    }

    if (req.method === 'DELETE' && id) {
      const idx = db.items.findIndex((x) => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: '未找到该物品' });
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

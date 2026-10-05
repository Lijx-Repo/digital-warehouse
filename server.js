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
  return ['茶叶', '白酒', '红酒', '洋酒', '保健品', '香烟', '礼品', '食品', '其他'];
}

const USAGE_STATUSES = ['在库', '部分送出', '已送出', '已饮用', '已食用', '已闲置', '已报废'];

function seedItems() {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      name: '西湖狮峰明前龙井（特级）',
      category: '茶叶',
      brand: '狮峰牌',
      model: '清明前 · 手工炒制 · 罐装 250g',
      serial: '',
      purchaseDate: '2025-04-05',
      price: 880,
      currency: 'CNY',
      store: '茶叶专卖店',
      warrantyMonths: null,
      productionDate: '2025-04-02',
      expiryDate: '2026-12-04',
      storage: '密封避光，冰箱冷藏（0~5℃）',
      valuePerUnit: 880,
      location: '茶室博古架',
      quantity: 2,
      unit: '罐',
      status: '在库',
      condition: '全新',
      notes: '绿茶讲究鲜爽，建议半年内饮完；送礼体面之选',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: '贵州茅台酒',
      category: '白酒',
      brand: '茅台',
      model: '飞天 53%vol 500ml',
      serial: '防伪码见瓶盖',
      purchaseDate: '2024-12-10',
      price: 2899,
      currency: 'CNY',
      store: '茅台官方渠道',
      warrantyMonths: null,
      productionDate: '2024-11-20',
      expiryDate: '',
      storage: '直立、避光、阴凉处（温度不超过 30℃）',
      valuePerUnit: 2899,
      location: '酒柜上层',
      quantity: 2,
      unit: '瓶',
      status: '在库',
      condition: '全新',
      notes: '白酒无保质期，越陈越香，适合长期收藏',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: '大益普洱茶七子饼',
      category: '茶叶',
      brand: '大益',
      model: '7572 熟茶 · 357g/饼',
      serial: '',
      purchaseDate: '2023-09-15',
      price: 420,
      currency: 'CNY',
      store: '品牌旗舰店',
      warrantyMonths: null,
      productionDate: '2023-06-18',
      expiryDate: '',
      storage: '陶罐/紫砂缸存放，通风干燥、远离异味',
      valuePerUnit: 420,
      location: '储藏室茶架',
      quantity: 3,
      unit: '饼',
      status: '部分送出',
      condition: '良好',
      notes: '普洱可长期陈化，随年份增值；剩余 3 饼（原 5 饼，送出 2 饼）',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: '拉菲传奇波尔多红葡萄酒',
      category: '红酒',
      brand: 'Lafite',
      model: 'Légende 2019 · 750ml',
      serial: '',
      purchaseDate: '2024-02-01',
      price: 368,
      currency: 'CNY',
      store: '酒便利',
      warrantyMonths: null,
      productionDate: '2019-01-01',
      expiryDate: '2029-01-01',
      storage: '横放，恒温 12~16℃、避光、避震',
      valuePerUnit: 368,
      location: '酒柜下层',
      quantity: 6,
      unit: '瓶',
      status: '在库',
      condition: '全新',
      notes: '日常宴请口粮酒，整箱购入按瓶记价',
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
    productionDate: s(body.productionDate),
    expiryDate: s(body.expiryDate),
    storage: s(body.storage),
    valuePerUnit: num(body.valuePerUnit),
    location: s(body.location),
    quantity: num(body.quantity) ?? 1,
    unit: s(body.unit) || '件',
    status: USAGE_STATUSES.includes(s(body.status)) ? s(body.status) : '在库',
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

/* 保质期：茶叶/食品/保健品看 expiryDate；白酒/普洱等可陈化物品留空即不提醒 */
function shelfLifeInfo(item) {
  if (!item.expiryDate) return { status: '无', daysLeft: null };
  const end = new Date(item.expiryDate);
  if (isNaN(end)) return { status: '未知', daysLeft: null };
  const daysLeft = Math.ceil((end - Date.now()) / 86400000);
  let status;
  if (daysLeft < 0) status = '已过期';
  else if (daysLeft <= 90) status = '临期';
  else status = '保质期内';
  return { status, daysLeft };
}

/* 总价值只计在库部分：已送出/已饮用的不计入家庭资产 */
const OUT_OF_STOCK = ['已送出', '已饮用', '已食用', '已报废'];

function itemValue(it) {
  if (OUT_OF_STOCK.includes(it.status)) return 0;
  const unit = it.valuePerUnit != null ? it.valuePerUnit : it.price;
  const qty = it.quantity || 1;
  return unit && qty ? unit * qty : 0;
}

function totalValue(items) {
  return items.reduce((sum, it) => sum + itemValue(it), 0);
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
      byCategory[c] = (byCategory[c] || 0) + itemValue(it);
    });
    const expiringSoon = db.items.filter((it) => shelfLifeInfo(it).status === '临期').length;
    const expired = db.items.filter((it) => shelfLifeInfo(it).status === '已过期').length;
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
          [it.name, it.brand, it.model, it.serial, it.location, it.store, it.storage, it.notes]
            .join(' ')
            .toLowerCase()
            .includes(kw)
        );
      }
      const sort = q.get('sort') || 'updatedAt';
      list.sort((a, b) => String(b[sort] || '').localeCompare(String(a[sort] || '')));
      return sendJSON(res, 200, list.map((it) => ({ ...it, warranty: warrantyInfo(it), shelfLife: shelfLifeInfo(it) })));
    }

    if (req.method === 'GET' && id) {
      const it = db.items.find((x) => x.id === id);
      if (!it) return sendJSON(res, 404, { error: '未找到该物品' });
      return sendJSON(res, 200, { ...it, warranty: warrantyInfo(it), shelfLife: shelfLifeInfo(it) });
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
        sendJSON(res, 201, { ...item, warranty: warrantyInfo(item), shelfLife: shelfLifeInfo(item) });
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
        sendJSON(res, 200, { ...item, warranty: warrantyInfo(item), shelfLife: shelfLifeInfo(item) });
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

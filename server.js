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

/* ---------------- 安全：密码哈希 + 数据加密（AES-256-GCM，防明文） ---------------- */
const PBKDF2_ITER = 210000; // OWASP 建议量级
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 会话有效期 7 天
const sessions = new Map(); // token -> { salt, key, expires }
let authFailUntil = 0; // 登录失败限速：在此之前拒绝新的解锁尝试

/** 口令 → (salt, 派生密钥)。同一函数用于「验证登录」和「解密数据」：
 *  文件头存的 verifier 用该密钥 HMAC 得到；加密密钥 = HKDF(主密钥)，密文自带 GCM 认证标签。
 *  因此只有正确密码才能同时通过校验并解密——磁盘上绝无明文数据与密码。 */
function deriveKey(password, saltHex) {
  return crypto.pbkdf2Sync(String(password), Buffer.from(saltHex, 'hex'), PBKDF2_ITER, 32, 'sha256');
}
function hmacHex(key, dataBuf) {
  return crypto.createHmac('sha256', key).update(dataBuf).digest('hex');
}
function timingSafeHexEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function hkdf(master, info) {
  const prk = crypto.createHmac('sha256', master).update(Buffer.from(info)).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.from([1])).digest(); // 1-block OKP，32 字节
}

function encryptJSON(obj, master) {
  const key = hkdf(master, 'enc');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { alg: 'AES-256-GCM', v: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: enc.toString('base64') };
}
function decryptJSON(env, master) {
  const key = hkdf(master, 'enc');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
  d.setAuthTag(Buffer.from(env.tag, 'hex'));
  const plain = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

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

/* ---------------- 加密存储层 ---------------- */
/* data/items.json 落盘格式（信封）：
 *   { kdf:{salt, verifier, iter}, enc:{iv,tag,data} }
 * - verifier = HMAC(派生密钥, "verify") —— 密码校验值（单向用途，与加密密钥分离）
 * - enc      = AES-256-GCM 密文，密钥 = HKDF(派生密钥)
 * 磁盘上不存在明文数据、不存在密码（连哈希也不存，存的是可复用的派生校验值）。 */

let db = null;               // 仅在解锁后驻留内存
let unlocked = null;         // { token, salt, key, expires } 当前服务端会话

function readEnvelope() {
  try {
    const env = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (env && env.kdf && env.kdf.salt && env.kdf.verifier && env.enc) return env;
  } catch (e) { /* 文件不存在或损坏 */ }
  return null;
}

function writeEnvelope(env) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(env, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

/** 用主密钥重新封装并原子写盘（每次数据变更后调用） */
function saveDB(nextDb) {
  if (!unlocked) throw new Error('内部错误：未解锁不允许写盘');
  db = nextDb;
  writeEnvelope({
    kdf: { salt: unlocked.salt, verifier: hmacHex(unlocked.key, Buffer.from('verify')), iter: PBKDF2_ITER },
    enc: encryptJSON(db, unlocked.key),
  });
}

/** 尝试用密码解锁：先验 verifier，再解密数据。成功返回 db，失败返回 null */
function tryUnlock(salt, password) {
  const key = deriveKey(password, salt);
  const env = readEnvelope();
  if (!env) return null;
  if (!timingSafeHexEqual(hmacHex(key, Buffer.from('verify')), env.kdf.verifier)) return null;
  try {
    return { key, db: migrate(decryptJSON(env.enc, key)) };
  } catch (e) {
    return null; // GCM 认证失败 → 密钥不对或文件被篡改
  }
}

function makeSession(salt, key) {
  const token = crypto.randomBytes(32).toString('hex');
  unlocked = { token, salt, key, expires: Date.now() + SESSION_TTL_MS };
  sessions.set(token, unlocked);
  return token;
}
function sessionFromReq(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+([0-9a-f]{64})$/i);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  s.expires = Date.now() + SESSION_TTL_MS; // 滑动续期
  return s;
}
function requireAuth(req, res) {
  const s = sessionFromReq(req);
  if (!s) { sendJSON(res, 401, { error: '未解锁，请先输入访问密码' }); return null; }
  return s;
}

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

/* ---------------- 认证 API（/api/auth/*，无需 token） ---------------- */
function handleAuth(req, res, url) {
  const action = parts2(url)[2]; // ['api','auth',action] -> action

  /* GET /api/auth/status —— 前端据此决定：初始化密码 / 解锁 / 已解锁 */
  if (action === 'status' && req.method === 'GET') {
    const env = readEnvelope();
    const s = sessionFromReq(req);
    return sendJSON(res, 200, {
      initialized: !!env,
      unlocked: !!s,
      lockedForSeconds: Math.max(0, Math.ceil((authFailUntil - Date.now()) / 1000)),
    });
  }

  /* POST /api/auth/init { password } —— 首次使用：设置访问密码并写入加密种子数据 */
  if (action === 'init' && req.method === 'POST') {
    if (readEnvelope()) return sendJSON(res, 409, { error: '系统已初始化，请勿重复设置密码' });
    return readBody(req).then((body) => {
      const pwd = String(body.password || '');
      if (pwd.length < 4) return sendJSON(res, 400, { error: '密码至少 4 位' });
      const salt = crypto.randomBytes(16).toString('hex');
      const key = deriveKey(pwd, salt);
      makeSession(salt, key);
      saveDB(migrate({ items: seedItems(), outbound: seedOutbound(), categories: defaultCategories() }));
      sendJSON(res, 201, { ok: true, token: unlocked.token });
    }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
  }

  /* POST /api/auth/unlock { password } —— 输入密码解密数据并建立会话 */
  if (action === 'unlock' && req.method === 'POST') {
    if (Date.now() < authFailUntil) {
      return sendJSON(res, 429, { error: `尝试过于频繁，请 ${Math.ceil((authFailUntil - Date.now()) / 1000)} 秒后再试` });
    }
    const env = readEnvelope();
    if (!env) return sendJSON(res, 400, { error: '尚未初始化，请先设置访问密码' });
    return readBody(req).then((body) => {
      const res2 = tryUnlock(env.kdf.salt, String(body.password || ''));
      if (!res2) { authFailUntil = Date.now() + 3000; return sendJSON(res, 401, { error: '密码错误' }); }
      makeSession(env.kdf.salt, res2.key);
      db = res2.db;
      sendJSON(res, 200, { ok: true, token: unlocked.token });
    }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
  }

  /* POST /api/auth/lock —— 锁定：清除服务端会话与内存数据 */
  if (action === 'lock' && req.method === 'POST') {
    const s = requireAuth(req, res);
    if (!s) return;
    sessions.delete(s.token);
    if (unlocked && unlocked.token === s.token) unlocked = null;
    db = null;
    return sendJSON(res, 200, { ok: true });
  }

  /* POST /api/auth/password { oldPassword, newPassword } —— 修改密码：
   * 验证旧密码 → 新盐重新派生 → 用新密钥重加密全部数据后原子落盘 */
  if (action === 'password' && req.method === 'POST') {
    const env = readEnvelope();
    if (!env) return sendJSON(res, 400, { error: '尚未初始化' });
    return readBody(req).then((body) => {
      const oldPwd = String(body.oldPassword || '');
      const newPwd = String(body.newPassword || '');
      if (newPwd.length < 4) return sendJSON(res, 400, { error: '新密码至少 4 位' });
      const check = tryUnlock(env.kdf.salt, oldPwd);
      if (!check) return sendJSON(res, 401, { error: '原密码不正确' });
      if (!db) db = check.db; // 理论上已在会话中解锁；兜底
      const newSalt = crypto.randomBytes(16).toString('hex');
      const newKey = deriveKey(newPwd, newSalt);
      if (unlocked) sessions.delete(unlocked.token); // 作废旧会话
      makeSession(newSalt, newKey);
      saveDB(db); // 用新密钥重加密写盘
      sendJSON(res, 200, { ok: true, token: unlocked.token });
    }).catch(() => sendJSON(res, 400, { error: '请求体 JSON 无效' }));
  }

  sendJSON(res, 404, { error: '接口不存在' });
}
function parts2(url) { return url.pathname.split('/').filter(Boolean); } // ['api','auth',...]

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

  if (resource === 'auth') return handleAuth(req, res, url);

  /* —— 其余业务接口一律要求已解锁的 Bearer token；数据只在解锁后驻留内存 —— */
  if (!requireAuth(req, res)) return;

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
    // 导出为密文信封（与磁盘同格式）：备份文件不含明文，换机后用同一密码即可解锁恢复
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="digital-warehouse-export.json"',
    });
    return res.end(JSON.stringify({ app: 'digital-warehouse', encrypted: true, note: 'AES-256-GCM 密文备份，需访问密码才能打开；恢复时直接覆盖 data/items.json', ...readEnvelope() }, null, 2));
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

/* Digital Warehouse 前端逻辑 —— 精简版：在库物品 + 出库记录（送给谁）+ 密码保护/加密存储 */
const $ = (sel) => document.querySelector(sel);

const TOKEN_KEY = 'dw-token';

const state = {
  items: [], categories: [], editingId: null,
  outbound: [], obEditingId: null, outTargetId: null,
  page: 'stock', // 'stock' | 'outbound'
  mode: 'init',  // 锁屏模式：'init' 设置初始密码 | 'unlock' 解锁
  token: localStorage.getItem(TOKEN_KEY) || '',
};

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // 会话过期 / 已在别处锁定 → 回到锁屏
    clearToken();
    showLock();
    throw new Error('已锁定，请重新输入密码');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || '请求失败');
  }
  return res.status === 204 ? null : res.json();
}

function setToken(t) {
  state.token = t;
  localStorage.setItem(TOKEN_KEY, t);
}
function clearToken() {
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
}

/* ---------- 锁屏 / 解锁 ---------- */
function showLock() {
  $('#lock-screen').classList.remove('hidden');
  document.querySelector('.tabs').classList.add('hidden');
  document.querySelector('main').classList.add('hidden');
  $('#btn-new').classList.add('hidden');
  $('#btn-lock').classList.add('hidden');
  $('#lock-error').textContent = '';
  if (state.mode === 'init') {
    $('#lock-title').textContent = '设置访问密码';
    $('#lock-hint').textContent = '首次使用，请设置一个访问密码。数据将以 AES-256-GCM 加密存储，密码只以派生校验值保存——忘记将无法找回。';
    $('#lock-submit').textContent = '初始化并进入';
    $('#lock-pwd').autocomplete = 'new-password';
    $('#lock-pwd2').classList.remove('hidden');
  } else {
    $('#lock-title').textContent = '🔒 仓库已锁定';
    $('#lock-hint').textContent = '请输入访问密码解锁（数据为密文存储，密码错误无法打开）';
    $('#lock-submit').textContent = '解锁进入';
    $('#lock-pwd').autocomplete = 'current-password';
    $('#lock-pwd2').classList.add('hidden');
  }
  $('#lock-pwd').value = '';
  $('#lock-pwd2').value = '';
  setTimeout(() => $('#lock-pwd').focus(), 50);
}

function showApp() {
  $('#lock-screen').classList.add('hidden');
  document.querySelector('.tabs').classList.remove('hidden');
  document.querySelector('main').classList.remove('hidden');
  $('#btn-new').classList.remove('hidden');
  $('#btn-lock').classList.remove('hidden');
}

async function submitLock(e) {
  e.preventDefault();
  const pwd = $('#lock-pwd').value;
  const errEl = $('#lock-error');
  errEl.textContent = '';
  if (state.mode === 'init' && pwd !== $('#lock-pwd2').value) {
    errEl.textContent = '两次输入的密码不一致'; return;
  }
  $('#lock-submit').disabled = true;
  $('#lock-submit').textContent = '处理中…（密钥派生需要几秒）';
  try {
    const r = state.mode === 'init'
      ? await api('/api/auth/init', { method: 'POST', body: JSON.stringify({ password: pwd }) })
      : await api('/api/auth/unlock', { method: 'POST', body: JSON.stringify({ password: pwd }) });
    setToken(r.token);
    showApp();
    await loadAll();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    $('#lock-submit').disabled = false;
  }
}

async function doLock() {
  if (!confirm('确定锁定吗？锁定后需重新输入密码才能查看数据。')) return;
  try { await api('/api/auth/lock', { method: 'POST' }); } catch (e) { /* 服务端可能已失效 */ }
  clearToken();
  state.mode = 'unlock';
  showLock();
}

/* ---------- 修改密码 ---------- */
function openPasswdDialog() {
  $('#passwd-form').reset();
  $('#passwd-error').textContent = '';
  $('#dlg-passwd').showModal();
}

async function submitPasswd(e) {
  e.preventDefault();
  const f = $('#passwd-form');
  const fd = new FormData(f);
  const oldPassword = fd.get('oldPassword'), newPassword = fd.get('newPassword'), confirmPwd = fd.get('confirm');
  const errEl = $('#passwd-error');
  errEl.textContent = '';
  if (newPassword !== confirmPwd) { errEl.textContent = '两次输入的新密码不一致'; return; }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = '重新加密中…';
  try {
    const r = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
    setToken(r.token); // 旧会话已作废，换新 token
    $('#dlg-passwd').close();
    alert('密码已修改，全部数据已用新密码重新加密 ✅');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = '确认修改';
  }
}

/* ---------- 启动：先查状态决定锁屏还是直接进入 ---------- */
async function boot() {
  try {
    const st = await fetch('/api/auth/status', { headers: state.token ? { Authorization: 'Bearer ' + state.token } : {} }).then((r) => r.json());
    if (st.unlocked) { showApp(); await loadAll(); return; }
    state.mode = st.initialized ? 'unlock' : 'init';
    showLock();
  } catch (err) {
    $('#lock-error').textContent = '无法连接服务：' + err.message;
    showLock();
  }
}

async function loadAll() {
  await loadCategories();
  await loadItems();
  await loadOutbound(); // 预载出库记录，用于统计卡片
}

/* ---------- 加载 ---------- */
async function loadCategories() {
  state.categories = await api('/api/categories');
  const opts = state.categories
    .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
    .join('');
  $('#filter-category').innerHTML = '<option value="">全部分类</option>' + opts;
  $('#ob-filter-category').innerHTML = '<option value="">全部分类</option>' + opts;
  $('#form-category').innerHTML = opts + '<option value="__new__">＋ 新分类…</option>';
}

async function loadItems() {
  const params = new URLSearchParams();
  const kw = $('#search').value.trim();
  const cat = $('#filter-category').value;
  const sort = $('#sort').value;
  if (kw) params.set('q', kw);
  if (cat) params.set('category', cat);
  params.set('sort', sort);
  state.items = await api('/api/items?' + params.toString());
  renderList();
  loadStats();
}

async function loadOutbound() {
  const params = new URLSearchParams();
  const kw = $('#ob-search').value.trim();
  const cat = $('#ob-filter-category').value;
  const sort = $('#ob-sort').value;
  if (kw) params.set('q', kw);
  if (cat) params.set('category', cat);
  params.set('sort', sort);
  state.outbound = await api('/api/outbound?' + params.toString());
  renderOutbound();
  loadStats();
}

async function loadStats() {
  const s = await api('/api/stats');
  $('#st-total').textContent = s.total;
  $('#st-out-total').textContent = s.outboundTotal ?? 0;
}

/* ---------- 渲染 ---------- */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CAT_ICON = { '茶叶': '🍵', '白酒': '🍶', '红酒': '🍷', '洋酒': '🥃', '保健品': '💊', '香烟': '🚬', '礼品': '🎁', '食品': '🍜' };
const catIcon = (c) => CAT_ICON[c] || '📦';

/* 时间徽章：在库时长；超过 1 年的茶叶/食品给个温和提示，酒类陈放反而是好事 */
function timeBadge(it) {
  const d = it.meta && it.meta.daysIn;
  if (d == null) return '';
  const years = Math.floor(d / 365);
  const dur = years >= 1 ? `${years}年${Math.floor((d % 365) / 30)}个月` : (d >= 30 ? `${Math.floor(d / 30)}个月（${d}天）` : `${d}天`);
  if (d > 365 && ['茶叶', '食品', '保健品'].includes(it.category)) {
    return `<span class="badge warn">⏳ 已存放 ${dur}，注意赏味期</span>`;
  }
  return `<span class="badge ok">🕐 已存放 ${dur}</span>`;
}

function renderList() {
  const list = $('#list');
  if (!state.items.length) {
    list.innerHTML = '';
    $('#empty').classList.remove('hidden');
    return;
  }
  $('#empty').classList.add('hidden');
  list.innerHTML = state.items.map((it) => `
    <article class="item" data-id="${it.id}">
      <div class="item-head">
        <h3 class="item-name">${catIcon(it.category)} ${esc(it.name)} ×${it.quantity}${esc(it.unit || '')}</h3>
        <span class="item-cat">${esc(it.category)}</span>
      </div>
      <div class="meta">
        ${it.spec ? `<b>${esc(it.spec)}</b><br>` : ''}
        📥 入库：${esc(it.inDate || '—')}${it.location ? ' · 📍 ' + esc(it.location) : ''}<br>
        ${it.notes ? `📝 ${esc(it.notes)}` : ''}
      </div>
      <div class="badges">
        ${timeBadge(it)}
      </div>
      <div class="row-actions">
        <button class="btn out small" data-act="out">📤 出库</button>
        <span class="spacer"></span>
        <button class="btn ghost small" data-act="edit">编辑</button>
        <button class="btn danger-ghost small" data-act="del">删除</button>
      </div>
    </article>`).join('');
}

/* ---------- 渲染：出库记录页 ---------- */
function outDurationBadge(rec) {
  const d = rec.meta && rec.meta.daysOut;
  if (d == null) return '';
  const years = Math.floor(d / 365);
  const dur = years >= 1 ? `${years}年${Math.floor((d % 365) / 30)}个月` : (d >= 30 ? `${Math.floor(d / 30)}个月（${d}天）` : `${d}天`);
  return `<span class="badge muted">🕐 已出库 ${dur}</span>`;
}

function renderOutbound() {
  const list = $('#ob-list');
  if (!state.outbound.length) {
    list.innerHTML = '';
    $('#ob-empty').classList.remove('hidden');
    return;
  }
  $('#ob-empty').classList.add('hidden');
  list.innerHTML = state.outbound.map((rec) => `
    <article class="item" data-id="${rec.id}">
      <div class="item-head">
        <h3 class="item-name">${catIcon(rec.category)} ${esc(rec.name)} ×${rec.quantity}${esc(rec.unit || '')}</h3>
        <span class="item-cat">${esc(rec.category)}</span>
      </div>
      <div class="meta">
        ${rec.spec ? `<b>${esc(rec.spec)}</b><br>` : ''}
        🎁 送给：<b>${esc(rec.recipient || '未填写')}</b>${rec.reason ? ' · ' + esc(rec.reason) : ''}<br>
        📥 入库：${esc(rec.inDate || '—')} → 📤 出库：${esc(rec.outDate || '—')}<br>
        ${rec.notes ? `📝 ${esc(rec.notes)}` : ''}
      </div>
      <div class="badges">
        ${outDurationBadge(rec)}
      </div>
      <div class="row-actions">
        <span class="spacer"></span>
        <button class="btn ghost small" data-act="ob-edit">编辑</button>
        <button class="btn danger-ghost small" data-act="ob-del">删除</button>
      </div>
    </article>`).join('');
}

/* ---------- 表单 ---------- */
function openDialog(item) {
  state.editingId = item ? item.id : null;
  $('#dlg-title').textContent = item ? '编辑记录' : '入库登记';
  const f = $('#form');
  f.reset();
  $('#new-category').classList.add('hidden');
  if (item) {
    for (const k of ['name','spec','quantity','unit','inDate','location','notes']) {
      if (f.elements[k]) f.elements[k].value = item[k] ?? '';
    }
    if (state.categories.includes(item.category)) f.elements.category.value = item.category;
    else { f.elements.category.value = '__new__'; $('#new-category').classList.remove('hidden'); $('#new-category').value = item.category; }
  }
  $('#dlg').showModal();
}

async function submitForm(e) {
  e.preventDefault();
  const f = $('#form');
  const fd = new FormData(f);
  const body = Object.fromEntries(fd.entries());
  if (body.category === '__new__') {
    body.category = (body.newCategory || '').trim() || '其他';
  }
  delete body.newCategory;
  try {
    if (state.editingId) {
      await api('/api/items/' + state.editingId, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/items', { method: 'POST', body: JSON.stringify(body) });
    }
    $('#dlg').close();
    await loadCategories();
    await loadItems();
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- 出库弹窗 ---------- */
function openOutDialog(item) {
  state.outTargetId = item.id;
  const f = $('#out-form');
  f.reset();
  $('#out-summary').textContent = `${item.name} ×${item.quantity}${item.unit || ''}（${item.category}${item.spec ? ' · ' + item.spec : ''}）`;
  f.elements.outDate.value = new Date().toISOString().slice(0, 10); // 默认今天
  $('#dlg-out').showModal();
  f.elements.recipient.focus();
}

async function submitOut(e) {
  e.preventDefault();
  const f = $('#out-form');
  const body = Object.fromEntries(new FormData(f).entries());
  try {
    await api(`/api/items/${state.outTargetId}/out`, { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-out').close();
    await Promise.all([loadItems(), loadOutbound()]);
  } catch (err) { alert(err.message); }
}

/* ---------- 编辑出库记录 ---------- */
function openObEditDialog(rec) {
  state.obEditingId = rec.id;
  const f = $('#ob-edit-form');
  f.reset();
  $('#ob-edit-summary').textContent = `${rec.name} ×${rec.quantity}${rec.unit || ''}（${rec.category}）`;
  for (const k of ['recipient', 'reason', 'outDate', 'notes']) {
    if (f.elements[k]) f.elements[k].value = rec[k] ?? '';
  }
  $('#dlg-ob-edit').showModal();
}

async function submitObEdit(e) {
  e.preventDefault();
  const f = $('#ob-edit-form');
  const body = Object.fromEntries(new FormData(f).entries());
  try {
    await api('/api/outbound/' + state.obEditingId, { method: 'PUT', body: JSON.stringify(body) });
    $('#dlg-ob-edit').close();
    await loadOutbound();
  } catch (err) { alert(err.message); }
}

/* ---------- 页面切换 ---------- */
function switchPage(page) {
  state.page = page;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
  $('#page-stock').classList.toggle('hidden', page !== 'stock');
  $('#page-outbound').classList.toggle('hidden', page !== 'outbound');
  if (page === 'outbound') loadOutbound();
}

/* ---------- 事件 ---------- */
$('#btn-new').addEventListener('click', () => openDialog(null));
$('#btn-cancel').addEventListener('click', () => $('#dlg').close());
$('#form').addEventListener('submit', submitForm);
$('#form-category').addEventListener('change', (e) => {
  $('#new-category').classList.toggle('hidden', e.target.value !== '__new__');
});
$('#btn-out-cancel').addEventListener('click', () => $('#dlg-out').close());
$('#out-form').addEventListener('submit', submitOut);
$('#btn-ob-cancel').addEventListener('click', () => $('#dlg-ob-edit').close());
$('#ob-edit-form').addEventListener('submit', submitObEdit);
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchPage(t.dataset.page)));

let debounce, obDebounce;
$('#search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(loadItems, 250); });
$('#filter-category').addEventListener('change', loadItems);
$('#sort').addEventListener('change', loadItems);
$('#ob-search').addEventListener('input', () => { clearTimeout(obDebounce); obDebounce = setTimeout(loadOutbound, 250); });
$('#ob-filter-category').addEventListener('change', loadOutbound);
$('#ob-sort').addEventListener('change', loadOutbound);

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const item = state.items.find((x) => x.id === id);
  const act = btn.dataset.act;
  try {
    if (act === 'edit') return openDialog(item);
    if (act === 'out') return openOutDialog(item); /* 出库：弹窗登记送给谁，确认后从在库列表消失 */
    if (act === 'del') {
      if (!confirm(`确定删除「${item.name}」吗？（仅删除记录，不会写入出库记录）`)) return;
      await api('/api/items/' + id, { method: 'DELETE' });
      await loadItems();
    }
  } catch (err) { alert(err.message); }
});

$('#ob-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const rec = state.outbound.find((x) => x.id === id);
  const act = btn.dataset.act;
  try {
    if (act === 'ob-edit') return openObEditDialog(rec);
    if (act === 'ob-del') {
      if (!confirm(`确定删除这条出库记录吗？（「${rec.name}」送给 ${rec.recipient || '未填写'}）`)) return;
      await api('/api/outbound/' + id, { method: 'DELETE' });
      await loadOutbound();
    }
  } catch (err) { alert(err.message); }
});

$('#btn-export').addEventListener('click', async () => {
  // 导出为密文备份：接口需要 Bearer token，用 fetch 拿 blob 再触发下载
  try {
    const res = await fetch('/api/export', { headers: { Authorization: 'Bearer ' + state.token } });
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'digital-warehouse-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { alert(err.message); }
});

/* ---------- 锁屏 / 密码相关事件 ---------- */
$('#lock-form').addEventListener('submit', submitLock);
$('#btn-lock').addEventListener('click', doLock);
$('#btn-passwd').addEventListener('click', openPasswdDialog);
$('#btn-passwd-cancel').addEventListener('click', () => $('#dlg-passwd').close());
$('#passwd-form').addEventListener('submit', submitPasswd);

/* ---------- 启动 ---------- */
boot();

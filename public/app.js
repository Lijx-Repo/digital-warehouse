/* Digital Warehouse 前端逻辑（初版） */
const $ = (sel) => document.querySelector(sel);

const state = { items: [], categories: [], editingId: null };

const fmtMoney = (n) =>
  n == null || isNaN(n) ? '—' : '¥' + Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || '请求失败');
  }
  return res.status === 204 ? null : res.json();
}

/* ---------- 加载 ---------- */
async function loadCategories() {
  state.categories = await api('/api/categories');
  const opts = state.categories
    .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
    .join('');
  $('#filter-category').innerHTML = '<option value="">全部分类</option>' + opts;
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

async function loadStats() {
  const s = await api('/api/stats');
  $('#st-count').textContent = s.count;
  $('#st-value').textContent = fmtMoney(s.totalValue).replace('¥', '');
  $('#st-expiring').textContent = s.expiringSoon;
  $('#st-expired').textContent = s.expired;
}

/* ---------- 渲染 ---------- */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function warrantyBadge(it) {
  const w = it.warranty || {};
  if (w.status === '保修中') return `<span class="badge ok">🛡 保修中 · 剩余${w.daysLeft}天</span>`;
  if (w.status === '即将过保') return `<span class="badge warn">⏰ 即将过保 · ${w.endDate}</span>`;
  if (w.status === '已过保') return `<span class="badge danger">已过保 (${w.endDate})</span>`;
  return '';
}

/* 保质期徽章：茶叶/食品看 expiryDate；白酒、普洱等可陈化物品留空则显示「宜陈放」 */
function shelfLifeBadge(it) {
  const s = it.shelfLife || {};
  if (s.status === '已过期') return `<span class="badge danger">⚠️ 已过期 (${esc(it.expiryDate)})</span>`;
  if (s.status === '临期') return `<span class="badge danger">⏰ 临期 · 剩${s.daysLeft}天</span>`;
  if (s.status === '保质期内') return `<span class="badge ok">✅ 保质期内 · ${esc(it.expiryDate)}</span>`;
  if (it.expiryDate) return `<span class="badge neutral">保质期 ${esc(it.expiryDate)}</span>`;
  return `<span class="badge neutral">🍶 宜陈放 · 无保质期</span>`;
}

const CAT_ICON = { '茶叶': '🍵', '白酒': '🍶', '红酒': '🍷', '洋酒': '🥃', '保健品': '💊', '香烟': '🚬', '礼品': '🎁', '食品': '🍜' };
const catIcon = (c) => CAT_ICON[c] || '📦';

const STATUS_MAP = {
  '在库': 'ok', '部分送出': 'neutral', '已送出': 'muted',
  '已饮用': 'muted', '已食用': 'muted', '已闲置': 'neutral', '已报废': 'danger',
};
function statusBadge(s) {
  const cls = STATUS_MAP[s] || 'neutral';
  return `<span class="badge ${cls}">${esc(s || '在库')}</span>`;
}

function conditionBadge(c) {
  const map = { '全新': 'ok', '良好': 'ok', '一般': 'neutral', '故障': 'warn', '已报废': 'danger' };
  return `<span class="badge ${map[c] || 'neutral'}">${esc(c)}</span>`;
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
        <h3 class="item-name">${catIcon(it.category)} ${esc(it.name)}${it.quantity > 1 ? ` ×${it.quantity}${esc(it.unit || '')}` : ''}</h3>
        <span class="item-cat">${esc(it.category)}</span>
      </div>
      <div class="meta">
        ${it.brand ? `<b>${esc(it.brand)}</b>${it.model ? ' · ' + esc(it.model) : ''}<br>` : (it.model ? `<b>${esc(it.model)}</b><br>` : '')}
        ${it.productionDate ? `🏷 年份/生产：${esc(it.productionDate)}<br>` : ''}
        ${it.purchaseDate ? `购于 ${esc(it.purchaseDate)}${it.store ? '（' + esc(it.store) + '）' : ''}<br>` : ''}
        ${it.location ? `📍 ${esc(it.location)}${it.storage ? ' · 存储：' + esc(it.storage) : ''}` : (it.storage ? '🧊 存储：' + esc(it.storage) : '')}
        ${it.serial ? `<br>🔎 ${esc(it.serial)}` : ''}
        ${it.notes ? `<br>📝 ${esc(it.notes)}` : ''}
      </div>
      <div class="badges">
        ${statusBadge(it.status)}
        ${shelfLifeBadge(it)}
        ${warrantyBadge(it)}
        ${conditionBadge(it.condition)}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
        <span class="price">${fmtMoney(it.valuePerUnit != null ? it.valuePerUnit : it.price)}${it.price != null && it.valuePerUnit == null && it.quantity > 1 ? ` <small>/件 · 共${fmtMoney(it.price * it.quantity)}</small>` : ''}</span>
        <div class="item-actions">
          <button class="btn ghost small" data-act="edit">编辑</button>
          <button class="btn danger-ghost small" data-act="del">删除</button>
        </div>
      </div>
    </article>`).join('');
}

/* ---------- 表单 ---------- */
function openDialog(item) {
  state.editingId = item ? item.id : null;
  $('#dlg-title').textContent = item ? '编辑物品' : '添加物品';
  const f = $('#form');
  f.reset();
  $('#new-category').classList.add('hidden');
  if (item) {
    for (const k of ['name','brand','model','serial','purchaseDate','price','valuePerUnit','quantity','unit','warrantyMonths','productionDate','expiryDate','storage','status','store','location','condition','notes']) {
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

/* ---------- 事件 ---------- */
$('#btn-new').addEventListener('click', () => openDialog(null));
$('#btn-cancel').addEventListener('click', () => $('#dlg').close());
$('#form').addEventListener('submit', submitForm);
$('#form-category').addEventListener('change', (e) => {
  $('#new-category').classList.toggle('hidden', e.target.value !== '__new__');
});

let debounce;
$('#search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(loadItems, 250); });
$('#filter-category').addEventListener('change', loadItems);
$('#sort').addEventListener('change', loadItems);

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const item = state.items.find((x) => x.id === id);
  if (btn.dataset.act === 'edit') openDialog(item);
  if (btn.dataset.act === 'del') {
    if (!confirm(`确定删除「${item.name}」吗？`)) return;
    try {
      await api('/api/items/' + id, { method: 'DELETE' });
      await loadItems();
    } catch (err) { alert(err.message); }
  }
});

$('#btn-export').addEventListener('click', () => {
  window.location.href = '/api/export';
});

/* ---------- 启动 ---------- */
(async function init() {
  try {
    await loadCategories();
    await loadItems();
  } catch (err) {
    alert('初始化失败：' + err.message);
  }
})();

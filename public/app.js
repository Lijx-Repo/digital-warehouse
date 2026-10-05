/* Digital Warehouse 前端逻辑 —— 精简版：入库 / 出库 / 时间追踪 */
const $ = (sel) => document.querySelector(sel);

const state = { items: [], categories: [], editingId: null };

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
  const stock = $('#filter-stock').value;
  const sort = $('#sort').value;
  if (kw) params.set('q', kw);
  if (cat) params.set('category', cat);
  if (stock) params.set('stock', stock);
  params.set('sort', sort);
  state.items = await api('/api/items?' + params.toString());
  renderList();
  loadStats();
}

async function loadStats() {
  const s = await api('/api/stats');
  $('#st-total').textContent = s.total;
  $('#st-in').textContent = s.inStockCount;
  $('#st-out').textContent = s.outStockCount;
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
  if (it.outDate) return `<span class="badge muted">🕐 存放 ${dur}</span>`;
  if (d > 365 && ['茶叶', '食品', '保健品'].includes(it.category)) {
    return `<span class="badge warn">⏳ 已存放 ${dur}，注意赏味期</span>`;
  }
  return `<span class="badge ok">🕐 已存放 ${dur}</span>`;
}

function stockBadge(it) {
  return it.inStock
    ? '<span class="badge ok">📥 在库</span>'
    : `<span class="badge muted">📤 已出库 · ${esc(it.outDate)}</span>`;
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
    <article class="item ${it.inStock ? '' : 'out'}" data-id="${it.id}">
      <div class="item-head">
        <h3 class="item-name">${catIcon(it.category)} ${esc(it.name)} ×${it.quantity}${esc(it.unit || '')}</h3>
        <span class="item-cat">${esc(it.category)}</span>
      </div>
      <div class="meta">
        ${it.spec ? `<b>${esc(it.spec)}</b><br>` : ''}
        📥 入库：${esc(it.inDate || '—')}${it.location ? ' · 📍 ' + esc(it.location) : ''}<br>
        ${it.outDate ? `📤 出库：${esc(it.outDate)}<br>` : ''}
        ${it.notes ? `📝 ${esc(it.notes)}` : ''}
      </div>
      <div class="badges">
        ${stockBadge(it)}
        ${timeBadge(it)}
      </div>
      <div class="row-actions">
        ${it.inStock
          ? '<button class="btn out small" data-act="out">📤 出库</button>'
          : '<button class="btn ghost small" data-act="in">↩ 撤销出库</button>'}
        <span class="spacer"></span>
        <button class="btn ghost small" data-act="edit">编辑</button>
        <button class="btn danger-ghost small" data-act="del">删除</button>
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
    for (const k of ['name','spec','quantity','unit','inDate','outDate','location','notes']) {
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
$('#filter-stock').addEventListener('change', loadItems);
$('#sort').addEventListener('change', loadItems);

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const item = state.items.find((x) => x.id === id);
  const act = btn.dataset.act;
  try {
    if (act === 'edit') return openDialog(item);
    if (act === 'out') {
      const date = prompt(`「${item.name}」出库日期（留空默认今天）`, new Date().toISOString().slice(0, 10));
      if (date === null) return;
      await api(`/api/items/${id}/out`, { method: 'POST', body: JSON.stringify({ date }) });
    }
    if (act === 'in') {
      await api(`/api/items/${id}/in`, { method: 'POST', body: '{}' });
    }
    if (act === 'del') {
      if (!confirm(`确定删除「${item.name}」吗？`)) return;
      await api('/api/items/' + id, { method: 'DELETE' });
    }
    await loadItems();
  } catch (err) { alert(err.message); }
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

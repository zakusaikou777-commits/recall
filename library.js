/* ============================================================
   Recall — ライブラリ画面
   ============================================================ */
import {
  getAll, putItems, removeItems, replaceMeta, makeItem, review, resume, isDue, usage,
  domainOf, faviconUrl, fmtDate, tagCounts, matches, normalizeTags, clip, wipeAll,
  thumbOf, youtubeId, fmtDuration, syncPush,
  STATUS, STATUS_LABEL, PRESET_INTERVALS, CAT_COLORS, DEFAULT_STEPS, DEFAULT_META,
  newId, LIMITS
} from './store.js';
import { CHANGELOG, currentVersion, entryFor } from './changelog.js';
import { KN_CATEGORIES, originOf, clipEnabled, MAX_TRIES } from './kininari.js';

const $ = (id) => document.getElementById(id);
let items = [], meta = null, rich = {};
let view = 'all', activeTag = null, query = '', sort = 'new';
let selMode = false, selection = new Set();
let focusQueue = [], focusIdx = 0;
let muteReload = false;

const ICONS = {
  bell: 'M12 2a6 6 0 00-6 6v3.7l-1.6 3a1 1 0 00.9 1.5h13.4a1 1 0 00.9-1.5l-1.6-3V8a6 6 0 00-6-6zm0 20a2.6 2.6 0 002.6-2.5H9.4A2.6 2.6 0 0012 22z',
  stack: 'M12 3l9 4.5-9 4.5-9-4.5L12 3zm0 8.7l6.9-3.4 2.1 1L12 13.9 3 9.3l2.1-1L12 11.7zm0 4.4l6.9-3.4 2.1 1L12 18.3 3 13.7l2.1-1L12 16.1z',
  inbox: 'M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zm1 9v5h14v-5h-4a3 3 0 01-6 0H5zm0-7v5h5.6c.3 0 .5.2.6.5a1.9 1.9 0 003.6 0c.1-.3.3-.5.6-.5H19V6H5z',
  book: 'M4 4h6a2 2 0 012 2v13a2 2 0 00-2-1.5H4V4zm16 0h-6a2 2 0 00-2 2v13a2 2 0 012-1.5h6V4z',
  star: 'M12 2.5l2.9 5.9 6.6 1-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5-4.8-4.6 6.6-1L12 2.5z',
  check: 'M9.2 16.4L4.9 12.1l-1.5 1.5L9.2 19.4 21 7.6 19.5 6 9.2 16.4z',
  archive: 'M3 4h18v4H3V4zm1.6 5.5h14.8V20H4.6V9.5zM9 12h6v2H9v-2z'
};
const VIEWS = [
  { key: 'review', ico: 'bell', label: '今日の復習', due: true },
  { key: 'all', ico: 'stack', label: 'すべて' },
  { key: 'new', ico: 'inbox', label: '未読' },
  { key: 'learning', ico: 'book', label: '学習中' },
  { key: 'fav', ico: 'star', label: 'お気に入り' },
  { key: 'done', ico: 'check', label: '完了' },
  { key: 'archived', ico: 'archive', label: 'アーカイブ' }
];
const svgIcon = (name) =>
  `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

boot();

async function boot() {
  ({ items, meta, rich } = await getAll());
  try { sort = localStorage.getItem('recall.sort') || 'new'; } catch { sort = 'new'; }
  if (!['new', 'old', 'due', 'title', 'domain'].includes(sort)) sort = 'new';
  $('sort').value = sort;
  applyHash();
  bind();
  render();
  if (new URLSearchParams(location.search).get('welcome')) $('welcome').classList.remove('hidden');
  renderVersion();
  await showUpdateNotice();

  chrome.storage.onChanged.addListener(async (_c, area) => {
    if ((area !== 'sync' && area !== 'local') || muteReload) return;
    if (Object.keys(_c).every(k => k === 'lastNotified')) return;
    ({ items, meta, rich } = await getAll());
    // 埋め込み動画を見ている最中に作り直すと再生が止まるので、そのときは描き直さない
    if (document.querySelector('.thumb.playing')) { renderUsage(); return; }
    render();
  });
}

/* ---------- ルーティング ---------- */

function applyHash() {
  let h = '';
  try { h = decodeURIComponent(location.hash.replace(/^#/, '')); }
  catch { h = location.hash.replace(/^#/, ''); }     // 不正な % があっても落とさない
  activeTag = null;
  if (h.startsWith('tag/')) { view = 'tag'; activeTag = h.slice(4); }
  else if (h.startsWith('cat/')) { view = 'cat:' + h.slice(4); }
  else if (h.startsWith('q/')) {                     // アドレスバー検索からの引き継ぎ
    view = 'all';
    query = h.slice(2);
    const box = $('q');
    if (box) { box.value = query; $('qClear').classList.toggle('hidden', !query); }
  } else if (h) view = h;
  else view = 'all';
  pruneSelection();
}

/** 表示されていない項目が選択に残らないようにする（見えない項目の一括削除を防ぐ） */
function pruneSelection() {
  if (!selection.size) return;
  const visible = new Set(filtered().map(i => i.id));
  for (const id of [...selection]) if (!visible.has(id)) selection.delete(id);
}

function go(hash) { location.hash = hash; applyHash(); render(); }

/* ---------- 絞り込み ---------- */

function filtered() {
  const now = Date.now();
  let out = items.filter(it => {
    if (view === 'review') return isDue(it, now);
    if (view === 'all') return it.s !== STATUS.ARCHIVED;
    if (view === 'new') return it.s === STATUS.NEW;
    if (view === 'learning') return it.s === STATUS.LEARNING;
    if (view === 'done') return it.s === STATUS.DONE;
    if (view === 'archived') return it.s === STATUS.ARCHIVED;
    if (view === 'fav') return it.f === 1 && it.s !== STATUS.ARCHIVED;
    if (view === 'tag') return it.s !== STATUS.ARCHIVED && (it.g || []).includes(activeTag);
    if (view.startsWith('cat:')) return it.s !== STATUS.ARCHIVED && it.c === view.slice(4);
    return true;
  });
  if (activeTag && view !== 'tag') out = out.filter(it => (it.g || []).includes(activeTag));
  if (query) out = out.filter(it => matches(it, query));

  const cmp = {
    new: (a, b) => b.cr - a.cr,
    old: (a, b) => a.cr - b.cr,
    due: (a, b) => (a.d || Infinity) - (b.d || Infinity),
    title: (a, b) => String(a.t).localeCompare(String(b.t), 'ja'),
    domain: (a, b) => domainOf(a.u).localeCompare(domainOf(b.u)) || b.cr - a.cr
  }[sort] || ((a, b) => b.cr - a.cr);
  return out.sort(cmp);
}

function counts() {
  const now = Date.now();
  const live = items.filter(i => i.s !== STATUS.ARCHIVED);
  return {
    review: items.filter(i => isDue(i, now)).length,
    all: live.length,
    new: items.filter(i => i.s === STATUS.NEW).length,
    learning: items.filter(i => i.s === STATUS.LEARNING).length,
    done: items.filter(i => i.s === STATUS.DONE).length,
    archived: items.filter(i => i.s === STATUS.ARCHIVED).length,
    fav: live.filter(i => i.f === 1).length
  };
}

const catById = (id) => meta.cats.find(c => c.id === id) || { id, name: '未分類', color: '#94a3b8' };

/* ---------- 描画 ---------- */

function render() { renderSide(); renderList(); renderUsage(); }

function renderSide() {
  const c = counts();
  const nav = $('views'); nav.innerHTML = '';
  for (const v of VIEWS) {
    const n = c[v.key] || 0;
    const el = document.createElement('div');
    el.className = 'navitem' + (view === v.key ? ' on' : '') + (v.due && n ? ' due' : '');
    el.innerHTML = `${svgIcon(v.ico)}<span class="grow truncate"></span><span class="n"></span>`;
    el.children[1].textContent = v.label;
    el.children[2].textContent = n ? String(n) : '';
    el.onclick = () => go(v.key);
    nav.appendChild(el);
  }

  const cl = $('catList'); cl.innerHTML = '';
  const per = {};
  for (const it of items) if (it.s !== STATUS.ARCHIVED) per[it.c] = (per[it.c] || 0) + 1;
  for (const cat of meta.cats) {
    const el = document.createElement('div');
    el.className = 'navitem' + (view === 'cat:' + cat.id ? ' on' : '');
    el.innerHTML = `<span class="dot"></span><span class="grow truncate"></span><span class="n"></span>`;
    el.children[0].style.background = cat.color;
    el.children[1].textContent = cat.name;
    el.children[2].textContent = per[cat.id] ? String(per[cat.id]) : '';
    el.onclick = () => go('cat/' + encodeURIComponent(cat.id));
    cl.appendChild(el);
  }

  const tc = tagCounts(items.filter(i => i.s !== STATUS.ARCHIVED));
  const cloud = $('tagCloud'); cloud.innerHTML = '';
  if (!tc.length) cloud.innerHTML = '<span class="faint" style="font-size:11.5px">まだタグがありません</span>';
  for (const [t, n] of tc.slice(0, 40)) {
    const el = document.createElement('span');
    el.className = 'chip' + (activeTag === t ? ' on' : '');
    el.textContent = `${t} ${n}`;
    el.onclick = () => (activeTag === t ? go('all') : go('tag/' + encodeURIComponent(t)));
    cloud.appendChild(el);
  }
}

function viewLabel() {
  if (view === 'tag') return '# ' + activeTag;
  if (view.startsWith('cat:')) return catById(view.slice(4)).name;
  return (VIEWS.find(v => v.key === view) || { label: 'すべて' }).label;
}

function renderList() {
  const list = filtered();
  // 一括操作やアーカイブで見えなくなった項目が選択に残らないようにする
  if (selection.size) {
    const visible = new Set(list.map(i => i.id));
    for (const id of [...selection]) if (!visible.has(id)) selection.delete(id);
  }
  $('viewTitle').textContent = viewLabel();
  $('viewCount').textContent = `${list.length} 件` + (query ? `（「${query}」で絞り込み）` : '');
  $('startReview').classList.toggle('hidden', !(view === 'review' && list.length));

  const box = $('list'); box.innerHTML = '';
  updateBulkBar();
  $('empty').classList.toggle('hidden', list.length > 0);
  if (!list.length) {
    $('empty').innerHTML = query
      ? '<b>見つかりませんでした</b>別のことばで検索してみてください。'
      : (view === 'review'
        ? '<b>今日の復習はありません 🎉</b>次の予定が来たらここに並びます。'
        : '<b>まだ何も保存されていません</b>ツールバーの Recall ボタン（Alt+S）でページを保存できます。');
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of list) frag.appendChild(card(it));
  box.appendChild(frag);
}

function card(it) {
  const cat = catById(it.c);
  const el = document.createElement('article');
  el.className = 'card' + (isDue(it) ? ' duenow' : '') + (selection.has(it.id) ? ' sel' : '');

  if (selMode) {
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.className = 'chk'; chk.checked = selection.has(it.id);
    chk.onchange = () => { chk.checked ? selection.add(it.id) : selection.delete(it.id); renderList(); };
    el.appendChild(chk);
  }

  const thumb = meta.s.thumbs === false ? '' : thumbOf(it, rich[it.id]);
  if (thumb) {
    el.appendChild(thumbBox(it, thumb, 'card'));   // クラスは thumb--card
  } else {
    const fav = document.createElement('img');
    fav.className = 'favicon'; fav.src = faviconUrl(it.u, 32); fav.alt = '';
    fav.style.marginTop = '3px';
    fav.onerror = () => { fav.style.visibility = 'hidden'; };
    el.appendChild(fav);
  }

  const body = document.createElement('div');
  body.className = 'body';

  const tl = document.createElement('div'); tl.className = 'titleline';
  const a = document.createElement('a');
  a.className = 'title grow truncate'; a.href = it.u; a.target = '_blank'; a.rel = 'noopener';
  a.textContent = it.t || it.u;
  a.title = it.u;
  tl.appendChild(a);
  body.appendChild(tl);

  const meta_ = document.createElement('div'); meta_.className = 'meta';
  meta_.appendChild(pill(cat.name, cat.color));
  const r = rich[it.id] || {};
  meta_.appendChild(txt(r.au ? `${domainOf(it.u)}・${r.au}` : (r.si || domainOf(it.u))));
  const st = document.createElement('span');
  st.className = 'statuspill st' + it.s; st.textContent = STATUS_LABEL[it.s];
  meta_.appendChild(st);
  if (it.s === STATUS.NEW || it.s === STATUS.LEARNING) {
    const d = document.createElement('span');
    d.className = isDue(it) ? 'due-over' : 'due-badge';
    d.textContent = isDue(it) ? `復習: ${fmtDate(it.d)}` : `次回 ${fmtDate(it.d)}`;
    meta_.appendChild(d);
  }
  if (it.rv) meta_.appendChild(txt(`${it.rv}回`));
  for (const t of it.g || []) {
    const c = document.createElement('span'); c.className = 'chip'; c.textContent = '#' + t;
    c.style.cursor = 'pointer';
    c.onclick = () => go('tag/' + encodeURIComponent(t));
    meta_.appendChild(c);
  }
  body.appendChild(meta_);

  if (it.n) { const n = document.createElement('div'); n.className = 'note'; n.textContent = it.n; body.appendChild(n); }
  el.appendChild(body);

  const acts = document.createElement('div'); acts.className = 'acts';
  const star = document.createElement('button');
  star.className = 'star' + (it.f ? ' on' : ''); star.textContent = it.f ? '★' : '☆';
  star.title = 'お気に入り';
  star.onclick = async () => { await save([{ ...it, f: it.f ? 0 : 1 }]); };
  acts.appendChild(star);

  if (it.s === STATUS.NEW || it.s === STATUS.LEARNING) {
    acts.appendChild(btn('覚えた', 'btn sm', async () => { await save([review(it, 'ok', meta)]); }));
    acts.appendChild(btn('まだ', 'btn sm ghost', async () => { await save([review(it, 'again', meta)]); }));
  } else if (it.s === STATUS.DONE) {
    acts.appendChild(btn('再開', 'btn sm ghost', async () => { await save([resume(it, meta, 0)]); }));
  } else {
    acts.appendChild(btn('戻す', 'btn sm ghost', async () => { await save([resume(it, meta, 0)]); }));
  }
  acts.appendChild(btn('編集', 'btn sm ghost', () => openEdit(it)));
  el.appendChild(acts);
  return el;
}

/** サムネイル。YouTube はクリックでその場再生に切り替わる */
function thumbBox(it, src, variant) {
  const vid = youtubeId(it.u);
  const box = document.createElement('div');
  box.className = 'thumb thumb--' + variant;

  const img = document.createElement('img');
  img.src = src; img.alt = ''; img.loading = 'lazy';
  // 画像が読み込めなくても（オフライン・画像ブロック時など）再生ボタンは残す
  img.onerror = () => {
    box.classList.add('noimg');
    const fb = document.createElement('img');
    fb.className = 'fallback'; fb.src = faviconUrl(it.u, 32); fb.alt = '';
    fb.onerror = () => fb.remove();
    box.appendChild(fb);
  };
  box.appendChild(img);

  const dur = fmtDuration((rich[it.id] || {}).du);
  if (dur) {
    const d = document.createElement('span');
    d.className = 'dur'; d.textContent = dur;
    box.appendChild(d);
  }

  if (vid && meta.s.embed !== false) {
    const play = document.createElement('button');
    play.className = 'play'; play.title = 'ここで再生';
    play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    play.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const frame = document.createElement('iframe');
      frame.src = `https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0`;
      frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      box.replaceChildren(frame);
      box.classList.add('playing');
    };
    box.appendChild(play);
  } else if (!vid) {
    const a = document.createElement('a');
    a.className = 'cover'; a.href = it.u; a.target = '_blank'; a.rel = 'noopener';
    box.appendChild(a);
  }
  return box;
}

function pill(text, color) {
  const s = document.createElement('span'); s.className = 'chip';
  s.innerHTML = '<span class="dot"></span><span></span>';
  s.firstElementChild.style.background = color;
  s.lastElementChild.textContent = text;
  return s;
}
function txt(t) { const s = document.createElement('span'); s.textContent = t; return s; }
function btn(label, cls, fn) { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; return b; }

async function renderUsage() {
  const u = await usage();
  const pct = Math.min(100, Math.round(u.pct * 100));
  $('usageText').textContent = `${u.total} 件`;
  $('usageSync').textContent = meta.s.sync === false
    ? '同期はオフ（この端末のみ）'
    : `うち ${u.synced} 件を同期中・${Math.round(u.syncBytes / 1024)}KB / 100KB`;
  const bar = $('usageBar');
  bar.className = 'bar' + (pct > 92 ? ' warn' : '');
  bar.firstElementChild.style.width = pct + '%';
}

/* ---------- 保存 ---------- */

async function save(changed) {
  // 同期ストレージへの書き込みは1秒近くかかることがあるので、先に画面を更新する
  const backup = new Map();
  for (const c of changed) {
    const i = items.findIndex(x => x.id === c.id);
    if (i >= 0) { backup.set(c.id, { ...items[i] }); items[i] = c; } else { items.unshift(c); }
  }
  render();

  muteReload = true;
  const res = await putItems(changed);
  muteReload = false;

  if (!res.ok) {
    for (const c of changed) {                       // 失敗したら元に戻す
      const i = items.findIndex(x => x.id === c.id);
      if (i < 0) continue;
      if (backup.has(c.id)) items[i] = backup.get(c.id); else items.splice(i, 1);
    }
    render();
    alert(res.error);
    return false;
  }
  chrome.runtime.sendMessage({ type: 'refresh' });
  renderUsage();
  return true;
}

async function removeMany(ids) {
  let res;
  try { muteReload = true; res = await removeItems(ids); }
  finally { muteReload = false; }                       // 失敗しても購読を止めたままにしない
  if (!res || !res.ok) { alert((res && res.error) || '削除に失敗しました'); return; }
  items = items.filter(i => !ids.includes(i.id));
  selection.clear();
  chrome.runtime.sendMessage({ type: 'refresh' });
  render();
}

/* ---------- 一括操作 ---------- */

function updateBulkBar() {
  $('bulkbar').classList.toggle('hidden', !selMode);
  if (!selMode) return;
  $('bulkCount').textContent = `${selection.size} 件を選択中`;
  const sel = $('bulkCat');
  sel.innerHTML = '';                                   // カテゴリの増減を必ず反映する
  const head = document.createElement('option');
  head.value = ''; head.textContent = 'カテゴリを変更…';
  sel.appendChild(head);
  for (const c of meta.cats) {
    const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.appendChild(o);
  }
}
const selectedItems = () => items.filter(i => selection.has(i.id));

/* ---------- 編集ダイアログ ---------- */

let editing = null;
function openEdit(it) {
  editing = it;
  $('eTitle').value = it.t; $('eUrl').value = it.u; $('eNote').value = it.n || '';
  $('eTags').value = (it.g || []).join(', ');
  fillCatSelect($('eCat'), it.c);
  fillIvSelect($('eIv'), it.iv || 0);
  $('eStatus').value = String(it.s);
  $('eDue').value = it.d ? toDateInput(it.d) : '';
  $('editDlg').showModal();
}

function fillCatSelect(sel, value) {
  sel.innerHTML = '';
  for (const c of meta.cats) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;     // 文字列連結しない（id に記号があっても壊れない）
    sel.appendChild(o);
  }
  sel.value = value;
  if (sel.selectedIndex < 0) sel.value = meta.cats[0].id;   // 消えたカテゴリは既定へ
}
function fillIvSelect(sel, value) {
  sel.innerHTML = '';
  const presets = [...PRESET_INTERVALS];
  const v = Number(value) || 0;
  if (!presets.some(p => p.v === v)) presets.push({ v, label: `${v}日ごと` });  // 独自の間隔も保持
  for (const p of presets) {
    const o = document.createElement('option');
    o.value = String(p.v); o.textContent = p.label;
    sel.appendChild(o);
  }
  sel.value = String(v);
  if (sel.selectedIndex < 0) sel.value = '0';
}
function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------- 集中復習 ---------- */

function startFocus() {
  focusQueue = filtered().map(i => i.id);
  focusIdx = 0;
  if (!focusQueue.length) return;
  $('focus').classList.remove('hidden');
  showFocus();
}
function endFocus() {
  // 隠すだけだと iframe が生きたままで、動画の音が鳴り続ける
  $('fThumb').replaceChildren();
  $('fThumb').classList.add('hidden');
  $('focus').classList.add('hidden');
  render();
}

function showFocus() {
  while (focusIdx < focusQueue.length && !items.find(i => i.id === focusQueue[focusIdx])) focusIdx++;
  if (focusIdx >= focusQueue.length) return endFocus();
  const it = items.find(i => i.id === focusQueue[focusIdx]);
  const cat = catById(it.c);
  $('fProgress').textContent = `${focusIdx + 1} / ${focusQueue.length}`;
  const fthumb = meta.s.thumbs === false ? '' : thumbOf(it, rich[it.id]);
  const holder = $('fThumb');
  holder.replaceChildren();
  holder.classList.toggle('hidden', !fthumb);
  if (fthumb) holder.appendChild(thumbBox(it, fthumb, 'focus'));
  $('fFav').src = faviconUrl(it.u, 32);
  $('fCat').innerHTML = '<span class="dot"></span><span></span>';
  $('fCat').firstElementChild.style.background = cat.color;
  $('fCat').lastElementChild.textContent = cat.name;
  const fr = rich[it.id] || {};
  $('fDom').textContent = fr.au ? `${domainOf(it.u)}・${fr.au}` : (fr.si || domainOf(it.u));
  $('fTitle').textContent = it.t; $('fTitle').href = it.u;
  $('fNote').textContent = it.n || '';
  const tg = $('fTags'); tg.innerHTML = '';
  for (const t of it.g || []) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = '#' + t; tg.appendChild(c); }
  const steps = meta.s.steps;
  const okDays = it.iv > 0 ? it.iv : (steps[Math.min((it.b || 0) + 1, steps.length - 1)]);
  const isLast = it.iv === 0 && (it.b || 0) + 1 >= steps.length;
  $('fOkSub').textContent = isLast ? '完了にする' : `次は${okDays}日後`;
  $('fAgainSub').textContent = it.iv > 0 ? `${Math.max(1, Math.round(it.iv / 3))}日後` : `${steps[0]}日後`;
}

async function focusAnswer(result) {
  const it = items.find(i => i.id === focusQueue[focusIdx]);
  if (it) await save([review(it, result, meta)]);
  focusIdx++;
  if (focusIdx >= focusQueue.length) endFocus(); else showFocus();
}

/* ---------- バージョン情報と更新履歴 ---------- */

function renderVersion() {
  const v = currentVersion();
  $('verText').textContent = `Recall v${v}`;
  $('aboutVer').textContent = `バージョン ${v}`;
}

function renderChangelog() {
  const box = $('changelog');
  box.innerHTML = '';
  const cur = currentVersion();
  for (const rel of CHANGELOG) {
    const el = document.createElement('div');
    el.className = 'release' + (rel.v === cur ? ' latest' : '');

    const head = document.createElement('div');
    head.className = 'rhead';
    const ver = document.createElement('span');
    ver.className = 'rver'; ver.textContent = 'v' + rel.v;
    head.appendChild(ver);
    if (rel.v === cur) {
      const tag = document.createElement('span');
      tag.className = 'tag'; tag.textContent = '使用中';
      head.appendChild(tag);
    }
    const date = document.createElement('span');
    date.className = 'rdate'; date.textContent = rel.date;
    head.appendChild(date);
    if (rel.title) {
      const t = document.createElement('span');
      t.className = 'rtitle'; t.textContent = rel.title;
      head.appendChild(t);
    }
    el.appendChild(head);

    for (const [key, label] of [['added', '追加'], ['changed', '変更'], ['fixed', '修正']]) {
      const list = rel[key];
      if (!list || !list.length) continue;
      const h = document.createElement('h4');
      h.textContent = label;
      const ul = document.createElement('ul');
      for (const line of list) {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      }
      el.append(h, ul);
    }
    box.appendChild(el);
  }
}

function openAbout() { renderChangelog(); $('aboutDlg').showModal(); }

/** 更新直後に一度だけお知らせを出す */
async function showUpdateNotice() {
  let flag = null;
  try { flag = (await chrome.storage.local.get('updatedTo')).updatedTo; } catch { return; }
  const cur = currentVersion();
  if (!flag || flag !== cur) return;
  const rel = entryFor(cur);
  $('updatedVer').textContent = 'v' + cur;
  $('updatedTitle').textContent = rel ? rel.title : '';
  $('updated').classList.remove('hidden');
}

async function dismissUpdateNotice() {
  $('updated').classList.add('hidden');
  try { await chrome.storage.local.remove('updatedTo'); } catch { /* 消せなくても表示は閉じる */ }
}

/* ---------- 設定 ---------- */

let skipSettingsSave = false;

function openSettings() { openSettingsForm(); $('setMsg').textContent = ''; $('setDlg').showModal(); }

function openSettingsForm() {
  $('sSteps').value = meta.s.steps.join(', ');
  $('sFirst').value = meta.s.firstDelay;
  $('sAgain').value = meta.s.againMode;
  $('sNotify').checked = !!meta.s.notify;
  $('sBadge').checked = !!meta.s.badge;
  $('sKnOn').checked = !!meta.s.knOn;
  $('sKnUrl').value = meta.s.knUrl || '';
  $('sKnCat').innerHTML = '';
  for (const c of KN_CATEGORIES) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    $('sKnCat').appendChild(o);
  }
  $('sKnCat').value = KN_CATEGORIES.includes(meta.s.knCat) ? meta.s.knCat : '調べる';
  refreshKnPerm();
  renderKnQueue();
  $('sThumbs').checked = meta.s.thumbs !== false;
  $('sEmbed').checked = meta.s.embed !== false;
  $('sSync').checked = meta.s.sync !== false;
  $('sSyncMax').value = meta.s.syncMax ?? 300;
  $('sHour').innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const o = document.createElement('option');
    o.value = String(h); o.textContent = `${String(h).padStart(2, '0')}:00`;
    $('sHour').appendChild(o);
  }
  $('sHour').value = String(meta.s.hour);
  fillCatSelect($('sCat'), meta.s.defaultCat);
  fillIvSelect($('sIv'), meta.s.defaultInterval);
  renderCatEditor();
}

/** 「保存の確認」用のホスト権限の状態を出す */
async function refreshKnPerm() {
  const origin = originOf(($('sKnUrl').value || '').trim());
  const btn = $('sKnPerm'), msg = $('sKnMsg');
  if (!origin) {
    btn.disabled = true;
    btn.textContent = '保存の確認を許可する';
    msg.textContent = '保存先URLは https:// または http:// で始めてください。';
    return;
  }
  let has = false;
  try { has = await chrome.permissions.contains({ origins: [origin] }); } catch { /* 続行 */ }
  btn.disabled = has;
  btn.textContent = has ? '保存の確認: 許可済み' : '保存の確認を許可する';
  msg.textContent = has
    ? '保存が終わったのを確かめてから、裏で開いたタブを閉じます。'
    : '許可しなくても送信は動きますが、保存できたかどうかは分かりません。';
}

/** 気になり帳へまだ送れていない項目を出す */
async function renderKnQueue() {
  const box = $('sKnQueue');
  let res = null;
  try { res = await new Promise(r => chrome.runtime.sendMessage({ type: 'clipQueue' }, x => r(chrome.runtime.lastError ? null : x))); }
  catch { res = null; }
  const entries = (res && res.entries) || [];
  if (!entries.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const stuck = entries.filter(e => (e.tries || 0) >= MAX_TRIES).length;
  $('sKnQueueCount').textContent = `気になり帳へ未送信: ${entries.length} 件`
    + (stuck ? `（うち ${stuck} 件は自動での送り直しを止めています）` : '');
  const list = $('sKnQueueList');
  list.innerHTML = '';
  const byId = new Map(items.map(i => [i.id, i]));
  for (const e of entries.slice(0, 8)) {
    const li = document.createElement('li');
    const it = byId.get(e.id);
    li.textContent = it ? clip(it.t, 48) : '(削除された項目)';
    if (e.tries) {
      const s2 = document.createElement('span');
      s2.textContent = `  — ${e.tries}回失敗${e.err ? '：' + clip(e.err, 60) : ''}`;
      li.appendChild(s2);
    }
    list.appendChild(li);
  }
  if (entries.length > 8) {
    const li = document.createElement('li');
    li.textContent = `…ほか ${entries.length - 8} 件`;
    list.appendChild(li);
  }
}

function renderCatEditor() {
  const box = $('catEditor'); box.innerHTML = '';
  meta.cats.forEach((c, idx) => {
    const row = document.createElement('div'); row.className = 'caterow';
    const color = document.createElement('input'); color.type = 'color'; color.value = c.color;
    const name = document.createElement('input'); name.type = 'text'; name.value = c.name; name.maxLength = 20;
    const n = items.filter(i => i.c === c.id).length;
    const cnt = document.createElement('span'); cnt.className = 'faint'; cnt.style.fontSize = '11.5px'; cnt.textContent = `${n}件`;
    const del = document.createElement('button'); del.type = 'button'; del.className = 'btn sm danger'; del.textContent = '削除';
    del.disabled = idx === 0;
    color.onchange = async () => { c.color = color.value; await saveMeta(); };
    name.onchange = async () => { c.name = clip(name.value, 20) || c.name; await saveMeta(); renderCatEditor(); };
    del.onclick = async () => {
      if (!confirm(`「${c.name}」を削除します。${n}件は「${meta.cats[0].name}」に移動します。`)) return;
      const moved = items.filter(i => i.c === c.id).map(i => ({ ...i, c: meta.cats[0].id }));
      meta.cats = meta.cats.filter(x => x.id !== c.id);
      if (meta.s.defaultCat === c.id) meta.s.defaultCat = meta.cats[0].id;
      await saveMeta();
      if (moved.length) await save(moved);
      renderCatEditor(); fillCatSelect($('sCat'), meta.s.defaultCat); render();
    };
    row.append(color, name, cnt, del);
    box.appendChild(row);
  });
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'btn sm'; add.textContent = '＋ カテゴリを追加';
  add.onclick = async () => {
    const name = prompt('カテゴリ名'); if (!name) return;
    meta.cats.push({ id: 'c' + newId(), name: clip(name, 20), color: CAT_COLORS[meta.cats.length % CAT_COLORS.length] });
    await saveMeta(); renderCatEditor(); fillCatSelect($('sCat'), meta.s.defaultCat); render();
  };
  box.appendChild(add);
}

async function saveMeta() {
  let res;
  try { muteReload = true; res = await replaceMeta(meta); }
  finally { muteReload = false; }                       // 例外でも購読を止めたままにしない
  if (!res || !res.ok) { alert((res && res.error) || '設定の保存に失敗しました'); return false; }
  return true;
}

/* ---------- 書き出し / 読み込み ---------- */

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportJson() {
  const payload = { app: 'recall', version: 2, exportedAt: new Date().toISOString(), meta, items, rich };
  download(`recall-backup-${toDateInput(Date.now())}.json`, JSON.stringify(payload, null, 2), 'application/json');
  $('setMsg').textContent = `${items.length} 件を書き出しました。`;
}

function exportCsv() {
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = ['タイトル', 'URL', 'カテゴリ', 'タグ', 'メモ', 'サイト/チャンネル', '状態', '次回復習', '復習回数', '保存日'];
  const rows = items.map(i => [
    i.t, i.u, catById(i.c).name, (i.g || []).join(' '), i.n,
    (rich[i.id] || {}).au || (rich[i.id] || {}).si || domainOf(i.u),
    STATUS_LABEL[i.s], i.d ? toDateInput(i.d) : '', i.rv, toDateInput(i.cr)
  ].map(esc).join(','));
  download(`recall-${toDateInput(Date.now())}.csv`, '﻿' + [head.map(esc).join(','), ...rows].join('\r\n'), 'text/csv');
  $('setMsg').textContent = `${items.length} 件をCSVで書き出しました。`;
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data.items) ? data.items : [];
    let importNote = '';
    if (!incoming.length) { $('setMsg').textContent = '読み込める項目がありませんでした。'; return; }
    if (data.meta && Array.isArray(data.meta.cats)) {
      const known = new Set(meta.cats.map(c => c.id));
      // まだ何も保存していない（＝既定のカテゴリのまま）なら、書き出し元の名前と色をそのまま使う
      const untouched = items.length === 0 &&
        JSON.stringify(meta.cats) === JSON.stringify(DEFAULT_META.cats);
      let skipped = 0;
      for (const c of data.meta.cats) {
        const id = String(c && c.id || '');
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) { skipped++; continue; }     // 不正な id は取り込まない
        const color = /^#[0-9a-fA-F]{3,8}$/.test(String(c.color || '')) ? c.color : CAT_COLORS[meta.cats.length % CAT_COLORS.length];
        const name = clip(c.name || 'カテゴリ', 20);
        const at = meta.cats.findIndex(x => x.id === id);
        if (at >= 0) {
          if (untouched) meta.cats[at] = { id, name, color };               // 名前と色を復元する
          else skipped++;
        } else {
          meta.cats.push({ id, name, color });
        }
        known.add(id);
      }
      importNote = skipped ? `（カテゴリ ${skipped} 件は既存と重なったため取り込みませんでした）` : '';
      await saveMeta();
    }
    const have = new Set(items.map(i => i.id));
    const add = [];
    const addRich = {};
    const incomingRich = (data.rich && typeof data.rich === 'object') ? data.rich : {};
    for (const raw of incoming) {
      const oldId = raw.id;
      const it = makeItem(raw, meta);
      while (have.has(it.id)) it.id = newId();   // 取り込み中に採番した ID も衝突判定に含める
      have.add(it.id);
      add.push(it);
      const r = incomingRich[oldId];             // ID が変わってもサムネイル情報を引き継ぐ
      if (r && typeof r === 'object') addRich[it.id] = r;
    }
    let done = 0, failure = '';
    try {
      muteReload = true;
      for (let i = 0; i < add.length; i += 20) {   // 書き込み回数制限に配慮して小分けにする
        const chunk = add.slice(i, i + 20);
        const chunkRich = {};
        for (const it of chunk) if (addRich[it.id]) chunkRich[it.id] = addRich[it.id];
        const res = await putItems(chunk, chunkRich);
        if (!res.ok) { failure = res.error; break; }
        done += chunk.length;
      }
    } finally { muteReload = false; }
    ({ items, meta, rich } = await getAll());
    render();
    $('setMsg').textContent = (failure
      ? `${done} 件まで読み込んだところで中断しました: ${failure}`
      : `${done} 件を読み込みました。`) + importNote;
  } catch (e) {
    $('setMsg').textContent = '読み込みに失敗しました: ' + e.message;
  }
}

/* ---------- イベント ---------- */

function bind() {
  window.addEventListener('hashchange', () => { applyHash(); render(); });

  $('q').addEventListener('input', () => {
    query = $('q').value.trim();
    $('qClear').classList.toggle('hidden', !query);
    pruneSelection();
    renderList();
  });
  $('qClear').onclick = () => {
    $('q').value = ''; query = ''; $('qClear').classList.add('hidden'); pruneSelection(); renderList();
  };

  $('sort').addEventListener('change', () => {
    sort = $('sort').value;
    try { localStorage.setItem('recall.sort', sort); } catch { /* 保存できなくても動作に影響なし */ }
    renderList();
  });
  $('selMode').addEventListener('change', () => { selMode = $('selMode').checked; selection.clear(); renderList(); });
  $('welcomeClose').onclick = () => $('welcome').classList.add('hidden');
  $('verBtn').onclick = openAbout;
  $('updatedShow').onclick = () => { dismissUpdateNotice(); openAbout(); };
  $('updatedClose').onclick = dismissUpdateNotice;
  $('startReview').onclick = startFocus;

  $('addCat').onclick = () => { $('addCatRow').classList.toggle('hidden'); $('newCatName').focus(); };
  $('newCatOk').onclick = addCatFromSide;
  $('newCatName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCatFromSide(); } });

  // 一括操作
  $('bulkAll').onclick = () => { filtered().forEach(i => selection.add(i.id)); renderList(); };
  $('bulkCat').addEventListener('change', async () => {
    const v = $('bulkCat').value; if (!v) return;
    await save(selectedItems().map(i => ({ ...i, c: v })));
    $('bulkCat').value = '';
  });
  $('bulkTagGo').onclick = async () => {
    const t = $('bulkTag').value.trim(); if (!t) return;
    await save(selectedItems().map(i => ({ ...i, g: normalizeTags([...(i.g || []), t]) })));
    $('bulkTag').value = '';
  };
  $('bulkDone').onclick = async () => save(selectedItems().map(i => ({ ...i, s: STATUS.DONE, d: 0 })));
  $('bulkArchive').onclick = async () => save(selectedItems().map(i => ({ ...i, s: STATUS.ARCHIVED, d: 0 })));
  $('bulkDel').onclick = async () => {
    if (!selection.size) return;
    const names = selectedItems().slice(0, 5).map(i => '・' + clip(i.t, 40)).join('\n');
    const more = selection.size > 5 ? `\n…ほか ${selection.size - 5} 件` : '';
    if (!confirm(`${selection.size} 件を削除します。元に戻せません。\n\n${names}${more}`)) return;
    await removeMany([...selection]);
  };

  // 編集ダイアログ
  $('editDlg').addEventListener('close', async () => {
    if ($('editDlg').returnValue !== 'save' || !editing) { editing = null; return; }
    const it = { ...editing };
    it.t = clip($('eTitle').value, LIMITS.title) || it.u;
    it.u = clip($('eUrl').value, LIMITS.url) || it.u;
    it.n = clip($('eNote').value, LIMITS.note);
    it.c = $('eCat').value;
    it.g = normalizeTags($('eTags').value);
    it.iv = Number($('eIv').value);
    it.s = Number($('eStatus').value);
    if ($('eDue').value) {
      const d = new Date($('eDue').value + 'T00:00:00');
      d.setHours(meta.s.hour, 0, 0, 0);
      if (!isNaN(d.getTime())) it.d = d.getTime();
    }
    if (it.s === STATUS.DONE || it.s === STATUS.ARCHIVED) it.d = 0;
    // 学習中／未読に戻したのに期限が無い項目は復習に出てこないので、今すぐ復習対象にする
    else if (!(it.d > 0)) it.d = resume(it, meta, 0).d;
    editing = null;
    const wasFocus = !$('focus').classList.contains('hidden');
    await save([it]);
    if (wasFocus) showFocus();                       // 集中復習中なら表示を更新
  });
  $('eCancel').addEventListener('click', () => { editing = null; $('editDlg').close('cancel'); });

  // 設定ダイアログ
  $('btnSettings').onclick = openSettings;
  $('setDlg').addEventListener('close', async () => {
    if (skipSettingsSave) { skipSettingsSave = false; return; }   // 「すべて削除」直後は書き戻さない
    const steps = $('sSteps').value.split(/[,、\s]+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
    meta.s.steps = steps.length ? steps.slice(0, 12) : DEFAULT_STEPS;
    meta.s.firstDelay = Math.max(0, Number($('sFirst').value) || 0);
    meta.s.againMode = $('sAgain').value;
    meta.s.notify = $('sNotify').checked;
    meta.s.badge = $('sBadge').checked;
    meta.s.knOn = $('sKnOn').checked;
    meta.s.knUrl = clip($('sKnUrl').value, 300).trim();
    meta.s.knCat = KN_CATEGORIES.includes($('sKnCat').value) ? $('sKnCat').value : '調べる';
    meta.s.thumbs = $('sThumbs').checked;
    meta.s.embed = $('sEmbed').checked;
    meta.s.sync = $('sSync').checked;
    meta.s.syncMax = Math.min(500, Math.max(0, Number($('sSyncMax').value) || 300));
    meta.s.hour = Number($('sHour').value);
    const cat = $('sCat').value;
    meta.s.defaultCat = meta.cats.some(c => c.id === cat) ? cat : meta.cats[0].id;
    meta.s.defaultInterval = Math.max(0, Number($('sIv').value) || 0);
    meta.s.hour = Math.min(23, Math.max(0, meta.s.hour || 0));
    await saveMeta();
    await syncPush();                      // 同期の設定を変えたら載せ直す
    chrome.runtime.sendMessage({ type: 'refresh' });
    ({ items, meta, rich } = await getAll());
    render();
  });
  $('sKnUrl').addEventListener('input', refreshKnPerm);
  $('sKnPerm').addEventListener('click', () => {
    const origin = originOf(($('sKnUrl').value || '').trim());
    if (!origin) { $('sKnMsg').textContent = '保存先URLは https:// または http:// で始めてください。'; return; }
    // chrome.permissions.request は「押した直後」でないと弾かれるので、手前に await を置かない
    let req = null;
    try { req = chrome.permissions.request({ origins: [origin] }); }
    catch (e) { $('sKnMsg').textContent = '許可を求められませんでした: ' + String((e && e.message) || e); return; }
    Promise.resolve(req).then(refreshKnPerm, (e) => {
      $('sKnMsg').textContent = '許可を求められませんでした: ' + String((e && e.message) || e);
    });
  });

  $('sKnFlush').addEventListener('click', async () => {
    $('sKnFlush').disabled = true;
    $('sKnMsg').textContent = '送信中…';
    try {
      // 設定はダイアログを閉じたときにしか保存されないので、
      // 直したばかりのURLで送れるようにここで先に保存する
      meta.s.knOn = $('sKnOn').checked;
      meta.s.knUrl = clip($('sKnUrl').value, 300).trim();
      meta.s.knCat = KN_CATEGORIES.includes($('sKnCat').value) ? $('sKnCat').value : '調べる';
      await saveMeta();
      await new Promise(r => setTimeout(r, 300));   // 設定が行き渡るのを待つ
      const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'clipFlush' }, x => r(chrome.runtime.lastError ? null : x)));
      if (!res) $('sKnMsg').textContent = '結果を受け取れませんでした。';
      else if (res.reason === 'off') $('sKnMsg').textContent = '「気になり帳へ送る」がオフです。';
      else if (res.reason === 'offline') $('sKnMsg').textContent = 'ネットにつながっていないようです。つながったら自動で送り直します。';
      else $('sKnMsg').textContent = `${res.sent} 件送りました。残り ${res.left} 件。`;
    } finally {
      $('sKnFlush').disabled = false;
      await renderKnQueue();
    }
  });

  $('expJson').onclick = exportJson;
  $('expCsv').onclick = exportCsv;
  $('impBtn').onclick = () => $('impFile').click();
  $('impFile').addEventListener('change', e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
  $('wipe').onclick = async () => {
    if (!confirm('保存したページと設定をすべて削除します。元に戻せません。よろしいですか？')) return;
    if (!confirm('本当に削除しますか？ 先に「JSONで書き出し」をおすすめします。')) return;
    try { muteReload = true; await wipeAll(); }
    finally { muteReload = false; }
    ({ items, meta, rich } = await getAll());
    selection.clear();
    render();
    openSettingsForm();                                  // 入力欄を初期値に戻す
    skipSettingsSave = true;                             // 閉じたときに古い値で書き戻さない
    // ただし削除後に何か設定を触ったら、その変更は保存する
    $('setDlg').addEventListener('input', () => { skipSettingsSave = false; }, { once: true });
    $('setMsg').textContent = 'すべて削除しました。';
  };

  // 集中復習
  $('fOk').onclick = () => focusAnswer('ok');
  $('fAgain').onclick = () => focusAnswer('again');
  $('fLater').onclick = () => focusAnswer('later');
  $('fClose').onclick = endFocus;
  $('fOpen').onclick = () => { const it = items.find(i => i.id === focusQueue[focusIdx]); if (it) window.open(it.u, '_blank', 'noopener'); };
  $('fEdit').onclick = () => { const it = items.find(i => i.id === focusQueue[focusIdx]); if (it) openEdit(it); };
  $('fDone').onclick = async () => {
    const it = items.find(i => i.id === focusQueue[focusIdx]);
    if (it) await save([{ ...it, s: STATUS.DONE, d: 0 }]);
    focusIdx++; focusIdx >= focusQueue.length ? endFocus() : showFocus();
  };
  $('fArch').onclick = async () => {
    const it = items.find(i => i.id === focusQueue[focusIdx]);
    if (it) await save([{ ...it, s: STATUS.ARCHIVED, d: 0 }]);
    focusIdx++; focusIdx >= focusQueue.length ? endFocus() : showFocus();
  };

  // キーボード
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;               // 日本語入力の変換中は無視
    if (e.ctrlKey || e.metaKey || e.altKey) return;               // Ctrl+R / Ctrl+A などを横取りしない
    if (e.repeat) return;                                         // 押しっぱなしで連打しない
    if (document.querySelector('dialog[open]')) return;           // ダイアログ操作を横取りしない
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const focusing = !$('focus').classList.contains('hidden');
    if (focusing) {
      // 集中復習中は、処理しなかったキーも下のショートカットへ落とさない
      if (typing) return;
      if (e.key === 'Escape') return endFocus();
      if (e.key === '1') return focusAnswer('again');
      if (e.key === '2') return focusAnswer('later');
      if (e.key === '3' || e.key === 'Enter') { e.preventDefault(); return focusAnswer('ok'); }
      if (e.key === 'o') return $('fOpen').click();
      return;
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('q').focus(); }
    if (e.key === 'r') go('review');
    if (e.key === 'a') go('all');
  });
}

async function addCatFromSide() {
  const name = $('newCatName').value.trim(); if (!name) return;
  meta.cats.push({ id: 'c' + newId(), name: clip(name, 20), color: CAT_COLORS[meta.cats.length % CAT_COLORS.length] });
  await saveMeta();
  $('newCatName').value = ''; $('addCatRow').classList.add('hidden');
  render();
}

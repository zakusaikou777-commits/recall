/* ============================================================
   Recall — 保存ポップアップ
   ============================================================ */
import {
  getAll, putItem, putRich, removeItems, setMeta, makeItem, normalizeUrl, normalizeTags,
  domainOf, faviconUrl, fmtDate, isDue, tagCounts, review, resume, isSavableUrl,
  thumbOf, youtubeId, fmtDuration,
  PRESET_INTERVALS, CAT_COLORS, newId, STATUS, STATUS_LABEL, LIMITS, clip
} from './store.js';
import { collectPageMeta } from './pagemeta.js';
import { clipEnabled, clipStateOf, CLIP_MESSAGE } from './kininari.js';

const $ = (id) => document.getElementById(id);
let meta, items = [], richAll = {}, current = null, tab = null, tags = [], catId = 'c0';
let rich = {};             // この項目のサムネイル等（同期しない）
let clipQueue = [];        // 気になり帳へまだ送れていない項目
let pageMetaPromise = null;   // ページ情報の読み取り（保存が先に来ても取りこぼさない）
let busy = false;          // 二重実行ガード
let composing = false;     // 日本語IMEの変換中か

init();

async function init() {
  const q = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = q[0] || null;
  ({ items, meta, rich: richAll } = await getAll());

  $('iv').innerHTML = '';
  for (const p of PRESET_INTERVALS) {
    const o = document.createElement('option');
    o.value = String(p.v); o.textContent = p.label;
    $('iv').appendChild(o);
  }

  const url = tab && tab.url ? tab.url : '';
  const blocked = !isSavableUrl(url);
  // 読み取りは待たずに始める。Alt+S → Enter の速い保存に間に合わせるため。
  if (!blocked && tab && tab.id != null) pageMetaPromise = collectPageMeta(tab.id, url);

  $('url').textContent = url;
  $('fav').src = url ? faviconUrl(url, 32) : '';
  $('fav').onerror = () => { $('fav').style.visibility = 'hidden'; };

  current = url ? items.find(i => normalizeUrl(i.u) === normalizeUrl(url)) || null : null;
  rich = current ? { ...(richAll[current.id] || {}) } : {};

  if (blocked) {
    $('state').textContent = url ? 'このページは保存できません' : 'ページを取得できませんでした';
    $('save').disabled = true;
    ['title', 'note', 'tagInput', 'iv'].forEach(id => $(id).disabled = true);
  } else if (current) {
    $('state').textContent = '保存済み — 編集';
    $('state').classList.add('saved');
    $('title').value = current.t;
    $('note').value = current.n || '';
    tags = [...(current.g || [])];
    catId = current.c;
    $('iv').value = String(current.iv || 0);
    $('del').classList.remove('hidden');
    $('save').textContent = '更新';
    renderSavedInfo();
  } else {
    $('title').value = clip(tab.title || url, LIMITS.title);
    catId = meta.dom[domainOf(url)] || meta.s.defaultCat || 'c0';
    $('iv').value = String(meta.s.defaultInterval || 0);
    if (meta.dom[domainOf(url)]) $('catHint').textContent = '前回このサイトで使ったカテゴリ';
  }

  // 保存済みカテゴリが消えている場合は既定に戻す
  if (!meta.cats.some(c => c.id === catId)) catId = meta.cats[0].id;

  renderCats();
  renderTags();
  renderTagSuggestions();
  updateIvHint();
  updateNoteCount();
  renderDueBanner();
  renderThumb();
  renderKn();
  bind();

  setTimeout(() => $('save').focus(), 30);

  if (clipEnabled(meta)) { await refreshQueue(); renderKn(); }

  // ページのサムネイル・サイト名・チャンネル名（画像はURLだけ持つ）。
  // 読み取りは init の早い段階で始めてあるので、ここでは結果を反映するだけ。
  if (pageMetaPromise) {
    const page = await pageMetaPromise;
    applyPageMeta(page, url, tab);
  }
}

/** 読み取った情報を画面に反映する。保存が先に走っていても後追いで足せる */
function applyPageMeta(page, url, tabRef) {
  if (!page) return;
  rich = { ...rich, ...page.rich };
  const original = clip((tabRef && tabRef.title) || url, LIMITS.title);
  if (!current && page.title && $('title').value === original) {
    $('title').value = clip(page.title, LIMITS.title);
  }
  renderThumb();
}

function renderThumb() {
  const url = tab && tab.url ? tab.url : '';
  const src = thumbOf({ u: url }, rich);
  const wrap = $('thumbWrap');
  if (!src) { wrap.classList.add('hidden'); }
  else {
    $('thumb').src = src;
    $('thumb').onerror = () => wrap.classList.add('hidden');
    wrap.classList.remove('hidden');
  }
  const dur = fmtDuration(rich.du);
  $('thumbDur').textContent = dur;
  $('thumbDur').classList.toggle('hidden', !dur);

  const bits = [];
  if (rich.si) bits.push(rich.si);
  if (rich.au) bits.push(youtubeId(url) ? '📺 ' + rich.au : rich.au);
  $('site').textContent = bits.join(' · ');
}

/* ---------- 描画 ---------- */

function renderCats() {
  const box = $('cats');
  box.innerHTML = '';
  for (const c of meta.cats) {
    const el = document.createElement('div');
    el.className = 'cat' + (c.id === catId ? ' on' : '');
    if (c.id === catId) el.style.background = c.color;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = c.color;          // 属性値を文字列連結しない（HTML 注入を防ぐ）
    const name = document.createElement('span');
    name.textContent = c.name;
    el.append(dot, name);
    el.onclick = () => { catId = c.id; renderCats(); };
    box.appendChild(el);
  }
  const add = document.createElement('div');
  add.className = 'cat add';
  add.textContent = '＋ 追加';
  add.onclick = () => { $('newCatRow').classList.remove('hidden'); $('newCat').focus(); };
  box.appendChild(add);
}

function renderTags() {
  const box = $('tagChips');
  box.innerHTML = '';
  for (const t of tags) {
    const el = document.createElement('span');
    el.className = 'chip';
    const label = document.createElement('span');
    label.textContent = t;
    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '×';
    // mousedown で処理する（blur による再描画でクリックが失われるのを防ぐ）
    x.onmousedown = (e) => {
      e.preventDefault();
      tags = tags.filter(v => v !== t);
      renderTags(); renderTagSuggestions();
    };
    el.append(label, x);
    box.appendChild(el);
  }
}

function renderTagSuggestions() {
  const all = tagCounts(items).map(([t]) => t);
  $('tagList').innerHTML = '';
  for (const t of all) {
    const o = document.createElement('option');
    o.value = t;
    $('tagList').appendChild(o);
  }
  const box = $('tagSug');
  box.innerHTML = '';
  for (const t of all.filter(t => !tags.includes(t)).slice(0, 6)) {
    const el = document.createElement('span');
    el.className = 'chip';
    el.textContent = '# ' + t;
    el.onmousedown = (e) => { e.preventDefault(); addTag(t); };
    box.appendChild(el);
  }
}

function renderSavedInfo() {
  if (!current) return;
  $('savedInfo').classList.remove('hidden');
  const s = STATUS_LABEL[current.s];
  $('savedDue').textContent = current.d
    ? `${s}・次の復習は ${fmtDate(current.d)}${current.rv ? `（${current.rv}回目）` : ''}`
    : s;
  const active = current.s === STATUS.NEW || current.s === STATUS.LEARNING;
  $('pOk').classList.toggle('hidden', !active);
  $('pAgain').classList.toggle('hidden', !active);
}

function renderKn() {
  const row = $('knRow');
  if (!clipEnabled(meta)) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');

  if (!current) {
    const waiting = clipQueue.length;
    $('knText').textContent = waiting
      ? `保存すると気になり帳にも送ります（未送信 ${waiting} 件）`
      : '保存すると気になり帳にも送ります';
    $('knSend').classList.add('hidden');
    return;
  }
  const entry = clipQueue.find(e => e.id === current.id);
  const state = clipStateOf(current, entry);
  $('knText').textContent = '気になり帳: ' + state.text;
  $('knSend').classList.remove('hidden');
  $('knSend').textContent = state.key === 'sent' ? 'もう一度送る' : '気になり帳へ送る';
}

function ask(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError || !res) { resolve(null); return; }
        resolve(res);
      });
    } catch { resolve(null); }
  });
}

async function refreshQueue() {
  const res = await ask({ type: 'clipQueue' });
  clipQueue = (res && res.entries) || [];
}

async function sendToKininari(id) {
  const res = await ask({ type: 'sendToKininari', id });
  return res || { ok: false, message: '結果を受け取れませんでした' };
}

function renderDueBanner() {
  const due = items.filter(i => isDue(i));
  if (!due.length) return;
  $('dueBanner').classList.remove('hidden');
  $('dueText').textContent = `今日の復習が ${due.length} 件あります`;
}

function updateIvHint() {
  const v = Number($('iv').value);
  const done = current && (current.s === STATUS.DONE || current.s === STATUS.ARCHIVED);
  $('ivHint').textContent = (v === 0
    ? `${meta.s.steps.join(' → ')} 日 と間隔を広げながら通知します`
    : `${v}日ごとに通知します`) + (done ? '（保存すると学習中に戻ります）' : '');
}

function updateNoteCount() {
  const n = $('note').value.length;
  $('noteCount').textContent = n ? `${n}/${LIMITS.note}` : '';
}

/* ---------- 操作 ---------- */

function addTag(raw) {
  tags = normalizeTags([...tags, raw]);
  $('tagInput').value = '';
  renderTags(); renderTagSuggestions();
}

/** 入力欄に打ちかけのタグが残っていれば取り込む */
function commitPendingTag() {
  const v = $('tagInput').value.trim();
  if (v) addTag(v);
}

function bind() {
  const input = $('tagInput');
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { setTimeout(() => { composing = false; }, 0); });

  input.addEventListener('keydown', (e) => {
    // IME 変換中のスペース／Enter は変換操作なので横取りしない
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      const v = input.value.trim();
      if (v) { e.preventDefault(); addTag(v); }
      else if (e.key === 'Enter') { e.preventDefault(); save(); }
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop(); renderTags(); renderTagSuggestions();
    }
  });

  $('iv').addEventListener('change', updateIvHint);
  $('note').addEventListener('input', updateNoteCount);
  $('save').addEventListener('click', save);
  $('del').addEventListener('click', del);
  $('toLib').addEventListener('click', () => openLib('#all'));
  $('goReview').addEventListener('click', () => openLib('#review'));

  $('newCatOk').addEventListener('click', addCategory);
  $('newCat').addEventListener('keydown', (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); addCategory(); }
    if (e.key === 'Escape') $('newCatRow').classList.add('hidden');
  });
  $('newCatCancel').addEventListener('click', () => $('newCatRow').classList.add('hidden'));

  $('pOk').addEventListener('click', () => answer('ok'));
  $('pAgain').addEventListener('click', () => answer('again'));
  $('knSend').addEventListener('click', async () => {
    if (!current || busy) return;
    busy = true;
    $('knSend').disabled = true;
    flash('気になり帳へ送信中…', '');
    try {
      const res = await sendToKininari(current.id);
      flash(res.message || (res.ok ? CLIP_MESSAGE.saved : '送れませんでした'), res.ok ? 'ok' : 'err');
      const fresh = await getAll();
      items = fresh.items; meta = fresh.meta;
      current = items.find(i => i.id === current.id) || current;
      await refreshQueue();
      renderKn();
    } finally { busy = false; $('knSend').disabled = false; }
  });

  document.addEventListener('keydown', (e) => {
    if (composing || e.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
  });
}

async function addCategory() {
  const name = $('newCat').value.trim();
  if (!name || busy) return;
  busy = true;
  try {
    const c = { id: 'c' + newId(), name: clip(name, 20), color: CAT_COLORS[meta.cats.length % CAT_COLORS.length] };
    const cats = [...meta.cats, c];
    const res = await setMeta({ cats });
    if (!res.ok) { flash(res.error, 'err'); return; }
    meta = res.meta;
    catId = c.id;
    $('newCat').value = '';
    $('newCatRow').classList.add('hidden');
    renderCats();
  } finally { busy = false; }
}

async function answer(result) {
  if (!current || busy) return;
  busy = true;
  try {
    const next = review(current, result, meta);
    const res = await putItem(next);
    if (!res.ok) { flash(res.error, 'err'); return; }
    current = next;
    renderSavedInfo();
    chrome.runtime.sendMessage({ type: 'refresh' });
    flash(next.s === STATUS.DONE ? '完了にしました' : `次の復習は ${fmtDate(next.d)}`, 'ok');
  } finally { busy = false; }
}

async function save() {
  if ($('save').disabled || busy) return;
  busy = true;
  $('save').disabled = true;
  flash('保存中…', '');
  try {
    commitPendingTag();
    const url = tab.url;

    // 開いてからの間に他の画面で保存・削除されている可能性があるので取り直す
    const fresh = await getAll();
    items = fresh.items; meta = fresh.meta;
    const latest = items.find(i => normalizeUrl(i.u) === normalizeUrl(url)) || null;
    if (current && !latest) current = null;                 // 他所で削除された → 新規として保存
    else if (latest) current = latest;

    const wasExisting = !!current;
    let base = {
      ...(current || {}),
      u: url,
      t: $('title').value.trim() || url,
      n: $('note').value,
      c: meta.cats.some(c => c.id === catId) ? catId : meta.cats[0].id,
      g: tags,
      iv: Number($('iv').value)
    };
    const ivChanged = current && Number(current.iv || 0) !== base.iv;
    if (ivChanged) base.d = undefined;                       // 間隔を変えたら次回予定を引き直す

    let item = makeItem(base, meta);
    if (current) {
      item.id = current.id; item.cr = current.cr; item.rv = current.rv;
      item.b = current.b; item.s = current.s; item.f = current.f;
      // 完了・アーカイブ中に間隔を変えたら、学習中に戻して予定を入れ直す
      if (ivChanged && (current.s === STATUS.DONE || current.s === STATUS.ARCHIVED)) {
        item = resume(item, meta, item.iv > 0 ? item.iv : meta.s.firstDelay);
      } else if (item.s === STATUS.DONE || item.s === STATUS.ARCHIVED) {
        item.d = 0;
      } else if (!(item.d > 0)) {
        item = resume(item, meta, 0);
      }
    }

    // 読み取りが終わりかけていれば少しだけ待つ（サムネイルの取りこぼしを減らす）
    if (pageMetaPromise) {
      const page = await Promise.race([pageMetaPromise, new Promise(r => setTimeout(() => r(null), 700))]);
      if (page) rich = { ...rich, ...page.rich };
    }
    const res = await putItem(item, Object.keys(rich).length ? rich : undefined);
    if (!res.ok) { flash(res.error, 'err'); $('save').disabled = false; return; }
    // 間に合わなかった分は、あとから届いたところで足す
    if (pageMetaPromise) {
      pageMetaPromise.then(page => {
        if (page && Object.keys(page.rich || {}).length) putRich(item.id, { ...rich, ...page.rich });
      }).catch(() => {});
    }

    // ドメイン→カテゴリの記憶（最近使った順に最大60件）
    const dom = domainOf(url);
    const nextDom = { ...meta.dom };
    delete nextDom[dom];
    nextDom[dom] = catId;
    const keys = Object.keys(nextDom);
    while (keys.length > 60) delete nextDom[keys.shift()];
    const mres = await setMeta({ dom: nextDom });
    if (!mres.ok) flash(`保存しました（カテゴリの記憶は失敗: ${mres.error}）`, 'ok');
    else flash(current ? '更新しました' : `保存しました（次の復習: ${fmtDate(item.d)}）`, 'ok');

    chrome.runtime.sendMessage({ type: 'refresh' });
    // 新しく保存したときだけ気になり帳へ送る（更新のたびには送らない）
    if (!wasExisting && clipEnabled(meta)) chrome.runtime.sendMessage({ type: 'sendToKininari', id: item.id });
    setTimeout(() => window.close(), 550);
  } catch (e) {
    flash('保存に失敗しました: ' + (e && e.message ? e.message : e), 'err');
    $('save').disabled = false;
  } finally { busy = false; }
}

async function del() {
  if (!current || busy) return;
  busy = true;
  try {
    const res = await removeItems([current.id]);
    if (!res.ok) { flash(res.error, 'err'); return; }
    chrome.runtime.sendMessage({ type: 'refresh' });
    flash('削除しました', 'ok');
    current = null;
    setTimeout(() => window.close(), 400);
  } finally { busy = false; }
}

function openLib(hash) {
  chrome.runtime.sendMessage({ type: 'openLibrary', hash });
  window.close();
}

function flash(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg ' + (cls || '');
}

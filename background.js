/* ============================================================
   Recall — バックグラウンド（Service Worker / MV3）
   ・30分ごとに復習期限をチェックしてバッジと通知を更新
   ・右クリックメニュー / キーボードショートカットからの保存
   ============================================================ */
import {
  getAll, putItem, putItems, makeItem, findByUrl,
  getLastNotified, setLastNotified, syncPush,
  isDue, domainOf, isSavableUrl, setMeta, META_KEY, ITEM_PREFIX, LOCAL_PREFIX
} from './store.js';
import { collectPageMeta } from './pagemeta.js';
import {
  sweepClips, adoptRestoredClipTabs, onClipTabUpdated, onClipTabRemoved,
  enqueueClip, flushClips, queueSummary, resetQueueTries, removeFromQueue,
  clipEnabled, clipStateOf, CLIP_ALARM, RETRY_ALARM, CLIP_MESSAGE
} from './kininari.js';

const TICK = 'recall-tick';
const NOTIF_ID = 'recall-due';

/* ---------- 初期化 ---------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  await setup();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('library.html?welcome=1') });
  } else if (details.reason === 'update') {
    // ライブラリを次に開いたとき「更新されました」を一度だけ出す
    const version = chrome.runtime.getManifest().version;
    if (details.previousVersion !== version) {
      try { await chrome.storage.local.set({ updatedTo: version, updatedFrom: details.previousVersion || '' }); } catch { /* 出せなくても動作に影響なし */ }
    }
  }
});

chrome.runtime.onStartup.addListener(setup);

// Service Worker はイベントのたびに起こされて 30 秒ほどで停止する。
// onInstalled / onStartup が来ない再起動（拡張の再有効化など）でも
// アラームと右クリックメニューが必ず復活するよう、読み込み時にも実行する。
setup().catch(e => console.warn('[Recall] setup failed', e));
sweepClips().catch(() => {});   // 起こされたときのクリップ取り残し点検

let setupDone = false;
async function setup() {
  try {
    await ensureAlarm();
    await buildMenus();
    setupDone = true;
    await refresh();
    await adoptRestoredClipTabs();   // 復元された裏タブを引き取る
    await sweepClips();
    // 起動時の設定を控えておく（次に変わったときだけ再送のきっかけにする）
    try { await writeClipCfg(clipCfgOf((await getAll()).meta)); } catch { /* 続行 */ }
    await flushClips();              // 前回送れなかった分を送り直す
  } catch (e) {
    console.warn('[Recall] setup error', e);
  }
}

async function ensureAlarm() {
  // create は同名なら上書きなので冪等
  await chrome.alarms.create(TICK, { periodInMinutes: 30, delayInMinutes: 1 });
}

function buildMenus() {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      const add = (o) => { try { chrome.contextMenus.create(o); } catch { /* 既に存在 */ } };
      add({ id: 'recall-save-page', title: 'このページを Recall に保存', contexts: ['page', 'selection', 'image', 'video'] });
      add({ id: 'recall-save-link', title: 'このリンクを Recall に保存', contexts: ['link'] });
      add({ id: 'recall-sep', type: 'separator', contexts: ['all'] });
      add({ id: 'recall-open', title: 'Recall ライブラリを開く', contexts: ['all'] });
      resolve();
    });
  });
}

/* ---------- 期限チェック ---------- */

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === TICK) await refresh();
  if (a.name === CLIP_ALARM) await sweepClips();
  if (a.name === RETRY_ALARM) await flushClips();   // 送れなかった分の再送
});

chrome.tabs.onUpdated.addListener(onClipTabUpdated);
chrome.tabs.onRemoved.addListener(onClipTabRemoved);

/* ---------- 気になり帳へ送る ---------- */

/**
 * 保存した項目を気になり帳へ送る。Recall 側の保存はすでに終わっているので、
 * ここで失敗しても項目は失われない。
 */
async function sendToKininari(itemId, sendResponse) {
  const { items, meta } = await getAll();
  const item = items.find(i => i.id === itemId);
  if (!item) { sendResponse({ ok: false, status: 'failed', message: '項目が見つかりません' }); return; }
  if (!clipEnabled(meta)) { sendResponse({ ok: false, status: 'off', message: CLIP_MESSAGE.off }); return; }

  // まず待ち行列に載せる。ここで失敗しても項目は消えないし、あとから必ず送り直せる。
  const before = item.kn || 0;
  const added = await enqueueClip(itemId);
  if (added && added.refused) {
    sendResponse({ ok: false, status: 'full', message: '未送信が多すぎます。先に「今すぐ送る」で片付けてください。' });
    return;
  }
  const res = await flushClips({ force: true });

  // 「待ち行列に無い＝送れた」ではなく、項目に印が付いたかどうかで判断する
  const after = (await getAll()).items.find(i => i.id === itemId);
  if (after && (after.kn || 0) > before) {
    sendResponse({
      ok: true,
      status: after.knc ? 'saved' : 'blind',
      message: after.knc ? CLIP_MESSAGE.saved : CLIP_MESSAGE.blind
    });
    return;
  }
  const stillQueued = (await queueSummary()).entries.find(e => e.id === itemId);
  sendResponse({
    ok: false,
    status: (stillQueued && stillQueued.status) || 'failed',
    message: '送れませんでした。あとで自動で送り直します（設定から今すぐ送ることもできます）',
    err: (stillQueued && stillQueued.err) || '',
    left: res.left
  });
}

/** 設定（送信のオン・保存先URL）が変わったら、諦めていた分も送り直す */
const CLIP_CFG_KEY = 'rcClipCfg';
function clipCfgOf(meta) { return `${meta.s.knOn ? 1 : 0}|${meta.s.knUrl || ''}`; }

async function readClipCfg() {
  // Service Worker は止まるとモジュール変数を失う。ここに置くと
  // 「起き直したあと最初の保存」を設定変更と勘違いして再送が走ってしまう。
  try { return (await chrome.storage.session.get(CLIP_CFG_KEY))[CLIP_CFG_KEY] || null; }
  catch { return null; }
}
async function writeClipCfg(cfg) {
  try { await chrome.storage.session.set({ [CLIP_CFG_KEY]: cfg }); } catch { /* 続行 */ }
}

async function onClipConfigMaybeChanged() {
  const { meta } = await getAll();
  const cfg = clipCfgOf(meta);
  const prev = await readClipCfg();
  if (cfg === prev) return;
  await writeClipCfg(cfg);
  if (prev === null || !meta.s.knOn) return;   // 起動直後の1回目は「変更」ではない
  await resetQueueTries();                     // URL を直したら、諦めていた分も送り直す
  await flushClips();
}

let refreshTimer = null;
chrome.storage.onChanged.addListener((changes, areaName) => {
  const keys = Object.keys(changes);
  const touched = keys.some(k => k.startsWith(ITEM_PREFIX) || k.startsWith(LOCAL_PREFIX));
  // 設定の変更は「再計算」より先に見る（下の早期 return に隠れないように）
  if (keys.includes(META_KEY)) onClipConfigMaybeChanged();
  // meta だけの変更（設定保存など）では再計算しない → 自分の書き込みで再入しない
  if (!touched && keys.every(k => k === META_KEY || k === 'lastNotified')) return;
  if (areaName !== 'sync' && areaName !== 'local') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 400);   // 連続書き込みをまとめる
});

async function refresh() {
  try {
    const { items, meta } = await getAll();
    const due = items.filter(i => isDue(i));

    if (meta.s.badge) {
      await chrome.action.setBadgeText({ text: due.length ? String(Math.min(due.length, 999)) : '' });
      await chrome.action.setBadgeBackgroundColor({ color: '#7c5aff' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }

    if (!meta.s.notify || due.length === 0) return;

    const now = new Date();
    if (now.getHours() < (meta.s.hour ?? 9)) return;          // 設定時刻前は出さない
    const last = new Date(await getLastNotified());
    const sameDay = last.getFullYear() === now.getFullYear()
      && last.getMonth() === now.getMonth() && last.getDate() === now.getDate();
    if (sameDay) return;                                       // 1日1回まで

    // 通知を作る前に記録する（通知APIが失敗しても鳴り続けない）
    await setLastNotified(Date.now());

    const head = due[0];
    chrome.notifications.create(NOTIF_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `復習の時間です（${due.length}件）`,
      message: due.length === 1 ? head.t : `${head.t} ほか ${due.length - 1} 件`,
      buttons: [{ title: '復習する' }],
      priority: 1
    });
  } catch (e) {
    console.warn('[Recall] refresh failed', e);
  }
}

function openLibrary(hash = '') {
  const url = chrome.runtime.getURL('library.html' + hash);
  chrome.tabs.query({ url: chrome.runtime.getURL('library.html') + '*' }, (tabs) => {
    if (tabs && tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true, url });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === NOTIF_ID) { openLibrary('#review'); chrome.notifications.clear(id); }
});
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id === NOTIF_ID) { openLibrary('#review'); chrome.notifications.clear(id); }
});

/* ---------- 保存 ---------- */

async function quickSave(url, title, tabId) {
  if (!isSavableUrl(url)) {
    return { ok: false, error: 'このページは保存できません（http/https のみ）' };
  }
  const dup = await findByUrl(url);
  if (dup) return { ok: false, duplicate: true, item: dup, error: 'すでに保存済みです' };

  const { meta } = await getAll();
  const dom = domainOf(url);
  const cat = meta.dom[dom] || meta.s.defaultCat || 'c0';
  const page = await collectPageMeta(tabId, url);      // サムネイル・サイト名・著者
  const item = makeItem({
    u: url, t: title || page.title || url, c: cat, iv: meta.s.defaultInterval || 0
  }, meta);
  const res = await putItem(item, page.rich);
  if (!res.ok) return res;
  await setMeta({ dom: { [dom]: cat } });      // 差分だけマージ（他の設定を巻き戻さない）
  await refresh();
  if (clipEnabled(meta)) { await enqueueClip(item.id); flushClips(); }   // 結果は待たない
  return { ok: true, item };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'recall-open') return openLibrary();
  const isLink = info.menuItemId === 'recall-save-link';
  const url = isLink ? info.linkUrl : (info.pageUrl || (tab && tab.url));
  const title = isLink ? (info.selectionText || info.linkUrl) : (tab && tab.title);
  // リンク先は別ページなので、そのページの情報は読み取らない
  const res = await quickSave(url, title, isLink ? null : (tab && tab.id));
  toast(res);
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'open-library') return openLibrary();
  if (cmd === 'quick-save') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) toast(await quickSave(tab.url, tab.title, tab.id));
  }
});

function toast(res) {
  chrome.notifications.create('recall-toast-' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: res.ok ? 'Recall に保存しました' : 'Recall',
    message: res.ok ? (res.item.t || res.item.u) : (res.error || '保存できませんでした'),
    priority: 0
  }, (id) => setTimeout(() => chrome.notifications.clear(id), 3500));
}

/* ---------- ページからのメッセージ ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'refresh') { refresh().then(() => sendResponse({ ok: true })); return true; }
  if (msg && msg.type === 'quickSave') { quickSave(msg.url, msg.title, msg.tabId).then(sendResponse); return true; }
  if (msg && msg.type === 'syncPush') { syncPush().then(sendResponse); return true; }
  if (msg && msg.type === 'sendToKininari') { sendToKininari(msg.id, sendResponse); return true; }
  if (msg && msg.type === 'clipQueue') { queueSummary().then(sendResponse); return true; }
  if (msg && msg.type === 'clipFlush') {
    resetQueueTries().then(() => flushClips({ force: true })).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'clipForget') { removeFromQueue(msg.id).then(() => sendResponse({ ok: true })); return true; }
  if (msg && msg.type === 'openLibrary') { openLibrary(msg.hash || ''); sendResponse({ ok: true }); return false; }
  return false;
});

/* ---------- アドレスバー検索（キーワード: rc） ---------- */

chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({ description: '保存したページを検索（Enter でライブラリを開く）' });
});

let omniSeq = 0;
chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const seq = ++omniSeq;
  try {
    const { items } = await getAll();
    if (seq !== omniSeq) return;                       // 打鍵が速いとき、古い結果で上書きしない
    const q = (text || '').trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const hit = items
      .filter(i => {
        const hay = `${i.t || ''} ${i.u || ''} ${i.n || ''} ${(i.g || []).join(' ')}`.toLowerCase();
        return terms.every(t => hay.includes(t));
      })
      .slice(0, 8)
      .map(i => ({
        content: i.u,
        description: `${esc(i.t)} <dim>— ${esc(domainOf(i.u))}${i.g && i.g.length ? ' · #' + esc(i.g.join(' #')) : ''}</dim>`
      }));
    suggest(hit);
  } catch (e) {
    if (seq === omniSeq) suggest([]);
  }
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  if (/^https?:\/\//i.test(text)) {
    if (disposition === 'newForegroundTab') chrome.tabs.create({ url: text });
    else if (disposition === 'newBackgroundTab') chrome.tabs.create({ url: text, active: false });
    else chrome.tabs.update({ url: text });
  } else {
    // 候補を選ばず Enter したときは、入力語をライブラリの検索欄へ引き継ぐ
    const q = (text || '').trim();
    openLibrary(q ? '#q/' + encodeURIComponent(q) : '#all');
  }
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

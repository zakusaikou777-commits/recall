/* ============================================================
   Recall — バックグラウンド（Service Worker / MV3）
   ・30分ごとに復習期限をチェックしてバッジと通知を更新
   ・右クリックメニュー / キーボードショートカットからの保存
   ============================================================ */
import {
  getAll, putItem, putItems, makeItem, findByUrl,
  getLastNotified, setLastNotified, syncPush,
  isDue, domainOf, isSavableUrl, setMeta, getMeta, pickCat,
  META_KEY, ITEM_PREFIX, LOCAL_PREFIX, RICH_PREFIX, LOCAL_TOMBS_KEY, WIPE_KEY
} from './store.js';
import { collectPageMeta } from './pagemeta.js';
import {
  sweepClips, adoptRestoredClipTabs, onClipTabUpdated, onClipTabRemoved,
  enqueueClip, flushClips, queueSummary, resetQueueTries, removeFromQueue,
  clipEnabled, clipStateOf, CLIP_ALARM, RETRY_ALARM, CLIP_MESSAGE
} from './kininari.js';
import {
  syncDrive, connectDrive, disconnectDrive, driveStatus, listBackups, getBackup, driveAlertFor, DRIVE_ALARM
} from './drive.js';

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
// アラームと右クリックメニューが必ず復活するよう、読み込み時にも見る。
// ただし準備は「ブラウザの起動・拡張の読み込み」ごとに1回で足りる（session に印を置く）。
// タブの更新などで起こされるたびに全部やり直すと、そのつど全データを読み直すことになる。
const SETUP_KEY = 'rcSetupDone';
let setupRun = null;
(async () => {
  let done = false;
  try { done = !!(await chrome.storage.session.get(SETUP_KEY))[SETUP_KEY]; } catch { /* 分からなければ準備する */ }
  if (done) await ensureAlarm();
  else await setup();
})().catch(e => console.warn('[Recall] setup failed', e));
sweepClips().catch(() => {});   // 起こされたときのクリップ取り残し点検

/** 準備。onStartup と読み込み時の両方から呼ばれても、同じ Service Worker の中では1回だけ走らせる */
function setup() {
  if (!setupRun) setupRun = runSetup();
  return setupRun;
}

async function runSetup() {
  try {
    await ensureAlarm();
    await buildMenus();
    await refresh();
    await adoptRestoredClipTabs();   // 復元された裏タブを引き取る
    await sweepClips();
    // 起動時の設定を控えておく（次に変わったときだけ再送のきっかけにする）
    try { await writeClipCfg(clipCfgOf((await getAll()).meta)); } catch { /* 続行 */ }
    await flushClips();              // 前回送れなかった分を送り直す
    await syncDriveInBackground();   // Google ドライブの最新を取り込む（オフなら何もしない）
    try { await chrome.storage.session.set({ [SETUP_KEY]: true }); } catch { /* 次に起きたときにやり直すだけ */ }
  } catch (e) {
    console.warn('[Recall] setup error', e);
  }
}

async function ensureAlarm() {
  // 同名で create すると予定が「1分後」に引き直されるので、無いときだけ作る
  try { if (await chrome.alarms.get(TICK)) return; } catch { /* 作り直す */ }
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
  if (a.name === TICK) { await refresh(); await syncDriveInBackground(); }   // ドライブ同期も30分ごとに確かめる
  if (a.name === DRIVE_ALARM) await syncDriveInBackground();                 // 変更のあと少し待ってから送る
  if (a.name === CLIP_ALARM) await sweepClips();
  if (a.name === RETRY_ALARM) await flushClips({ retry: true });   // 送れなかった分の再送（5分ごと）
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
  // 「送信済み（未確認）」を送り直すときは前と同じ番号で送る。前の分が届いていれば、
  // 気になり帳は二重に登録せず「もう入っている」と返す（確認できたことになる）
  const before = item.kn || 0;
  const reuse = item.kn && !item.knc && item.knk ? item.knk : '';
  const added = await enqueueClip(itemId, { nonce: reuse });
  if (added && added.refused) {
    sendResponse({ ok: false, status: 'full', message: '未送信が多すぎます。先に「今すぐ送る」で片付けてください。' });
    return;
  }
  // 別の送信が進んでいる最中なら、それが終わるのを待ってから送る
  //（すぐ戻ると、実際には送れるのに「送れませんでした」と出てしまう）
  const res = await flushClips({ force: true, wait: true });

  // 「待ち行列に無い＝送れた」ではなく、項目に印が付いたかどうかで判断する
  const after = (await getAll()).items.find(i => i.id === itemId);
  if (after && (after.kn || 0) > before) {
    const st = (res.results && res.results[itemId]) || (after.knc ? 'saved' : 'blind');
    sendResponse({ ok: true, status: st, message: CLIP_MESSAGE[st] || (after.knc ? CLIP_MESSAGE.saved : CLIP_MESSAGE.blind) });
    return;
  }
  const stillQueued = (await queueSummary()).entries.find(e => e.id === itemId);
  const why = stillQueued && stillQueued.status;
  sendResponse({
    ok: false,
    status: why || 'failed',
    // 容量不足・形式エラーは待っても直らないので、自動では送り直さない（理由をそのまま出す）
    message: (why === 'quota' || why === 'parse') ? CLIP_MESSAGE[why]
      : '送れませんでした。あとで自動で送り直します（設定から今すぐ送ることもできます）',
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

/**
 * 項目・削除の記録・カテゴリが変わったら、1分ほどあとに Google ドライブへ送る。
 * 続けて変わっても予約は1つだけ（無いときだけ作る）なので、まとめて1回で送られる。
 */
async function scheduleDriveSync() {
  try {
    if (!(await getMeta()).s.driveOn) return;
    if (await chrome.alarms.get(DRIVE_ALARM)) return;
    await chrome.alarms.create(DRIVE_ALARM, { delayInMinutes: 1 });
  } catch { /* 30分ごとの確認で送られる */ }
}

let refreshTimer = null;
chrome.storage.onChanged.addListener((changes, areaName) => {
  const keys = Object.keys(changes);
  const touched = keys.some(k => k.startsWith(ITEM_PREFIX) || k.startsWith(LOCAL_PREFIX));
  if ((areaName === 'local' && keys.some(k => k.startsWith(LOCAL_PREFIX) || k.startsWith(RICH_PREFIX) || k === LOCAL_TOMBS_KEY))
    || (areaName === 'sync' && (keys.includes(META_KEY) || keys.includes(WIPE_KEY)))) {
    scheduleDriveSync();
  }
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
  if (id === DRIVE_NOTIF_ID) { openLibrary('#drive'); chrome.notifications.clear(id); }
});
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id === NOTIF_ID) { openLibrary('#review'); chrome.notifications.clear(id); }
  if (id === DRIVE_NOTIF_ID) { openLibrary('#drive'); chrome.notifications.clear(id); }
});

/* ---------- Google ドライブ同期（裏で） ---------- */

const DRIVE_NOTIF_ID = 'recall-drive';
const DRIVE_ALERT_KEY = 'rcDriveAlert';   // local: 最後に「止まっています」と知らせた時刻

/**
 * 裏で同期する。許可切れなど、待っても直らない理由で止まったら通知で知らせる（1日1回まで）。
 * うまくいったら控えを消す（次にまた止まったときにすぐ知らせられるように）。
 */
async function syncDriveInBackground() {
  const r = await syncDrive();
  try {
    if (r && r.ok) {
      if ((await chrome.storage.local.get(DRIVE_ALERT_KEY))[DRIVE_ALERT_KEY]) {
        await chrome.storage.local.remove(DRIVE_ALERT_KEY);
        chrome.notifications.clear(DRIVE_NOTIF_ID);
      }
      return r;
    }
    const last = (await chrome.storage.local.get(DRIVE_ALERT_KEY))[DRIVE_ALERT_KEY] || 0;
    const alert = driveAlertFor(r, last, Date.now());
    if (!alert) return r;
    await chrome.storage.local.set({ [DRIVE_ALERT_KEY]: Date.now() });   // 先に記録する（通知に失敗しても鳴り続けない）
    chrome.notifications.create(DRIVE_NOTIF_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: alert.title,
      message: alert.message,
      buttons: [{ title: 'つなぎ直す' }],
      priority: 1
    });
  } catch { /* 知らせられなくても、設定画面には理由が出ている */ }
  return r;
}

/* ---------- 保存 ---------- */

async function quickSave(url, title, tabId) {
  if (!isSavableUrl(url)) {
    return { ok: false, error: 'このページは保存できません（http/https のみ）' };
  }
  const dup = await findByUrl(url);
  if (dup) return { ok: false, duplicate: true, item: dup, error: 'すでに保存済みです' };

  const { meta } = await getAll();
  const dom = domainOf(url);
  // 覚えているカテゴリが消されていたら既定のカテゴリへ（消したカテゴリに入ると、どの一覧にも出なくなる）
  const cat = pickCat(meta, meta.dom[dom], meta.s.defaultCat);
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
    resetQueueTries().then(() => flushClips({ force: true, wait: true })).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'clipForget') { removeFromQueue(msg.id).then(() => sendResponse({ ok: true })); return true; }
  if (msg && msg.type === 'clipRequeue') {
    // 「元に戻す」で戻した項目を、気になり帳へ送る順番待ちに並べ直す。
    // 待ち行列の書き換えは Service Worker の中で順番に行う（画面から直接書くと取り合いになる）
    (async () => {
      // 消す前の番号のまま並べ直す（消す前の送信が届いていたら、気になり帳が二重にしない）
      const nonces = (msg.nonces && typeof msg.nonces === 'object') ? msg.nonces : {};
      for (const id of (Array.isArray(msg.ids) ? msg.ids : [])) await enqueueClip(id, { nonce: nonces[id] });
      flushClips();
    })().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg && msg.type === 'openLibrary') { openLibrary(msg.hash || ''); sendResponse({ ok: true }); return false; }
  // Google ドライブ同期（設定画面から）
  if (msg && msg.type === 'driveStatus') { driveStatus().then(sendResponse); return true; }
  if (msg && msg.type === 'driveConnect') { connectDrive().then(sendResponse); return true; }
  if (msg && msg.type === 'driveSync') {
    // soft … ライブラリを開いたときの取り込み（裏の同期と同じ扱い。止まっていれば通知する）
    (msg.soft ? syncDriveInBackground() : syncDrive({ force: true })).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'driveDisconnect') { disconnectDrive().then(sendResponse); return true; }
  if (msg && msg.type === 'driveBackups') { listBackups().then(sendResponse); return true; }
  if (msg && msg.type === 'driveBackupGet') { getBackup(msg.id).then(sendResponse); return true; }
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

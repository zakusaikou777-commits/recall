/* ============================================================
   Recall — 気になり帳と合わせる（実ブラウザでの動作テスト）
   実際に Chrome へ拡張機能を読み込み、気になり帳のタブ・結合アプリ（index.html の iframe）・
   手動の裏タブで、分類とフォルダが合わさるかを確かめる。

   「保存の確認を許可する」の許可ダイアログは自動では押せないので、拡張機能の写しを作り、
   テスト用のサイト（127.0.0.1）への権限を最初から付けて読み込む（中身は本物と同じ）。

   既定では、取り決め（protocol v1）どおりに動く小さな気になり帳（このファイルの中の受け口）を使う。
   本物の気になり帳で確かめるときは、そのフォルダを指定する:
     KININARI_ROOT=/path/to/private-diary xvfb-run -a node tests/e2e-kn-sync.mjs
   実行: npm run test:kn-sync   （npm run test:e2e でも続けて走る）
   ============================================================ */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const EXT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.KININARI_ROOT ? path.resolve(process.env.KININARI_ROOT) : '';
const REAL = !!ROOT;
if (REAL && !fs.existsSync(path.join(ROOT, 'kininari.html'))) {
  console.error(`KININARI_ROOT に kininari.html がありません: ${ROOT}`);
  process.exit(2);
}

async function loadChromium() {
  for (const spec of ['playwright', '@playwright/test', 'playwright-core']) {
    try { const m = await import(spec); if (m.chromium) return m.chromium; if (m.default?.chromium) return m.default.chromium; } catch { /* 次を試す */ }
  }
  console.error('Playwright が見つかりません。プロジェクトのフォルダで次を実行してください:\n  npm install\n  npx playwright install chromium');
  process.exit(2);
}
const chromium = await loadChromium();

let pass = 0, fail = 0;
const errors = [];
const NET = /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_|ERR_BLOCKED_BY_CLIENT|ERR_PROXY|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE/;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const eq = (n, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${n}` + (good ? '' : `\n      実際: ${JSON.stringify(got)}\n      期待: ${JSON.stringify(want)}`));
};
const section = (t) => console.log(`\n--- ${t} ---`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn, ms = 10000, gap = 200) => {   // 時間で決め打ちせず、条件がそろうまで待つ
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* まだ */ } await sleep(gap); }
  return false;
};
/** 気になり帳と同じ URL の見分け方（# 以降と末尾の / は区別しない） */
const urlKey = (u) => { try { const x = new URL(String(u).trim()); x.hash = ''; return x.href.replace(/\/+$/, ''); } catch { return String(u || ''); } };

/* ---------- テスト用の気になり帳（protocol v1 の B 節どおりに動く） ---------- */

const stub = {
  api: true,          // false = 受け口の無い古い気になり帳
  apiDelay: 1200,     // データを読み終えて受け口を出すまで（本物も非同期で読む）
  folders: [
    { name: '未分類', color: '#C0463C', parent: null },
    { name: '株主優待', color: '#3E6CA3', parent: null },
    { name: 'ゲーム', color: '#57845A', parent: null },
    { name: '攻略メモ', color: '', parent: 'ゲーム' }
  ],
  memos: [],          // { u, folder: フォルダ名（'' = フォルダなし）, rc?: string }
  clips: [],          // #knadd= で届いたクリップ
  calls: []           // apply に渡された中身
};
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
function stubEnsureFolder(name, color, created) {
  const n = String(name || '').trim();
  if (!n || n === '未分類' || stub.folders.some(f => sameName(f.name, n))) return;
  stub.folders.push({ name: n, color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#888888', parent: null });
  if (created) created.push(n);
}
function stubClip(p) {
  stub.clips.push(p);
  let f = String(p.f || '').trim();
  if (f === '未分類') f = '';
  stubEnsureFolder(f);
  const memo = { u: p.u, folder: f };
  if (p.src === 'recall') memo.rc = f;
  stub.memos.push(memo);
}
function stubApply(p) {
  if (!p || typeof p !== 'object') return { ok: false, error: 'bad payload' };
  stub.calls.push(p);
  const created = [];
  for (const c of Array.isArray(p.cats) ? p.cats : []) if (c && typeof c.name === 'string') stubEnsureFolder(c.name, c.color, created);
  let moved = 0;
  for (const it of Array.isArray(p.items) ? p.items : []) {
    if (!it || typeof it.u !== 'string') continue;
    let target = String(it.f || '').trim();
    if (target === '未分類') target = '';
    stubEnsureFolder(target, '', created);
    for (const m of stub.memos.filter(x => urlKey(x.u) === urlKey(it.u))) {
      if (m.rc === undefined) {
        if (!m.folder || m.folder === '未分類') { if (m.folder !== target) moved++; m.folder = target; }
        m.rc = target;
      } else if (m.rc !== target) { m.folder = target; m.rc = target; moved++; }
    }
  }
  const removed = [];
  if (stub.folders.some(f => f.name === '未分類') && !stub.memos.some(m => m.folder === '未分類') && !stub.folders.some(f => f.parent === '未分類')) {
    stub.folders = stub.folders.filter(f => f.name !== '未分類');
    removed.push('未分類');
  }
  return { ok: true, v: 1, folders: stub.folders.filter(f => f.name !== '未分類'), moved, created, removed };
}

const STUB_KN = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>気になり帳（テスト用）</title></head>
<body><h1>気になり帳（テスト用）</h1><script>
(async () => {
  const cfg = await (await fetch('/__stub/config')).json();
  const m = (location.hash || '').match(/knadd=([^&]+)/);
  if (m) {
    const r = await (await fetch('/__stub/clip', { method: 'POST', body: decodeURIComponent(m[1]) })).json();
    window.__kininariClipStatus = r.status;
    window.__kininariClipSaved = true;
  }
  if (!cfg.api) {
    // 古い気になり帳: 受け口は無く、データは localStorage にある（1.10 の「フォルダを取り込む」が読む形）
    localStorage.setItem('kininari:data:v2', JSON.stringify({ memos: [], notebooks: cfg.folders.map((f, i) => ({ id: 'n' + i, name: f.name, color: f.color })) }));
    return;
  }
  setTimeout(() => {
    window.__kininariRecall = {
      v: 1,
      apply: (p) => fetch('/__stub/apply', { method: 'POST', body: JSON.stringify(p) }).then(r => r.json())
    };
  }, cfg.apiDelay);
})();
</` + `script></body></html>`;
// 結合アプリ（index.html）の代わり。気になり帳は iframe の中
const STUB_HUB = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>結合アプリ（テスト用）</title></head>
<body><div>タブ: 日記帳 / 気になり帳</div><iframe id="frame-kininari" src="kininari.html" style="width:600px;height:300px"></iframe></body></html>`;
// 本物の index.html と同じく、気になり帳の iframe はタブを選んだときに初めて読み込む
const STUB_HUB_LAZY = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>結合アプリ（あとから読み込む）</title></head>
<body><button id="tab-kininari" onclick="var f=document.createElement('iframe');f.src='kininari.html';document.body.appendChild(f);this.disabled=true">気になり帳</button></body></html>`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm' };
const readBody = (req) => new Promise(r => { let b = ''; req.setEncoding('utf8'); req.on('data', c => { b += c; }); req.on('end', () => r(b)); });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const html = (h) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(h); };
  if (u.pathname === '/__stub/config') return json({ api: stub.api, apiDelay: stub.apiDelay, folders: stub.folders });
  if (u.pathname === '/__stub/clip') { try { stubClip(JSON.parse(await readBody(req))); return json({ status: 'saved' }); } catch { return json({ status: 'parse' }); } }
  if (u.pathname === '/__stub/apply') { let p = null; try { p = JSON.parse(await readBody(req)); } catch { /* 下で断る */ } return json(stubApply(p)); }
  if (u.pathname === '/hub-lazy.html') return html(STUB_HUB_LAZY);
  if (!REAL) {
    if (u.pathname === '/kininari.html') return html(STUB_KN);
    if (u.pathname === '/index.html') return html(STUB_HUB);
    res.writeHead(404); return res.end('not found');
  }
  // 本物の気になり帳のフォルダをそのまま配る
  const file = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const KN_URL = ORIGIN + '/kininari.html';

/* ---------- テスト用のサイトへの権限を付けた拡張機能の写し ---------- */

const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-kn-sync-'));
for (const name of fs.readdirSync(EXT_SRC)) {
  if (['tests', 'node_modules', '.git'].includes(name)) continue;
  fs.cpSync(path.join(EXT_SRC, name), path.join(EXT, name), { recursive: true });
}
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
mf.host_permissions = [...(mf.host_permissions || []), 'http://127.0.0.1/*'];
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));

let ctx;
try {
  ctx = await chromium.launchPersistentContext('', {
    headless: false,                                 // 拡張機能の読み込みには画面が必要
    executablePath: process.env.RECALL_CHROME || undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox']
  });
} catch (e) {
  const msg = String(e && e.message || e);
  if (/DISPLAY|X server|ozone/i.test(msg)) console.error('画面が見つかりません。画面のない Linux では:  xvfb-run -a node tests/e2e-kn-sync.mjs');
  else console.error(msg);
  fs.rmSync(EXT, { recursive: true, force: true });
  process.exit(2);
}

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
const extUrl = (p) => `chrome-extension://${extId}/${p}`;
const watch = (p, tag) => {
  p.on('pageerror', e => { if (!REAL || !p.url().startsWith(ORIGIN)) errors.push(`[${tag}] ${e.message}`); });
  p.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (NET.test(t) || /Failed to load resource/.test(t)) return;
    if (REAL && p.url().startsWith(ORIGIN)) return;   // 本物の気になり帳の中のエラー（外部の読み込みなど）は数えない
    errors.push(`[${tag}] console: ${t}`);
  });
};

// 気になり帳のサイトで開いたタブを全部見張る（拡張機能が裏で開いたものも含む）
const knPages = [];          // { page, mine }
const mine = new Set();      // テストが自分で開いたページ
ctx.on('page', (pg) => { watch(pg, 'tab'); knPages.push({ page: pg }); });
const openedByExtension = () => knPages.filter(x => !mine.has(x.page) && x.page.url().startsWith(ORIGIN) && !x.page.url().includes('#knadd='));
const openKn = async (p) => {
  const pg = await ctx.newPage();
  mine.add(pg);
  await pg.goto(ORIGIN + p);
  return pg;
};
const closeKnTabs = async () => {
  for (const pg of ctx.pages()) if (pg.url().startsWith(ORIGIN)) await pg.close().catch(() => {});
};

const lib = await ctx.newPage();   // 画面のエラーは ctx の 'page' で見張っている
mine.add(lib);
await lib.goto(extUrl('library.html'));
await lib.waitForTimeout(1000);

const knState = () => lib.evaluate(async () => (await chrome.storage.local.get('rcKnSync')).rcKnSync || {});
const catNames = () => lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta.cats.map(c => c.name));
const readItems = () => lib.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('L:')).map(([, v]) => v));
/** 合わせる処理が1回終わる（成功・失敗とも）まで待つ */
const lastAt = async () => ((await knState()).last || {}).at || 0;
const waitSync = async (after, ms = 20000, okOnly = true) => waitUntil(async () => {
  const st = await knState();
  return st.last && st.last.at > after && (!okOnly || st.last.ok);
}, ms, 250);

/** 気になり帳のメモの状態 { [URL]: フォルダ名 } とフォルダの一覧。本物ではそのサイトのページの localStorage を読む */
async function knSnapshot(page) {
  if (!REAL) return { memos: Object.fromEntries(stub.memos.map(m => [urlKey(m.u), m.folder])), folders: stub.folders.map(f => f.name) };
  const d = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('kininari:data:v2') || 'null'); } catch { return null; } });
  const nb = new Map(((d && d.notebooks) || []).map(f => [f.id, f.name]));
  const memos = {};
  for (const m of (d && d.memos) || []) for (const l of m.links || []) memos[urlKey(l)] = m.notebookId ? (nb.get(m.notebookId) || '?') : '';
  return { memos, folders: [...nb.values()] };
}
/**
 * 気になり帳にフォルダを足す（スマホで足して同期で届いた、の代わり）。
 * 本物では、気になり帳が動いていない同じサイトのページから localStorage に書く
 * （気になり帳が開いていると、手元のデータで書き戻されることがあるため）。
 */
async function knAddFolder(name) {
  if (!REAL) { stub.folders.push({ name, color: '#C98A1B', parent: null }); return; }
  const pg = await openKn('/hub-lazy.html');
  await pg.evaluate((name) => {
    const d = JSON.parse(localStorage.getItem('kininari:data:v2') || '{"memos":[],"notebooks":[]}');
    d.notebooks.push({ id: 'e2e' + Date.now().toString(36), name, color: '#C98A1B', parentId: null });
    localStorage.setItem('kininari:data:v2', JSON.stringify(d));
  }, name);
  await pg.close();
}
async function editCat(title, label) {
  await lib.goto(extUrl('library.html#all')); await lib.waitForTimeout(700);
  await lib.locator('#list .card', { hasText: title }).first().locator('button', { hasText: '編集' }).click();
  await lib.waitForTimeout(300);
  await lib.selectOption('#eCat', { label });
  await lib.click('#eSave');
  await lib.waitForTimeout(600);
}
const itemCat = async (u) => {
  const cats = await lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta.cats);
  const it = (await readItems()).find(i => i.u === u);
  return it ? (cats.find(c => c.id === it.c) || {}).name : undefined;
};

section(`準備（${REAL ? '本物の気になり帳: ' + ROOT : 'テスト用の気になり帳'}）`);
ok('拡張機能が読み込まれる', !!extId);
await lib.evaluate(async (knUrl) => {
  const m = (await chrome.storage.sync.get('meta')).meta || {};
  await chrome.storage.sync.set({ meta: { ...m, s: { ...(m.s || {}), knOn: true, knUrl, knCat: '調べる' } } });
}, KN_URL);
await lib.reload(); await lib.waitForTimeout(1000);
ok('テスト用のサイトへの権限がある（「保存の確認を許可する」を押した状態）',
  await lib.evaluate((o) => chrome.permissions.contains({ origins: [o + '/*'] }), ORIGIN));
if (REAL) {
  // 本物の気になり帳を一度開いて初期データを作らせ、閉じる（このとき合わせる処理も走るが、まだ項目は無い）
  const first = await openKn('/kininari.html');
  await first.waitForTimeout(4000);
  await first.close();
  await sleep(1500);
}

section('送るとき: 未分類は「フォルダなし」・Recall から来た印');
const U1 = 'https://kn-sync.example/article-1';
const U2 = 'https://kn-sync.example/article-2';
const save = (u, t) => lib.evaluate(([a, b]) => chrome.runtime.sendMessage({ type: 'quickSave', url: a, title: b }), [u, t]);
ok('1件目を保存できる', (await save(U1, '合わせるテスト1')).ok);
ok('2件目を保存できる', (await save(U2, '合わせるテスト2')).ok);
const sentAll = await waitUntil(async () => (await readItems()).filter(i => i.u.startsWith('https://kn-sync.example/')).every(i => i.kn > 0 && i.knc), 40000, 500);
ok('2件とも気になり帳に届き、確認できる', sentAll);
if (!REAL) {
  const c1 = stub.clips.find(c => c.u === U1);
  eq('未分類の項目は f を空で送る', c1 && c1.f, '');
  eq('Recall から来た印（src）を付ける', c1 && c1.src, 'recall');
}
await waitUntil(async () => !ctx.pages().some(pg => pg.url().includes('#knadd=')), 30000, 500);
ok('送信用の裏タブは閉じられる', !ctx.pages().some(pg => pg.url().includes('#knadd=')));
await sleep(1500);

section('気になり帳が開いていないとき');
const callsAtStart = stub.calls.length;
const openedBefore = openedByExtension().length;
let t0 = await lastAt();
await editCat('合わせるテスト1', '技術');
ok('Recall のカテゴリを変えられる', await waitUntil(async () => (await itemCat(U1)) === '技術', 5000));
await sleep(7000);                                    // 3秒待って合わせに行く（開いているタブが無いので何もしない）
eq('自分では気になり帳のタブを開かない', openedByExtension().length, openedBefore);
if (!REAL) eq('気になり帳は呼ばれない', stub.calls.length, callsAtStart);
let st = await knState();
ok('まだ届いていない印が残る', st.pendingAt > 0);
eq('理由は「開いている気になり帳がない」', st.last && st.last.at > t0 && st.last.reason, 'notab');

section('気になり帳を開くと、届いていない分を合わせる');
t0 = await lastAt();
const kn1 = await openKn('/kininari.html');
ok('開いて数秒で合わせる（受け口が出るのを待つ）', await waitSync(t0, 25000));
if (!REAL) {
  const p = stub.calls.at(-1) || {};
  eq('渡す中身の版', p.v, 1);
  ok('カテゴリを渡す（未分類は除く）', Array.isArray(p.cats) && p.cats.some(c => c.name === '技術' && /^#[0-9a-f]{6}$/i.test(c.color)) && !p.cats.some(c => c.name === '未分類'));
  eq('項目の分類を渡す（変えた分は技術・未分類は ""）', (p.items || []).filter(i => i.u.startsWith('https://kn-sync.example/')).map(i => [i.u, i.f]).sort(), [[U1, '技術'], [U2, '']]);
}
let snap;
ok('気になり帳のメモが「技術」へ移る', await waitUntil(async () => { snap = await knSnapshot(kn1); return snap.memos[urlKey(U1)] === '技術'; }, 10000));
eq('未分類のままの項目は「フォルダなし」', snap && snap.memos[urlKey(U2)], '');
ok('気になり帳に「技術」フォルダができる', snap && snap.folders.includes('技術'));
ok('Recall で足したカテゴリ（あとで読む など）も気になり帳のフォルダになる', snap && snap.folders.includes('あとで読む'));
ok('気になり帳の「未分類」フォルダは使わない', snap && !Object.values(snap.memos).includes('未分類'));
let cats = await catNames();
const knOnly = (snap ? snap.folders : []).filter(n => n !== '未分類');
ok('気になり帳のフォルダが Recall のカテゴリに加わる（入れ子も）', knOnly.length > 0 && knOnly.every(n => n.length > 20 || cats.some(c => c.toLowerCase() === n.toLowerCase())));
if (!REAL) ok('（テスト用）株主優待・攻略メモがカテゴリになる', cats.includes('株主優待') && cats.includes('攻略メモ'));
eq('Recall の未分類は1つのまま', cats.filter(n => n === '未分類').length, 1);
// 足したカテゴリの書き込みも「変更」として一度印が付くが、中身は合わせ済みなので数秒で消える
ok('届いていない印が消え、合わせた時刻が残る', await waitUntil(async () => { const x = await knState(); return !x.pendingAt && x.lastOk > 0; }, 10000));
eq('自分ではタブを開いていない', openedByExtension().length, openedBefore);

section('気になり帳が開いているとき');
t0 = await lastAt();
const callsBeforeOpen = stub.calls.length;
const changedAt = Date.now();
await editCat('合わせるテスト2', '学習');
ok('カテゴリを変えると数秒で合わせる', await waitSync(t0, 15000));
console.log(`      （変えてから合わせ終わるまで ${((Date.now() - changedAt) / 1000).toFixed(1)} 秒）`);
if (!REAL) {
  ok('気になり帳を1回だけ呼ぶ', stub.calls.length === callsBeforeOpen + 1);
  eq('変えた分類を渡す', ((stub.calls.at(-1) || {}).items || []).find(i => i.u === U2)?.f, '学習');
}
ok('気になり帳のメモが「学習」へ移る', await waitUntil(async () => (await knSnapshot(kn1)).memos[urlKey(U2)] === '学習', 10000));
t0 = await lastAt();
await lib.goto(extUrl('library.html#all')); await lib.waitForTimeout(700);
await lib.click('#addCat');
await lib.fill('#newCatName', '料理');
await lib.click('#newCatOk');
ok('カテゴリを足すと合わせる', await waitSync(t0, 15000));
ok('気になり帳に「料理」フォルダができる', await waitUntil(async () => (await knSnapshot(kn1)).folders.includes('料理'), 10000));
// 復習の結果やメモの編集では合わせに行かない
t0 = await lastAt();
const callsBeforeNote = stub.calls.length;
await lib.evaluate(async (u) => {
  const ls = await chrome.storage.local.get(null);
  const [k, v] = Object.entries(ls).find(([key, it]) => key.startsWith('L:') && it.u === u);
  await chrome.storage.local.set({ [k]: { ...v, n: 'メモだけ直した', b: 2, up: Date.now() } });
}, U1);
await sleep(5000);
ok('メモや復習の結果だけの変更では合わせない', (await lastAt()) === t0 && stub.calls.length === callsBeforeNote);
await kn1.close();
await sleep(800);

section('結合アプリ（index.html）の iframe の中の気になり帳');
const hub = await openKn('/index.html');
if (REAL) {
  // 本物の index.html は、気になり帳のタブを選んだときに iframe を読み込む
  await hub.waitForTimeout(1500);
  await hub.locator('.apptab[data-app="kininari"]').first().click().catch(() => {});
}
await waitUntil(async () => hub.frames().some(f => /kininari\.html/.test(f.url())), 10000);
await sleep(REAL ? 5000 : 2500);                      // iframe の気になり帳がデータを読み終えるまで
t0 = await lastAt();
await editCat('合わせるテスト1', '未分類');
ok('iframe の中の気になり帳で合わせる', await waitSync(t0, 20000));
const knFrame = hub.frames().find(f => /kininari\.html/.test(f.url()));
ok('未分類に戻すと「フォルダなし」へ移る', await waitUntil(async () => (await knSnapshot(knFrame)).memos[urlKey(U1)] === '', 10000));
if (!REAL) eq('渡す中身（未分類は ""）', ((stub.calls.at(-1) || {}).items || []).find(i => i.u === U1)?.f, '');
eq('このときも自分ではタブを開かない', openedByExtension().length, openedBefore);
await hub.close();
await sleep(800);

section('あとから iframe を読み込む結合アプリ（タブを選んでから気になり帳が出る）');
const lazy = await openKn('/hub-lazy.html');
await sleep(1500);
t0 = await lastAt();
await editCat('合わせるテスト2', '技術');
ok('気になり帳がまだ出ていなければ見送り、印を残す', await waitSync(t0, 15000, false) && (await knState()).pendingAt > 0 && !(await knState()).last.ok);
ok('見直しの予約を置く', await sw.evaluate(async () => !!(await chrome.alarms.get('recall-kn-sync-retry'))));
await sleep(1000);
t0 = await lastAt();
await lazy.click('#tab-kininari');
// iframe の読み込みでは tabs.onUpdated が来ないので、30秒ごとの見直しで拾う
const lazyAt = Date.now();
ok('気になり帳を出すと、見直しの予約で合わせる（1分以内）', await waitSync(t0, 70000));
console.log(`      （気になり帳を出してから合わせ終わるまで ${((Date.now() - lazyAt) / 1000).toFixed(1)} 秒）`);
ok('合わせたら見直しの予約を外す', !(await sw.evaluate(async () => !!(await chrome.alarms.get('recall-kn-sync-retry')))));
ok('「技術」へ移る', await waitUntil(async () => {
  const f = lazy.frames().find(x => /kininari\.html/.test(x.url()));
  return f && (await knSnapshot(f)).memos[urlKey(U2)] === '技術';
}, 10000));
await lazy.close();
await closeKnTabs();
await sleep(800);

section('「気になり帳と合わせる」ボタン（開いていなければ裏で開いて閉じる）');
await knAddFolder('旅行の計画');
await sleep(1000);
ok('（足す前は Recall に無い）', !(await catNames()).includes('旅行の計画'));
const openedBeforeBtn = openedByExtension().length;
await lib.goto(extUrl('library.html#all')); await lib.waitForTimeout(800);
await lib.click('#btnSettings'); await lib.waitForTimeout(800);
const msg = () => lib.locator('#knSyncMsg').innerText();
await lib.click('#knSync');
await waitUntil(async () => { const t = (await msg()).trim(); return !!t && !t.endsWith('…'); }, 45000, 300);
const btnMsg = await msg();
console.log(`      （表示: ${btnMsg}）`);
ok('合わせたと伝える', btnMsg.includes('気になり帳と合わせました'));
ok('気になり帳で足したフォルダをカテゴリに足したと伝える', btnMsg.includes('旅行の計画'));
const btnTabs = openedByExtension().slice(openedBeforeBtn);
eq('裏のタブを1つ開く', btnTabs.length, 1);
ok('開いたのは保存先の気になり帳', btnTabs.length === 1 && btnTabs[0].page.url().split('#')[0] === KN_URL);
ok('終わったら閉じる', await waitUntil(async () => btnTabs.every(x => x.page.isClosed()), 5000));
cats = await catNames();
ok('Recall のカテゴリに加わる', cats.includes('旅行の計画'));
ok('カテゴリの管理にも出る', (await lib.locator('#catEditor input[type=text]').evaluateAll(els => els.map(e => e.value))).includes('旅行の計画'));
ok('最後に合わせた時刻が出る', (await lib.locator('#knSyncState').innerText()).includes('最後に合わせたのは'));
await lib.click('#knSync');
await waitUntil(async () => { const t = (await msg()).trim(); return !!t && !t.endsWith('…') && t !== btnMsg; }, 45000, 300);
ok('2回押しても変わらない', (await msg()).includes('変わったところはありません'));
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(1200);
ok('設定を閉じても足したカテゴリは消えない', (await catNames()).includes('旅行の計画'));

if (!REAL) {
  section('古い気になり帳（合わせる受け口が無い）');
  stub.api = false;
  stub.folders.push({ name: '古い版のフォルダ', color: '#3E6CA3', parent: null });
  const callsOld = stub.calls.length;
  await lib.click('#btnSettings'); await lib.waitForTimeout(800);
  await lib.click('#knSync');
  await waitUntil(async () => { const t = (await msg()).trim(); return !!t && !t.endsWith('…'); }, 45000, 300);
  const oldMsg = await msg();
  console.log(`      （表示: ${oldMsg}）`);
  ok('古い版だと伝える', oldMsg.includes('古い版'));
  ok('フォルダの取り込みだけはする', (await catNames()).includes('古い版のフォルダ'));
  eq('分類は合わせない（受け口が無い）', stub.calls.length, callsOld);
  ok('このときもタブは閉じる', await waitUntil(async () => openedByExtension().every(x => x.page.isClosed()), 5000));
  await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(800);
  stub.api = true;
}

section('後片付け');
const leftOpen = ctx.pages().filter(pg => pg.url().startsWith(ORIGIN) && !mine.has(pg));
eq('拡張機能が開いたタブは残っていない', leftOpen.length, 0);
await ctx.close();
server.closeAllConnections();
await new Promise(r => server.close(r));
fs.rmSync(EXT, { recursive: true, force: true });

console.log('\n--- ページ内エラー ---');
console.log(errors.length ? errors.join('\n') : '（なし）');
console.log(`\n${pass} 件成功 / ${fail} 件失敗 / ページ内エラー ${errors.length} 件`);
process.exit(fail || errors.length ? 1 : 0);

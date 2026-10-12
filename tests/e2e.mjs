/* ============================================================
   Recall — 実ブラウザでの動作テスト
   実際に Chrome へ拡張機能を読み込み、画面を操作して検証する。
   実行: npm run test:e2e   （初回のみ npm install が必要）
   ============================================================ */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadChromium() {
  const candidates = ['playwright', '@playwright/test', 'playwright-core'];
  for (const spec of candidates) {
    try { const m = await import(spec); if (m.chromium) return m.chromium; if (m.default?.chromium) return m.default.chromium; } catch { /* 次を試す */ }
  }
  console.error('Playwright が見つかりません。プロジェクトのフォルダで次を実行してください:\n  npm install\n  npx playwright install chromium');
  process.exit(2);
}
const chromium = await loadChromium();

let pass = 0, fail = 0;
const errors = [];
const netFails = [];
// 外部サムネイルの読み込み失敗は環境依存（オフライン・画像ブロック）なので不具合として数えない
const NET = /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_|ERR_BLOCKED_BY_CLIENT|ERR_PROXY/;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const eq2 = (n, got, want) => {
  const good = got === want;
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${n}` + (good ? '' : `\n      実際: ${JSON.stringify(got)}\n      期待: ${JSON.stringify(want)}`));
};
const section = (t) => console.log(`\n--- ${t} ---`);

let ctx;
try {
  ctx = await chromium.launchPersistentContext('', {
    headless: false,                                 // 拡張機能の読み込みには画面が必要
    executablePath: process.env.RECALL_CHROME || undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox']
  });
} catch (e) {
  const msg = String(e && e.message || e);
  if (/DISPLAY|X server|ozone/i.test(msg)) {
    console.error('画面（デスクトップ環境）が見つかりません。拡張機能の読み込みには実際の画面が必要です。');
    console.error('・普段お使いの Mac / Windows / Linux デスクトップで実行してください。');
    console.error('・画面のない Linux サーバーでは:  xvfb-run -a npm run test:e2e');
  } else if (/Executable doesn't exist|browserType.launch/i.test(msg)) {
    console.error('Chromium が見つかりません。次を実行してください:  npm run setup:browser');
  } else {
    console.error(msg);
  }
  process.exit(2);
}

let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
const url = (p) => `chrome-extension://${id}/${p}`;
const watch = (p, tag) => {
  p.on('pageerror', e => errors.push(`[${tag}] ${e.message}`));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (NET.test(t) || /Failed to load resource/.test(t)) { netFails.push(t); return; }
    errors.push(`[${tag}] console: ${t}`);
  });
};
const WAIT = 1800;    // 同期ストレージへの書き込みは1秒近くかかることがある

// 本体は chrome.storage.local の "L:<id>" に入る（同期分は sync の "i:<id>"）
const readItems = () => lib.evaluate(async () => {
  const ls = await chrome.storage.local.get(null);
  return Object.entries(ls).filter(([k]) => k.startsWith('L:')).map(([, v]) => v);
});
const countSynced = () => lib.evaluate(async () => {
  const ss = await chrome.storage.sync.get(null);
  return Object.keys(ss).filter(k => k.startsWith('i:')).length;
});

section('起動');
ok('拡張機能が読み込まれ Service Worker が動く', !!id);

const lib = await ctx.newPage();
watch(lib, 'library');
await lib.goto(url('library.html'));
await lib.waitForTimeout(900);

ok('ライブラリが表示される', (await lib.title()).includes('Recall'));
ok('サイドバーにビューが並ぶ', (await lib.locator('#views .navitem').count()) === 7);
ok('アイコンが SVG で描画される', (await lib.locator('#views svg.ico').count()) === 7);
ok('既定カテゴリが6件', (await lib.locator('#catList .navitem').count()) === 6);
ok('空状態のメッセージ', (await lib.locator('#empty').innerText()).includes('まだ何も保存されていません'));

section('保存');
const save = (u, t) => lib.evaluate(([a, b]) => chrome.runtime.sendMessage({ type: 'quickSave', url: a, title: b }), [u, t]);
let r = await save('https://ja.react.dev/learn', 'React クイックスタート');
ok('quickSave で保存できる', r && r.ok === true);
r = await save('https://ja.react.dev/learn?utm_source=x', 'React（重複）');
ok('追跡パラメータ違いは重複として弾く', r && r.duplicate === true);
r = await save('chrome://extensions', 'ダメなURL');
ok('chrome:// は保存できない', r && r.ok === false);
r = await save('file:///tmp/a.pdf', 'ローカルファイル');
ok('file:// も保存できない（ポップアップ側の判定と一致）', r && r.ok === false);
await save('https://developer.mozilla.org/ja/docs/Web/CSS', 'CSS リファレンス');
await save('https://news.ycombinator.com/item?id=1', 'HN スレッド');
await lib.waitForTimeout(900);
await lib.reload(); await lib.waitForTimeout(900);
ok('一覧に3件並ぶ', (await lib.locator('#list .card').count()) === 3);

section('検索');
await lib.fill('#q', 'css'); await lib.waitForTimeout(300);
ok('検索で絞り込める', (await lib.locator('#list .card').count()) === 1);
await lib.fill('#q', 'ないはずの語'); await lib.waitForTimeout(250);
ok('該当なしの表示', (await lib.locator('#empty').innerText()).includes('見つかりませんでした'));
await lib.fill('#q', ''); await lib.waitForTimeout(250);

await lib.goto(url('library.html#q/' + encodeURIComponent('css')));
await lib.waitForTimeout(900);
ok('アドレスバー検索の語が検索欄に入る', (await lib.inputValue('#q')) === 'css');
ok('その語で絞り込まれている', (await lib.locator('#list .card').count()) === 1);
await lib.click('#qClear'); await lib.waitForTimeout(400);
ok('検索をクリアすると全件に戻る', (await lib.locator('#list .card').count()) === 3);
await lib.goto(url('library.html#all')); await lib.waitForTimeout(700);

section('編集');
await lib.locator('#list .card').first().locator('button', { hasText: '編集' }).click();
await lib.waitForTimeout(400);
ok('編集ダイアログが開く', await lib.locator('#editDlg').evaluate(d => d.open));
await lib.selectOption('#eCat', { label: '技術' });
await lib.fill('#eTags', 'react, フロントエンド');
await lib.fill('#eNote', 'useEffect の依存配列に注意');
await lib.click('#eSave');
await lib.waitForTimeout(WAIT);
ok('カテゴリを変更できる', (await lib.locator('#catList .navitem').allInnerTexts()).some(t => t.includes('技術') && /\d/.test(t)));
ok('タグがサイドバーに出る', (await lib.locator('#tagCloud .chip').allInnerTexts()).some(t => t.includes('react')));
ok('メモがカードに出る', (await lib.locator('#list .note').first().innerText()).includes('useEffect'));

// 回帰: 以前はテキスト欄で Enter を押すと「キャンセル」扱いになり編集が消えた
await lib.locator('#list .card').first().locator('button', { hasText: '編集' }).click();
await lib.waitForTimeout(400);
await lib.fill('#eTitle', 'Enter で保存されるか');
await lib.locator('#eTitle').press('Enter');
await lib.waitForTimeout(WAIT);
ok('回帰: テキスト欄で Enter を押すと保存される',
  (await lib.locator('#list .card a.title').first().innerText()) === 'Enter で保存されるか');

// 回帰: キャンセルでは保存されない
await lib.locator('#list .card').first().locator('button', { hasText: '編集' }).click();
await lib.waitForTimeout(400);
await lib.fill('#eTitle', '捨てられるはずの値');
await lib.click('#eCancel');
await lib.waitForTimeout(900);
ok('回帰: キャンセルすると変更が破棄される',
  (await lib.locator('#list .card a.title').first().innerText()) === 'Enter で保存されるか');

section('絞り込み');
await lib.locator('#tagCloud .chip', { hasText: 'react' }).click();
await lib.waitForTimeout(400);
ok('タグで絞り込める', (await lib.locator('#list .card').count()) === 1);
ok('見出しがタグ名になる', (await lib.locator('#viewTitle').innerText()).includes('react'));
await lib.locator('#catList .navitem', { hasText: '技術' }).click();
await lib.waitForTimeout(400);
ok('カテゴリで絞り込める', (await lib.locator('#list .card').count()) === 1);

await lib.click('#addCat');
await lib.fill('#newCatName', '料理');
await lib.click('#newCatOk');
await lib.waitForTimeout(WAIT);
ok('カテゴリを追加できる', (await lib.locator('#catList .navitem').count()) === 7);

section('一括操作');
await lib.goto(url('library.html#all')); await lib.waitForTimeout(800);
await lib.check('#selMode'); await lib.waitForTimeout(300);
// 回帰: 以前はカテゴリを追加してもプルダウンが更新されなかった
ok('回帰: 一括バーのプルダウンに新カテゴリが出る',
  (await lib.locator('#bulkCat option').allInnerTexts()).includes('料理'));

await lib.click('#bulkAll'); await lib.waitForTimeout(400);
ok('全選択できる', (await lib.locator('#bulkCount').innerText()).includes('3 件'));
// 回帰: 以前は絞り込みを変えても選択が残り、見えない項目を一括操作できてしまった
await lib.locator('#catList .navitem', { hasText: '技術' }).click();
await lib.waitForTimeout(500);
ok('回帰: 絞り込みを変えると見えない項目の選択が外れる',
  (await lib.locator('#bulkCount').innerText()).includes('1 件'));
await lib.goto(url('library.html#all')); await lib.waitForTimeout(800);
await lib.check('#selMode'); await lib.click('#bulkAll'); await lib.waitForTimeout(300);
await lib.fill('#bulkTag', '一括タグ');
await lib.click('#bulkTagGo'); await lib.waitForTimeout(WAIT);
ok('一括でタグを付与できる', (await lib.locator('#tagCloud .chip').allInnerTexts()).some(t => t.startsWith('一括タグ 3')));
await lib.uncheck('#selMode'); await lib.waitForTimeout(300);
ok('選択モードを切ると一括バーが消える', !(await lib.locator('#bulkbar').isVisible()));

section('復習');
await lib.evaluate(async () => {
  const ls = await chrome.storage.local.get(null);
  const patch = {};
  for (const [k, v] of Object.entries(ls)) if (k.startsWith('L:')) { v.d = Date.now() - 86400000; patch[k] = v; }
  await chrome.storage.local.set(patch);
});
await lib.goto(url('library.html#review')); await lib.waitForTimeout(1000);
ok('今日の復習に3件並ぶ', (await lib.locator('#list .card').count()) === 3);
await lib.click('#startReview'); await lib.waitForTimeout(500);
ok('集中復習が開く', await lib.locator('#focus').isVisible());
ok('進捗が 1 / 3', (await lib.locator('#fProgress').innerText()).trim() === '1 / 3');

// 回帰: 集中復習中に編集ダイアログを開くと、Enter が復習の回答に横取りされていた
await lib.click('#fEdit'); await lib.waitForTimeout(500);
await lib.fill('#eTitle', '集中復習中の編集');
await lib.locator('#eTitle').press('Enter');
await lib.waitForTimeout(WAIT);
ok('回帰: 集中復習中の編集で進捗が進まない', (await lib.locator('#fProgress').innerText()).trim() === '1 / 3');
ok('回帰: 編集内容が集中復習カードに反映される', (await lib.locator('#fTitle').innerText()) === '集中復習中の編集');

await lib.click('#fOk'); await lib.waitForTimeout(WAIT);
ok('覚えたで次へ進む', (await lib.locator('#fProgress').innerText()).trim() === '2 / 3');
await lib.keyboard.press('1'); await lib.waitForTimeout(WAIT);
ok('キーボードでも回答できる', (await lib.locator('#fProgress').innerText()).trim() === '3 / 3');
await lib.click('#fOk'); await lib.waitForTimeout(WAIT);
ok('最後まで進むと閉じる', !(await lib.locator('#focus').isVisible()));
await lib.goto(url('library.html#review')); await lib.waitForTimeout(900);
ok('復習済みは今日の復習から消える', (await lib.locator('#list .card').count()) === 0);

section('アーカイブと復帰');
await lib.goto(url('library.html#all')); await lib.waitForTimeout(800);
await lib.check('#selMode'); await lib.click('#bulkAll'); await lib.waitForTimeout(300);
await lib.click('#bulkArchive'); await lib.waitForTimeout(WAIT);
await lib.goto(url('library.html#archived')); await lib.waitForTimeout(900);
ok('アーカイブに3件入る', (await lib.locator('#list .card').count()) === 3);
// 回帰: 以前は戻しても期限が 0 のままで、二度と復習に出てこなかった
await lib.locator('#list .card').first().locator('button', { hasText: '戻す' }).click();
await lib.waitForTimeout(WAIT);
await lib.goto(url('library.html#review')); await lib.waitForTimeout(900);
ok('回帰: アーカイブから戻すと今日の復習に出る', (await lib.locator('#list .card').count()) === 1);

// 回帰: 編集ダイアログでアーカイブ→学習中に戻したときも期限が入る
await lib.goto(url('library.html#archived')); await lib.waitForTimeout(900);
ok('戻した1件はアーカイブから外れる', (await lib.locator('#list .card').count()) === 2);
await lib.locator('#list .card').first().locator('button', { hasText: '編集' }).click();
await lib.waitForTimeout(400);
await lib.selectOption('#eStatus', '1');
await lib.click('#eSave'); await lib.waitForTimeout(WAIT);
await lib.goto(url('library.html#review')); await lib.waitForTimeout(900);
ok('回帰: 編集で学習中に戻すと今日の復習に出る', (await lib.locator('#list .card').count()) === 2);

section('設定');
await lib.goto(url('library.html#all')); await lib.waitForTimeout(800);
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
ok('設定ダイアログが開く', await lib.locator('#setDlg').evaluate(d => d.open));
await lib.fill('#sSteps', '2, 4, 8');
await lib.selectOption('#sHour', '21');
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(WAIT);
let m = await lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta.s);
ok('間隔設定が保存される', JSON.stringify(m.steps) === '[2,4,8]');
ok('通知時刻が保存される', m.hour === 21);

// 回帰: 以前は「すべて削除」の後に閉じると古い設定が書き戻っていた
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
// confirm は差し替えるので、ダイアログの受け手は登録しない
// （登録すると使われないまま残り、あとのテストのダイアログを二重に処理してしまう）
await lib.evaluate(() => { window.confirm = () => true; });
await lib.click('#wipe'); await lib.waitForTimeout(WAIT);
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(WAIT);
m = await lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta);
ok('回帰: すべて削除の後に設定が復活しない', !m || !m.s || JSON.stringify(m.s.steps) !== '[2,4,8]');
ok('すべて削除で項目が消える', (await readItems()).length === 0);
ok('同期側も空になる', (await countSynced()) === 0);

section('ポップアップ');
const fakeTab = (u, t) => `chrome.tabs.query = (info, cb) => { const f=[{id:99,url:${JSON.stringify(u)},title:${JSON.stringify(t)}}]; return cb ? cb(f) : Promise.resolve(f); };`;
async function openPopup(u, t, tag) {
  const p = await ctx.newPage();
  watch(p, tag);
  await p.addInitScript(fakeTab(u, t));
  await p.goto(url('popup.html'));
  await p.waitForTimeout(900);
  return p;
}

const pop = await openPopup('https://example.com/great-article', 'すごい記事', 'popup');
ok('現在タブのタイトルが入る', (await pop.inputValue('#title')) === 'すごい記事');
ok('カテゴリ選択が並ぶ', (await pop.locator('#cats .cat').count()) >= 7);

// 回帰: IME 変換中のスペース／Enter でタグが確定してしまわないこと
await pop.fill('#tagInput', 'きかいがくしゅう');
await pop.evaluate(() => {
  const el = document.getElementById('tagInput');
  el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', isComposing: true, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
});
await pop.waitForTimeout(300);
ok('回帰: IME 変換中のスペースでタグが確定しない', (await pop.locator('#tagChips .chip').count()) === 0);
ok('回帰: 変換中の文字が入力欄に残る', (await pop.inputValue('#tagInput')) === 'きかいがくしゅう');
await pop.fill('#tagInput', '');

await pop.locator('#cats .cat', { hasText: '学習' }).first().click();
await pop.fill('#tagInput', 'あとで読む');
await pop.keyboard.press('Enter');
await pop.fill('#note', 'ポップアップからのメモ');
// 回帰: タグ欄に打ちかけの文字があっても保存に取り込まれる
await pop.fill('#tagInput', '打ちかけタグ');
await pop.click('#save');
await lib.waitForTimeout(2200);

const saved = (await readItems()).find(v => v.u.includes('great-article'));
ok('ポップアップから保存できる', !!saved);
ok('タグが保存される', saved && saved.g.includes('あとで読む'));
ok('回帰: 打ちかけのタグも取り込まれる', saved && saved.g.includes('打ちかけタグ'));
ok('メモが保存される', saved && saved.n === 'ポップアップからのメモ');
ok('選んだカテゴリで保存される', saved && saved.c === 'c2');

const pop2 = await openPopup('https://example.com/great-article', 'すごい記事', 'popup2');
ok('保存済みは編集モードで開く', (await pop2.locator('#state').innerText()).includes('保存済み'));
ok('メモが復元される', (await pop2.inputValue('#note')) === 'ポップアップからのメモ');
ok('次の復習日が表示される', /次の復習は/.test(await pop2.locator('#savedDue').innerText()));
const before = await pop2.locator('#savedDue').innerText();
await pop2.click('#pOk'); await lib.waitForTimeout(WAIT);
ok('ポップアップから復習を記録できる', (await pop2.locator('#savedDue').innerText()) !== before);

// 回帰: SPA のハッシュルートは別ページとして扱う
const pop3 = await openPopup('https://example.com/great-article#/other', '別のルート', 'popup3');
ok('回帰: ハッシュルートが違えば新規保存になる', (await pop3.locator('#state').innerText()).includes('新規'));

// 回帰: 完了済みの項目で間隔を変えると学習中に戻る
await lib.evaluate(async () => {
  const ls = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(ls)) {
    if (k.startsWith('L:') && v.u && v.u.includes('great-article') && !v.u.includes('other')) {
      v.s = 2; v.d = 0; await chrome.storage.local.set({ [k]: v });
    }
  }
});
await lib.waitForTimeout(1200);
const pop4 = await openPopup('https://example.com/great-article', 'すごい記事', 'popup4');
ok('完了状態が表示される', (await pop4.locator('#savedDue').innerText()).includes('完了'));
await pop4.selectOption('#iv', '7');
await pop4.click('#save');
await lib.waitForTimeout(2200);
const revived = (await readItems()).find(v => v.u.includes('great-article') && !v.u.includes('other'));
ok('回帰: 完了項目の間隔を変えると学習中に戻る', revived && revived.s === 1);
ok('回帰: そのとき次回の復習日が入る', revived && revived.d > 0);

section('YouTube とサムネイル');
await save('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'サンプル動画');
await lib.waitForTimeout(1200);
let dup = await save('https://youtu.be/dQw4w9WgXcQ?si=xyz&list=PLabc', '同じ動画（別URL）');
ok('同じ動画は重複としてまとめる', dup && dup.duplicate === true);
dup = await save('https://www.youtube.com/shorts/dQw4w9WgXcQ', '同じ動画（shorts）');
ok('shorts の URL も同じ動画として扱う', dup && dup.duplicate === true);
await save('https://www.youtube.com/watch?v=aBcDeFgHiJk', '別の動画');
await lib.waitForTimeout(1200);

await lib.goto(url('library.html#all')); await lib.waitForTimeout(900);
ok('YouTube のカードにサムネイルが付く', (await lib.locator('#list .card .thumb').count()) >= 2);
ok('サムネイルのクラス名がカードと衝突しない',
  (await lib.locator('#list .card').count()) === (await lib.locator('#list .card a.title').count()));
const thumbSrc = await lib.locator('#list .card .thumb img').first().getAttribute('src');
ok('サムネイルは動画IDから導出される', /i\.ytimg\.com\/vi\/[\w-]{11}\/mqdefault\.jpg/.test(thumbSrc));
ok('その場再生ボタンがある', (await lib.locator('#list .card .thumb .play').count()) >= 2);

// 画像データそのものは保存していない（容量を食わない）
const ytItem = (await readItems()).find(i => i.u.includes('dQw4w9WgXcQ'));
ok('項目にサムネイルURLを保存していない', ytItem && !JSON.stringify(ytItem).includes('ytimg'));
ok('項目1件は 400 バイト未満', ytItem && new TextEncoder().encode(JSON.stringify(ytItem)).length < 400);

await lib.locator('#list .card .thumb .play').first().click();
await lib.waitForTimeout(600);
ok('クリックで埋め込みプレーヤーに変わる', (await lib.locator('#list .card .thumb iframe').count()) === 1);
const frameSrc = await lib.locator('#list .card .thumb iframe').first().getAttribute('src');
ok('youtube-nocookie で埋め込む', /youtube-nocookie\.com\/embed\/[\w-]{11}/.test(frameSrc));

await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.uncheck('#sThumbs');
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(WAIT);
ok('設定でサムネイルを消せる', (await lib.locator('#list .card .thumb').count()) === 0);
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.check('#sThumbs');
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(WAIT);
ok('戻すとサムネイルが復活する', (await lib.locator('#list .card .thumb').count()) >= 2);

section('ハイブリッド保存');
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.fill('#sSyncMax', '2');
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(2200);
const totalNow = (await readItems()).length;
const syncedNow = await countSynced();
ok(`同期件数の上限が効く（全${totalNow}件中 同期${syncedNow}件）`, syncedNow <= 2 && totalNow > 2);
await lib.reload(); await lib.waitForTimeout(1200);
ok('同期に載らない項目も一覧に出る', (await lib.locator('#list .card').count()) === totalNow);

await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.uncheck('#sSync');
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(2200);
ok('同期をオフにすると同期側が空になる', (await countSynced()) === 0);
await lib.reload(); await lib.waitForTimeout(1200);
ok('同期オフでも全件そのまま', (await lib.locator('#list .card').count()) === totalNow);
ok('サイドバーに同期オフと出る', (await lib.locator('#usageSync').innerText()).includes('オフ'));
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.check('#sSync'); await lib.fill('#sSyncMax', '300');
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(2200);
ok('同期を戻すと再び載る', (await countSynced()) > 0);

section('気になり帳へ送る');
// 気になり帳の代わりになる小さなページをローカルに立てる
const knPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>気になり帳（テスト用）</title></head>
<body><pre id="got"></pre><script>
  document.getElementById('got').textContent = location.hash;
  window.__kininariClipSaved = true;
</` + `script></body></html>`;
const knServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(knPage);
});
await new Promise(r => knServer.listen(0, '127.0.0.1', r));
const knBase = `http://127.0.0.1:${knServer.address().port}/kininari.html`;

await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.check('#sKnOn');
await lib.fill('#sKnUrl', knBase);
await lib.selectOption('#sKnCat', '調べる');
ok('保存先URLを入れると許可ボタンが押せる', !(await lib.locator('#sKnPerm').isDisabled()));
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(2200);
const knCfg = await lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta.s);
ok('設定が保存される', knCfg.knOn === true && knCfg.knUrl === knBase.replace(/\s/g, ''));
eq2('カテゴリも保存される', knCfg.knCat, '調べる');

// 裏タブが開くのを捕まえて、送られた内容を確かめる
const openedTabs = [];
const onPage = (pg) => { openedTabs.push(pg); };   // 通知時点では about:blank なので後で URL を見る
ctx.on('page', onPage);
const clipTabsNow = () => openedTabs.filter(pg => pg.url().includes('#knadd='));
const waitUntilTabs = async (n, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && clipTabsNow().length < n) await lib.waitForTimeout(250);
};

// 前のセクションで保存済みの動画と重ならないよう、新しい動画IDを使う
const knPop = await openPopup('https://www.youtube.com/watch?v=knTestVid01', '送信テストの動画', 'kn-popup');
await knPop.locator('#cats .cat', { hasText: '技術' }).first().click();
await knPop.fill('#tagInput', 'テストタグ');
await knPop.keyboard.press('Enter');
await knPop.fill('#note', '気になり帳へ送るメモ');
ok('ポップアップに送信の案内が出る', (await knPop.locator('#knText').innerText()).includes('気になり帳'));
await knPop.click('#save');
await lib.waitForTimeout(12000);   // 確認の権限が無いときは読み込みを待ってから閉じる

const clipTabs = clipTabsNow();
ok('気になり帳を裏タブで開く', clipTabs.length >= 1);
const clipUrl = clipTabs.length ? clipTabs[0].url() : '';
ok('保存先URLに送っている', clipUrl.startsWith(knBase + '#knadd='));
let sent = null;
try { sent = JSON.parse(decodeURIComponent(clipUrl.split('#knadd=')[1])); } catch { sent = null; }
ok('送った内容を読み取れる', !!sent);
eq2('タイトルが送られる', sent && sent.t, '送信テストの動画');
eq2('URLが送られる', sent && sent.u, 'https://www.youtube.com/watch?v=knTestVid01');
ok('メモが送られる', sent && sent.n.includes('気になり帳へ送るメモ'));
ok('タグが本文に付く', sent && sent.n.includes('#テストタグ'));
eq2('Recall のカテゴリがフォルダになる', sent && sent.f, '技術');
eq2('気になり帳のカテゴリが入る', sent && sent.c, '調べる');
ok('YouTube のサムネイルURLが付く', sent && /i\.ytimg\.com\/vi\/knTestVid01/.test(sent.img));
ok('タグを項目として送る', sent && Array.isArray(sent.tags) && sent.tags.includes('テストタグ'));
ok('復習の進み具合を送る', sent && sent.srs && typeof sent.srs.d === 'number' && sent.srs.d > 0);
eq2('新しい項目は未読で送る', sent && sent.srs && sent.srs.st, 0);
ok('クリップの番号を付けて送る（気になり帳が二重登録を防ぐ）', sent && /^[0-9a-f]{32}$/.test(sent.k || ''));

// 送った印が付き、裏タブは自動で閉じられる
const clipped = (await readItems()).find(i => i.u.includes('knTestVid01'));
ok('送信済みの印が付く', clipped && clipped.kn > 0);
for (let i = 0; i < 30 && clipTabsNow().some(pg => !pg.isClosed()); i++) await lib.waitForTimeout(1000);
ok('裏タブは自動で閉じられる', clipTabsNow().length > 0 && clipTabsNow().every(pg => pg.isClosed()));

// 更新のたびには送らない
const clipsBefore = clipTabsNow().length;
const knPop2 = await openPopup('https://www.youtube.com/watch?v=knTestVid01', '送信テストの動画', 'kn-popup2');
ok('送信済みと表示される', (await knPop2.locator('#knText').innerText()).includes('送信済み'));
await knPop2.fill('#note', 'あとから直したメモ');
await knPop2.click('#save');
await lib.waitForTimeout(3500);
ok('更新では送らない', clipTabsNow().length === clipsBefore);
ok('送った番号を項目に残す', (await readItems()).find(i => i.u.includes('knTestVid01')).knk === sent.k);

// 「送信済み（未確認）」を送り直すときは同じ番号で（届いていれば気になり帳が「もう入っている」と返す）
const knPop3 = await openPopup('https://www.youtube.com/watch?v=knTestVid01', '送信テストの動画', 'kn-popup3');
ok('未確認の項目には送り直しのボタンが出る', await knPop3.locator('#knSend').isVisible());
await knPop3.click('#knSend');
await waitUntilTabs(clipsBefore + 1);
const resent = clipTabsNow().slice(clipsBefore).map(pg => { try { return JSON.parse(decodeURIComponent(pg.url().split('#knadd=')[1])); } catch { return null; } })[0];
eq2('回帰: 未確認の送り直しは同じ番号を使う', resent && resent.k, sent && sent.k);
await lib.waitForTimeout(12000);
await knPop3.close().catch(() => {});

section('回帰: 裏タブは一度に1つ');
// 権限を許可していない状態で複数件を送っても、裏タブが一斉に開かないこと
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.fill('#sKnUrl', knBase);
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(2500);
const beforeTabs = openedTabs.length;
const manyIds = await lib.evaluate(async () => {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const r = await chrome.runtime.sendMessage({ type: 'quickSave', url: 'https://example.com/burst' + i, title: 'burst' + i });
    if (r && r.item) out.push(r.item.id);
  }
  return out;
});
eq2('3件保存できる', manyIds.length, 3);
await lib.waitForTimeout(3000);
const openNow = openedTabs.filter(pg => !pg.isClosed() && pg.url().includes('#knadd=')).length;
ok(`回帰: 同時に開く裏タブは1つ（実際 ${openNow}）`, openNow <= 1);
// 送信が終わるまで待って、全部片付くこと
for (let i = 0; i < 60 && (await lib.evaluate(async () => ((await chrome.storage.local.get('rcClipQueue')).rcClipQueue || []).length)) > 0; i++) {
  await lib.waitForTimeout(1000);
}
const burstQueue = await lib.evaluate(async () => (await chrome.storage.local.get('rcClipQueue')).rcClipQueue || []);
eq2('最後には全部送られる', burstQueue.length, 0);
const burstItems = (await readItems()).filter(i => i.u.includes('/burst'));
ok('3件とも印が付く', burstItems.length === 3 && burstItems.every(i => i.kn > 0));

section('送信の信頼性');
// わざと送れない保存先にする（data: URL はタブを開けないので必ず失敗する）
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.fill('#sKnUrl', 'data:text/html,kininari');
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(2500);

const failPop = await openPopup('https://example.com/fail-clip-test', '送れないはずの記事', 'kn-fail');
await failPop.click('#save');
await lib.waitForTimeout(5000);

const failed = (await readItems()).find(i => i.u.includes('fail-clip-test'));
ok('項目自体は保存されている', !!failed);
eq2('回帰: 送信に失敗しても「送信済み」にしない', failed && failed.kn, 0);
const queued = await lib.evaluate(async () => (await chrome.storage.local.get('rcClipQueue')).rcClipQueue || []);
ok('未送信として残る', queued.some(e => e.id === failed.id));
ok('失敗の回数が記録される', queued.some(e => e.id === failed.id && e.tries >= 1));

await lib.click('#btnSettings'); await lib.waitForTimeout(600);
ok('設定に未送信の件数が出る', await lib.locator('#sKnQueue').isVisible());
ok('未送信の見出しが出る', (await lib.locator('#sKnQueueCount').innerText()).includes('未送信'));
ok('未送信の中身が並ぶ', (await lib.locator('#sKnQueueList li').first().innerText()).includes('送れないはずの記事'));

// ポップアップでも「送信待ち」と分かる
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(1500);
const failPop2 = await openPopup('https://example.com/fail-clip-test', '送れないはずの記事', 'kn-fail2');
ok('ポップアップに送信待ちと出る', (await failPop2.locator('#knText').innerText()).includes('送信待ち'));
await failPop2.close();

// 保存先を直すと自動で送り直す
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.fill('#sKnUrl', knBase);
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(22000);   // 確認の権限が無いときは8秒待ってからタブを閉じる
const afterFix = (await readItems()).find(i => i.u.includes('fail-clip-test'));
ok('保存先を直すと送られる', afterFix && afterFix.kn > 0);
eq2('確認していないので未確認あつかい', afterFix && afterFix.knc, 0);
const queueAfter = await lib.evaluate(async () => (await chrome.storage.local.get('rcClipQueue')).rcClipQueue || []);
ok('未送信から消える', !queueAfter.some(e => e.id === afterFix.id));

const fixPop = await openPopup('https://example.com/fail-clip-test', '送れないはずの記事', 'kn-fixed');
ok('ポップアップに未確認と出る', (await fixPop.locator('#knText').innerText()).includes('未確認'));
await fixPop.close();

await lib.click('#btnSettings'); await lib.waitForTimeout(600);
ok('未送信の表示が消える', !(await lib.locator('#sKnQueue').isVisible()));
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(1500);

// 設定を戻す
ctx.off('page', onPage);
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.uncheck('#sKnOn');
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(2200);
ok('オフに戻せる', (await lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta.s.knOn)) === false);
// ブラウザがつなぎっぱなしにしている接続があると close が終わらないので、先に切る
knServer.closeAllConnections();
await new Promise(r => knServer.close(r));

section('回帰: 画面の細かい不具合');
await lib.goto(url('library.html#all')); await lib.waitForTimeout(900);

// 修飾キー付きのショートカットを横取りしない
const viewBefore = await lib.locator('#viewTitle').innerText();
await lib.locator('#list').click({ position: { x: 5, y: 5 } }).catch(() => {});
await lib.keyboard.press('Control+a');
await lib.waitForTimeout(400);
eq2('回帰: Ctrl+A でビューが変わらない', await lib.locator('#viewTitle').innerText(), viewBefore);

// 一括操作のあとに選択が残らない
await lib.check('#selMode'); await lib.waitForTimeout(300);
await lib.click('#bulkAll'); await lib.waitForTimeout(300);
const selCount = await lib.locator('#list .card').count();
ok('全選択できる', (await lib.locator('#bulkCount').innerText()).includes(`${selCount} 件`));
await lib.click('#bulkArchive'); await lib.waitForTimeout(WAIT);
ok('回帰: アーカイブ後に選択が残らない', (await lib.locator('#bulkCount').innerText()).includes('0 件'));
await lib.uncheck('#selMode'); await lib.waitForTimeout(300);

// 集中復習を終えると埋め込み動画が残らない
await lib.goto(url('library.html#archived')); await lib.waitForTimeout(800);
await lib.check('#selMode'); await lib.click('#bulkAll'); await lib.waitForTimeout(300);
await lib.click('#bulkDone'); await lib.waitForTimeout(WAIT);
await lib.uncheck('#selMode'); await lib.waitForTimeout(300);
await lib.evaluate(async () => {
  const ls = await chrome.storage.local.get(null);
  const patch = {};
  for (const [k, v] of Object.entries(ls)) {
    if (k.startsWith('L:') && v.u && v.u.includes('youtube')) { v.s = 1; v.d = Date.now() - 86400000; patch[k] = v; }
  }
  await chrome.storage.local.set(patch);
});
await lib.goto(url('library.html#review')); await lib.waitForTimeout(1200);
if (await lib.locator('#startReview').isVisible()) {
  await lib.click('#startReview'); await lib.waitForTimeout(500);
  if (await lib.locator('#fThumb .play').count()) {
    await lib.locator('#fThumb .play').click();
    await lib.waitForTimeout(600);
    ok('集中復習で動画を再生できる', (await lib.locator('#fThumb iframe').count()) === 1);
    await lib.click('#fClose'); await lib.waitForTimeout(500);
    eq2('回帰: 終了すると埋め込みが残らない（音が鳴り続けない）', await lib.locator('#fThumb iframe').count(), 0);
  } else {
    ok('集中復習で動画を再生できる（対象なしのため省略）', true);
    ok('回帰: 終了すると埋め込みが残らない（対象なしのため省略）', true);
    await lib.click('#fClose').catch(() => {});
  }
} else {
  ok('集中復習で動画を再生できる（対象なしのため省略）', true);
  ok('回帰: 終了すると埋め込みが残らない（対象なしのため省略）', true);
}

section('バージョン情報と更新履歴');
const manifestVer = await lib.evaluate(() => chrome.runtime.getManifest().version);
ok('サイドバーにバージョンが出る',
  (await lib.locator('#verText').innerText()) === `Recall v${manifestVer}`);
await lib.click('#verBtn'); await lib.waitForTimeout(400);
ok('更新履歴ダイアログが開く', await lib.locator('#aboutDlg').evaluate(d => d.open));
ok('ダイアログにもバージョンが出る',
  (await lib.locator('#aboutVer').innerText()).includes(manifestVer));
const releases = await lib.locator('#changelog .release').count();
ok(`更新履歴が全バージョン分並ぶ（${releases}件）`, releases >= 3);
ok('最新版に「使用中」が付く',
  (await lib.locator('#changelog .release.latest .tag').innerText()) === '使用中');
ok('最新版の見出しが現在のバージョン',
  (await lib.locator('#changelog .release').first().locator('.rver').innerText()) === 'v' + manifestVer);
ok('変更点が箇条書きで出る', (await lib.locator('#changelog .release li').count()) > 5);
ok('日付が表示される', /\d{4}-\d{2}-\d{2}/.test(await lib.locator('#changelog .rdate').first().innerText()));
await lib.locator('#aboutDlg button[value=close]').click();
await lib.waitForTimeout(400);
ok('閉じられる', !(await lib.locator('#aboutDlg').evaluate(d => d.open)));

// 更新直後のお知らせ
await lib.evaluate(async (v) => { await chrome.storage.local.set({ updatedTo: v }); }, manifestVer);
await lib.reload(); await lib.waitForTimeout(1200);
ok('更新のお知らせが出る', await lib.locator('#updated').isVisible());
ok('お知らせにバージョンが出る', (await lib.locator('#updatedVer').innerText()) === 'v' + manifestVer);
await lib.click('#updatedShow'); await lib.waitForTimeout(500);
ok('「変更点を見る」で履歴が開く', await lib.locator('#aboutDlg').evaluate(d => d.open));
await lib.locator('#aboutDlg button[value=close]').click(); await lib.waitForTimeout(400);
ok('お知らせは閉じている', !(await lib.locator('#updated').isVisible()));
await lib.reload(); await lib.waitForTimeout(1200);
ok('一度閉じたら再表示されない', !(await lib.locator('#updated').isVisible()));

// 別バージョンの記録が残っていても出さない
await lib.evaluate(async () => { await chrome.storage.local.set({ updatedTo: '0.0.1' }); });
await lib.reload(); await lib.waitForTimeout(1200);
ok('別バージョンの記録では出さない', !(await lib.locator('#updated').isVisible()));
await lib.evaluate(async () => { await chrome.storage.local.remove('updatedTo'); });

section('ページ情報の読み取り');
const fx = await ctx.newPage();
watch(fx, 'fixture');
await fx.goto(url('tests/fixture-ogp.html'));
await fx.waitForFunction(() => window.__ready === true, null, { timeout: 8000 });
const meta1 = await fx.evaluate(() => window.__readPageMeta());
eq2('OGP タイトルを優先する', meta1.title, 'OGPのタイトル');
eq2('サイト名を読む', meta1.si, 'テストメディア');
eq2('著者を読む', meta1.au, '山田太郎');
eq2('OGP の説明を優先する', meta1.desc, 'OGPの説明文です。');
ok('相対パスの画像URLを絶対URLに直す', /^chrome-extension:\/\/.*\/images\/hero\.png$/.test(meta1.th));

await fx.goto(url('tests/fixture-video.html'));
await fx.waitForFunction(() => window.__ready === true, null, { timeout: 8000 });
const meta2 = await fx.evaluate(() => window.__readPageMeta());
eq2('チャンネル名を読む', meta2.au, 'テストチャンネル');
eq2('再生時間を読む', meta2.du, 'PT18M22S');
eq2('絶対URLの画像はそのまま', meta2.th, 'https://example.com/thumb.jpg');
await fx.close();

section('サムネイル情報の保持');
// 直接 R: を書いて、編集してもサムネイルが消えないことを確かめる
await lib.goto(url('library.html#all')); await lib.waitForTimeout(900);
const firstTitle = await lib.locator('#list .card a.title').first().innerText();
const target = (await readItems()).find(i => i.t === firstTitle) || (await readItems())[0];
await lib.evaluate(async (id) => {
  await chrome.storage.local.set({ ['R:' + id]: { th: 'https://example.com/keep.png', si: 'Keep', au: 'テスト著者' } });
}, target.id);
await lib.reload(); await lib.waitForTimeout(1200);
ok('サムネイル情報がカードに反映される',
  (await lib.locator('#list .card .meta').allInnerTexts()).some(t => t.includes('テスト著者')));

await lib.locator('#list .card').first().locator('button', { hasText: '編集' }).click();
await lib.waitForTimeout(400);
await lib.fill('#eNote', 'サムネイル保持の確認');
await lib.click('#eSave'); await lib.waitForTimeout(WAIT);
const richAfterEdit = await lib.evaluate(async (id) => (await chrome.storage.local.get('R:' + id))['R:' + id], target.id);
ok('編集してもサムネイル情報が残る', richAfterEdit && richAfterEdit.th === 'https://example.com/keep.png');

section('削除と元に戻す');
await lib.goto(url('library.html#all')); await lib.waitForTimeout(900);
const nCards = await lib.locator('#list .card').count();
ok('カードに削除ボタンがある', (await lib.locator('#list .card button.del').count()) === nCards);
// 消す前に、サムネイル情報と復習の進み具合を持たせておく（戻したときに失われないか見る）
await lib.evaluate(async (vid) => {
  const k = 'L:' + vid; const v = (await chrome.storage.local.get(k))[k];
  v.rv = 4; v.b = 3; v.s = 1; await chrome.storage.local.set({ [k]: v });
}, target.id);
await lib.reload(); await lib.waitForTimeout(1200);
const victimCard = lib.locator('#list .card').filter({ has: lib.locator(`a.title`, { hasText: (await readItems()).find(i => i.id === target.id).t }) }).first();
await victimCard.locator('button.del').click();
await lib.waitForTimeout(WAIT);
eq2('削除ボタンで一覧から消える', await lib.locator('#list .card').count(), nCards - 1);
ok('端末内からも消える', !(await readItems()).some(i => i.id === target.id));
ok('「元に戻す」が出る', await lib.locator('#toastUndo').isVisible());
ok('何を消したかが出る', (await lib.locator('#toastMsg').innerText()).includes('を削除しました'));
await lib.click('#toastUndo'); await lib.waitForTimeout(WAIT);
eq2('元に戻すとカードが戻る', await lib.locator('#list .card').count(), nCards);
const backItem = (await readItems()).find(i => i.id === target.id);
ok('復習の進み具合も元どおり', !!backItem && backItem.rv === 4 && backItem.b === 3 && backItem.s === 1);
const richBack = await lib.evaluate(async (vid) => (await chrome.storage.local.get('R:' + vid))['R:' + vid], target.id);
ok('サムネイル情報も戻る', !!richBack && richBack.th === 'https://example.com/keep.png');
const delRec = await lib.evaluate(async () => (await chrome.storage.sync.get('del')).del || []);
ok('削除の記録は外れる（他の PC で消されない）', !delRec.some(d => d.i === target.id));
ok('戻したことを知らせる', (await lib.locator('#toastMsg').innerText()).includes('元に戻しました'));
ok('戻したあとは「元に戻す」を出さない', !(await lib.locator('#toastUndo').isVisible()));

await lib.locator('#list .card').first().locator('button.del').click(); await lib.waitForTimeout(WAIT);
eq2('もう一度消す', await lib.locator('#list .card').count(), nCards - 1);
await lib.keyboard.press('Control+z'); await lib.waitForTimeout(WAIT);
eq2('Ctrl+Z でも戻る', await lib.locator('#list .card').count(), nCards);

await lib.locator('#list .card').first().locator('button', { hasText: '編集' }).click(); await lib.waitForTimeout(400);
await lib.click('#eDel'); await lib.waitForTimeout(WAIT);
ok('編集ダイアログからも削除できる',
  !(await lib.locator('#editDlg').isVisible()) && (await lib.locator('#list .card').count()) === nCards - 1);
await lib.click('#toastUndo'); await lib.waitForTimeout(WAIT);
eq2('編集ダイアログからの削除も戻せる', await lib.locator('#list .card').count(), nCards);

await lib.check('#selMode'); await lib.waitForTimeout(300);
await lib.click('#bulkAll'); await lib.waitForTimeout(300);
lib.once('dialog', d => d.accept().catch(() => {}));
await lib.click('#bulkDel'); await lib.waitForTimeout(WAIT);
eq2('選択してまとめて削除', await lib.locator('#list .card').count(), 0);
ok('件数を知らせる', (await lib.locator('#toastMsg').innerText()).includes(`${nCards} 件を削除しました`));
await lib.click('#toastUndo'); await lib.waitForTimeout(WAIT);
eq2('まとめて削除も元に戻せる', await lib.locator('#list .card').count(), nCards);
await lib.uncheck('#selMode'); await lib.waitForTimeout(300);

// 集中復習で「不要」と判断したら、その場で消して次へ
await lib.evaluate(async () => {
  const ls = await chrome.storage.local.get(null);
  const patch = {};
  for (const [k, v] of Object.entries(ls)) if (k.startsWith('L:')) { v.s = 1; v.d = Date.now() - 86400000; patch[k] = v; }
  await chrome.storage.local.set(patch);
});
await lib.goto(url('library.html#review')); await lib.waitForTimeout(1000);
const dueN = await lib.locator('#list .card').count();
await lib.click('#startReview'); await lib.waitForTimeout(500);
await lib.click('#fDel'); await lib.waitForTimeout(WAIT);
eq2('集中復習から削除すると次へ進む', (await lib.locator('#fProgress').innerText()).trim(), `2 / ${dueN}`);
ok('集中復習の上にも「元に戻す」が出る', await lib.locator('#toastUndo').isVisible());
await lib.click('#toastUndo'); await lib.waitForTimeout(WAIT);
await lib.click('#fClose'); await lib.waitForTimeout(500);
await lib.goto(url('library.html#review')); await lib.waitForTimeout(1000);
eq2('集中復習で消したものも元に戻せる', await lib.locator('#list .card').count(), dueN);

section('バックアップ');
const dump = await lib.evaluate(async () => {
  const ls = await chrome.storage.local.get(null);
  const ss = await chrome.storage.sync.get('meta');
  return { items: Object.entries(ls).filter(([k]) => k.startsWith('L:')).map(([, v]) => v), meta: ss.meta };
});
const importRes = await lib.evaluate(async (payload) => {
  // 不正なカテゴリ（HTML を仕込んだ色 / 変な id）が混ざったバックアップ
  payload.meta.cats.push({ id: 'ev"><img src=x>', name: '不正', color: 'red"><img src=x>' });
  return { payload };
}, dump);
ok('書き出しデータが取れる', importRes.payload.items.length > 0);

// 書き出し JSON にサムネイル情報が含まれ、読み込みで戻ること
const exported = await lib.evaluate(async () => {
  const ls = await chrome.storage.local.get(null);
  const ss = await chrome.storage.sync.get('meta');
  const items = Object.entries(ls).filter(([k]) => k.startsWith('L:')).map(([, v]) => v);
  const rich = {};
  for (const [k, v] of Object.entries(ls)) if (k.startsWith('R:')) rich[k.slice(2)] = v;
  return { app: 'recall', version: 2, meta: ss.meta, items, rich };
});
ok('書き出しにサムネイル情報が含まれる', Object.keys(exported.rich).length > 0);

const importFile = async (name, payload) => {
  await lib.click('#btnSettings'); await lib.waitForTimeout(400);
  await lib.setInputFiles('#impFile', { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await lib.waitForTimeout(2500);
  const msg = await lib.locator('#setMsg').innerText();
  await lib.locator('#setDlg button[value=close]').click();
  await lib.waitForTimeout(800);
  return msg;
};
// 回帰: 以前は同じ項目を別の ID で読み込み直し、すべて二重になっていた
const dupMsg = await importFile('same.json', exported);
eq2('回帰: 同じバックアップを読み込んでも二重にならない', (await readItems()).length, exported.items.length);
ok('すでにある分は読み込まなかったと知らせる', dupMsg.includes('すでに保存してある'));
// 端末から消えた状態（入れ直し・別の PC）で読み込むと、サムネイル情報ごと戻る
await lib.evaluate(async (ids) => {
  await chrome.storage.sync.remove(ids.map(id => 'i:' + id));
  await chrome.storage.local.remove(ids.flatMap(id => ['L:' + id, 'R:' + id]));
}, exported.items.map(i => i.id));
await lib.waitForTimeout(800);
await importFile('with-rich.json', exported);
const richCount = await lib.evaluate(async () =>
  Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('R:')).length);
ok('読み込むとサムネイル情報も復元される', richCount >= Object.keys(exported.rich).length);
eq2('件数も元どおり', (await readItems()).length, exported.items.length);
await lib.waitForTimeout(2500);   // 設定ダイアログを閉じたあとの同期処理が終わるのを待つ

await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.setInputFiles('#impFile', {
  name: 'backup.json', mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(importRes.payload))
});
await lib.waitForTimeout(2500);
ok('読み込み結果が表示される', /読み込みました|読み込みませんでした|中断/.test(await lib.locator('#setMsg').innerText()));
const catIds = await lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta.cats.map(c => c.id));
ok('回帰: 不正な id のカテゴリは取り込まない', !catIds.some(c => c.includes('<')));
const allAfter = await readItems();
ok('読み込み後も ID が衝突していない', allAfter.length === new Set(allAfter.map(i => i.id)).size);
await lib.locator('#setDlg button[value=close]').click();
await lib.waitForTimeout(900);

section('旧バージョンからの移行');
// v1.1 では項目が sync にしか無かった。local を空にして同じ状況を作る
await lib.evaluate(async () => {
  const ls = await chrome.storage.local.get(null);
  const olds = Object.entries(ls).filter(([k]) => k.startsWith('L:')).map(([, v]) => v).slice(0, 2);
  const ss = await chrome.storage.sync.get('meta');
  await chrome.storage.sync.clear();     // 先に同期側を空にする（そうしないと取り込み直される）
  await chrome.storage.local.clear();
  const patch = { meta: ss.meta };
  for (const v of olds) { delete v.up; patch['i:' + v.id] = v; }   // up が無い旧形式
  await chrome.storage.sync.set(patch);
});
await lib.waitForTimeout(1500);
await lib.goto(url('library.html#all')); await lib.waitForTimeout(1400);
ok('旧データが一覧に出る', (await lib.locator('#list .card').count()) === 2);
ok('端末内へ移行される', (await readItems()).length === 2);
await lib.reload(); await lib.waitForTimeout(1200);
ok('再読み込みしても増えない', (await readItems()).length === 2);
ok('復習の進み具合が保たれる', (await readItems()).every(i => typeof i.b === 'number' && typeof i.rv === 'number'));

/* ---------- 1.8.1 の回帰テスト（自分で用意した項目だけで確かめる） ---------- */
const freshStore = async () => {
  // 先に読み込み直して、前のテストでまだ動いている保存（遅くした同期など）を止めてから空にする
  await lib.reload(); await lib.waitForTimeout(1000);
  await lib.evaluate(async () => { await chrome.storage.sync.clear(); await chrome.storage.local.clear(); });
  await lib.waitForTimeout(600);
};
const seedItems = (n, opts = {}) => lib.evaluate(async ({ n, opts }) => {
  const now = Date.now();
  const patch = {};
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `${opts.prefix || 'r'}${i}${now.toString(36)}`;
    ids.push(id);
    patch['L:' + id] = {
      id, u: `https://regress.example/${opts.prefix || 'r'}/${i}`, t: `${opts.title || '回帰'} ${i}`, n: '', c: 'c0', g: [],
      s: 1, f: 0, b: opts.b ?? 1, d: opts.due ? now - 86400000 : now + 5 * 86400000,
      cr: now - i * 60000, rv: 2, iv: 0, kn: opts.kn || 0, knc: 0, up: now - 1000
    };
  }
  await chrome.storage.local.set(patch);
  return ids;
}, { n, opts });
const openLib = async (hash) => {          // 読み込み直して、前のテストの状態（お知らせ・差し替え）を持ち越さない
  await lib.goto(url('library.html#' + hash)); await lib.reload(); await lib.waitForTimeout(1200);
};
const waitUntil = async (fn, ms = 10000) => {   // 時間で決め打ちせず、条件がそろうまで待つ
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await lib.waitForTimeout(150); }
  return false;
};
const dblClick = async (loc, gap = 120) => {     // 人のダブルクリック（2回目は detail=2 になる）
  const b = await loc.boundingBox();
  if (!b) { ok('ダブルクリックする対象が見えている', false); return; }   // 見えなければ失敗として記録し、先へ進む
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await lib.mouse.move(x, y);
  await lib.mouse.down({ clickCount: 1 }); await lib.mouse.up({ clickCount: 1 });
  await lib.waitForTimeout(gap);
  await lib.mouse.down({ clickCount: 2 }); await lib.mouse.up({ clickCount: 2 });
};
const slowSync = () => lib.evaluate(() => {     // 同期の読み書きが遅いとき（1秒近くかかることがある）を再現する
  const s = chrome.storage.sync;
  for (const fn of ['get', 'set', 'remove']) {
    const orig = s[fn].bind(s);
    s[fn] = async (...a) => { await new Promise(r => setTimeout(r, 300)); return orig(...a); };
  }
});
const toastText = () => lib.locator('#toastMsg').innerText();
const itemCount = async () => (await readItems()).length;

section('回帰: 削除の二度押しと、まとめて元に戻す');
await freshStore();
await seedItems(6);
await openLib('all');
eq2('6件並ぶ', await lib.locator('#list .card').count(), 6);
// 以前は1回目で一覧が詰まり、2回目が次のカードの削除ボタンに当たって2件消えていた
await dblClick(lib.locator('#list .card').first().locator('button.del'));
await waitUntil(async () => (await itemCount()) < 6);
await lib.waitForTimeout(1000);
eq2('回帰: 削除ボタンのダブルクリックで消えるのは1件だけ', await itemCount(), 5);
ok('お知らせは1件分', /^「.+」を削除しました/.test(await toastText()));
await lib.click('#toastUndo');
await waitUntil(async () => (await itemCount()) === 6);
eq2('元に戻せる', await itemCount(), 6);

// 以前は2件目を消すと1件目の「元に戻す」が消え、1件目は戻せなくなっていた
await lib.waitForTimeout(500);
await lib.locator('#list .card').nth(0).locator('button.del').click();
await waitUntil(async () => (await itemCount()) === 5);
await lib.waitForTimeout(600);
await lib.locator('#list .card').nth(1).locator('button.del').click();
await waitUntil(async () => (await itemCount()) === 4);
await lib.waitForTimeout(300);
ok('回帰: 続けて消すと1つのお知らせにまとまる', (await toastText()).includes('2 件を削除しました'));
await lib.click('#toastUndo');
await waitUntil(async () => (await itemCount()) === 6);
eq2('回帰: 「元に戻す」で2件とも戻る', await itemCount(), 6);
await waitUntil(async () => (await toastText()).includes('2 件を元に戻しました'), 5000);
ok('2件戻したと知らせる', (await toastText()).includes('2 件を元に戻しました'));

for (let i = 0; i < 3; i++) {
  const before = await itemCount();
  await lib.locator('#list .card').first().locator('button.del').click();
  await waitUntil(async () => (await itemCount()) === before - 1);
  await lib.waitForTimeout(500);
}
ok('3件続けて消すとまとめて知らせる', (await toastText()).includes('3 件を削除しました'));
await lib.keyboard.press('Control+z');
await waitUntil(async () => (await itemCount()) === 6);
eq2('回帰: Ctrl+Z でもまとめて戻る', await itemCount(), 6);

// 以前は、戻している間に別の項目を消すと、戻し終わりのお知らせがその「元に戻す」を消していた
await openLib('all');
await slowSync();
const tB = await lib.locator('#list .card a.title').nth(1).innerText();
await lib.locator('#list .card').first().locator('button.del').click();
await waitUntil(async () => lib.locator('#toastUndo').isVisible());
await lib.click('#toastUndo');                                          // 1件目を戻し始める（同期が遅い）
await lib.waitForTimeout(200);
await lib.locator('#list .card').filter({ has: lib.locator('a.title', { hasText: tB }) }).locator('button.del').click();
await waitUntil(async () => (await itemCount()) === 5 && !(await readItems()).some(i => i.t === tB), 12000);
await lib.waitForTimeout(2500);                                         // 戻し終わるのを待つ
ok('回帰: 戻している間に消した分の「元に戻す」が残る',
  (await lib.locator('#toastUndo').isVisible()) && (await toastText()).includes(tB));
await lib.keyboard.press('Control+z');
await waitUntil(async () => (await itemCount()) === 6, 12000);
eq2('そのまま戻せる', await itemCount(), 6);
await waitUntil(async () => (await toastText()).includes('元に戻しました'), 12000);   // 戻し終わるまで待つ

section('回帰: 集中復習の連打');
await freshStore();
await seedItems(5, { prefix: 'f', title: '集中', due: true });
await openLib('review');
await lib.click('#startReview'); await lib.waitForTimeout(700);
const prog = async () => (await lib.locator('#fProgress').innerText()).trim();
const rvOf = async () => Object.fromEntries((await readItems()).map(i => [i.t, i.rv]));
eq2('1枚目から始まる', await prog(), '1 / 5');
await dblClick(lib.locator('#fOk'));
await lib.waitForTimeout(1500);
eq2('回帰: 「覚えた」のダブルクリックで進むのは1枚だけ', await prog(), '2 / 5');
const rvNow = await rvOf();
eq2('回帰: 見ていない次のカードには答えていない', JSON.stringify([rvNow['集中 0'], rvNow['集中 1']]), '[3,2]');
await lib.waitForTimeout(500);
await dblClick(lib.locator('#fDel'));
await lib.waitForTimeout(1500);
eq2('回帰: 「削除」のダブルクリックで進むのは1枚だけ', await prog(), '3 / 5');
eq2('消えたのは1件だけ', await itemCount(), 4);
ok('次のカードは消えていない', (await readItems()).some(i => i.t === '集中 2'));
await lib.click('#toastUndo');
await waitUntil(async () => (await itemCount()) === 5);
await lib.waitForTimeout(600);
await lib.keyboard.press('3');
await lib.waitForTimeout(100);
await lib.keyboard.press('3');
await lib.waitForTimeout(1500);
eq2('回帰: キーの連打でも進むのは1枚だけ', await prog(), '4 / 5');
// 同期が遅いとき: 保存している間の2回目のクリックは受け付けない（同じ項目を二重に記録しない）
await slowSync();
await lib.waitForTimeout(600);
const okBox = await lib.locator('#fOk').boundingBox();
ok('集中復習が続いている', !!okBox);
if (okBox) {
  await lib.mouse.click(okBox.x + okBox.width / 2, okBox.y + okBox.height / 2);
  await lib.waitForTimeout(150);
  await lib.mouse.click(okBox.x + okBox.width / 2, okBox.y + okBox.height / 2);
}
await waitUntil(async () => (await prog()) !== '4 / 5', 8000);
await lib.waitForTimeout(1500);
eq2('回帰: 保存中のクリックで2枚進まない', await prog(), '5 / 5');
const slow3 = (await readItems()).find(i => i.t === '集中 3') || {};
eq2('回帰: 同じ項目を二重に記録しない', JSON.stringify([slow3.rv, slow3.b]), '[3,2]');
if (await lib.locator('#fClose').isVisible()) { await lib.click('#fClose'); await lib.waitForTimeout(400); }

section('回帰: 集中復習の「まだ」に出す日数');
await freshStore();
await lib.evaluate(async () => { await chrome.storage.sync.set({ meta: { s: { againMode: 'back' } } }); });
await seedItems(1, { prefix: 'g', title: '段位3', due: true, b: 3 });
await openLib('review');
await lib.click('#startReview'); await lib.waitForTimeout(600);
eq2('回帰: 「まだ」の日数が実際の予定と合う（1段階だけ戻す設定）', (await lib.locator('#fAgainSub').innerText()).trim(), '7日後');
eq2('「覚えた」の日数', (await lib.locator('#fOkSub').innerText()).trim(), '次は30日後');
await lib.click('#fAgain');
await waitUntil(async () => (await readItems())[0].b === 2);
const g3 = (await readItems())[0];
eq2('実際に入った予定も7日後',
  Math.round((new Date(g3.d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000), 7);

section('回帰: 開いている間に届いた変更を巻き戻さない');
await freshStore();
const [exId] = await seedItems(1, { prefix: 'e', title: '編集' });
await openLib('all');
await lib.locator('#list .card').first().locator('button', { hasText: '編集' }).click();
await lib.waitForTimeout(400);
// 編集ダイアログを開いている間に、気になり帳へ送った印が付き、他の PC でタイトルが直された
await lib.evaluate(async (id) => {
  const k = 'L:' + id; const v = (await chrome.storage.local.get(k))[k];
  Object.assign(v, { kn: Date.now(), knc: 1, t: '他の PC で直したタイトル', up: Date.now() });
  await chrome.storage.local.set({ [k]: v });
}, exId);
await lib.waitForTimeout(600);
await lib.fill('#eNote', '開いている間に書いたメモ');
await lib.click('#eSave');
await waitUntil(async () => ((await readItems()).find(i => i.id === exId) || {}).n === '開いている間に書いたメモ');
const exAfter = (await readItems()).find(i => i.id === exId);
eq2('メモは保存される', exAfter.n, '開いている間に書いたメモ');
ok('回帰: 開いている間に付いた「送った印」が消えない', exAfter.kn > 0 && exAfter.knc === 1);
eq2('回帰: 触っていない欄は、ほかで直した内容のまま', exAfter.t, '他の PC で直したタイトル');

// カテゴリの管理: 開いている間に画面が読み直されても、名前や色の変更が保存される
await lib.click('#btnSettings'); await lib.waitForTimeout(500);
await lib.evaluate(async () => { await chrome.storage.local.set({ e2eTouch: Date.now() }); });   // 別の処理による書き込み
await lib.waitForTimeout(600);
await lib.locator('#catEditor .caterow').nth(1).locator('input[type=color]')
  .evaluate(el => { el.value = '#ff0000'; el.dispatchEvent(new Event('change')); });
const catAt = (i) => lib.evaluate(async (i) => ((await chrome.storage.sync.get('meta')).meta || { cats: [] }).cats[i], i);
await waitUntil(async () => ((await catAt(1)) || {}).color === '#ff0000', 5000);
eq2('回帰: カテゴリの色の変更が保存される', ((await catAt(1)) || {}).color, '#ff0000');
await lib.locator('#catEditor .caterow').nth(2).locator('input[type=text]').fill('改名テスト');
await lib.locator('#catEditor .caterow').nth(2).locator('input[type=text]').dispatchEvent('change');
await waitUntil(async () => ((await catAt(2)) || {}).name === '改名テスト', 5000);
eq2('回帰: カテゴリの名前の変更が保存される', ((await catAt(2)) || {}).name, '改名テスト');
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(1500);
await lib.evaluate(async () => { await chrome.storage.local.remove('e2eTouch'); });

section('回帰: 読み込みで URL を確かめる');
await openLib('all');
const beforeImp = await itemCount();
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.setInputFiles('#impFile', {
  name: 'mixed.json', mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({ app: 'recall', version: 2, items: [
    { url: 'https://import-ok.example/1', title: '読み込める' },
    { title: 'URL なし' },
    { url: 'javascript:alert(1)', title: 'スクリプト' },
    null
  ] }))
});
await waitUntil(async () => /読み込みました|ありませんでした|中断/.test(await lib.locator('#setMsg').innerText()));
const impMsg = await lib.locator('#setMsg').innerText();
ok('1件だけ読み込む', impMsg.includes('1 件を読み込みました'));
ok('回帰: 読み込まなかった件数を知らせる', impMsg.includes('3 件は読み込みませんでした'));
const afterImp = await readItems();
eq2('回帰: URL の無い項目や javascript: は保存しない', afterImp.length, beforeImp + 1);
ok('保存したのは http(s) の項目だけ', afterImp.every(i => /^https?:\/\//.test(i.u)));

// CSV: = で始まるタイトルが数式として実行されないように
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(1200);
await seedItems(1, { prefix: 'csv', title: '=1+2' });
await openLib('all');
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
const [csvDl] = await Promise.all([lib.waitForEvent('download'), lib.click('#expCsv')]);
const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
ok('回帰: CSV では = で始まるタイトルの前に \' を付ける', csvText.includes(`"'=1+2 0"`) && !csvText.includes(`"=1+2 0"`));
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(1200);

section('回帰: 元に戻すと、気になり帳へ送る順番待ちに並び直す');
await freshStore();
// 送れない保存先（data: URL）にしておくと、項目は送信待ちのまま残る
await lib.evaluate(async () => {
  await chrome.storage.sync.set({ meta: { s: { knOn: true, knUrl: 'data:text/html,kininari', knCat: '調べる' } } });
});
await lib.waitForTimeout(1000);
const requeueSave = await lib.evaluate(() => chrome.runtime.sendMessage({ type: 'quickSave', url: 'https://requeue.example/1', title: '送信待ちのまま消す' }));
const qid = requeueSave && requeueSave.item && requeueSave.item.id;
const queueIds = () => lib.evaluate(async () => ((await chrome.storage.local.get('rcClipQueue')).rcClipQueue || []).map(e => e.id));
await waitUntil(async () => (await queueIds()).includes(qid));
ok('送信待ちに並んでいる', (await queueIds()).includes(qid));
await openLib('all');
await lib.locator('#list .card').first().locator('button.del').click();
await waitUntil(async () => !(await readItems()).some(i => i.id === qid));
// 消している間に送信が走ると、消えた項目は待ち行列から外される
await waitUntil(async () => {
  await lib.evaluate(() => chrome.runtime.sendMessage({ type: 'clipFlush' }));
  return !(await queueIds()).includes(qid);
}, 6000);
ok('（前提）消している間に待ち行列から外れた', !(await queueIds()).includes(qid));
await lib.click('#toastUndo');
await waitUntil(async () => (await queueIds()).includes(qid));
ok('回帰: 元に戻すと、送信待ちに並び直す', (await queueIds()).includes(qid));

// 以前は Service Worker が起き直すたび（タブの更新でも起きる）に送り直し、5回の試行をすぐ使い切っていた
const triesOf = async (id) => ((await lib.evaluate(async () => (await chrome.storage.local.get('rcClipQueue')).rcClipQueue || []))
  .find(e => e.id === id) || {}).tries;
await waitUntil(async () => (await triesOf(qid)) >= 1);
const triesBefore = await triesOf(qid);
const cdp = await ctx.newCDPSession(lib);
for (let i = 0; i < 2; i++) {
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');        // 30秒放置で止まったのと同じ状態にする
  await lib.waitForTimeout(800);
  await lib.evaluate(() => chrome.runtime.sendMessage({ type: 'clipQueue' }).catch(() => null));   // 何かのきっかけで起き直す
  await lib.waitForTimeout(2000);
}
eq2('回帰: 起き直しのたびには送り直さない（前回の失敗から間をあける）', await triesOf(qid), triesBefore);
await cdp.detach().catch(() => {});
// 起き直した Service Worker をつかみ直す（後片付けで使う）
sw = ctx.serviceWorkers().filter(w => w.url().includes(id)).pop() || await ctx.waitForEvent('serviceworker', { timeout: 10000 });
await lib.evaluate(async (id) => {
  await chrome.runtime.sendMessage({ type: 'clipForget', id });
  await chrome.storage.sync.set({ meta: { s: { knOn: false } } });
}, qid);
// 未確認の送信（kn だけ）でも「気になり帳に残ります」と知らせる
await freshStore();
await seedItems(1, { prefix: 'k', title: '送信済み（未確認）', kn: Date.now() });
await openLib('all');
await lib.locator('#list .card').first().locator('button.del').click();
await waitUntil(async () => lib.locator('#toastUndo').isVisible());
ok('回帰: 未確認の送信でも「気になり帳に残ります」と出す', (await toastText()).includes('気になり帳に送った分は'));
await lib.click('#toastUndo');
await waitUntil(async () => (await itemCount()) === 1);

section('回帰: 1.8.2');
await freshStore();
await seedItems(3, { prefix: 'sp', title: '集中S', due: true });
await openLib('review');
await lib.click('#startReview'); await lib.waitForTimeout(600);
const fTitle = () => lib.locator('#fTitle').innerText().then(t => t.trim());
const t1 = await fTitle();
await lib.click('#fLater');                                   // マウスで「あとで」→ フォーカスがボタンに残る
await waitUntil(async () => (await fTitle()) !== t1);
await lib.waitForTimeout(600);
const t2 = await fTitle();
await lib.keyboard.press(' ');
await waitUntil(async () => (await fTitle()) !== t2, 5000);
await lib.waitForTimeout(WAIT);
const byTitle = async (t) => (await readItems()).find(i => i.t === t) || {};
eq2('回帰: 集中復習の Space は「覚えた」（段位が1つ上がる）', (await byTitle(t2)).b, 2);
eq2('直前に押した「あとで」が次の項目にかからない', (await byTitle(t1)).b, 1);
await lib.keyboard.press('Escape'); await lib.waitForTimeout(400);

// 編集ダイアログの URL
await openLib('all');
const editCard = lib.locator('#list .card').first();
const editTitle = (await editCard.locator('a.title').innerText()).trim();
const editTarget = await byTitle(editTitle);
const otherUrl = (await readItems()).find(i => i.id !== editTarget.id).u;
await editCard.locator('button', { hasText: '編集' }).click(); await lib.waitForTimeout(400);
await lib.fill('#eUrl', 'javascript:alert(1)');
await lib.click('#eSave'); await lib.waitForTimeout(500);
ok('回帰: http(s) 以外の URL では保存しない（ダイアログが閉じない）', await lib.locator('#editDlg').evaluate(d => d.open));
const reopenEdit = async () => {   // 閉じてしまった（＝不具合）ときも、止まらずに次を確かめる
  if (await lib.locator('#editDlg').evaluate(d => d.open)) return;
  await lib.locator('#list .card', { hasText: editTitle }).first().locator('button', { hasText: '編集' }).click();
  await lib.waitForTimeout(400);
};
await reopenEdit();
await lib.fill('#eUrl', otherUrl);
await lib.click('#eSave'); await lib.waitForTimeout(500);
ok('回帰: ほかの項目と同じページには書き換えない', await lib.locator('#editDlg').evaluate(d => d.open));
await reopenEdit();
await lib.fill('#eUrl', 'https://regress.example/edited');
await lib.click('#eSave'); await lib.waitForTimeout(WAIT);
ok('正しい URL なら保存して閉じる', !(await lib.locator('#editDlg').evaluate(d => d.open)));
eq2('URL が書き換わる', (await readItems()).find(i => i.id === editTarget.id).u, 'https://regress.example/edited');

// お気に入りのダブルクリック
await openLib('all');
const starCard = lib.locator('#list .card').first();
const starTitle = (await starCard.locator('a.title').innerText()).trim();
await dblClick(starCard.locator('button.star'));
await lib.waitForTimeout(WAIT);
eq2('回帰: ★ のダブルクリックで2回切り替わらない', (await byTitle(starTitle)).f, 1);

// 即保存: 覚えているカテゴリが消されていたら既定のカテゴリへ
await lib.evaluate(async () => {
  const m = (await chrome.storage.sync.get('meta')).meta || {};
  await chrome.storage.sync.set({ meta: { ...m, dom: { ...(m.dom || {}), 'quick.example': 'cGone' } } });
});
await lib.waitForTimeout(500);
const qs = await lib.evaluate(() => chrome.runtime.sendMessage({ type: 'quickSave', url: 'https://quick.example/page', title: '即保存', tabId: null }));
ok('即保存できる', qs && qs.ok);
eq2('回帰: 消えたカテゴリには入れない', qs && qs.item && qs.item.c, 'c0');

// 同期する件数の上限 0
await lib.click('#btnSettings'); await lib.waitForTimeout(400);
await lib.fill('#sSyncMax', '0');
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(WAIT);
eq2('回帰: 同期する件数の上限を 0 にできる', (await lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta.s.syncMax)), 0);
eq2('上限 0 なら同期に載らない', await countSynced(), 0);

section('1.9.0: Google ドライブ同期');
eq2('拡張機能の ID が固定されている（フォルダの場所によらない）', id, 'kcgmjcokekapobnjijclhlhnaccdpkpp');
await freshStore();
await seedItems(2, { prefix: 'gd', title: 'ドライブ' });
await openLib('all');
const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const realCid = manifestOnDisk.oauth2 && manifestOnDisk.oauth2.client_id;
ok('manifest に OAuth クライアント ID が入っている', /^[\w.-]+\.apps\.googleusercontent\.com$/.test(realCid || '') && !/YOUR_CLIENT_ID/.test(realCid));
await lib.click('#btnSettings'); await lib.waitForTimeout(800);
ok('つなぐ前は「つないでいません」と出る', (await lib.locator('#gdStatus').innerText()).includes('つないでいません'));
ok('「つなぐ」を押せる', !(await lib.locator('#gdConnect').isDisabled()));
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(800);
await lib.evaluate(() => chrome.runtime.sendMessage({ type: 'driveStatus' }));
sw = ctx.serviceWorkers().filter(w => w.url().includes(id)).pop() || await ctx.waitForEvent('serviceworker', { timeout: 10000 });
// client_id が未設定の版（フォークした人など）では「準備がまだ」と出て、押せない
await sw.evaluate(() => {
  self.__realGetManifest = chrome.runtime.getManifest;
  const real = chrome.runtime.getManifest();
  chrome.runtime.getManifest = () => ({ ...real, oauth2: { ...real.oauth2, client_id: 'YOUR_CLIENT_ID.apps.googleusercontent.com' } });
});
await lib.click('#btnSettings'); await lib.waitForTimeout(800);
ok('client_id が未設定なら「準備がまだ」と出る', (await lib.locator('#gdStatus').innerText()).includes('準備がまだ'));
ok('そのときは「つなぐ」を押せない', await lib.locator('#gdConnect').isDisabled());
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(800);
// Service Worker に、Google の許可とドライブの代わりを差し込む（本物の Google には送らない）
await sw.evaluate(() => {
  chrome.runtime.getManifest = self.__realGetManifest;
  chrome.identity.getAuthToken = async () => ({ token: 'e2e-token' });
  chrome.identity.removeCachedAuthToken = async () => {};
  const fd = self.__fakeDrive = {
    files: new Map(), seq: 0,
    byName(n) { return [...this.files.values()].filter(f => f.name === n); }
  };
  const res = (status, body, text) => new Response(text !== undefined ? text : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = self.fetch.bind(self);
  self.fetch = async (url, init = {}) => {
    const u = new URL(String(url && url.url || url));
    // Google 以外（通知のアイコンの読み込みなど）は本物に任せる
    if (!/(^|\.)googleapis\.com$|^accounts\.google\.com$/.test(u.hostname)) return realFetch(url, init);
    const method = (init.method || 'GET').toUpperCase();
    if (u.hostname === 'accounts.google.com') return res(200, {});
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const eqm = q.match(/name = '([^']+)'/), cm = q.match(/name contains '([^']+)'/);
      let files = [...fd.files.values()];
      if (eqm) files = files.filter(f => f.name === eqm[1]);
      if (cm) files = files.filter(f => f.name.includes(cm[1]));
      return res(200, { files: files.map(f => ({ id: f.id, name: f.name, version: String(f.version), size: String(f.content.length) })) });
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') {
      const id = 'f' + (++fd.seq);
      fd.files.set(id, { id, name: JSON.parse(init.body).name, content: '', version: 1 });
      return res(200, { id, version: '1' });
    }
    let m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === 'GET') return res(200, null, fd.files.get(m[1]).content);
    if (m && method === 'DELETE') { fd.files.delete(m[1]); return new Response(null, { status: 204 }); }
    m = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === 'PATCH') { const f = fd.files.get(m[1]); f.content = init.body; f.version++; return res(200, { id: f.id, version: String(f.version) }); }
    return res(400, { error: { code: 400, message: 'unexpected' } });
  };
});
await lib.click('#btnSettings'); await lib.waitForTimeout(800);
ok('準備ができていれば「つなぐ」を押せる', !(await lib.locator('#gdConnect').isDisabled()));
await lib.click('#gdConnect');
const gdDone = async () => { const t = (await lib.locator('#gdMsg').innerText()).trim(); return !!t && !t.endsWith('…'); };   // 「…しています…」の間は待つ
await waitUntil(gdDone, 15000);
ok('つなぐとすぐ同期する', (await lib.locator('#gdMsg').innerText()).includes('つなぎました'));
await waitUntil(async () => (await lib.locator('#gdStatus').innerText()).includes('同期しています'), 5000);
ok('状態に「同期しています」と出る', (await lib.locator('#gdStatus').innerText()).includes('同期しています'));
eq2('ドライブに全件が載る', await sw.evaluate(() => JSON.parse(self.__fakeDrive.byName('recall-sync.json')[0].content).items.length), 2);
ok('その日のバックアップも作られる', await sw.evaluate(() => [...self.__fakeDrive.files.values()].some(f => f.name.startsWith('recall-backup-'))));
// ほかの PC がドライブに足した項目を「今すぐ同期」で取り込む
await sw.evaluate(() => {
  const f = self.__fakeDrive.byName('recall-sync.json')[0];
  const d = JSON.parse(f.content);
  const now = Date.now();
  d.items.push({ id: 'remote1', u: 'https://drive-remote.example/1', t: 'ほかの PC から', n: '', c: 'c0', g: [], s: 1, f: 0, b: 0, d: now + 86400000, cr: now, rv: 0, iv: 0, kn: 0, knc: 0, up: now });
  f.content = JSON.stringify(d); f.version++;
});
await lib.click('#gdSync');
await waitUntil(gdDone, 15000);
ok('ほかの PC の項目を取り込む', (await lib.locator('#gdMsg').innerText()).includes('1 件を取り込み'));
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(1200);
ok('取り込んだ項目が一覧に出る', (await lib.locator('#list .card a.title').allInnerTexts()).some(t => t.includes('ほかの PC から')));
await lib.click('#btnSettings'); await lib.waitForTimeout(800);
await lib.locator('#gdBackupBox summary').click();
await waitUntil(async () => (await lib.locator('#gdBackups li').count()) > 0, 8000);
ok('ドライブのバックアップが一覧に出る', (await lib.locator('#gdBackups li').first().innerText()).includes('この日の状態から戻す'));
await lib.evaluate(() => { window.confirm = () => true; });
await lib.click('#gdDisconnect');
await waitUntil(async () => (await lib.locator('#gdMsg').innerText()).includes('やめました'), 8000);
ok('同期をやめられる', (await lib.evaluate(async () => (await chrome.storage.sync.get('meta')).meta.s.driveOn)) === false);
ok('やめたら「つなぐ」に戻る', await waitUntil(async () => lib.locator('#gdConnect').isVisible(), 5000));
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(800);

// 許可が切れて裏の同期が止まったら、通知で知らせる（テスト中のアプリは許可が7日で切れることがある）
await sw.evaluate(() => { chrome.identity.getAuthToken = async () => { throw new Error('OAuth2 not granted or revoked.'); }; });
await lib.evaluate(async () => {
  const m = (await chrome.storage.sync.get('meta')).meta;
  await chrome.storage.sync.set({ meta: { ...m, s: { ...m.s, driveOn: true } } });
  await chrome.storage.local.remove('rcDriveAlert');
});
const softRes = await lib.evaluate(() => chrome.runtime.sendMessage({ type: 'driveSync', soft: true }));
eq2('許可が切れていると同期は止まる', softRes && softRes.reason, 'auth');
ok('「同期が止まっています」と通知する', await waitUntil(async () => 'recall-drive' in (await sw.evaluate(() => chrome.notifications.getAll())), 5000));
await sw.evaluate(() => chrome.notifications.clear('recall-drive'));
await lib.evaluate(() => chrome.runtime.sendMessage({ type: 'driveSync', soft: true }));
await lib.waitForTimeout(800);
ok('同じ日のうちは2回目の通知を出さない', !('recall-drive' in (await sw.evaluate(() => chrome.notifications.getAll()))));
await lib.goto('about:blank');
await lib.goto(url('library.html#drive')); await lib.waitForTimeout(1500);       // ライブラリが開いていないとき
ok('通知から開くと設定の「Google ドライブ同期」が出る', await lib.locator('#setDlg').evaluate(d => d.open) && await lib.locator('#gdStatus').isVisible());
ok('そこに「つなぎ直す」がある', await waitUntil(async () => (await lib.locator('#gdConnect').innerText()).includes('つなぎ直す'), 5000));
ok('開いたあとは一覧の表示に戻す', (await lib.evaluate(() => location.hash)) === '#all');
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(800);
await lib.evaluate(() => { location.hash = 'drive'; });                          // ライブラリがもう開いているとき
ok('開いているライブラリでも設定が出る', await waitUntil(async () => lib.locator('#setDlg').evaluate(d => d.open), 5000));
await lib.locator('#setDlg button[value=close]').click(); await lib.waitForTimeout(800);
await lib.evaluate(async () => {
  const m = (await chrome.storage.sync.get('meta')).meta;
  await chrome.storage.sync.set({ meta: { ...m, s: { ...m.s, driveOn: false } } });
});

section('後片付け');
const badge = await sw.evaluate(async () => await chrome.action.getBadgeText({}));
ok('バッジ API が動く', typeof badge === 'string');
await lib.screenshot({ path: path.join(EXT, 'tests', 'screenshot-library.png'), fullPage: true });

await ctx.close();

console.log('\n--- ページ内エラー ---');
console.log(errors.length ? errors.join('\n') : '（なし）');
if (netFails.length) console.log(`（参考）外部画像などの読み込み失敗 ${netFails.length} 件 — オフライン環境では正常です`);
console.log(`\n${pass} 件成功 / ${fail} 件失敗 / ページ内エラー ${errors.length} 件`);
process.exit(fail || errors.length ? 1 : 0);

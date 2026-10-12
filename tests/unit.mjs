/* ============================================================
   Recall — ロジックのテスト（ブラウザ不要）
   chrome API をスタブして store.js を直接検証する。
   ============================================================ */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Chrome のストレージを再現するスタブ（sync は本物と同じ上限を課す） */
function makeArea(limits) {
  const mem = {};
  const size = (k, v) => new TextEncoder().encode(k + JSON.stringify(v)).length;
  // latency を入れると、読み書きの途中に別の処理が割り込む状況（同期が遅いとき）を作れる
  const area = {
    _mem: mem,
    latency: 0,
    errors: [],                                  // 握りつぶされた書き込みエラーも後から確かめられるように
    get: async (k) => {
      if (area.latency) await new Promise(r => setTimeout(r, area.latency));
      if (k === null || k === undefined) return { ...mem };
      const keys = [].concat(k);
      const out = {};
      for (const key of keys) if (key in mem) out[key] = mem[key];
      return out;
    },
    set: async (obj) => {
      if (area.latency) await new Promise(r => setTimeout(r, area.latency));
      const fail = (msg) => { area.errors.push(msg); throw new Error(msg); };
      for (const [k, v] of Object.entries(obj)) {
        if (size(k, v) > limits.perItem) fail('QUOTA_BYTES_PER_ITEM quota exceeded');
      }
      const next = { ...mem, ...obj };
      let total = 0;
      for (const [k, v] of Object.entries(next)) total += size(k, v);
      if (total > limits.total) fail('QUOTA_BYTES quota exceeded');
      if (Object.keys(next).length > limits.maxItems) fail('MAX_ITEMS quota exceeded');
      Object.assign(mem, obj);
    },
    remove: async (keys) => {
      if (area.latency) await new Promise(r => setTimeout(r, area.latency));
      for (const k of [].concat(keys)) delete mem[k];
    },
    clear: async () => { for (const k of Object.keys(mem)) delete mem[k]; },
    getBytesInUse: async () => Object.entries(mem).reduce((n, [k, v]) => n + size(k, v), 0)
  };
  return area;
}
const syncArea = makeArea({ perItem: 8192, total: 102400, maxItems: 512 });
const localArea = makeArea({ perItem: Infinity, total: Infinity, maxItems: Infinity });
const localAreaB = makeArea({ perItem: Infinity, total: Infinity, maxItems: Infinity });   // もう1台の PC
/** 「もう1台の PC」で実行する（store.js は呼ばれるたびに chrome.storage.local を見る） */
async function onPcB(fn) {
  chrome.storage.local = localAreaB;
  try { return await fn(); } finally { chrome.storage.local = localArea; }
}
let scriptingResult = null;   // collectPageMeta のテスト用
/* 気になり帳への送信を試すための最小限のブラウザ側スタブ */
const fakeBrowser = {
  createFails: false,        // タブを開けない（送信先URLが不正など）
  hasPermission: true,       // 保存の確認ができるか
  savedFlag: true,           // 気になり帳が保存を終えたか
  tabs: new Map(),
  nextTabId: 1,
  created: [],
  attempts: 0,               // タブを開こうとした回数（失敗も数える）
  onCreate: null,            // タブを開いた瞬間に割り込む処理（送信中の削除など）
  alarms: new Map(),
  reset() { this.createFails = false; this.hasPermission = true; this.savedFlag = true; this.tabs.clear(); this.created = []; this.attempts = 0; this.onCreate = null; }
};
const sessionMem = {};
globalThis.chrome = {
  runtime: { getURL: (p) => 'chrome-extension://test' + p },
  storage: {
    sync: syncArea, local: localArea,
    session: {
      get: async (k) => {
        const out = {};
        for (const key of [].concat(k)) if (key in sessionMem) out[key] = sessionMem[key];
        return out;
      },
      set: async (o) => Object.assign(sessionMem, o),
      remove: async (k) => { for (const x of [].concat(k)) delete sessionMem[x]; }
    }
  },
  scripting: {
    executeScript: async (opts) => {
      if (opts && opts.world === 'MAIN') return [{ result: fakeBrowser.savedFlag }];
      if (scriptingResult instanceof Error) throw scriptingResult;
      return [{ result: scriptingResult }];
    }
  },
  permissions: { contains: async () => fakeBrowser.hasPermission },
  tabs: {
    create: async ({ url }) => {
      fakeBrowser.attempts++;
      if (fakeBrowser.onCreate) await fakeBrowser.onCreate(url);
      if (fakeBrowser.createFails) throw new Error('タブを開けませんでした');
      const id = fakeBrowser.nextTabId++;
      fakeBrowser.tabs.set(id, url);
      fakeBrowser.created.push(url);
      return { id, url };
    },
    get: async (id) => { if (!fakeBrowser.tabs.has(id)) throw new Error('no tab'); return { id }; },
    remove: (id, cb) => { fakeBrowser.tabs.delete(id); if (cb) cb(); },
    query: async () => []
  },
  alarms: {
    get: async (n) => fakeBrowser.alarms.get(n) || null,
    create: (n, o) => fakeBrowser.alarms.set(n, o || {}),
    clear: async (n) => fakeBrowser.alarms.delete(n)
  },
  runtime: { getURL: (p) => 'chrome-extension://test' + p, lastError: null }
};

const S = await import(pathToFileURL(path.join(ROOT, 'store.js')).href);
const PM = await import(pathToFileURL(path.join(ROOT, 'pagemeta.js')).href);
const CL = await import(pathToFileURL(path.join(ROOT, 'changelog.js')).href);
const KN = await import(pathToFileURL(path.join(ROOT, 'kininari.js')).href);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n      実際: ${JSON.stringify(got)}\n      期待: ${JSON.stringify(want)}`));
};
const ok = (name, cond) => eq(name, !!cond, true);

const meta = structuredClone(S.DEFAULT_META);
const DAY = 86400000;
const days = (ts) => Math.round((new Date(ts).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);

console.log('--- URL の正規化 ---');
eq('utm を除去する', S.normalizeUrl('https://a.com/x?utm_source=z&b=1'), 'https://a.com/x?b=1');
eq('末尾スラッシュを揃える', S.normalizeUrl('https://a.com/x/'), S.normalizeUrl('https://a.com/x'));
eq('通常のハッシュは除去する', S.normalizeUrl('https://a.com/x#sec'), 'https://a.com/x');
eq('ホスト名は小文字にする', S.normalizeUrl('https://WWW.Example.COM/A'), 'https://www.example.com/A');
ok('パスの大文字小文字は区別する', S.normalizeUrl('https://bit.ly/aBcDeF') !== S.normalizeUrl('https://bit.ly/abcdef'));
ok('SPA のハッシュルートは別ページ扱い',
  S.normalizeUrl('https://ex.com/app#/notes/1') !== S.normalizeUrl('https://ex.com/app#/notes/2'));
eq('ドメイン抽出', S.domainOf('https://www.example.co.jp/a/b'), 'example.co.jp');

console.log('\n--- 保存できる URL ---');
ok('http は保存できる', S.isSavableUrl('http://a.com'));
ok('https は保存できる', S.isSavableUrl('https://a.com'));
ok('chrome:// は保存しない', !S.isSavableUrl('chrome://extensions'));
ok('file:// は保存しない', !S.isSavableUrl('file:///Users/me/a.pdf'));
ok('空は保存しない', !S.isSavableUrl(''));

console.log('\n--- タグ ---');
eq('区切り文字で分割', S.normalizeTags('#js, react  vue、css'), ['js', 'react', 'vue', 'css']);
eq('重複を除去', S.normalizeTags(['a', 'a', 'b']), ['a', 'b']);
ok('個数の上限', S.normalizeTags(Array.from({ length: 30 }, (_, i) => 't' + i)).length === S.LIMITS.tags);

console.log('\n--- 忘却曲線 ---');
let it = S.makeItem({ u: 'https://a.com', t: 'A' }, meta);
eq('初回は1日後', days(it.d), 1);
eq('初期状態は未読', it.s, S.STATUS.NEW);
it = S.review(it, 'ok', meta);    eq('1回目OK → 3日後', days(it.d), 3);
eq('状態は学習中', it.s, S.STATUS.LEARNING);
it = S.review(it, 'ok', meta);    eq('2回目OK → 7日後', days(it.d), 7);
it = S.review(it, 'again', meta); eq('まだ → 最初に戻る', days(it.d), 1);
eq('box もリセット', it.b, 0);
it = S.review(it, 'later', meta); eq('あとで → 明日', days(it.d), 1);
eq('あとでは学習中のまま', it.s, S.STATUS.LEARNING);

let z = S.makeItem({ u: 'https://z.com' }, meta);
for (let i = 0; i < S.DEFAULT_STEPS.length; i++) z = S.review(z, 'ok', meta);
eq('全ステップ通過で完了', z.s, S.STATUS.DONE);
eq('完了は期限なし', z.d, 0);

const m2 = structuredClone(meta); m2.s.againMode = 'back';
let y = S.makeItem({ u: 'https://y.com' }, m2);
y = S.review(y, 'ok', m2); y = S.review(y, 'ok', m2);
y = S.review(y, 'again', m2);
eq('back モードは1段階だけ戻る', days(y.d), 3);

let f = S.makeItem({ u: 'https://f.com', iv: 7 }, meta);
eq('固定間隔の初回', days(f.d), 7);
f = S.review(f, 'ok', meta);    eq('固定間隔OK', days(f.d), 7);
f = S.review(f, 'again', meta); eq('固定間隔まだ→短縮', days(f.d), 2);

const m3 = structuredClone(meta); m3.s.steps = [2, 5, 20];
let c = S.makeItem({ u: 'https://c.com' }, m3);
c = S.review(c, 'ok', m3); eq('カスタムステップ', days(c.d), 5);

console.log('\n--- 回帰: ステップを短くしても壊れない ---');
// 以前は steps[b] が undefined になり、次回日時が NaN → null になって永久に復習に出なくなった
const mShort = structuredClone(meta); mShort.s.steps = [1, 3, 7]; mShort.s.againMode = 'back';
const advanced = { ...S.makeItem({ u: 'https://old.com' }, meta), b: 6, s: S.STATUS.LEARNING };
const afterAgain = S.review(advanced, 'again', mShort);
ok('「まだ」で次回日時が有効な数値になる', Number.isFinite(afterAgain.d) && afterAgain.d > 0);
eq('box が範囲内に丸められる', afterAgain.b, 1);
// 既に新しいステップ数を超えて復習済みの項目は、次の「覚えた」で完了になるのが正しい
const afterOk = S.review(advanced, 'ok', mShort);
eq('ステップを超えていた項目は完了になる', afterOk.s, S.STATUS.DONE);
eq('完了なので期限は 0（null や NaN にならない）', afterOk.d, 0);
const midway = S.review({ ...advanced, b: 0 }, 'ok', mShort);
ok('途中の項目は次回日時が有効', Number.isFinite(midway.d) && midway.d > 0);
eq('途中の項目は学習中のまま', midway.s, S.STATUS.LEARNING);
eq('box のクランプ', S.clampBox(99, [1, 2, 3]), 2);
eq('負の box もクランプ', S.clampBox(-5, [1, 2, 3]), 0);

console.log('\n--- 回帰: 不正な日数でも壊れない ---');
ok('undefined 日でも有効な日付', Number.isFinite(S.dueAfterDays(undefined)));
ok('NaN 日でも有効な日付', Number.isFinite(S.dueAfterDays(NaN)));
ok('文字列でも有効な日付', Number.isFinite(S.dueAfterDays('3')));
eq('月をまたぐ加算', new Date(S.dueAfterDays(1, 9, new Date(2026, 0, 31, 12).getTime())).getDate(), 1);

console.log('\n--- 回帰: 状態と期限の整合 ---');
const doneItem = S.makeItem({ u: 'https://d.com', s: S.STATUS.DONE, d: Date.now() + DAY }, meta);
eq('完了なら期限は 0', doneItem.d, 0);
const archived = S.makeItem({ u: 'https://ar.com', s: S.STATUS.ARCHIVED, d: Date.now() + DAY }, meta);
eq('アーカイブなら期限は 0', archived.d, 0);
const broken = S.makeItem({ u: 'https://b.com', d: NaN }, meta);
ok('壊れた期限は入れ直される', broken.d > 0);
const resumed = S.resume(archived, meta, 0);
ok('復帰すると期限が入る', resumed.d > 0);
eq('復帰すると学習中', resumed.s, S.STATUS.LEARNING);
ok('復帰した項目は復習対象', S.isDue(resumed));

console.log('\n--- 期限判定 ---');
ok('期限切れは対象', S.isDue({ s: 1, d: Date.now() - 1000 }));
ok('未来は対象外', !S.isDue({ s: 1, d: Date.now() + DAY }));
ok('完了は対象外', !S.isDue({ s: S.STATUS.DONE, d: 1 }));
ok('期限 null は対象外', !S.isDue({ s: 1, d: null }));

console.log('\n--- 検索 ---');
const sample = { t: 'React Hooks 入門', u: 'https://ja.react.dev/learn', n: 'useEffect の依存配列', g: ['react', 'js'] };
ok('タイトル', S.matches(sample, 'hooks'));
ok('メモ', S.matches(sample, 'useeffect'));
ok('タグ', S.matches(sample, 'react'));
ok('URL', S.matches(sample, 'react.dev'));
ok('AND 検索', S.matches(sample, 'react 入門'));
ok('不一致', !S.matches(sample, 'vue'));

console.log('\n--- バージョンと更新履歴 ---');
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
eq('manifest のバージョンと履歴の先頭が一致する', CL.CHANGELOG[0].v, manifest.version);
ok('履歴が新しい順に並んでいる', CL.CHANGELOG.every((r, i) =>
  i === 0 || CL.CHANGELOG[i - 1].v.split('.').map(Number).join('') > r.v.split('.').map(Number).join('')));
ok('すべての版に日付がある', CL.CHANGELOG.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
ok('すべての版に中身がある', CL.CHANGELOG.every(r => (r.added || r.changed || r.fixed || []).length > 0));
ok('バージョンが重複していない', new Set(CL.CHANGELOG.map(r => r.v)).size === CL.CHANGELOG.length);
eq('現在のバージョンを引ける', CL.currentVersion(), manifest.version);
ok('その版の内容を引ける', CL.entryFor(manifest.version) !== null);
eq('無い版は null', CL.entryFor('0.0.1'), null);
eq('初版が最後にある', CL.CHANGELOG[CL.CHANGELOG.length - 1].v, '1.0.0');

console.log('\n--- 気になり帳へ送る内容 ---');
const knMeta = structuredClone(S.DEFAULT_META);
knMeta.s.knOn = true; knMeta.s.knUrl = 'https://example.com/app/kininari.html'; knMeta.s.knCat = '調べる';
knMeta.cats = [{ id: 'c0', name: '未分類', color: '#000' }, { id: 'c4', name: '技術', color: '#000' }];

ok('設定がそろえば有効', KN.clipEnabled(knMeta));
ok('URLが空なら無効', !KN.clipEnabled({ s: { knOn: true, knUrl: '' } }));
ok('オフなら無効', !KN.clipEnabled({ s: { knOn: false, knUrl: 'https://a.com' } }));
eq('オリジンを取り出す', KN.originOf('https://a.com/app/kininari.html'), 'https://a.com/*');
eq('http 以外は null', KN.originOf('chrome-extension://abc/x.html'), null);

const knItem = S.makeItem({ u: 'https://youtu.be/dQw4w9WgXcQ', t: '動画のタイトル', n: '本題は12:40から', g: ['react', '動画'], c: 'c4' }, knMeta);
eq('メモの後ろにタグを並べる', KN.clipNote(knItem), '本題は12:40から\n\n#react #動画');
eq('メモが無ければタグだけ', KN.clipNote({ n: '', g: ['a'] }), '#a');
eq('どちらも無ければ空', KN.clipNote({ n: '', g: [] }), '');
ok('長すぎるメモは切る', KN.clipNote({ n: 'あ'.repeat(5000), g: [] }).length <= KN.CLIP_LIMITS.note);

const fields = KN.clipFieldsFor(knItem, knMeta, null);
eq('Recall のカテゴリがフォルダになる', fields.folder, '技術');
eq('気になり帳のカテゴリは設定どおり', fields.category, '調べる');
eq('YouTube はサムネイルURLを組み立てて送る', fields.image, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');

const built = KN.buildClipUrl(knMeta.s.knUrl, fields);
ok('#knadd= 付きのURLになる', built.url.startsWith('https://example.com/app/kininari.html#knadd='));
const decoded = JSON.parse(decodeURIComponent(built.url.split('#knadd=')[1]));
eq('タイトルが入る', decoded.t, '動画のタイトル');
eq('URLが入る', decoded.u, 'https://youtu.be/dQw4w9WgXcQ');
eq('メモとタグが入る', decoded.n, '本題は12:40から\n\n#react #動画');
eq('画像が入る', decoded.img, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
eq('カテゴリが入る', decoded.c, '調べる');
eq('フォルダが入る', decoded.f, '技術');
eq('タグを項目として送る', decoded.tags, ['react', '動画']);
ok('復習の進み具合を送る', decoded.srs && typeof decoded.srs === 'object');
eq('未読は st=0', decoded.srs.st, 0);
eq('段位を送る', decoded.srs.b, 0);

// 復習の状態の対応
const learning = { ...knItem, s: S.STATUS.LEARNING, b: 3, rv: 5, d: Date.now() + 86400000, iv: 0 };
eq('学習中は st=1', KN.srsFor(learning).st, 1);
eq('段位と回数を引き継ぐ', [KN.srsFor(learning).b, KN.srsFor(learning).rv], [3, 5]);
const done = { ...knItem, s: S.STATUS.DONE, d: 0 };
eq('完了は st=2', KN.srsFor(done).st, 2);
eq('完了は期限なし', KN.srsFor(done).d, 0);
eq('アーカイブは復習に入れない', KN.srsFor({ ...knItem, s: S.STATUS.ARCHIVED }), null);
const archivedFields = KN.clipFieldsFor({ ...knItem, s: S.STATUS.ARCHIVED }, knMeta, null);
const archivedUrl = KN.buildClipUrl(knMeta.s.knUrl, archivedFields);
ok('アーカイブでは srs を送らない',
  JSON.parse(decodeURIComponent(archivedUrl.url.split('#knadd=')[1])).srs === undefined);
ok('元のURLのハッシュは引き継がない',
  KN.buildClipUrl('https://a.com/k.html#old', fields).url.startsWith('https://a.com/k.html#knadd='));

const badCat = KN.buildClipUrl(knMeta.s.knUrl, { ...fields, category: '存在しない分類' });
eq('知らないカテゴリは「調べる」になる', JSON.parse(decodeURIComponent(badCat.url.split('#knadd=')[1])).c, '調べる');
const badImg = KN.buildClipUrl(knMeta.s.knUrl, { ...fields, image: 'javascript:alert(1)' });
eq('http(s) 以外の画像は送らない', JSON.parse(decodeURIComponent(badImg.url.split('#knadd=')[1])).img, '');

// 長すぎるときは 画像 → メモ の順に削る
const longNote = KN.buildClipUrl(knMeta.s.knUrl, { ...fields, note: 'あ'.repeat(1500) });
ok('URLの上限を超えない', longNote.url.length <= KN.CLIP_LIMITS.url);
ok('先に画像を落とす', longNote.cutImg === true);
const decodedLong = JSON.parse(decodeURIComponent(longNote.url.split('#knadd=')[1]));
ok('画像は落ちている', decodedLong.img === '');
ok('メモは残っている（削られても中身はある）', decodedLong.n.length > 0);
const tooLong = KN.buildClipUrl(knMeta.s.knUrl, { ...fields, title: 'あ'.repeat(200), note: 'い'.repeat(2000) });
ok('削っても収まるなら送る', tooLong.url.length > 0 && tooLong.url.length <= KN.CLIP_LIMITS.url);

// 二重送信の印
ok('未送信は印なし', !KN.alreadyClipped(knItem));
const marked = KN.markClipped(knItem);
ok('送ると印が付く', KN.alreadyClipped(marked));
ok('印は時刻', marked.kn > 0);
ok('保存しても印が保たれる', S.makeItem(marked, knMeta).kn === marked.kn);

console.log('\n--- 回帰: 送信の信頼性 ---');
await S.wipeAll();
await S.replaceMeta({ ...structuredClone(S.DEFAULT_META), cats: knMeta.cats,
  s: { ...S.DEFAULT_META.s, knOn: true, knUrl: 'https://example.com/kininari.html', knCat: '調べる' } });
const qItem = S.makeItem({ u: 'https://example.com/q1', t: '送信テスト', c: 'c4' }, knMeta);
await S.putItems([qItem]);

// 送信に失敗したとき
fakeBrowser.reset();
fakeBrowser.createFails = true;
await KN.enqueueClip(qItem.id);
let flush = await KN.flushClips({ force: true });
eq('失敗したら送信数は0', flush.sent, 0);
eq('待ち行列に残る', flush.left, 1);
let stored = (await S.getAll()).items.find(i => i.id === qItem.id);
eq('回帰: 失敗したら「送信済み」にしない', stored.kn, 0);
let q = await KN.queueSummary();
eq('失敗の回数が記録される', q.entries[0].tries, 1);
eq('失敗の理由が残る', q.entries[0].status, 'failed');
eq('状態は「送信待ち」', KN.clipStateOf(stored, q.entries[0]).key, 'pending');

// 何度も失敗すると自動での送り直しを止める
// （自動の再送は5分ごとのアラーム { retry: true } が担う。起き直しのたびには送らない — 下の回帰テスト）
for (let i = 0; i < KN.MAX_TRIES + 2; i++) await KN.flushClips({ retry: true });
q = await KN.queueSummary();
ok('自動再送を止める', q.entries[0].tries >= KN.MAX_TRIES);
eq('止めた分を数えられる', q.stuck, 1);
eq('状態は「送れていません」', KN.clipStateOf(stored, q.entries[0]).key, 'stuck');
const beforeForce = fakeBrowser.created.length;
await KN.flushClips();
eq('放っておいても送りに行かない', fakeBrowser.created.length, beforeForce);

// 送信先が直ったら送れる
fakeBrowser.createFails = false;
await KN.resetQueueTries();
flush = await KN.flushClips();
eq('復旧すると送れる', flush.sent, 1);
eq('待ち行列が空になる', flush.left, 0);
stored = (await S.getAll()).items.find(i => i.id === qItem.id);
ok('送信済みの印が付く', stored.kn > 0);
eq('確認できたので confirmed', stored.knc, 1);
eq('状態は「送信済み」', KN.clipStateOf(stored, null).key, 'sent');
ok('送った内容は最新の項目から作る', fakeBrowser.created[fakeBrowser.created.length - 1].includes('%E9%80%81%E4%BF%A1%E3%83%86%E3%82%B9%E3%83%88'));

console.log('\n--- 回帰: 失敗した送信は間をあけて送り直す（Service Worker の起き直しごとに送らない） ---');
// 以前は起き直すたび（タブの更新でも起きる）に送り直し、裏タブが何度も開いて5回の試行をすぐ使い切っていた
fakeBrowser.reset();
fakeBrowser.createFails = true;
const gapItem = S.makeItem({ u: 'https://example.com/gap', t: '間をあける' }, knMeta);
await S.putItems([gapItem]);
await KN.enqueueClip(gapItem.id);
await KN.flushClips({ force: true });
eq('1回目の失敗', fakeBrowser.attempts, 1);
await KN.flushClips();                         // 起き直したときの送り直し
await KN.flushClips();
eq('失敗したばかりの分は、起き直しても送らない', fakeBrowser.attempts, 1);
await KN.flushClips({ retry: true });          // 5分ごとの再送アラーム
eq('再送アラームでは送る', fakeBrowser.attempts, 2);
await KN.flushClips({ force: true });          // 「今すぐ送る」
eq('「今すぐ送る」では送る', fakeBrowser.attempts, 3);
await chrome.storage.local.set({ [KN.QUEUE_KEY]: (await KN.getQueue()).map(e => ({ ...e, at: Date.now() - KN.RETRY_GAP_MS - 1000 })) });
await KN.flushClips();
eq('前回から間があいていれば、起き直したときにも送る', fakeBrowser.attempts, 4);
const fresh1 = S.makeItem({ u: 'https://example.com/gap-new', t: '新しく保存' }, knMeta);
await S.putItems([fresh1]);
await KN.enqueueClip(fresh1.id);
const before1 = fakeBrowser.attempts;
await KN.flushClips();
eq('新しく保存した分は待たずに送る（失敗中の分は待たせたまま）', fakeBrowser.attempts, before1 + 1);
await KN.removeFromQueue(gapItem.id);
await KN.removeFromQueue(fresh1.id);

console.log('\n--- 回帰: 送っている間に消された項目は、送った印を控えておく ---');
// 「元に戻す」で戻したときに印が無いと、もう一度送られて気になり帳に二重にできる
fakeBrowser.reset();
const goneItem = S.makeItem({ u: 'https://example.com/gone-while-sending', t: '送信中に削除' }, knMeta);
await S.putItems([goneItem]);
await KN.enqueueClip(goneItem.id);
fakeBrowser.onCreate = async () => { fakeBrowser.onCreate = null; await S.removeItems([goneItem.id]); };
flush = await KN.flushClips({ force: true });
eq('送信は済んでいる', flush.sent, 1);
eq('待ち行列からは外れる', (await KN.queueSummary()).entries.filter(e => e.id === goneItem.id).length, 0);
const goneMark = await KN.takeSentWhileGone([goneItem.id]);
ok('送った印が控えてある', goneMark[goneItem.id] && goneMark[goneItem.id].kn > 0 && goneMark[goneItem.id].knc === 1);
eq('控えは一度だけ使う', await KN.takeSentWhileGone([goneItem.id]), {});
eq('控えが無ければ空', await KN.takeSentWhileGone(['nothing']), {});

// 保存の確認を許可していないときは「未確認」
fakeBrowser.reset();
fakeBrowser.hasPermission = false;
const qItem2 = S.makeItem({ u: 'https://example.com/q2', t: '未確認テスト', c: 'c4' }, knMeta);
await S.putItems([qItem2]);
await KN.enqueueClip(qItem2.id);
// 確認できないときは 8 秒待ってから閉じるので、ここでは待ち行列に載ることだけ見る
eq('待ち行列に載る', (await KN.queueSummary()).total, 1);
eq('未確認は送信済みと区別する', KN.clipStateOf({ kn: Date.now(), knc: 0 }, null).key, 'unconfirmed');
eq('未送信の表示', KN.clipStateOf({ kn: 0, knc: 0 }, null).key, 'none');
await KN.removeFromQueue(qItem2.id);

// 保存先URLが http/https でないときは、開けても「送れた」ことにしない
fakeBrowser.reset();
await S.replaceMeta({ ...structuredClone(S.DEFAULT_META), cats: knMeta.cats,
  s: { ...S.DEFAULT_META.s, knOn: true, knUrl: 'data:text/html,kininari', knCat: '調べる' } });
const badUrlItem = S.makeItem({ u: 'https://example.com/badurl', t: 'URL間違い' }, knMeta);
await S.putItems([badUrlItem]);
await KN.enqueueClip(badUrlItem.id);
flush = await KN.flushClips({ force: true });
eq('おかしなURLでは送らない', flush.sent, 0);
eq('タブも開かない', fakeBrowser.created.length, 0);
eq('回帰: 印を付けない', (await S.getAll()).items.find(i => i.id === badUrlItem.id).kn, 0);
ok('理由が残る', (await KN.queueSummary()).entries.some(e => e.status === 'badurl'));
await KN.removeFromQueue(badUrlItem.id);
await S.replaceMeta({ ...structuredClone(S.DEFAULT_META), cats: knMeta.cats,
  s: { ...S.DEFAULT_META.s, knOn: true, knUrl: 'https://example.com/kininari.html', knCat: '調べる' } });

// 消された項目は待ち行列から落とす
fakeBrowser.reset();
const gone = S.makeItem({ u: 'https://example.com/gone', t: '消える項目' }, knMeta);
await S.putItems([gone]);
await KN.enqueueClip(gone.id);
await S.removeItems([gone.id]);
flush = await KN.flushClips();
eq('消された項目は待ち行列から消える', (await KN.queueSummary()).total, 0);
eq('その分は送らない', flush.sent, 0);

// 二重に並ばない
await KN.enqueueClip(qItem.id);
await KN.enqueueClip(qItem.id);
eq('同じ項目は1つだけ並ぶ', (await KN.queueSummary()).total, 1);
await KN.removeFromQueue(qItem.id);

// 送信がオフのときは送らない（待ち行列は残す）
await S.replaceMeta({ ...structuredClone(S.DEFAULT_META), s: { ...S.DEFAULT_META.s, knOn: false } });
await KN.enqueueClip(qItem.id);
flush = await KN.flushClips();
eq('オフなら送らない', flush.reason, 'off');
eq('待ち行列は残す', (await KN.queueSummary()).total, 1);
await KN.removeFromQueue(qItem.id);
await S.wipeAll();
await S.replaceMeta(meta);

console.log('\n--- ページ情報の取り込み ---');
scriptingResult = { th: 'https://example.com/og.png', si: 'テストメディア', au: '山田太郎', du: 'PT18M22S', title: 'OGPのタイトル', desc: '説明' };
let page = await PM.collectPageMeta(1, 'https://example.com/article');
eq('サムネイルURLを取り込む', page.rich.th, 'https://example.com/og.png');
eq('サイト名を取り込む', page.rich.si, 'テストメディア');
eq('著者を取り込む', page.rich.au, '山田太郎');
eq('タイトルを返す', page.title, 'OGPのタイトル');

page = await PM.collectPageMeta(1, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
ok('YouTube はサムネイルURLを保存しない（IDから導けるため）', page.rich.th === undefined);
eq('YouTube でもチャンネル名は保存する', page.rich.au, '山田太郎');
eq('YouTube でも再生時間は保存する', page.rich.du, 'PT18M22S');

scriptingResult = { th: 'javascript:alert(1)', si: 'x' };
page = await PM.collectPageMeta(1, 'https://example.com/a');
ok('http(s) 以外のサムネイルURLは取り込まない', page.rich.th === undefined);

scriptingResult = { th: 'https://example.com/' + 'a'.repeat(900), si: 'あ'.repeat(200), au: 'い'.repeat(200) };
page = await PM.collectPageMeta(1, 'https://example.com/a');
ok('長すぎるサムネイルURLは切り詰める', page.rich.th.length <= PM.RICH_LIMITS.th);
ok('長すぎるサイト名も切り詰める', page.rich.si.length <= PM.RICH_LIMITS.si);
ok('長すぎる著者名も切り詰める', page.rich.au.length <= PM.RICH_LIMITS.au);

scriptingResult = new Error('Cannot access contents of the page');
page = await PM.collectPageMeta(1, 'https://example.com/a');
eq('読み取れないページでは空を返す（保存は続けられる）', page, { rich: {}, title: '', desc: '' });
scriptingResult = {};
eq('タブIDが無ければ何もしない', await PM.collectPageMeta(null, 'https://a.com'), { rich: {}, title: '', desc: '' });

console.log('\n--- ID ---');
const ids = new Set(Array.from({ length: 5000 }, () => S.newId()));
eq('5000個生成しても衝突しない', ids.size, 5000);

console.log('\n--- YouTube ---');
eq('watch から ID', S.youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'), 'dQw4w9WgXcQ');
eq('youtu.be から ID', S.youtubeId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
eq('shorts から ID', S.youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('embed から ID', S.youtubeId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('m.youtube から ID', S.youtubeId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('YouTube 以外は空', S.youtubeId('https://vimeo.com/12345'), '');
eq('動画一覧ページは空', S.youtubeId('https://www.youtube.com/feed/subscriptions'), '');
ok('同じ動画はまとめる（時間指定・プレイリスト違い）',
  S.normalizeUrl('https://youtu.be/dQw4w9WgXcQ?t=90') ===
  S.normalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&index=3'));
ok('別の動画は別扱い',
  S.normalizeUrl('https://youtu.be/dQw4w9WgXcQ') !== S.normalizeUrl('https://youtu.be/aQw4w9WgXcX'));
eq('サムネイルは ID から導ける',
  S.thumbOf({ u: 'https://youtu.be/dQw4w9WgXcQ' }, null),
  'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
eq('YouTube 以外は保存済みURLを使う', S.thumbOf({ u: 'https://a.com' }, { th: 'https://a.com/og.png' }), 'https://a.com/og.png');
eq('サムネイルが無ければ空', S.thumbOf({ u: 'https://a.com' }, null), '');
eq('再生時間 4分13秒', S.fmtDuration('PT4M13S'), '4:13');
eq('再生時間 1時間超', S.fmtDuration('PT1H2M3S'), '1:02:03');
eq('再生時間 秒のみ', S.fmtDuration('PT45S'), '0:45');
eq('画面表示そのままの形式も通す', S.fmtDuration('12:34'), '12:34');
eq('不正な値は空', S.fmtDuration('abc'), '');

console.log('\n--- ストレージ（ハイブリッド） ---');
await S.replaceMeta(meta);
await S.putItems([
  S.makeItem({ u: 'https://one.com', t: 'One', g: ['x'] }, meta),
  S.makeItem({ u: 'https://two.com', t: 'Two' }, meta)
], { });
const all = await S.getAll();
eq('2件保存できる', all.items.length, 2);
ok('meta が読める', all.meta.cats.length === 6);
const found = await S.findByUrl('https://one.com/?utm_source=q');
ok('正規化して重複検出', found && found.t === 'One');
eq('タグ集計', S.tagCounts(all.items), [['x', 1]]);
const u = await S.usage();
ok('件数と同期件数が取れる', u.total === 2 && u.synced === 2);
ok('本体はローカルにある', Object.keys(localArea._mem).filter(k => k.startsWith('L:')).length === 2);
ok('同期側にも載っている', Object.keys(syncArea._mem).filter(k => k.startsWith('i:')).length === 2);

const withRich = S.makeItem({ u: 'https://rich.com', t: 'サムネ付き' }, meta);
await S.putItem(withRich, { th: 'https://rich.com/og.png', si: 'Rich', au: '著者', du: 'PT2M' });
const afterRich = await S.getAll();
ok('サムネイル情報が読み出せる', afterRich.rich[withRich.id].th === 'https://rich.com/og.png');
ok('サムネイル情報は同期に載せない',
  !Object.keys(syncArea._mem).some(k => JSON.stringify(syncArea._mem[k]).includes('rich.com/og.png')));

const del = await S.removeItems([all.items[0].id]);
ok('削除は {ok:true} を返す', del.ok === true);
eq('実際に削除される', (await S.getAll()).items.length, 2);
ok('削除の記録が同期に残る', (syncArea._mem.del || []).some(d => d.i === all.items[0].id));

console.log('\n--- 回帰: サムネイル情報の扱い ---');
const keepRich = S.makeItem({ u: 'https://keep.example/a', t: '保持テスト' }, meta);
await S.putItem(keepRich, { th: 'https://keep.example/og.png', si: 'Keep' });
// 付随情報を渡さずに本体だけ更新しても、サムネイルは消えない
await S.putItem({ ...keepRich, t: 'タイトルだけ変更' });
let g = await S.getAll();
eq('本体だけ更新してもサムネイルが残る', g.rich[keepRich.id].th, 'https://keep.example/og.png');
eq('本体の更新は反映される', g.items.find(i => i.id === keepRich.id).t, 'タイトルだけ変更');
await S.putRich(keepRich.id, { th: 'https://keep.example/new.png' });
g = await S.getAll();
eq('サムネイルだけ差し替えられる', g.rich[keepRich.id].th, 'https://keep.example/new.png');
await S.removeItems([keepRich.id]);
g = await S.getAll();
ok('項目を消すとサムネイル情報も消える', !g.rich[keepRich.id]);
ok('端末内にゴミが残らない', !Object.keys(localArea._mem).some(k => k === 'R:' + keepRich.id));

console.log('\n--- 回帰: 旧バージョン（同期のみ）からの移行 ---');
await S.wipeAll();
delete syncArea._mem[S.WIPE_KEY];   // v1.1 から上げてきた端末に「すべて削除」の記録は無い
await S.replaceMeta(meta);
// v1.1 では項目が sync の "i:<id>" にしか無かった。local は空。
for (let i = 0; i < 3; i++) {
  syncArea._mem['i:old' + i] = {
    id: 'old' + i, u: `https://old.example/${i}`, t: `旧データ ${i}`, n: '', c: 'c0', g: [],
    s: 1, f: 0, b: 1, d: Date.now() + 86400000, cr: Date.now() - i * 1000, rv: 2, iv: 0
    // up は無い（旧バージョンには存在しなかった項目）
  };
}
const migrated = await S.getAll();
eq('旧データがそのまま読める', migrated.items.length, 3);
ok('端末内へ移行される', Object.keys(localArea._mem).filter(k => k.startsWith('L:')).length === 3);
ok('復習の進み具合が保たれる', migrated.items.every(i => i.b === 1 && i.rv === 2));
const again = await S.getAll();
eq('二度読んでも増えない', again.items.length, 3);
await S.putItems([{ ...migrated.items[0], t: '移行後に編集' }]);
const afterEdit = await S.getAll();
eq('移行後も編集できる', afterEdit.items.find(i => i.id === 'old0').t, '移行後に編集');
eq('件数は変わらない', afterEdit.items.length, 3);
await S.wipeAll();
await S.replaceMeta(meta);

console.log('\n--- 回帰: すべて削除が他の PC にも伝わる ---');
await S.wipeAll();
delete syncArea._mem[S.WIPE_KEY];
await S.replaceMeta(meta);
const keepA = S.makeItem({ u: 'https://a.example/1', t: '消える項目' }, meta);
await S.putItems([keepA]);
await S.wipeAll();
ok('「すべて削除」の印が同期に残る', Number(syncArea._mem[S.WIPE_KEY]) > 0);
// 他の PC にはまだ項目が残っている状態を作る
localArea._mem['L:' + keepA.id] = keepA;
const afterWipe = await S.getAll();
eq('他の PC に残っていた項目も消える', afterWipe.items.length, 0);
ok('端末内からも消える', !localArea._mem['L:' + keepA.id]);
// 削除のあとに保存したものは残る
await S.replaceMeta(meta);
const newAfter = S.makeItem({ u: 'https://a.example/2', t: '削除後に保存' }, meta);
await S.putItems([newAfter]);
eq('削除のあとの保存は残る', (await S.getAll()).items.length, 1);
ok('同期にも載る', Object.keys(syncArea._mem).some(k => k === 'i:' + newAfter.id));
await S.wipeAll();
delete syncArea._mem[S.WIPE_KEY];
await S.replaceMeta(meta);

console.log('\n--- 回帰: 取り込む前の項目を同期から降ろさない ---');
// 他の PC が保存した項目が sync にあり、この端末にはまだ無い状態で保存すると、
// 以前は syncPush がその項目を sync から消してしまい、永久に届かなくなっていた
syncArea._mem['i:other1'] = { id: 'other1', u: 'https://other.example/x', t: '他のPCの項目',
  n: '', c: 'c0', g: [], s: 0, f: 0, b: 0, d: Date.now() + 86400000, cr: Date.now(), rv: 0, iv: 0, kn: 0, knc: 0, up: Date.now() };
const mine = S.makeItem({ u: 'https://mine.example/y', t: 'こちらの項目' }, meta);
await S.putItems([mine]);
ok('他の PC の項目が同期に残る', !!syncArea._mem['i:other1']);
eq('読み出すと両方見える', (await S.getAll()).items.length, 2);
await S.wipeAll();
delete syncArea._mem[S.WIPE_KEY];
await S.replaceMeta(meta);

console.log('\n--- 回帰: 削除済みの項目を取り込み直さない ---');
const delItem = S.makeItem({ u: 'https://del.example/1', t: '削除する項目' }, meta);
await S.putItems([delItem]);
await S.removeItems([delItem.id]);
// 他の PC がまだ持っていて、同期に載せ直してしまった状況
syncArea._mem['i:' + delItem.id] = { ...delItem, up: delItem.up };
const g1 = await S.getAll();
eq('削除済みは戻ってこない', g1.items.filter(i => i.id === delItem.id).length, 0);
ok('同期側からも片付ける', !syncArea._mem['i:' + delItem.id]);
const g2 = await S.getAll();
eq('二度読んでも増えない（書き込みが止まらなくならない）', g2.items.length, 0);
await S.wipeAll();
delete syncArea._mem[S.WIPE_KEY];
await S.replaceMeta(meta);

console.log('\n--- 削除の取り消し（元に戻す） ---');
const undoItem = S.makeItem({ u: 'https://undo.example/1', t: '元に戻す項目' }, meta);
Object.assign(undoItem, { s: 1, rv: 3, b: 2, kn: 1, knc: 1 });
const undoRich = { th: 'https://undo.example/th.jpg', si: 'サイト名' };
await S.putItems([undoItem], { [undoItem.id]: undoRich });
const undoSnap = structuredClone((await S.getAll()).items.find(i => i.id === undoItem.id));
await S.removeItems([undoItem.id]);
ok('削除の記録が付く', (syncArea._mem.del || []).some(d => d.i === undoItem.id));
eq('削除すると消える', (await S.getAll()).items.filter(i => i.id === undoItem.id).length, 0);
await new Promise(r => setTimeout(r, 5));   // 削除と取り消しが同じミリ秒にならないように
const undoRes = await S.restoreItems([undoSnap], { [undoItem.id]: undoRich });
ok('元に戻せる', undoRes.ok);
const undoAll = await S.getAll();
const undoBack = undoAll.items.find(i => i.id === undoItem.id);
ok('一覧に戻る', !!undoBack);
eq('復習の進み具合・気になり帳の印も元どおり', [undoBack.s, undoBack.rv, undoBack.b, undoBack.kn, undoBack.knc], [1, 3, 2, 1, 1]);
eq('サムネイル等も戻る', undoAll.rich[undoItem.id], undoRich);
ok('削除の記録は外れる', !(syncArea._mem.del || []).some(d => d.i === undoItem.id));
ok('同期にも載り直す', !!syncArea._mem['i:' + undoItem.id]);
ok('更新時刻が新しくなる', undoBack.up > undoSnap.up);
ok('渡した控えは書き換えない', undoSnap.up < undoBack.up);
// 他の PC: 削除の記録を先に受け取って消したあとで、戻した項目が届いた場合
delete localArea._mem['L:' + undoItem.id];
delete localArea._mem['R:' + undoItem.id];
syncArea._mem.del = [...(syncArea._mem.del || []), { i: undoItem.id, t: undoSnap.up + 1 }];
const other = await S.getAll();
ok('他の PC で消えた分も、戻した方が新しいので取り込まれる', other.items.some(i => i.id === undoItem.id));
eq('空の取り消しは何もしない', (await S.restoreItems([])).count, 0);
await S.wipeAll();
delete syncArea._mem[S.WIPE_KEY];
await S.replaceMeta(meta);

console.log('\n--- 回帰: ドメインの記憶が増え続けない ---');
let domRes = null;
for (let i = 0; i < 80; i++) domRes = await S.setMeta({ dom: { ['d' + i + '.example']: 'c0' } });
ok('上限まで刈り込まれる', Object.keys(domRes.meta.dom).length <= S.DOM_MAX);
ok('新しいものが残る', 'd79.example' in domRes.meta.dom);
ok('古いものは落ちる', !('d0.example' in domRes.meta.dom));
ok('meta が同期の1件上限に収まる', S.byteSize(JSON.stringify(domRes.meta)) < 8000);
await S.replaceMeta(meta);

console.log('\n--- 他の PC との同期 ---');
await S.putItems([S.makeItem({ u: 'https://local.example/x', t: 'こちらの項目' }, meta)]);
// 他の PC が保存した項目が sync 経由で降ってくる
syncArea._mem['i:remote1'] = { id: 'remote1', u: 'https://remote.example/a', t: '他のPCで保存', n: '', c: 'c0', g: [], s: 0, f: 0, b: 0, d: Date.now() + 86400000, cr: Date.now(), rv: 0, iv: 0, up: Date.now() };
const merged = await S.getAll();
ok('他の PC の項目が取り込まれる', merged.items.some(i => i.id === 'remote1'));
ok('取り込んだ項目はローカルにも入る', !!localArea._mem['L:remote1']);

// 他の PC で削除された項目は、こちらでも消える
const now = Date.now();
syncArea._mem.del = [...(syncArea._mem.del || []), { i: 'remote1', t: now + 1000 }];
const afterRemoteDelete = await S.getAll();
ok('他の PC の削除が反映される', !afterRemoteDelete.items.some(i => i.id === 'remote1'));
ok('ローカルからも消える', !localArea._mem['L:remote1']);

console.log('\n--- 回帰: 同期の上限を超えても保存できる ---');
await S.wipeAll();
await S.replaceMeta({ ...structuredClone(S.DEFAULT_META), s: { ...S.DEFAULT_META.s, syncMax: 20 } });
const many = [];
for (let i = 0; i < 60; i++) {
  many.push(S.makeItem({ u: `https://ex.com/p${i}`, t: `記事 ${i}`, n: 'メモ'.repeat(20) }, meta));
}
for (let i = 0; i < many.length; i += 10) {
  const res = await S.putItems(many.slice(i, i + 10));
  if (!res.ok) { console.log('   保存失敗:', res.error); break; }
}
const big = await S.getAll();
eq('60件すべて読み出せる', big.items.length, 60);
const syncedCount = Object.keys(syncArea._mem).filter(k => k.startsWith('i:')).length;
ok(`同期は上限（20件）までに収まる: ${syncedCount}`, syncedCount <= 20);
ok('同期に載らなかった項目もローカルにある',
  Object.keys(localArea._mem).filter(k => k.startsWith('L:')).length === 60);
const usage2 = await S.usage();
ok('使用量に全件と同期件数が出る', usage2.total === 60 && usage2.synced === syncedCount);
ok('同期容量は上限内', usage2.syncBytes < 102400);

// 同期をオフにすると sync から降ろされる
await S.replaceMeta({ ...structuredClone(S.DEFAULT_META), s: { ...S.DEFAULT_META.s, sync: false } });
await S.syncPush();
eq('同期オフで sync 側が空になる', Object.keys(syncArea._mem).filter(k => k.startsWith('i:')).length, 0);
eq('それでも全件読める', (await S.getAll()).items.length, 60);

await S.wipeAll();
eq('すべて削除できる', (await S.getAll()).items.length, 0);
await S.replaceMeta(meta);

console.log('\n--- 回帰: meta は差分マージで書く ---');
await S.replaceMeta({ ...structuredClone(S.DEFAULT_META), cats: [...structuredClone(S.DEFAULT_META).cats, { id: 'cZ', name: '追加', color: '#111111' }] });
const r1 = await S.setMeta({ dom: { 'example.com': 'c1' } });
ok('dom を足しても cats が消えない', r1.ok && r1.meta.cats.some(c => c.id === 'cZ'));
const r2 = await S.setMeta({ s: { hour: 21 } });
ok('s は浅くマージされる', r2.ok && r2.meta.s.hour === 21 && r2.meta.s.notify === true);
ok('先に書いた dom も残る', r2.meta.dom['example.com'] === 'c1');

console.log('\n--- 回帰: 1件あたりのバイト数 ---');
// Chrome 実機で確認: 上限 8192 バイト（UTF-8、日本語は1文字3バイト）
const jp = S.makeItem({ u: 'https://x.com/' + 'a'.repeat(200), t: 'あ'.repeat(200), n: 'あ'.repeat(1200) }, meta);
ok('日本語で上限いっぱいでも 8192 未満', S.itemBytes(jp) < 8192);
ok('その項目は実際に保存できる', (await S.putItems([jp])).ok);
const huge = { ...jp, id: 'huge', n: 'あ'.repeat(4000) };
const hres = await S.putItems([huge]);
ok('大きすぎる項目は保存前に弾く', hres.ok === false && /長すぎます/.test(hres.error));
ok('同期容量エラーの文言', S.describeQuotaError(new Error('QUOTA_BYTES quota exceeded')).includes('端末内'));

/* ---------- 1.8.1 の回帰テスト: 削除の記録 ---------- */
const resetAll = async (m = meta) => {
  await S.wipeAll();
  delete syncArea._mem[S.WIPE_KEY];
  for (const k of Object.keys(localAreaB._mem)) delete localAreaB._mem[k];
  syncArea.errors.length = 0;
  await S.replaceMeta(structuredClone(m));
};
const tombIds = () => [...S.readTombs(syncArea._mem).keys()];
const syncBytes = () => Object.entries(syncArea._mem).reduce((n, [k, v]) => n + new TextEncoder().encode(k + JSON.stringify(v)).length, 0);
const tombKeySizes = () => Object.entries(syncArea._mem)
  .filter(([k]) => k === S.DEL_KEY || S.isTombShardKey(k))
  .map(([k, v]) => new TextEncoder().encode(k + JSON.stringify(v)).length);
/** PC A で保存したものを、PC B が少しずつ取り込んでいく（同期に載るのは新しい分だけなので） */
async function putOnBothPcs(list, chunk = 50) {
  for (let i = 0; i < list.length; i += chunk) {
    await S.putItems(list.slice(i, i + chunk));
    await onPcB(() => S.getAll());
  }
}

console.log('\n--- 回帰: 一度にたくさん消しても削除の記録を落とさない ---');
// 以前は記録を 120 件で切っていたので、まとめて消すと残りが他の PC から戻ってきた
await resetAll();
const many500 = Array.from({ length: 500 }, (_, i) => S.makeItem({ u: `https://bulk.example/${i}`, t: `まとめて ${i}` }, meta));
await putOnBothPcs(many500);
eq('PC B にも 500 件ある', (await onPcB(() => S.getAll())).items.length, 500);
await S.removeItems(many500.map(i => i.id));
eq('同期の書き込みエラーは出ていない', syncArea.errors, []);
eq('500 件すべての記録が残る', many500.filter(i => tombIds().includes(i.id)).length, 500);
ok('記録は複数のキーに分けて持つ', Object.keys(syncArea._mem).filter(k => S.isTombShardKey(k)).length >= 2);
ok('どのキーも 1キー 8192 バイト未満', tombKeySizes().every(n => n < 8192));
ok('旧バージョン向けの del は新しい 120 件まで', Array.isArray(syncArea._mem.del) && syncArea._mem.del.length === S.DEL_MAX);
ok('同期全体も上限内', syncBytes() <= S.SYNC_QUOTA_BYTES && Object.keys(syncArea._mem).length <= S.SYNC_MAX_ITEMS);
eq('PC B でも全部消える', (await onPcB(() => S.getAll())).items.length, 0);
const onB = S.makeItem({ u: 'https://bulk.example/new-on-b', t: 'PC B で保存' }, meta);
await onPcB(() => S.putItems([onB]));
eq('回帰: PC B が何か保存しても、消した項目は戻ってこない', (await S.getAll()).items.map(i => i.id), [onB.id]);

console.log('\n--- 回帰: 同期がいっぱいでも削除の記録を書ける ---');
await resetAll();
const oldOnes = Array.from({ length: 600 }, (_, i) => S.makeItem({ u: `https://old.example/${i}`, t: `古い項目 ${i}` }, meta));
await putOnBothPcs(oldOnes, 60);
const newOnes = Array.from({ length: 260 }, (_, i) => S.makeItem({ u: `https://new.example/${i}`, t: `新しい項目 ${i}`, n: 'メモ'.repeat(30) }, meta));
await putOnBothPcs(newOnes, 65);
ok(`同期に新しい項目が上限近くまで載っている（${syncBytes()} バイト）`, syncBytes() > 80000);
ok('古い項目は同期に載っていない', !Object.keys(syncArea._mem).some(k => k === 'i:' + oldOnes[0].id));
await S.removeItems(oldOnes.map(i => i.id));     // 同期に載っていない 600 件を消す
eq('同期の書き込みエラーは出ていない', syncArea.errors, []);
eq('600 件すべての記録が残る', oldOnes.filter(i => tombIds().includes(i.id)).length, 600);
ok('同期全体は上限内', syncBytes() <= S.SYNC_QUOTA_BYTES);
const bAfterFull = await onPcB(() => S.getAll());
eq('PC B からも消える', bAfterFull.items.filter(i => i.u.startsWith('https://old.example/')).length, 0);
eq('同期から降ろした新しい項目も、どちらの PC にも残る', [
  (await S.getAll()).items.filter(i => i.u.startsWith('https://new.example/')).length,
  bAfterFull.items.filter(i => i.u.startsWith('https://new.example/')).length
], [260, 260]);
await S.syncPush();
ok('載せ直しても上限を超えない', syncBytes() <= S.SYNC_QUOTA_BYTES && !syncArea.errors.length);

console.log('\n--- 回帰: 削除の記録の形と期限 ---');
const DAYMS = 86400000;
const now0 = Date.now();
const tomb = new Map([['keep-1', now0], ['recent', now0 - DAYMS], ['expired', now0 - 61 * DAYMS]]);
const enc = S.encodeTombs(tomb, new Set(['keep-1']), now0);
const back = S.readTombs(enc.keys);
ok('60日を過ぎた記録は捨てる', !back.has('expired'));
eq('期限内の記録は残る（時刻もそのまま）', [back.get('keep-1'), back.get('recent')], [now0, now0 - DAYMS]);
ok('旧形式の del にも写す', enc.keys.del.some(d => d.i === 'recent' && d.t === now0 - DAYMS));
// 入りきらないほど記録があっても、今回の分は必ず残し、古いものから捨てる
const bigTombs = new Map();
for (let i = 0; i < 4000; i++) bigTombs.set('old-' + i, now0 - DAYMS - i * 1000);
const batch = new Set();
for (let i = 0; i < 500; i++) { bigTombs.set('batch-' + i, now0); batch.add('batch-' + i); }
const encBig = S.encodeTombs(bigTombs, batch, now0);
const backBig = S.readTombs(encBig.keys);
ok('今回の 500 件は必ず残る', [...batch].every(id => backBig.has(id)));
ok(`入りきらない古い記録は捨てる（残り ${backBig.size} 件）`, backBig.size < 4500 && encBig.dropped > 0);
ok('捨てるのは古いものから', backBig.has('old-0') && !backBig.has('old-3999'));
ok('キーの数は上限まで', Object.keys(encBig.keys).filter(k => S.isTombShardKey(k)).length <= S.TOMB_SHARDS);
ok('どのキーも 8192 バイト未満',
  Object.entries(encBig.keys).every(([k, v]) => new TextEncoder().encode(k + JSON.stringify(v)).length < 8192));
eq('"__proto__" のような id でも記録が残る', S.readTombs(S.encodeTombs(new Map([['__proto__', now0]]), new Set(), now0).keys).get('__proto__'), now0);

console.log('\n--- 回帰: 旧バージョンの端末と混在しても記録が消えない ---');
await resetAll();
const mixA = S.makeItem({ u: 'https://mix.example/a', t: '新しい版で削除' }, meta);
const mixB = S.makeItem({ u: 'https://mix.example/b', t: '旧版で削除' }, meta);
await putOnBothPcs([mixA, mixB]);
await S.removeItems([mixA.id]);
// 旧バージョン（1.8.0）の端末が自分の削除を del に書く: 読んで → 足して → 120件に切って書く
const oldDel = (syncArea._mem.del || []).filter(d => d.i !== mixA.id);   // たまたま古い内容を読んでいた
syncArea._mem.del = [...oldDel, { i: mixB.id, t: Date.now() }];
delete syncArea._mem['i:' + mixB.id];
const mixOnB = await onPcB(() => S.getAll());
eq('新しい版の記録（del1..）も旧版の記録（del）も効く', mixOnB.items.length, 0);
await S.removeItems(['someone-else']);        // 新しい版が次に書くとき、旧版の記録も取り込む
ok('旧版の記録を分割キーへ引き継ぐ', Object.keys(syncArea._mem).filter(k => S.isTombShardKey(k))
  .some(k => mixB.id in syncArea._mem[k]));
// 旧形式（del だけ）しか無い同期も読める
await resetAll();
const legacyOnly = S.makeItem({ u: 'https://legacy.example/x', t: '旧形式で削除済み' }, meta);
await putOnBothPcs([legacyOnly]);
syncArea._mem.del = [{ i: legacyOnly.id, t: Date.now() + 10 }];
delete syncArea._mem['i:' + legacyOnly.id];
eq('旧形式の記録だけでも削除が伝わる', (await onPcB(() => S.getAll())).items.length, 0);

console.log('\n--- 回帰: 数値の id でも削除が伝わる ---');
await resetAll();
const numItem = S.makeItem({ id: 4242, url: 'https://num.example/1', title: '数値ID' }, meta);
await putOnBothPcs([numItem]);
await S.removeItems([4242]);
ok('旧形式の del には数値のまま写す', (syncArea._mem.del || []).some(d => d.i === 4242));
eq('PC B でも消える', (await onPcB(() => S.getAll())).items.length, 0);

console.log('\n--- 回帰: 削除の記録の読み書きが重ならない ---');
// 以前は2つの削除が重なると、あとから書いた方が先の記録を消していた（消した項目が他の PC から戻る）
await resetAll();
const raceA = S.makeItem({ u: 'https://race.example/a', t: '先に消す' }, meta);
const raceB = S.makeItem({ u: 'https://race.example/b', t: 'すぐあとに消す' }, meta);
await putOnBothPcs([raceA, raceB]);
syncArea.latency = 15;
await Promise.all([S.removeItems([raceA.id]), new Promise(r => setTimeout(r, 5)).then(() => S.removeItems([raceB.id]))]);
syncArea.latency = 0;
ok('同じ画面で続けて消しても、両方の記録が残る', tombIds().includes(raceA.id) && tombIds().includes(raceB.id));
const restoreRace = S.makeItem({ u: 'https://race.example/c', t: '戻しながら消す' }, meta);
await S.putItems([restoreRace]);
const snapC = { ...(await S.getAll()).items.find(i => i.id === restoreRace.id) };
await S.removeItems([restoreRace.id]);
await new Promise(r => setTimeout(r, 5));
syncArea.latency = 15;
const raceD = S.makeItem({ u: 'https://race.example/d', t: '戻している間に消す' }, meta);
await S.putItems([raceD]);
await Promise.all([S.restoreItems([snapC]), new Promise(r => setTimeout(r, 5)).then(() => S.removeItems([raceD.id]))]);
syncArea.latency = 0;
ok('戻している間に消しても、消した方の記録は残る', tombIds().includes(raceD.id) && !tombIds().includes(restoreRace.id));

// 別のタブや Service Worker（＝別のモジュール）とも重ならない: Web Locks で並べる
const S2 = await import(pathToFileURL(path.join(ROOT, 'store.js')).href + '?another-tab');
const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
async function crossTabRace(withLocks) {
  await resetAll();
  const x = S.makeItem({ u: 'https://tabs.example/x', t: 'タブ1で消す' }, meta);
  const y = S.makeItem({ u: 'https://tabs.example/y', t: 'タブ2で消す' }, meta);
  await S.putItems([x, y]);
  const tails = new Map();
  const locks = { calls: 0, request(name, cb) {
    this.calls++;
    const run = (tails.get(name) || Promise.resolve()).then(() => cb({ name }));
    tails.set(name, run.then(() => {}, () => {}));
    return run;
  } };
  Object.defineProperty(globalThis, 'navigator', { value: withLocks ? { locks } : {}, configurable: true, writable: true });
  syncArea.latency = 15;
  try { await Promise.all([S.removeItems([x.id]), S2.removeItems([y.id])]); }
  finally { syncArea.latency = 0; Object.defineProperty(globalThis, 'navigator', navDesc); }
  return { both: tombIds().includes(x.id) && tombIds().includes(y.id), calls: locks.calls };
}
const noLock = await crossTabRace(false);
ok('（確認）ロックが無いと別のタブ同士では記録を取り合う', !noLock.both);
const withLock = await crossTabRace(true);
ok('Web Locks があれば別のタブ同士でも両方の記録が残る', withLock.both && withLock.calls >= 2);

console.log('\n--- 回帰: 同期オフのときは削除を他の PC へ伝えない ---');
await resetAll();
const shared = S.makeItem({ u: 'https://shared.example/1', t: '両方の PC にある' }, meta);
await putOnBothPcs([shared]);
await S.replaceMeta({ ...structuredClone(meta), s: { ...meta.s, sync: false } });
await S.removeItems([shared.id]);
ok('記録を残さない', !tombIds().includes(shared.id));
eq('PC B の同じ項目は消えない（「この端末のみ」）', (await onPcB(() => S.getAll())).items.map(i => i.id), [shared.id]);
eq('こちらでは消えている', (await S.getAll()).items.length, 0);

console.log('\n--- 回帰: 元に戻すと、分割した記録からも外れる ---');
await resetAll();
const undoX = S.makeItem({ u: 'https://undo2.example/x', t: '戻す項目' }, meta);
await putOnBothPcs([undoX]);
const undoXSnap = { ...(await S.getAll()).items.find(i => i.id === undoX.id) };
await S.removeItems([undoX.id]);
ok('消すと記録が付く', tombIds().includes(undoX.id));
await new Promise(r => setTimeout(r, 5));
await S.restoreItems([undoXSnap]);
ok('戻すと記録が外れる（分割キー・旧形式とも）', !tombIds().includes(undoX.id) && !(syncArea._mem.del || []).some(d => d.i === undoX.id));
eq('PC B にも戻る', (await onPcB(() => S.getAll())).items.map(i => i.id), [undoX.id]);
await resetAll();

console.log('\n--- 回帰: CSV に書き出す値 ---');
eq('= で始まる値は数式にならないようにする', S.csvCell('=HYPERLINK("http://evil/")'), `"'=HYPERLINK(""http://evil/"")"`);
eq('+ - @ も同じ', ['+1', '-1', '@SUM(A1)'].map(S.csvCell), [`"'+1"`, `"'-1"`, `"'@SUM(A1)"`]);
eq('タブ・CR で始まる値も同じ', ['\tx', '\rx'].map(S.csvCell), ['"\'\tx"', '"\'\rx"']);
eq('ふつうの値はそのまま', [S.csvCell('React 入門'), S.csvCell(3), S.csvCell(null)], ['"React 入門"', '"3"', '""']);

console.log('\n--- エラーメッセージ ---');
ok('同期容量の文言', S.describeQuotaError(new Error('QUOTA_BYTES quota exceeded')).includes('100KB'));
ok('件数超過の文言', S.describeQuotaError(new Error('MAX_ITEMS quota exceeded')).includes('件'));
ok('端末容量の文言', S.describeLocalError(new Error('QUOTA_BYTES quota exceeded')).includes('端末'));

/* ---------- 1.8.2 の回帰テスト ---------- */
console.log('\n--- 回帰: ドメインの記憶は「最近使った順」で刈り込む ---');
await resetAll();
await S.setMeta({ dom: { 'daily.example': 'c1' } });
for (let i = 0; i < S.DOM_MAX - 1; i++) await S.setMeta({ dom: { ['site' + i + '.example']: 'c2' } });
await S.setMeta({ dom: { 'daily.example': 'c1' } });          // いま使い直した
let domKeys = Object.keys((await S.getMeta()).dom);
eq('使い直したドメインは末尾（いちばん新しい）へ', domKeys[domKeys.length - 1], 'daily.example');
await S.setMeta({ dom: { 'new.example': 'c3' } });
domKeys = Object.keys((await S.getMeta()).dom);
ok('新しいサイトを足しても、使い直したドメインは残る', domKeys.includes('daily.example'));
ok('いちばん古いものから落ちる', !domKeys.includes('site0.example') && domKeys.length === S.DOM_MAX);
eq('使い直すとカテゴリも新しい値になる', (await S.setMeta({ dom: { 'daily.example': 'c4' } })).meta.dom['daily.example'], 'c4');

console.log('\n--- 回帰: 消したカテゴリは選ばない ---');
const catMeta = { ...structuredClone(meta), cats: meta.cats.filter(c => c.id !== 'c3') };
eq('覚えているカテゴリがあればそれ', S.pickCat(catMeta, 'c2', 'c1'), 'c2');
eq('消えていれば次の候補（既定のカテゴリ）', S.pickCat(catMeta, 'c3', 'c1'), 'c1');
eq('どれも無ければ先頭のカテゴリ', S.pickCat(catMeta, 'c3', 'gone', undefined), 'c0');
eq('meta が壊れていても既定のカテゴリ', S.pickCat(null, 'x'), S.DEFAULT_META.cats[0].id);

console.log('\n--- 回帰: 同期する件数の上限を 0 にできる ---');
eq('0 は 0 のまま', S.syncMaxOf({ s: { syncMax: 0 } }), 0);
eq('文字の "0" も 0', S.syncMaxOf({ s: { syncMax: '0' } }), 0);
eq('空・不正な値は既定値', [S.syncMaxOf({ s: { syncMax: '' } }), S.syncMaxOf({ s: { syncMax: 'abc' } }), S.syncMaxOf({ s: {} })], [300, 300, 300]);
await resetAll({ ...structuredClone(meta), s: { ...meta.s, syncMax: 0 } });
await S.putItems([S.makeItem({ u: 'https://zero.example/1', t: '同期しない' }, meta)]);
eq('上限 0 なら同期には載せない', Object.keys(syncArea._mem).filter(k => k.startsWith(S.ITEM_PREFIX)).length, 0);
eq('端末内には保存される', (await S.getAll()).items.length, 1);

console.log('\n--- 回帰: 読み込みで二重にしない ---');
const have1 = S.makeItem({ u: 'https://have.example/a?utm_source=x', t: 'すでにある' }, meta);
const have2 = S.makeItem({ u: 'https://have.example/b', t: 'すでにある2' }, meta);
const plan = S.planImport([have1, have2], [
  { ...have1, t: '同じ ID' },                                   // 同期で届いていた分（同じ ID）
  { id: 'other-id', url: 'https://have.example/b#top', title: '同じページ' },   // ID は違うが同じページ
  { url: 'https://new.example/1', title: '新しい' },
  { url: 'https://new.example/1?utm_medium=y', title: 'ファイルの中で重複' },
  { id: 'keep-id', u: 'https://new.example/2', t: 'ID を保つ' },
  { url: 'javascript:alert(1)' }, null, 'x'
], meta);
eq('新しいものだけ読み込む', plan.add.map(a => a.item.t), ['新しい', 'ID を保つ']);
eq('すでにある分の件数', plan.dup, 3);
eq('読み込めない分の件数', plan.invalid, 3);
eq('ID はそのまま使う（サムネイル情報を引き継げる）', plan.add[1].item.id, 'keep-id');
eq('元の ID を返す', plan.add[1].oldId, 'keep-id');
ok('ID の無い形式には新しい ID を振る', plan.add[0].item.id && plan.add[0].oldId === undefined);
const twice = S.planImport([...[have1, have2], ...plan.add.map(a => a.item)], [{ url: 'https://new.example/1' }, { id: 'keep-id', u: 'https://changed.example/' }], meta);
eq('同じバックアップを2回読み込んでも増えない', [twice.add.length, twice.dup], [0, 2]);

// PC B に同期で届いた分があるところへ、PC A の全件のバックアップを読み込む（README の「移行」）
await resetAll();
const migr = Array.from({ length: 5 }, (_, i) => S.makeItem({ u: `https://migrate.example/${i}`, t: `移行 ${i}` }, meta));
await putOnBothPcs(migr);
const backup = (await S.getAll()).items.map(i => ({ ...i }));
const migratedOnB = await onPcB(async () => {
  const p = S.planImport((await S.getAll()).items, backup, meta);
  await S.putItems(p.add.map(a => a.item));
  return (await S.getAll()).items;
});
eq('回帰: 移行先で二重にならない', migratedOnB.length, 5);

console.log('\n--- バックアップの設定を読み込む ---');
const curS = structuredClone(S.DEFAULT_META.s);
const san = S.sanitizeSettings({
  steps: [2, '4', -1, 'x', 8], hour: 25, firstDelay: 3, againMode: 'back', notify: false,
  syncMax: 0, defaultCat: 'c2', knUrl: 'https://kn.example/kininari.html', knCat: 'メモ',
  defaultInterval: 7, unknownKey: 'x', badge: 'yes'
}, curS, { cats: meta.cats, knCats: ['メモ', '調べる'] });
eq('正の数だけの間隔を取り込む', san.s.steps, [2, 4, 8]);
eq('範囲外の時刻は丸める', san.s.hour, 23);
eq('真偽値でない値は取り込まない', san.s.badge, true);
eq('0 の上限も取り込む', san.s.syncMax, 0);
ok('知らない項目は取り込まない', !('unknownKey' in san.s));
eq('変わった項目の一覧', san.changed.sort(), ['againMode', 'defaultCat', 'defaultInterval', 'firstDelay', 'hour', 'knCat', 'knUrl', 'notify', 'steps', 'syncMax'].sort());
const bad = S.sanitizeSettings({ defaultCat: 'gone', knCat: '勝手な値', knUrl: 'javascript:alert(1)', againMode: 'x', hour: null, steps: [] }, curS, { cats: meta.cats, knCats: ['メモ'] });
eq('不正な値はどれも取り込まない', bad.changed, []);
eq('いまの設定と同じなら「変わった」ことにしない', S.sanitizeSettings(curS, curS, { cats: meta.cats, knCats: ['調べる'] }).changed, []);
eq('設定が無いバックアップでも壊れない', S.sanitizeSettings(null, curS).s, curS);

console.log('\n--- 回帰: 同期オフの「すべて削除」はこの端末だけ ---');
await resetAll();
const wipeShared = S.makeItem({ u: 'https://wipe.example/1', t: '両方の PC にある' }, meta);
await putOnBothPcs([wipeShared]);
await S.replaceMeta({ ...structuredClone(meta), s: { ...meta.s, sync: false, hour: 7 } });
eq('同期オフなら scope は local', (await S.wipeAll()).scope, 'local');
eq('こちらの項目は消える', (await S.getAll()).items.length, 0);
ok('「すべて削除した」記録を同期に残さない', !(S.WIPE_KEY in syncArea._mem));
eq('PC B の項目は消えない', (await onPcB(() => S.getAll())).items.map(i => i.id), [wipeShared.id]);
eq('共有している設定は残す', (await S.getMeta()).s.hour, 7);
await S.replaceMeta(structuredClone(meta));
eq('同期オンなら scope は all', (await S.wipeAll()).scope, 'all');
ok('同期オンなら記録を残す', S.WIPE_KEY in syncArea._mem);
eq('PC B の項目も消える', (await onPcB(() => S.getAll())).items.length, 0);
await resetAll();

console.log('\n--- 回帰: YouTube の古いページ情報を使わない ---');
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
scriptingResult = { si: 'YouTube', au: '前のチャンネル', du: 'PT1M', title: '前の動画', desc: '前の説明', ogUrl: 'https://www.youtube.com/watch?v=aBcDeFgHiJk', mvid: '' };
page = await PM.collectPageMeta(1, YT);
eq('og:url が別の動画ならタイトルを使わない', page.title, '');
ok('構造化データも古いと見て、チャンネル名・再生時間を使わない', page.rich.au === undefined && page.rich.du === undefined);
eq('サイト名はそのまま', page.rich.si, 'YouTube');
scriptingResult = { ...scriptingResult, mvid: 'dQw4w9WgXcQ', au: 'いまのチャンネル', du: 'PT2M' };
page = await PM.collectPageMeta(1, YT);
ok('構造化データが今の動画なら、チャンネル名・再生時間は使う', page.rich.au === 'いまのチャンネル' && page.rich.du === 'PT2M' && page.title === '');
scriptingResult = { ...scriptingResult, ogUrl: 'https://www.youtube.com/', mvid: '' };
eq('og:url が動画でない（トップから移った）ときもタイトルを使わない', (await PM.collectPageMeta(1, YT)).title, '');
scriptingResult = { au: 'ch', du: 'PT3M', title: '今の動画', ogUrl: 'https://youtu.be/dQw4w9WgXcQ', mvid: 'dQw4w9WgXcQ' };
page = await PM.collectPageMeta(1, YT);
ok('同じ動画ならそのまま使う', page.title === '今の動画' && page.rich.au === 'ch' && page.rich.du === 'PT3M');
scriptingResult = { title: '記事', au: '著者', ogUrl: 'https://example.com/other' };
eq('YouTube 以外は og:url を見ない', (await PM.collectPageMeta(1, 'https://example.com/a')).title, '記事');
scriptingResult = {};

console.log('\n--- 回帰: 送信中に「気になり帳へ送る」を押しても失敗扱いにしない ---');
await resetAll({ ...structuredClone(knMeta), s: { ...knMeta.s, knOn: true, knUrl: 'https://example.com/kininari.html' } });
fakeBrowser.reset();
fakeBrowser.onCreate = () => new Promise(r => setTimeout(r, 150));   // 1件ずつ少し時間がかかる
const wA = S.makeItem({ u: 'https://wait.example/a', t: '先に送る' }, knMeta);
const wB = S.makeItem({ u: 'https://wait.example/b', t: 'あとから押す' }, knMeta);
await S.putItems([wA, wB]);
await KN.enqueueClip(wA.id);
const firstRun = KN.flushClips();                   // 即保存などで始まった送信
await new Promise(r => setTimeout(r, 20));
await KN.enqueueClip(wB.id);
eq('待たない呼び出しは busy で戻る', (await KN.flushClips({ force: true })).reason, 'busy');
const waited = await KN.flushClips({ force: true, wait: true });
await firstRun;
ok('待つ呼び出しは、送信中の回が終わってから結果を返す', waited.reason !== 'busy' && waited.left === 0);
ok('あとから押した項目も送れている', (await S.getAll()).items.find(i => i.id === wB.id).kn > 0);
fakeBrowser.reset();

console.log('\n--- 送信をオフにしたら再送の予約も止める ---');
await KN.enqueueClip(wA.id);
fakeBrowser.alarms.set(KN.RETRY_ALARM, { periodInMinutes: 5 });
await S.setMeta({ s: { knOn: false } });
eq('オフなら送らない', (await KN.flushClips({ retry: true })).reason, 'off');
ok('再送のアラームを止める', !fakeBrowser.alarms.has(KN.RETRY_ALARM));
await KN.removeFromQueue(wA.id);
await resetAll();

/* ---------- 1.9.0: Google ドライブ同期 ---------- */
// ドライブの API と chrome.identity を、メモリの中だけで再現する
const fakeDrive = {
  files: new Map(), seq: 0, token: 'tok1', tokenSeq: 1,
  downloads: 0, uploads: 0, calls: [], expireOnce: false, failWith: null, networkDown: false,
  authError: null, removedTokens: [], violations: [],
  reset() {
    this.files.clear(); this.seq = 0; this.token = 'tok1'; this.tokenSeq = 1; this.downloads = 0; this.uploads = 0;
    this.calls = []; this.expireOnce = false; this.failWith = null; this.networkDown = false; this.authError = null; this.removedTokens = [];
  },
  byName(n) { return [...this.files.values()].filter(f => f.name === n).sort((a, b) => a.created - b.created); },
  backups() { return [...this.files.values()].filter(f => f.name.startsWith('recall-backup-')).map(f => f.name).sort(); },
  add(name, content) { const id = 'f' + (++this.seq); this.files.set(id, { id, name, content, version: 1, created: this.seq }); return id; },
  remote() { const f = this.byName('recall-sync.json')[0]; return f ? JSON.parse(f.content) : null; },
  async fetch(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const res = (status, body, text) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => body, text: async () => (text !== undefined ? text : JSON.stringify(body))
    });
    if (u.hostname === 'accounts.google.com') return res(200, {});
    this.calls.push(`${method} ${u.pathname}`);
    if (this.networkDown) throw new TypeError('Failed to fetch');
    if (this.failWith) return res(this.failWith.status, { error: this.failWith.error });
    if (this.expireOnce) { this.expireOnce = false; return res(401, { error: { code: 401, message: 'Invalid Credentials' } }); }
    if ((init.headers || {}).Authorization !== 'Bearer ' + this.token) return res(401, { error: { code: 401, message: 'Invalid Credentials' } });
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      if (u.searchParams.get('spaces') !== 'appDataFolder') this.violations.push('appDataFolder 以外を探した');
      const q = u.searchParams.get('q') || '';
      let files = [...this.files.values()];
      const eqm = q.match(/name = '([^']+)'/), cm = q.match(/name contains '([^']+)'/);
      if (eqm) files = files.filter(f => f.name === eqm[1]);
      if (cm) files = files.filter(f => f.name.includes(cm[1]));
      files.sort((a, b) => a.created - b.created);
      return res(200, { files: files.map(f => ({ id: f.id, name: f.name, version: String(f.version), size: String(f.content.length) })) });
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(init.body);
      if (JSON.stringify(meta.parents) !== '["appDataFolder"]') this.violations.push('appDataFolder 以外に作った: ' + meta.name);
      const id = this.add(meta.name, '');
      return res(200, { id, version: '1' });
    }
    let m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === 'GET' && u.searchParams.get('alt') === 'media') {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return res(404, { error: { code: 404, message: 'File not found' } });
      this.downloads++;
      return res(200, null, f.content);
    }
    if (m && method === 'DELETE') { this.files.delete(decodeURIComponent(m[1])); return res(204, null, ''); }
    m = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return res(404, { error: { code: 404, message: 'File not found' } });
      f.content = init.body; f.version++; this.uploads++;
      return res(200, { id: f.id, version: String(f.version) });
    }
    return res(400, { error: { code: 400, message: 'unknown ' + method + ' ' + u.pathname } });
  }
};
globalThis.fetch = (url, init) => fakeDrive.fetch(url, init);
chrome.identity = {
  getAuthToken: async () => { if (fakeDrive.authError) throw new Error(fakeDrive.authError); return { token: fakeDrive.token }; },
  removeCachedAuthToken: async ({ token }) => {
    fakeDrive.removedTokens.push(token);
    if (token === fakeDrive.token) fakeDrive.token = 'tok' + (++fakeDrive.tokenSeq);
  }
};
const READY_MANIFEST = { version: '1.9.0', oauth2: { client_id: '1234-abcd.apps.googleusercontent.com', scopes: ['https://www.googleapis.com/auth/drive.appdata'] } };
chrome.runtime.getManifest = () => READY_MANIFEST;
const DR = await import(pathToFileURL(path.join(ROOT, 'drive.js')).href);

// もう1台（別の Chrome アカウントで、Chrome の同期を共有しない PC）
const syncAreaC = makeArea({ perItem: 8192, total: 102400, maxItems: 512 });
const localAreaC = makeArea({ perItem: Infinity, total: Infinity, maxItems: Infinity });
async function onPcC(fn) {
  const [l, sy] = [chrome.storage.local, chrome.storage.sync];
  chrome.storage.local = localAreaC; chrome.storage.sync = syncAreaC;
  try { return await fn(); } finally { chrome.storage.local = l; chrome.storage.sync = sy; }
}

console.log('\n--- Google ドライブ同期: 内容を合わせる（純粋な関数） ---');
const D0 = Date.now();
const dit = (id, up, extra = {}) => ({ ...S.makeItem({ id, u: `https://drive.example/${id}`, t: id, c: 'c0', ...extra }, meta), up });
let mg = DR.mergeSync({ items: [dit('a', 100), dit('b', 200)], tombs: {}, wipe: 0 }, { items: [dit('a', 150), dit('b', 150), dit('c', 100)], tombs: {}, wipe: 0 }, D0);
eq('同じ項目は更新の新しい方', mg.items.map(i => `${i.id}:${i.up}`).sort(), ['a:150', 'b:200', 'c:100']);
eq('端末に書くのはドライブの方が新しい分だけ', mg.put.map(i => i.id).sort(), ['a', 'c']);
mg = DR.mergeSync({ items: [dit('a', D0 - 1000)], tombs: {} }, { items: [], tombs: { a: D0 - 500 } }, D0);
eq('ドライブの削除の記録で消える', mg.items.length, 0);
mg = DR.mergeSync({ items: [dit('a', D0 - 100)], tombs: {} }, { items: [], tombs: { a: D0 - 500 } }, D0);
eq('消したあとで戻した（更新が新しい）項目は残る', mg.items.map(i => i.id), ['a']);
mg = DR.mergeSync({ items: [dit('a', D0 - 2000), dit('b', D0)], tombs: {} }, { items: [], tombs: {}, wipe: D0 - 1000 }, D0);
eq('「すべて削除」より前の内容は消える', mg.items.map(i => i.id), ['b']);
mg = DR.mergeSync({ items: [], tombs: { old: D0 - 61 * 86400000, keep: D0 - 1000 } }, null, D0);
eq('60日を過ぎた削除の記録は捨てる', Object.keys(mg.tombs), ['keep']);
mg = DR.mergeSync({ items: [dit('a', 1), dit('b', 1)], rich: { a: { si: '端末' } } }, { items: [], rich: { a: { si: 'ドライブ' }, b: { si: 'ドライブ' } } }, D0);
eq('サムネイル情報は端末を優先し、無い分だけドライブから', mg.rich, { a: { si: '端末' }, b: { si: 'ドライブ' } });
const snapA = DR.buildSnapshot({ items: [dit('b', 2), dit('a', 1)], rich: {}, tombs: { z: 5, y: 4 }, wipe: 0, meta }, 111);
const snapB = DR.buildSnapshot({ items: [dit('a', 1), dit('b', 2)], rich: {}, tombs: { y: 4, z: 5 }, wipe: 0, meta: { ...meta, s: { ...meta.s, hour: 3 } } }, 222);
eq('並び順・保存時刻・設定が違っても、中身が同じなら指紋は同じ', DR.fingerprint(snapA), DR.fingerprint(snapB));
ok('項目の更新時刻が変われば指紋も変わる', DR.fingerprint(snapA) !== DR.fingerprint(DR.buildSnapshot({ items: [dit('a', 1), dit('b', 3)], rich: {}, tombs: { y: 4, z: 5 }, wipe: 0, meta }, 1)));
ok('ドメインの記憶（閲覧したサイト）はドライブに載せない', !('dom' in snapA.meta));
eq('Recall のファイルでなければ読まない', [DR.parseSnapshot(null), DR.parseSnapshot({ items: [] }), DR.parseSnapshot({ app: 'x', items: [] })], [null, null, null]);
const parsed = DR.parseSnapshot({
  app: 'recall', items: [dit('ok1', 5), { ...dit('js', 5), u: 'javascript:alert(1)' }, dit('ok1', 9), { u: 'https://noid.example/' }],
  rich: { ok1: { th: 'javascript:x', si: 'サイト', bad: 1 }, js: { si: 'x' } },
  tombs: { t1: 10, t2: 'x' }, wipe: 3,
  meta: { cats: [{ id: 'cA', name: 'A', color: '#123456' }, { id: 'bad id"', name: 'x' }, { id: 'cB', name: 'B', color: 'red' }], s: { hour: 7 } }
});
eq('http(s) の項目だけ・ID の重複は先のものだけ読む', parsed.items.map(i => `${i.id}:${i.up}`), ['ok1:5']);
eq('サムネイル情報も確かめて読む', parsed.rich, { ok1: { si: 'サイト' } });
eq('削除の記録は数値だけ', parsed.tombs, { t1: 10 });
eq('カテゴリは不正な id を捨て、色を確かめる', parsed.meta.cats, [{ id: 'cA', name: 'A', color: '#123456' }, { id: 'cB', name: 'B', color: '#94a3b8' }]);
eq('項目が指しているのに無いカテゴリを拾う', DR.missingCats([{ c: 'c0' }, { c: 'cA' }, { c: 'cA' }, { c: 'gone' }], meta.cats, parsed.meta.cats).map(c => c.id), ['cA']);
eq('バックアップの名前は日付', DR.backupName(new Date(2026, 0, 5, 23).getTime()), 'recall-backup-2026-01-05.json');
eq('エラーの種類', ['The user did not approve access.', 'The user is not signed in.', "OAuth2 request failed: Service responded with error: 'bad client id: x'", 'OAuth2 not granted or revoked.', 'Failed to fetch', 'なにか'].map(m => DR.classifyError(new Error(m)).code),
  ['denied', 'signin', 'clientid', 'auth', 'offline', 'failed']);

console.log('\n--- Google ドライブ同期: 2台の PC ---');
await resetAll({ ...structuredClone(meta), s: { ...meta.s, sync: false, driveOn: true } });
fakeDrive.reset();
const dg1 = S.makeItem({ u: 'https://drive.example/1', t: 'A の項目1', c: 'c1' }, meta);
const dg2 = S.makeItem({ u: 'https://drive.example/2', t: 'A の項目2', c: 'c2' }, meta);
await S.putItems([dg1, dg2], { [dg1.id]: { si: 'サイトA' } });
let gr = await DR.syncDrive();
ok('PC A: 同期できる', gr.ok && gr.uploaded);
eq('ドライブに同期用のファイルが1つ', fakeDrive.byName(DR.DRIVE_FILE).length, 1);
eq('ドライブに2件', fakeDrive.remote().items.length, 2);
ok('サムネイル情報も載る', fakeDrive.remote().rich[dg1.id].si === 'サイトA');
eq('その日のバックアップが1つできる', fakeDrive.backups().length, 1);
eq('Chrome の同期はオフのまま（ドライブだけで運ぶ）', Object.keys(syncArea._mem).filter(k => k.startsWith('i:')).length, 0);
gr = await onPcB(() => DR.syncDrive());
const onB1 = (await onPcB(() => S.getAll()));
eq('PC B に2件届く', onB1.items.map(i => i.id).sort(), [dg1.id, dg2.id].sort());
eq('更新時刻は付け直さない', onB1.items.find(i => i.id === dg1.id).up, (await S.getAll()).items.find(i => i.id === dg1.id).up);
eq('サムネイル情報も届く', onB1.rich[dg1.id], { si: 'サイトA' });
eq('PC B の取り込み件数', gr.put, 2);
const dlBefore = fakeDrive.downloads, upBefore = fakeDrive.uploads;
gr = await DR.syncDrive();
ok('変わっていなければダウンロードもアップロードもしない', gr.ok && gr.skipped && fakeDrive.downloads === dlBefore && fakeDrive.uploads === upBefore);

await new Promise(r => setTimeout(r, 5));
await onPcB(async () => {
  const cur = (await S.getAll()).items.find(i => i.id === dg1.id);
  await S.putItems([{ ...cur, n: 'B で書いたメモ' }]);
  await DR.syncDrive();
});
await DR.syncDrive();
eq('B での編集が A に届く', (await S.getAll()).items.find(i => i.id === dg1.id).n, 'B で書いたメモ');

const dg2full = { ...(await S.getAll()).items.find(i => i.id === dg2.id) };
await new Promise(r => setTimeout(r, 5));
await S.removeItems([dg2.id]);
const tombG2 = (localArea._mem[S.LOCAL_TOMBS_KEY] || {})[dg2.id];
ok('A に削除の記録が残る（Chrome の同期がオフでも）', tombG2 > 0);
await DR.syncDrive();
eq('ドライブにも削除の記録が載る', fakeDrive.remote().tombs[dg2.id], tombG2);
await onPcB(() => DR.syncDrive());
ok('A で消すと B でも消える', !(await onPcB(() => S.getAll())).items.some(i => i.id === dg2.id));
eq('B の削除の記録は A と同じ時刻（「今」にしない）', (localAreaB._mem[S.LOCAL_TOMBS_KEY] || {})[dg2.id], tombG2);
await new Promise(r => setTimeout(r, 5));
await S.restoreItems([dg2full]);
ok('元に戻すと A の削除の記録から外れる', !((localArea._mem[S.LOCAL_TOMBS_KEY] || {})[dg2.id]));
await DR.syncDrive();
await onPcB(() => DR.syncDrive());
ok('元に戻すと B にも戻る', (await onPcB(() => S.getAll())).items.some(i => i.id === dg2.id));

console.log('\n--- Google ドライブ同期: 2台が同時に書いたとき ---');
const mainFile = fakeDrive.byName(DR.DRIVE_FILE)[0];
const stale = JSON.parse(mainFile.content);
stale.items = stale.items.filter(i => i.id !== dg1.id);           // ほかの PC が古い内容で上書きした
mainFile.content = JSON.stringify(stale); mainFile.version++;
await DR.syncDrive();
ok('上書きで消えた分も、持っている PC の次の同期で戻る', fakeDrive.remote().items.some(i => i.id === dg1.id));
ok('上書きされても A の項目は消えない', (await S.getAll()).items.some(i => i.id === dg1.id));
fakeDrive.add(DR.DRIVE_FILE, JSON.stringify(DR.buildSnapshot({ items: [dit('twin1', Date.now())], rich: {}, tombs: {}, wipe: 0, meta }, Date.now())));
await DR.syncDrive();
eq('同じ名前のファイルが2つできても1つにまとめる', fakeDrive.byName(DR.DRIVE_FILE).length, 1);
ok('もう一方の中身も取り込む', (await S.getAll()).items.some(i => i.id === 'twin1') && fakeDrive.remote().items.some(i => i.id === 'twin1'));

console.log('\n--- Google ドライブ同期: 認証とエラー ---');
fakeDrive.expireOnce = true;
gr = await DR.syncDrive({ force: true });
ok('トークンが切れていたら1回だけ取り直して続ける', gr.ok && fakeDrive.removedTokens.includes('tok1'));
fakeDrive.failWith = { status: 403, error: { code: 403, message: 'Google Drive API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } };
gr = await DR.syncDrive({ force: true });
eq('Drive API が無効なら知らせる', gr.reason, 'api');
eq('結果を控える（設定画面に出す）', (await DR.getDriveState()).err, 'api');
fakeDrive.failWith = { status: 503, error: { code: 503, message: 'backendError' } };
eq('混み合っているとき', (await DR.syncDrive({ force: true })).reason, 'busy');
fakeDrive.failWith = null;
fakeDrive.networkDown = true;
eq('ネットにつながらないとき', (await DR.syncDrive({ force: true })).reason, 'offline');
fakeDrive.networkDown = false;
gr = await DR.syncDrive({ force: true });
ok('つながったら戻る', gr.ok && (await DR.getDriveState()).err === '');
chrome.runtime.getManifest = () => ({ version: '1.9.0', oauth2: { client_id: 'YOUR_CLIENT_ID.apps.googleusercontent.com' } });
const callsBefore = fakeDrive.calls.length;
gr = await DR.syncDrive({ force: true });
ok('client_id が未設定なら通信しない', gr.reason === 'noclient' && fakeDrive.calls.length === callsBefore);
eq('つなぐボタンも同じ理由で止まる', (await DR.connectDrive()).reason, 'noclient');
chrome.runtime.getManifest = () => READY_MANIFEST;
fakeDrive.authError = 'The user did not approve access.';
eq('許可の画面で断られたとき', (await DR.connectDrive()).reason, 'denied');
fakeDrive.authError = null;
await S.setMeta({ s: { driveOn: false } });
eq('オフなら何もしない', (await DR.syncDrive()).reason, 'off');
gr = await DR.connectDrive();
ok('つなぐとオンになり、すぐに同期する', gr.ok && (await S.getMeta()).s.driveOn === true);

console.log('\n--- Google ドライブ同期: 入れ直した PC で戻す ---');
await S.setMeta({ cats: [...(await S.getMeta()).cats, { id: 'cDrive', name: 'ドライブ用', color: '#123456' }], s: { hour: 21 } });
await S.putItems([S.makeItem({ u: 'https://drive.example/cat', t: 'カテゴリつき', c: 'cDrive' }, meta)]);
await DR.syncDrive();
const totalA = (await S.getAll()).items.length;
await onPcC(async () => {
  await S.replaceMeta({ ...structuredClone(S.DEFAULT_META), s: { ...S.DEFAULT_META.s, driveOn: true } });
  const r = await DR.syncDrive();
  const c = await S.getAll();
  eq('入れ直した PC に全件が戻る', [r.ok, c.items.length], [true, totalA]);
  ok('カテゴリも戻る', c.meta.cats.some(x => x.id === 'cDrive' && x.name === 'ドライブ用'));
  eq('設定も戻る', c.meta.s.hour, 21);
  ok('ドライブ同期はオンのまま', c.meta.s.driveOn === true);
});

console.log('\n--- Google ドライブ同期: 日ごとのバックアップ ---');
for (let k = 1; k <= 9; k++) await DR.syncDrive({ force: true, now: Date.now() + k * 86400000 });
eq('バックアップは7日分だけ残す', fakeDrive.backups().length, DR.BACKUP_KEEP);
eq('残るのは新しい日', fakeDrive.backups()[DR.BACKUP_KEEP - 1], DR.backupName(Date.now() + 9 * 86400000));
const lb = await DR.listBackups();
ok('一覧は新しい順', lb.ok && lb.backups[0].name === DR.backupName(Date.now() + 9 * 86400000) && lb.backups.length === DR.BACKUP_KEEP);
const gb = await DR.getBackup(lb.backups[0].id);
eq('バックアップを読み込みと同じ形で返す', [gb.ok, gb.data.items.length, Array.isArray(gb.data.meta.cats)], [true, totalA, true]);

console.log('\n--- Google ドライブ同期: すべて削除 ---');
const backupsBefore = fakeDrive.backups().length;
eq('ドライブ同期中の「すべて削除」はほかの PC とも共有する', (await S.wipeAll()).scope, 'all');
ok('ドライブとのつながりは残す', (await S.getMeta()).s.driveOn === true);
await DR.syncDrive();
eq('ドライブからも消える', fakeDrive.remote().items.length, 0);
await onPcC(() => DR.syncDrive());
eq('Chrome の同期を共有しない PC でも、ドライブ経由で消える', (await onPcC(() => S.getAll())).items.length, 0);
eq('日ごとのバックアップは残る（空では上書きしない）', fakeDrive.backups().length, backupsBefore);
ok('「すべて削除」したあとは、ドライブからカテゴリや設定を戻さない', !(await S.getMeta()).cats.some(c => c.id === 'cDrive') && (await S.getMeta()).s.hour !== 21);
const restore = await DR.getBackup((await DR.listBackups()).backups[0].id);
ok('バックアップから戻せる中身がある', restore.ok && restore.data.items.length === totalA);

eq('ドライブのアプリ専用の領域だけを使う（ほかのファイルには触れない）', fakeDrive.violations, []);

console.log('\n--- Google ドライブ同期: やめる ---');
await DR.disconnectDrive();
ok('オフになる', (await S.getMeta()).s.driveOn === false);
ok('許可（トークン）を手放す', fakeDrive.removedTokens.length >= 2);
eq('控えも消す', await DR.getDriveState(), {});
await S.removeItems([]);
await resetAll();

console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);

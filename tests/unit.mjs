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
  return {
    _mem: mem,
    get: async (k) => {
      if (k === null || k === undefined) return { ...mem };
      const keys = [].concat(k);
      const out = {};
      for (const key of keys) if (key in mem) out[key] = mem[key];
      return out;
    },
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) {
        if (size(k, v) > limits.perItem) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      }
      const next = { ...mem, ...obj };
      let total = 0;
      for (const [k, v] of Object.entries(next)) total += size(k, v);
      if (total > limits.total) throw new Error('QUOTA_BYTES quota exceeded');
      if (Object.keys(next).length > limits.maxItems) throw new Error('MAX_ITEMS quota exceeded');
      Object.assign(mem, obj);
    },
    remove: async (keys) => { for (const k of [].concat(keys)) delete mem[k]; },
    clear: async () => { for (const k of Object.keys(mem)) delete mem[k]; },
    getBytesInUse: async () => Object.entries(mem).reduce((n, [k, v]) => n + size(k, v), 0)
  };
}
const syncArea = makeArea({ perItem: 8192, total: 102400, maxItems: 512 });
const localArea = makeArea({ perItem: Infinity, total: Infinity, maxItems: Infinity });
let scriptingResult = null;   // collectPageMeta のテスト用
/* 気になり帳への送信を試すための最小限のブラウザ側スタブ */
const fakeBrowser = {
  createFails: false,        // タブを開けない（送信先URLが不正など）
  hasPermission: true,       // 保存の確認ができるか
  savedFlag: true,           // 気になり帳が保存を終えたか
  tabs: new Map(),
  nextTabId: 1,
  created: [],
  alarms: new Map(),
  reset() { this.createFails = false; this.hasPermission = true; this.savedFlag = true; this.tabs.clear(); this.created = []; }
};
const sessionMem = {};
globalThis.chrome = {
  runtime: { getURL: (p) => 'chrome-extension://test' + p },
  storage: {
    sync: syncArea, local: localArea,
    session: {
      get: async (k) => (k in sessionMem ? { [k]: sessionMem[k] } : {}),
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
for (let i = 0; i < KN.MAX_TRIES + 2; i++) await KN.flushClips();
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

console.log('\n--- エラーメッセージ ---');
ok('同期容量の文言', S.describeQuotaError(new Error('QUOTA_BYTES quota exceeded')).includes('100KB'));
ok('件数超過の文言', S.describeQuotaError(new Error('MAX_ITEMS quota exceeded')).includes('件'));
ok('端末容量の文言', S.describeLocalError(new Error('QUOTA_BYTES quota exceeded')).includes('端末'));

console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);

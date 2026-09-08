/* ============================================================
   Recall — 静的チェック（依存パッケージなしで動く）
   ブラウザを起動しなくても分かる種類のバグを機械的に洗い出す。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));

const problems = [];
const notes = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);
const note = (file, msg) => notes.push(`${file}: ${msg}`);

/* ---------- 1. manifest ---------- */
const manifest = JSON.parse(read('manifest.json'));
const REQUIRED = ['manifest_version', 'name', 'version', 'icons', 'action', 'background'];
for (const k of REQUIRED) if (!(k in manifest)) fail('manifest.json', `必須項目 "${k}" がありません`);
if (manifest.manifest_version !== 3) fail('manifest.json', 'manifest_version は 3 である必要があります');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail('manifest.json', `version "${manifest.version}" の形式が不正です`);

// manifest から参照されるファイルの実在チェック
const refs = [
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  manifest.action && manifest.action.default_popup,
  manifest.background && manifest.background.service_worker,
  manifest.options_page
].filter(Boolean);
for (const f of refs) if (!exists(f)) fail('manifest.json', `参照しているファイルがありません: ${f}`);

// コマンドの重複ショートカット
const keys = new Map();
for (const [name, c] of Object.entries(manifest.commands || {})) {
  const k = c.suggested_key && c.suggested_key.default;
  if (!k) continue;
  if (keys.has(k)) fail('manifest.json', `ショートカット ${k} が ${keys.get(k)} と ${name} で重複しています`);
  keys.set(k, name);
}
if (manifest.omnibox && !manifest.omnibox.keyword) fail('manifest.json', 'omnibox の keyword が空です');

/* ---------- 対象ファイル ---------- */
const JS = ['store.js', 'pagemeta.js', 'changelog.js', 'background.js', 'popup.js', 'library.js'];
const HTML = ['popup.html', 'library.html'];
const src = Object.fromEntries([...JS, ...HTML].map(f => [f, read(f)]));

/* ---------- 2. import / export の整合 ---------- */
function exportedNames(code) {
  const out = new Set();
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) out.add(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) out.add(name);
    }
  }
  return out;
}
const storeExports = exportedNames(src['store.js']);
for (const f of JS) {
  for (const m of src[f].matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/([^'"]+)['"]/g)) {
    const from = m[2];
    if (!exists(from)) { fail(f, `import 元のファイルがありません: ${from}`); continue; }
    const avail = from === 'store.js' ? storeExports : exportedNames(read(from));
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!avail.has(name)) fail(f, `${from} から存在しない "${name}" を import しています`);
    }
  }
}

/* ---------- 3. 未定義の識別子（import 忘れ・タイポ） ---------- */
const GLOBALS = new Set(['chrome', 'document', 'window', 'console', 'location', 'localStorage', 'navigator',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'fetch', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'TextEncoder', 'TextDecoder', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Object',
  'Array', 'Set', 'Map', 'WeakMap', 'Promise', 'Error', 'TypeError', 'RegExp', 'Infinity', 'NaN', 'undefined', 'null',
  'true', 'false', 'structuredClone', 'crypto', 'globalThis', 'alert', 'confirm', 'prompt', 'isNaN', 'parseInt',
  'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'self', 'Intl', 'Symbol', 'BigInt', 'queueMicrotask',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView']);

for (const f of JS) {
  const code = src[f];
  const declared = new Set(GLOBALS);
  for (const m of code.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g))
    for (const raw of m[1].split(',')) { const n = raw.trim().split(/\s+as\s+/).pop().trim(); if (n) declared.add(n); }
  for (const m of code.matchAll(/(?:^|\s)(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g))
    for (const raw of m[1].split(',')) { const n = raw.trim().split(':').pop().trim(); if (/^[A-Za-z0-9_$]+$/.test(n)) declared.add(n); }
  // 関数・アロー関数・catch の引数も「定義済み」として扱う
  const paramLists = [
    ...[...code.matchAll(/function\s*[A-Za-z0-9_$]*\s*\(([^()]*)\)/g)].map(m => m[1]),
    ...[...code.matchAll(/\(([^()]*)\)\s*=>/g)].map(m => m[1]),
    ...[...code.matchAll(/(?:^|[^\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)].map(m => m[1]),
    ...[...code.matchAll(/catch\s*\(([^()]*)\)/g)].map(m => m[1]),
    ...[...code.matchAll(/for\s*\(\s*(?:const|let|var)\s+([^;)]*)[;)]/g)].map(m => m[1])
  ];
  for (const list of paramLists)
    for (const raw of String(list).split(',')) {
      const n = raw.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n)) declared.add(n);
    }
  // 呼び出されている関数名がどこにも定義されていないか
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // 正規表現リテラルを取り除く（中身が関数呼び出しに見えてしまうため）
    .replace(/(^|[=(,:!&|?+\-*%~{;[\n]\s*)\/(?![*\/])(?:\\.|\[(?:\\.|[^\]])*\]|[^\/\\\n])+\/[gimsuy]*/g, '$1RE');
  for (const m of stripped.matchAll(/(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = m[2];
    if (declared.has(name)) continue;
    if (/^(if|for|while|switch|catch|return|typeof|new|await|function|async|of|in|do|else|case|delete|void|yield|instanceof|throw)$/.test(name)) continue;
    fail(f, `定義されていない関数 "${name}()" を呼び出しています`);
  }
}

/* ---------- 4. DOM の id 参照 ---------- */
const pageOf = { 'popup.js': 'popup.html', 'library.js': 'library.html' };
for (const [js, html] of Object.entries(pageOf)) {
  const ids = new Set([...src[html].matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([
    ...[...src[js].matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map(m => m[1]),
    ...[...src[js].matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(m => m[1])
  ]);
  for (const id of used) if (!ids.has(id)) fail(js, `${html} に存在しない id "${id}" を参照しています`);
  for (const id of ids) if (!used.has(id) && !/^(app|editForm)$/.test(id)) note(html, `id "${id}" は JS から参照されていません`);
}

/* ---------- 5. HTML が参照するファイル ---------- */
for (const f of HTML) {
  for (const m of src[f].matchAll(/(?:src|href)="([^"#?:]+)"/g)) {
    if (!exists(m[1])) fail(f, `参照しているファイルがありません: ${m[1]}`);
  }
}

/* ---------- 6. innerHTML への文字列連結（HTML 注入の危険） ---------- */
for (const f of JS) {
  src[f].split('\n').forEach((line, i) => {
    if (/innerHTML\s*(\+)?=/.test(line) && /\$\{/.test(line)) {
      // 定数だけを埋め込んでいる行は除外
      const interpolations = [...line.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1].trim());
      const risky = interpolations.filter(x => !/^(svgIcon\(|ICONS\[|[A-Z_]+$)/.test(x));
      if (risky.length) fail(f, `${i + 1}行目: innerHTML に値を埋め込んでいます（${risky.join(', ')}）。textContent か createElement を使ってください`);
    }
  });
}

/* ---------- 7. 権限と API の対応 ---------- */
const perms = new Set(manifest.permissions || []);
const NEEDS = {
  'chrome.storage': 'storage', 'chrome.alarms': 'alarms', 'chrome.notifications': 'notifications',
  'chrome.contextMenus': 'contextMenus', 'chrome.tabs.query': 'tabs', '_favicon': 'favicon',
  'chrome.scripting': 'scripting'
};
const allJs = JS.map(f => src[f]).join('\n');
for (const [api, perm] of Object.entries(NEEDS)) {
  if (allJs.includes(api) && !perms.has(perm)) fail('manifest.json', `${api} を使っていますが permissions に "${perm}" がありません`);
}
if (allJs.includes('chrome.omnibox') && !manifest.omnibox) fail('manifest.json', 'chrome.omnibox を使っていますが omnibox の宣言がありません');
// executeScript は権限だけでは注入できない。activeTab かホスト権限のどちらかが要る
if (allJs.includes('chrome.scripting.executeScript')
  && !perms.has('activeTab')
  && !(manifest.host_permissions || []).length) {
  fail('manifest.json', 'chrome.scripting.executeScript を使っていますが activeTab も host_permissions もありません（ページを読めず、サムネイルが取れません）');
}
// chrome.permissions.request/contains は optional_host_permissions の宣言が要る
if (allJs.includes('chrome.permissions.request') && !(manifest.optional_host_permissions || []).length) {
  fail('manifest.json', 'chrome.permissions.request を使っていますが optional_host_permissions がありません');
}
for (const p of perms) {
  if (p === 'activeTab' || p === 'unlimitedStorage') continue;   // コードに現れない種類の権限
  const api = Object.entries(NEEDS).find(([, v]) => v === p);
  if (api && !allJs.includes(api[0])) note('manifest.json', `permissions の "${p}" は使われていない可能性があります`);
}

/* ---------- 8. Service Worker で使えない API ---------- */
const swCode = src['background.js'];
for (const bad of ['document.', 'window.', 'localStorage', 'alert(', 'confirm(', 'prompt(']) {
  if (swCode.includes(bad)) fail('background.js', `Service Worker では使えない ${bad} を参照しています`);
}
if (/setTimeout\(\s*[^)]*,\s*([6-9]\d{4,}|\d{6,})/.test(swCode)) {
  fail('background.js', 'Service Worker は約30秒で停止するため、長い setTimeout は発火しません。chrome.alarms を使ってください');
}

/* ---------- 9. finally での状態復帰漏れ ---------- */
const lib = src['library.js'];
for (const m of lib.matchAll(/muteReload\s*=\s*true/g)) {
  const after = lib.slice(m.index, m.index + 600);
  if (!/finally\s*\{[^}]*muteReload\s*=\s*false/.test(after) && !/muteReload\s*=\s*false/.test(after)) {
    fail('library.js', 'muteReload = true の後に false へ戻す処理が見つかりません（失敗すると画面が更新されなくなります）');
  }
}

/* ---------- 10. await 漏れ ---------- */
for (const f of JS) {
  src[f].split('\n').forEach((line, i) => {
    if (/^\s*(putItems?|removeItems|setMeta|replaceMeta)\(/.test(line)) {
      fail(f, `${i + 1}行目: 保存処理に await がありません`);
    }
  });
}

/* ---------- 11. バージョンと更新履歴の整合 ---------- */
const { loadChangelog, renderMarkdown, HEADING } = await import('./changelog-md.mjs');
const changelog = await loadChangelog();

if (!changelog.length) fail('changelog.js', '更新履歴が空です');
if (changelog[0].v !== manifest.version) {
  fail('changelog.js', `manifest.json の version（${manifest.version}）と更新履歴の先頭（${changelog[0].v}）が一致しません`);
}
const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
const seen = new Set();
changelog.forEach((rel, i) => {
  const where = `changelog.js の ${rel.v}`;
  if (!/^\d+\.\d+\.\d+$/.test(rel.v)) fail('changelog.js', `${rel.v} はバージョン番号の形式ではありません`);
  if (seen.has(rel.v)) fail('changelog.js', `${rel.v} が重複しています`);
  seen.add(rel.v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rel.date || '')) fail(where, '日付が YYYY-MM-DD の形式ではありません');
  if (!rel.title) fail(where, 'title がありません');
  const total = ['added', 'changed', 'fixed'].reduce((n, k) => n + ((rel[k] || []).length), 0);
  if (!total) fail(where, '追加・変更・修正のいずれも書かれていません');
  for (const k of ['added', 'changed', 'fixed']) {
    for (const line of rel[k] || []) {
      if (typeof line !== 'string' || !line.trim()) fail(where, `${k} に空の項目があります`);
    }
  }
  if (i > 0 && cmp(changelog[i - 1].v, rel.v) <= 0) {
    fail('changelog.js', `${changelog[i - 1].v} と ${rel.v} の並び順が新しい順になっていません`);
  }
});

const readme = read('README.md');
const at = readme.indexOf(HEADING);
if (at < 0) {
  fail('README.md', `「${HEADING}」の節がありません（npm run sync:readme で作れます）`);
} else if (readme.slice(at).trim() !== renderMarkdown(changelog).trim()) {
  fail('README.md', '変更履歴が changelog.js と一致しません（npm run sync:readme で更新してください）');
}

/* ---------- 結果 ---------- */
console.log('=== 静的チェック ===');
if (notes.length) { console.log('\n[参考]'); notes.forEach(n => console.log('  - ' + n)); }
if (problems.length) {
  console.log('\n[要修正]');
  problems.forEach(p => console.log('  ✗ ' + p));
  console.log(`\n${problems.length} 件の問題が見つかりました。`);
  process.exit(1);
}
console.log('\n問題は見つかりませんでした。');

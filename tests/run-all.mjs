/* ============================================================
   Recall — すべてのテストをまとめて実行する
     1. 静的チェック（依存なし・数百ミリ秒）
     2. ロジックのテスト（依存なし・数百ミリ秒）
     3. 実ブラウザでの動作テスト（playwright が入っていれば実行）
   ============================================================ */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit', env: process.env });
    p.on('close', (code) => resolve(code || 0));
  });
}

async function hasPlaywright() {
  for (const spec of ['playwright', '@playwright/test', 'playwright-core']) {
    try { await import(spec); return true; } catch { /* 次を試す */ }
  }
  return false;
}

const results = [];
console.log('\n########## 1/3 静的チェック ##########');
results.push(['静的チェック', await run('check.mjs')]);

console.log('\n########## 2/3 ロジックのテスト ##########');
results.push(['ロジック', await run('unit.mjs')]);

console.log('\n########## 3/3 実ブラウザでの動作テスト ##########');
if (await hasPlaywright()) {
  results.push(['ブラウザ', await run('e2e.mjs')]);
} else {
  console.log('playwright が未インストールのため省略します。');
  console.log('実行するには、このフォルダで:  npm install && npm run setup:browser');
  results.push(['ブラウザ', 'skip']);
}

console.log('\n########## 結果 ##########');
let bad = 0;
for (const [name, code] of results) {
  const label = code === 'skip' ? '－ 省略' : (code === 0 ? '✓ 成功' : '✗ 失敗');
  if (code !== 'skip' && code !== 0) bad++;
  console.log(`  ${label}  ${name}`);
}
process.exit(bad ? 1 : 0);

/* README の「変更履歴」節を changelog.js から作り直す:  npm run sync:readme */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChangelog, renderMarkdown, HEADING } from './changelog-md.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'README.md');
const md = fs.readFileSync(file, 'utf8');
const at = md.indexOf(HEADING);
const body = renderMarkdown(await loadChangelog());
const next = at < 0 ? md.replace(/\n*$/, '\n\n---\n\n') + body : md.slice(0, at) + body;
fs.writeFileSync(file, next);
console.log('README.md の変更履歴を更新しました。');

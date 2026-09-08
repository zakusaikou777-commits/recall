/* changelog.js から README の「変更履歴」節を組み立てる。
   README を手で書き換えると静的チェックが食い違いを検出する。 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HEADING = '## 変更履歴';

export async function loadChangelog() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'changelog.js')).href);
  return mod.CHANGELOG;
}

export function renderMarkdown(changelog) {
  const out = [HEADING, ''];
  for (const rel of changelog) {
    out.push(`### ${rel.v} — ${rel.title}（${rel.date}）`, '');
    for (const [key, label] of [['added', '追加'], ['changed', '変更'], ['fixed', '修正']]) {
      const list = rel[key];
      if (!list || !list.length) continue;
      out.push(`**${label}**`, '');
      for (const line of list) out.push(`- ${line}`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

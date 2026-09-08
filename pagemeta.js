/* ============================================================
   Recall — ページからサムネイル等を読み取る
   画像そのものは保存せず「画像の URL」だけを持つので、容量をほとんど使わない。
   activeTab の権限で、ユーザーが保存操作をした瞬間だけページを読む。
   ============================================================ */
import { youtubeId, clip } from './store.js';

export const RICH_LIMITS = { th: 400, si: 40, au: 60, du: 12 };

/**
 * ページ内で実行される関数（外の変数を参照しないこと）。
 * テストから直接呼べるよう export しているが、実際は executeScript で注入される。
 */
export function readPageMeta() {
  const attr = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return '';
    return el.getAttribute('content') || el.getAttribute('href') || el.textContent || '';
  };
  const abs = (u) => { try { return u ? new URL(u, location.href).href : ''; } catch { return ''; } };

  const image = attr('meta[property="og:image:secure_url"]')
    || attr('meta[property="og:image"]')
    || attr('meta[name="twitter:image"]')
    || attr('meta[name="twitter:image:src"]')
    || attr('link[rel="image_src"]');

  let author = attr('meta[name="author"]')
    || attr('meta[property="article:author"]')
    || attr('meta[name="twitter:creator"]');

  // YouTube のチャンネル名
  const channel = document.querySelector('span[itemprop="author"] link[itemprop="name"]')
    || document.querySelector('link[itemprop="name"]');
  if (channel && channel.getAttribute('content')) author = channel.getAttribute('content');

  let duration = attr('meta[itemprop="duration"]');
  if (!duration) {
    const t = document.querySelector('.ytp-time-duration');
    if (t && t.textContent) duration = t.textContent.trim();
  }

  return {
    th: abs(image),
    si: attr('meta[property="og:site_name"]'),
    au: author,
    du: duration,
    title: attr('meta[property="og:title"]') || document.title || '',
    desc: attr('meta[property="og:description"]') || attr('meta[name="description"]') || ''
  };
}

/**
 * タブからページ情報を取り出す。取れなくても保存は続けられるよう、必ず値を返す。
 * @returns {{rich: object, title: string, desc: string}}
 */
export async function collectPageMeta(tabId, url) {
  const empty = { rich: {}, title: '', desc: '' };
  const vid = youtubeId(url || '');
  try {
    if (!chrome.scripting || tabId == null) return empty;
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: readPageMeta });
    const r = (res && res.result) || {};
    const rich = {};
    // YouTube のサムネイルは ID から導けるので保存しない（容量の節約）
    if (!vid && r.th && /^https?:\/\//i.test(r.th)) rich.th = clip(r.th, RICH_LIMITS.th);
    if (r.si) rich.si = clip(r.si, RICH_LIMITS.si);
    if (r.au) rich.au = clip(r.au, RICH_LIMITS.au);
    if (r.du) rich.du = clip(r.du, RICH_LIMITS.du);
    return { rich, title: r.title || '', desc: r.desc || '' };
  } catch {
    return empty;   // 権限がない・読み取れないページでは何もしない
  }
}

/* テスト用ページから pagemeta.js の抽出関数を呼べるようにする
   （拡張機能ページはインラインスクリプトを実行できないため外部ファイルにしている） */
import { readPageMeta } from '../pagemeta.js';
window.__readPageMeta = readPageMeta;
window.__ready = true;

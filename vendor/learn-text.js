// learn 的逐字稿／Markdown 渲染與 AI 摘要解析——JS 版（給 OM App 用）。
// 規則的正本在 learn 的 Python：src/om_learn/renderer.py、src/om_learn/summary.py。這個檔逐行移植，
// learn 的 tests/test_omapp_js_parity.py 拿同一批輸入比對兩邊輸出必須完全相同；learn 改規則時那個測試會先紅。
//
// 依賴：markdown-it（OM App 站內託管的 vendor/markdown-it.min.js，15.0.3）。
// 用法（瀏覽器）：<script src="vendor/markdown-it.min.js"></script><script src="learn-text.js"></script> → window.LearnText
// 用法（node）：const LearnText = require('./learn-text.js')(require('markdown-it'))
// 輸出是 HTML 字串：跟其他 Markdown 一樣，交給 DOMPurify 之後才放進頁面。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.LearnText = factory(root.markdownit);
})(typeof self !== 'undefined' ? self : this, function (markdownit) {
  'use strict';

  // ── Python 標準函式的對應 ─────────────────────────────
  // html.escape(s, quote=True)
  function escapeHtml(s, quote) {
    s = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (quote !== false) s = s.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    return s;
  }
  // urllib.parse.quote(s, safe='')：只留 A-Z a-z 0-9 _ . - ~
  function pyQuote(s) {
    return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  // str.splitlines()：認得 \r\n、\r、\n 與其他 Unicode 換行；結尾的換行不產生空行
  const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');
  function splitlines(text) {
    if (text === '') return [];
    const parts = text.split(LINE_BREAK);
    if (LINE_BREAK.test(text.slice(-1)) || text.endsWith('\r\n')) parts.pop();
    return parts;
  }
  // str.lstrip(' ')
  const lstripSpaces = (s) => s.replace(/^ +/, '');

  // ── renderer.py ────────────────────────────────────────
  const TIMESTAMP_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] (.*)$/;
  const GAP_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] 【約 (\d+) 秒未能轉錄：(.+?)】$/;
  const HEADING_RE = /^#{1,6} /;
  const MD_ESCAPE_RE = /([\\[\]*_`!])/g;
  const BLOCKQUOTE_PREFIX_RE = /^(\s*(?:>\s?)+)/;
  const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])(?:\s|$)/;
  const FENCE_RE = /^(```|~~~)/;

  const seconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

  let OPTIONS = {
    // ![[圖]] 的網址。learn 是 /attachments/<名稱>；OM App 可以換成自己的（例如資料包裡的路徑）
    attachmentUrl: (name) => '/attachments/' + pyQuote(name),
    // (src, alt) → 一段 HTML；不設就照 learn 輸出 <img src alt loading="lazy">
    renderImage: null,
  };

  function inlineSource(text) {
    const pieces = [];
    let cursor = 0;
    const pattern = /!\[\[([^\]]+)\]\]|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      pieces.push(escapeHtml(text.slice(cursor, m.index)));
      if (m[1] !== undefined) {
        // Markdown 圖片語法（不是 <img>）：單獨一行的 <img> 會開出 HTML 區塊，把後面的文字全當原始文字
        const name = m[1];
        const alt = escapeHtml(name, false).replace(MD_ESCAPE_RE, '\\$1');
        pieces.push(`![${alt}](${OPTIONS.attachmentUrl(name)})`);
      } else {
        const label = m[3] !== undefined ? m[3] : m[2];
        pieces.push(`<span class="wikilink">${escapeHtml(label)}</span>`);
      }
      cursor = m.index + m[0].length;
    }
    pieces.push(escapeHtml(text.slice(cursor)));
    return pieces.join('');
  }

  // 保留行首的引用記號 >（整行跳脫會把 > 變成 &gt;，引用區塊就出不來）
  function blockSource(line) {
    const prefix = BLOCKQUOTE_PREFIX_RE.exec(line);
    if (!prefix) return inlineSource(line);
    return prefix[1] + inlineSource(line.slice(prefix[0].length));
  }

  let MD = null;
  function md() {
    if (!MD) {
      // breaks：單一換行照樣換行（2026-11-04，同 renderer.py）
      MD = markdownit('commonmark', { html: true, linkify: false, typographer: false, breaks: true });
      const image = MD.renderer.rules.image;
      MD.renderer.rules.image = function (tokens, idx, options, env, self) {
        if (OPTIONS.renderImage) {   // App 自己決定圖片怎麼輸出（例：om: 網址 → data-om，之後從資料包載入）
          return OPTIONS.renderImage(tokens[idx].attrGet('src'), self.renderInlineAsText(tokens[idx].children, options, env));
        }
        tokens[idx].attrSet('loading', 'lazy');
        return image(tokens, idx, options, env, self);
      };
    }
    return MD;
  }
  const renderInline = (text) => md().renderInline(inlineSource(text));
  const rstrip = (s) => s.replace(/\s+$/, '');

  // read_body：從 body_start_line（1 起算）開始的 [行號, 內容]
  function readBody(text, bodyStartLine) {
    const lines = splitlines(text);
    const start = Math.max(bodyStartLine - 1, 0);
    const out = [];
    for (let lineNo = start + 1; lineNo <= lines.length; lineNo++) out.push([lineNo, lines[lineNo - 1]]);
    return out;
  }

  // 逐字稿：時間戳行 → 可點的區塊（data-t、id t<秒>），續行歸同一區塊，標題結束區塊
  function renderTranscript(text, bodyStartLine) {
    const blocks = [];
    const segments = [];
    let currentT = null;
    const occurrence = new Map();
    for (const [lineNo, line] of readBody(text, bodyStartLine)) {
      const stamp = TIMESTAMP_RE.exec(line);
      if (stamp) {
        const tS = seconds(stamp[1], stamp[2], stamp[3]);
        currentT = tS;
        occurrence.set(tS, (occurrence.get(tS) || 0) + 1);
        const n = occurrence.get(tS);
        const elementId = n === 1 ? `t${tS}` : `t${tS}-${n}`;
        const gap = GAP_RE.test(line);
        const classes = gap ? 'seg gap' : 'seg';
        const label = `${stamp[1]}:${stamp[2]}:${stamp[3]}`;
        blocks.push(`<p class="${classes}" data-t="${tS}" data-line="${lineNo}" id="${elementId}">`
          + `<button class="ts" type="button" data-seek="${tS}">${label}</button> `
          + `${renderInline(stamp[4])}</p>`);
        segments.push({ t_s: tS, line_no: lineNo, is_gap: gap });
        continue;
      }
      if (HEADING_RE.test(line)) {
        currentT = null;
        blocks.push(rstrip(md().render(blockSource(line))));
        continue;
      }
      if (!line) continue;
      if (currentT !== null) {
        blocks.push(`<p class="seg-cont" data-t="${currentT}" data-line="${lineNo}">${renderInline(line)}</p>`);
      } else {
        blocks.push(rstrip(md().render(blockSource(line))));
      }
    }
    return { html: blocks.join('\n'), segments };
  }

  // Notion 子區塊的縮排還原（只影響顯示）：父層是清單才保留相對縮排，否則拉回父層；圍欄程式碼整塊平移
  function unindentToggleChildren(lines) {
    const out = [];
    const stack = []; // [原縮排, 顯示縮排, 是否清單項目]
    let fenceShift = null;
    for (const line of lines) {
      if (fenceShift !== null) {
        out.push(line.slice(Math.min(fenceShift, line.length - lstripSpaces(line).length)));
        if (FENCE_RE.test(lstripSpaces(line))) fenceShift = null;
        continue;
      }
      if (!line.trim()) { out.push(line); continue; }
      const stripped = lstripSpaces(line);
      const indent = line.length - stripped.length;
      while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
      let rendered;
      if (!stack.length) rendered = indent >= 4 ? 0 : indent;
      else if (stack[stack.length - 1][2]) rendered = stack[stack.length - 1][1] + (indent - stack[stack.length - 1][0]);
      else rendered = stack[stack.length - 1][1];
      if (FENCE_RE.test(stripped)) fenceShift = indent - rendered;
      stack.push([indent, rendered, LIST_ITEM_RE.test(stripped)]);
      out.push(' '.repeat(rendered) + stripped);
    }
    return out;
  }

  function renderMarkdownLines(lines) {
    return md().render(unindentToggleChildren(lines).map(blockSource).join('\n'));
  }
  function renderMarkdown(text, bodyStartLine) {
    return renderMarkdownLines(readBody(text, bodyStartLine || 1).map(([, line]) => line));
  }

  // ── summary.py ─────────────────────────────────────────
  const SECTION_RE = /^【(.+?)】\s*(.*)$/;
  const ITEM_RE = /^[・•]\s*(?:\[(\d\d):(\d\d):(\d\d)\]\s*)?(.*)$/;
  const HEADING_PREFIX = '#### AI 摘要';
  const pyStrip = (s) => s.replace(/^\s+|\s+$/g, '');

  // lines＝整個檔（0 起算陣列）；startLine／endLine＝索引的 1 起算、含兩端
  function parseSummary(lines, startLine, endLine) {
    const heading = startLine >= 2 ? (lines[startLine - 2] ?? '') : '';
    let note = heading.startsWith(HEADING_PREFIX) ? pyStrip(heading.slice(HEADING_PREFIX.length)) : '';
    if (note.startsWith('（') && note.endsWith('）')) note = note.slice(1, -1);
    const sections = [];
    for (const line of lines.slice(Math.max(startLine - 1, 0), endLine)) {
      const text = pyStrip(line);
      if (!text) continue;
      const section = SECTION_RE.exec(text);
      if (section) { sections.push({ name: section[1], text: pyStrip(section[2]), items: [] }); continue; }
      if (!sections.length) sections.push({ name: '', text: '', items: [] });
      const last = sections[sections.length - 1];
      const item = ITEM_RE.exec(text);
      if (item) {
        const tS = item[1] !== undefined ? seconds(item[1], item[2], item[3]) : null;
        last.items.push({ t_s: tS, text: pyStrip(item[4]) });
      } else if (last.items.length) {
        last.items[last.items.length - 1].text += text;   // 上一條重點折行
      } else {
        last.text = pyStrip(last.text + text);
      }
    }
    const gist = (sections.find((s) => s.name === '主旨') || { text: '' }).text;
    return { gist, sections, note };
  }
  // 方便用：整個檔的文字＋索引的 lesson.summary 範圍
  function summaryOf(text, range) {
    return range ? parseSummary(splitlines(text), range.start_line, range.end_line) : null;
  }

  return {
    renderTranscript, renderMarkdown, renderMarkdownLines, parseSummary, summaryOf,
    unindentToggleChildren, splitlines,
    configure(opts) { OPTIONS = Object.assign({}, OPTIONS, opts || {}); },
  };
});

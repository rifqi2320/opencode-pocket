/**
 * Lightweight, dependency-free Markdown parser for assistant output.
 * Pure (no React Native imports) so it can be unit-tested with `node --test`.
 * Supports the subset agents actually emit: paragraphs, ATX headings, emphasis, inline code,
 * fenced code, bullet/ordered lists (nested), blockquotes, links/autolinks, rules and pipe tables.
 * Anything it does not understand degrades to plain paragraph text; it never throws.
 */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export type ListItem = { children: Block[]; checked?: boolean };
export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'blockquote'; children: Block[] }
  | { type: 'table'; align: Array<'left' | 'center' | 'right' | undefined>; header: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^( *)([-*+])\s+(.*)$/;
const ORDERED = /^( *)(\d{1,9})([.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const MAX_DEPTH = 6;

export function parseMarkdown(source: string): Block[] {
  try { return parseBlocks(String(source ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), 0); }
  catch { return [{ type: 'paragraph', children: [{ type: 'text', text: String(source ?? '') }] }]; }
}

function isListStart(line: string) { return BULLET.test(line) || ORDERED.test(line); }
function isBlockStart(line: string) { return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || isListStart(line); }
function indentOf(line: string) { return line.length - line.trimStart().length; }

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) { i++; continue; }

    const fence = depth < MAX_DEPTH ? line.match(FENCE) : null;
    if (fence) {
      const marker = fence[1] ?? '```'; const body: string[] = []; const baseIndent = indentOf(line);
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i] ?? '')) {
        const raw = lines[i] ?? ''; body.push(raw.slice(Math.min(baseIndent, indentOf(raw)))); i++;
      }
      i++; // closing fence (or EOF)
      blocks.push({ type: 'code', ...(fence[2] ? { lang: fence[2] } : {}), text: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) { blocks.push({ type: 'heading', level: (heading[1] ?? '#').length, children: parseInline(heading[2] ?? '') }); i++; continue; }

    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const inner: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() && (QUOTE.test(lines[i] ?? '') || !isBlockStart(lines[i] ?? ''))) {
        const m = (lines[i] ?? '').match(QUOTE); inner.push(m ? m[1] ?? '' : (lines[i] ?? '').trim()); i++;
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(inner, depth + 1) });
      continue;
    }

    if (isListStart(line) && depth < MAX_DEPTH) {
      const result = parseList(lines, i, depth);
      blocks.push(result.block); i = result.next; continue;
    }

    // Pipe table: header row, separator row, body rows.
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const header = splitRow(line); const sep = splitRow(lines[i + 1] ?? '');
      if (header.length >= 1 && sep.length === header.length) {
        const align = sep.map(cell => { const c = cell.trim(); return c.startsWith(':') && c.endsWith(':') ? 'center' as const : c.endsWith(':') ? 'right' as const : c.startsWith(':') ? 'left' as const : undefined; });
        i += 2; const rows: Inline[][][] = [];
        while (i < lines.length && (lines[i] ?? '').trim() && (lines[i] ?? '').includes('|')) {
          const cells = splitRow(lines[i] ?? ''); rows.push(header.map((_, index) => parseInline(cells[index] ?? ''))); i++;
        }
        blocks.push({ type: 'table', align, header: header.map(parseInline), rows });
        continue;
      }
    }

    // Paragraph: consecutive lines until a blank line or another block starts.
    const para: string[] = [line.trim()]; i++;
    while (i < lines.length && (lines[i] ?? '').trim() && !isBlockStart(lines[i] ?? '') && !((lines[i] ?? '').includes('|') && TABLE_SEP.test(lines[i + 1] ?? ''))) { para.push((lines[i] ?? '').trim()); i++; }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }
  return blocks;
}

function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } {
  const first = lines[start] ?? '';
  const ordered = !BULLET.test(first);
  const baseIndent = indentOf(first);
  const startNumber = ordered ? Number((first.match(ORDERED) ?? [])[2] ?? 1) : 1;
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = ordered ? line.match(ORDERED) : line.match(BULLET);
    if (!m || indentOf(line) !== baseIndent) break;
    const content = (ordered ? m[4] : m[3]) ?? '';
    const contentIndent = line.length - content.length;
    const body: string[] = [content]; i++;
    let blankRun = 0;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (!next.trim()) { blankRun++; i++; continue; }
      const ind = indentOf(next);
      if (ind > baseIndent) { for (let b = 0; b < blankRun; b++) body.push(''); blankRun = 0; body.push(next.slice(Math.min(ind, contentIndent))); i++; continue; }
      // Lazy continuation (unindented text right after the item, no blank line).
      if (blankRun === 0 && ind === baseIndent && !isBlockStart(next)) { body.push(next.trim()); i++; continue; }
      break;
    }
    if (blankRun > 0) {
      // Blank lines end the list unless another sibling item follows.
      const next = lines[i] ?? '';
      const sibling = ordered ? ORDERED.test(next) : BULLET.test(next);
      if (!(sibling && indentOf(next) === baseIndent)) { items.push(makeItem(body, depth)); break; }
    }
    items.push(makeItem(body, depth));
  }
  return { block: { type: 'list', ordered, start: startNumber, items }, next: i };
}

function makeItem(body: string[], depth: number): ListItem {
  const task = (body[0] ?? '').match(/^\[([ xX])\]\s+(.*)$/);
  if (task) body[0] = task[2] ?? '';
  const children = parseBlocks(body, depth + 1);
  return task ? { children, checked: task[1] !== ' ' } : { children };
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = []; let current = ''; let inCode = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') { current += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
export function safeHref(href: string): string | undefined { const value = href.trim(); return SAFE_URL.test(value) ? value : undefined; }

export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => { if (buffer) { out.push({ type: 'text', text: buffer }); buffer = ''; } };
  const text = source;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    const rest = text.slice(i);

    if (ch === '\\' && i + 1 < text.length && /[\\`*_{}\[\]()#+\-.!|~>]/.test(text[i + 1] ?? '')) { buffer += text[i + 1]; i += 2; continue; }
    if (ch === '\n') { flush(); out.push({ type: 'br' }); i++; continue; }

    if (ch === '`') {
      const ticks = (rest.match(/^`+/) ?? ['`'])[0];
      const close = text.indexOf(ticks, i + ticks.length);
      if (close > -1) {
        flush();
        let code = text.slice(i + ticks.length, close);
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push({ type: 'code', text: code.replace(/\n/g, ' ') }); i = close + ticks.length; continue;
      }
      buffer += ticks; i += ticks.length; continue;
    }

    if (depth < MAX_DEPTH && ch === '[') {
      const link = matchLink(text, i);
      if (link) { flush(); const href = safeHref(link.href); const children = parseInline(link.label, depth + 1); out.push(href ? { type: 'link', href, children } : { type: 'text', text: link.label }); i = link.end; continue; }
    }

    const auto = rest.match(/^<?(https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?/);
    if (auto && (i === 0 || /[\s(\[*_~]/.test(text[i - 1] ?? ''))) {
      let url = auto[1] ?? '';
      const trailing = url.match(/[.,;:!?'"]+$/); if (trailing && !rest.startsWith('<')) url = url.slice(0, -trailing[0].length);
      flush(); out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
      i += rest.startsWith('<') && auto[0].endsWith('>') ? auto[0].length : url.length; continue;
    }

    if (depth < MAX_DEPTH && (ch === '*' || ch === '_' || ch === '~')) {
      const emphasis = matchEmphasis(text, i);
      if (emphasis) { flush(); out.push({ type: emphasis.type, children: parseInline(emphasis.inner, depth + 1) }); i = emphasis.end; continue; }
    }

    buffer += ch; i++;
  }
  flush();
  return out;
}

function matchLink(text: string, start: number): { label: string; href: string; end: number } | undefined {
  let depth = 0; let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0 || text[i + 1] !== '(') return undefined;
  const close = text.indexOf(')', i + 2);
  if (close < 0) return undefined;
  const target = text.slice(i + 2, close).trim().replace(/^<|>$/g, '').split(/\s+"/)[0] ?? '';
  return { label: text.slice(start + 1, i), href: target, end: close + 1 };
}

function matchEmphasis(text: string, start: number): { type: 'strong' | 'em' | 'del'; inner: string; end: number } | undefined {
  const ch = text[start] ?? '';
  const candidates: Array<[string, 'strong' | 'em' | 'del']> = ch === '~' ? [['~~', 'del']] : [[ch.repeat(3), 'strong'], [ch.repeat(2), 'strong'], [ch, 'em']];
  for (const [marker, type] of candidates) {
    if (!text.startsWith(marker, start)) continue;
    const after = text[start + marker.length] ?? '';
    if (!after || /\s/.test(after)) continue;
    // Intraword underscores (snake_case) are literal.
    if (ch === '_' && /[A-Za-z0-9]/.test(text[start - 1] ?? '')) return undefined;
    let search = start + marker.length;
    while (search < text.length) {
      const close = text.indexOf(marker, search);
      if (close < 0) break;
      const before = text[close - 1] ?? '';
      const next = text[close + marker.length] ?? '';
      const intraword = ch === '_' && /[A-Za-z0-9]/.test(next);
      // Single `*` must not match the first half of a `**` closer.
      const partOfLonger = marker.length === 1 && text[close + 1] === ch && text[close - 1] !== ch;
      if (close > start + marker.length && !/\s/.test(before) && !intraword && !partOfLonger) {
        const inner = text.slice(start + marker.length, close);
        if (marker.length === 3) return { type, inner: `${ch}${inner}${ch}`, end: close + 3 };
        return { type, inner, end: close + marker.length };
      }
      search = close + 1;
    }
  }
  return undefined;
}

/** Flattens inline nodes to plain text (accessibility labels, previews). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map(node => node.type === 'text' || node.type === 'code' ? node.text : node.type === 'br' ? '\n' : inlineText(node.children)).join('');
}

// mend — a patch tool for every AI edit format (SPEC.md v1).
//
// Run as `node main.ts [options] [PATCH]` with the working directory as the
// root of a tree of text files. It reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
// each edit names at the first of three matching tiers, and writes every
// change or none, printing what it changed or why it failed.
//
// Node 22, standard library only.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type FormatName = (typeof FORMAT_NAMES)[number];

/** A patch that cannot be read in its format; `line` is the 1-based patch line to report. */
class ParseFault extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

/** One edit that cannot be applied; reported as `error: <code> <path>`. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed each, no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A text file as lines plus its own line break and whether it ends with one. */
interface TextFile {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function readTextFile(text: string): TextFile {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function writeTextFile(f: TextFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: `now` holds changed paths (null: deleted). */
class Tree {
  private readonly seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; next: string }> = [];

  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit: apply it to the tree, or throw EditFail. A failed edit changes nothing. */
type Edit = (tree: Tree) => void;

// ---------- matching (SPEC.md section 5) ----------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at which `old` occurs in `lines` from `from`, at `tier`. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  const want = old.map((l) => normLine(l, tier));
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(lines[i + j], tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs at least once from `from`, with its positions. */
function firstTier(lines: string[], old: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, old, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** One line of a replacement: a context line mirrors a line of the old block. */
interface NewLine {
  text: string;
  ctx: boolean;
  oldIndex: number;
}

/**
 * Replace the `old.length` lines at `at` with `next`. A context line is written
 * as the file's own matched line; at tier 2 every other line is re-indented
 * from the old block's first-line indent to the file's.
 */
function applyReplacement(file: TextFile, at: number, old: string[], next: NewLine[], tier: number): void {
  const f = leadingWs(file.lines[at] ?? '');
  const p = leadingWs(old[0] ?? '');
  const out: string[] = next.map((nl) => {
    if (nl.ctx) return file.lines[at + nl.oldIndex];
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
      return t;
    }
    return nl.text;
  });
  file.lines.splice(at, old.length, ...out);
}

/** One body line of a unified hunk or a V4A chunk. `noNL` is set by a `\` line after it. */
interface BodyEntry {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNL: boolean;
}

/** Split a hunk/chunk body into its old lines and its new lines (with context flags). */
function splitBody(body: BodyEntry[]): { old: string[]; next: NewLine[] } {
  const old: string[] = [];
  const next: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      next.push({ text: b.text, ctx: true, oldIndex: old.length });
      old.push(b.text);
    } else if (b.kind === 'del') {
      old.push(b.text);
    } else {
      next.push({ text: b.text, ctx: false, oldIndex: -1 });
    }
  }
  return { old, next };
}

// ---------- unified diffs (SPEC.md section 6) ----------

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, spaces removed, `/dev/null` is no file. */
function diffPath(raw: string): string | null {
  let p = raw.split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk header at `lines[i]` and the body after it; trailing empty context lines are not part of it. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]);
  if (m === null) throw new ParseFault(i + 1);
  const body: BodyEntry[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const ln = lines[j];
    if (ln.startsWith('diff --git ')) break;
    if (ln.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (ln === '' || ln.startsWith(' ') || ln.startsWith('-') || ln.startsWith('+')) {
      body.push({
        kind: ln === '' ? 'ctx' : ln[0] === ' ' ? 'ctx' : ln[0] === '-' ? 'del' : 'add',
        text: ln === '' ? '' : ln.slice(1),
        noNL: false,
      });
      j++;
    } else if (ln.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1].noNL = true;
      j++;
    } else {
      break;
    }
  }
  // Empty lines at the end of a body are not part of it — but a `\` line is
  // itself a body line, so an empty line a `\` line follows is not at the
  // end of the body and stays (SPEC.md section 6).
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === 'ctx' && last.text === '' && !last.noNL) body.pop();
    else break;
  }
  return { hunk: { a: Number(m[1]), body }, next: j };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxOrAddNoNL(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k--) {
    const b = hunk.body[k];
    if (b.kind === 'ctx' || b.kind === 'add') return b.noNL;
  }
  return false;
}

/** Whether a `\` line follows the last `+` line of any of the hunks. */
function lastAddNoNL(hunks: Hunk[]): boolean {
  for (let s = hunks.length - 1; s >= 0; s--) {
    for (let k = hunks[s].body.length - 1; k >= 0; k--) {
      const b = hunks[s].body[k];
      if (b.kind === 'add') return b.noNL;
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file; `d` tracks the line drift so far. */
function applyHunks(file: TextFile, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const { old, next } = splitBody(hunk.body);
    if (old.length === 0) {
      const at = Math.min(Math.max(hunk.a + d, 0), file.lines.length);
      const wasEnd = at === file.lines.length;
      file.lines.splice(at, 0, ...next.map((n) => n.text));
      if (wasEnd) file.finalBreak = !lastCtxOrAddNoNL(hunk);
      d += next.length;
      continue;
    }
    const found = firstTier(file.lines, old, strict, 0);
    if (found === null) throw new EditFail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const runsToEnd = best + old.length === file.lines.length;
    applyReplacement(file, best, old, next, found.tier);
    if (runsToEnd) file.finalBreak = !lastCtxOrAddNoNL(hunk);
    d += next.length - old.length;
  }
}

/** One unified section as one edit. */
function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld !== undefined ? sec.diffOld : null;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew !== undefined ? sec.diffNew : null;
  return (tree: Tree) => {
    const isCreate = sec.create || oldPath === null;
    const isDelete = !isCreate && (sec.remove || newPath === null);
    if (isCreate) {
      if (newPath === null) return;
      if (!isSafePath(newPath)) throw new EditFail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new EditFail('exists', newPath);
      const added: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'add') added.push(b.text);
      const finalBreak = added.length === 0 ? false : !lastAddNoNL(sec.hunks);
      tree.now.set(newPath, added.length === 0 ? '' : added.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (!isSafePath(oldPath)) throw new EditFail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new EditFail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!isSafePath(oldPath)) throw new EditFail('unsafe', oldPath);
      if (!isSafePath(newPath)) throw new EditFail('unsafe', newPath);
      const content = tree.get(oldPath);
      if (content === null) throw new EditFail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditFail('exists', newPath);
      const file = readTextFile(content);
      applyHunks(file, sec.hunks, strict, oldPath);
      tree.now.set(newPath, writeTextFile(file));
      tree.now.set(oldPath, null);
      tree.moves.push({ old: oldPath, next: newPath });
      return;
    }
    if (!isSafePath(oldPath)) throw new EditFail('unsafe', oldPath);
    const content = tree.get(oldPath);
    if (content === null) throw new EditFail('missing', oldPath);
    const file = readTextFile(content);
    applyHunks(file, sec.hunks, strict, oldPath);
    tree.now.set(oldPath, writeTextFile(file));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(ln);
      if (m === null) throw new ParseFault(i + 1);
      cur = { pairOld: undefined, pairNew: undefined, renameFrom: undefined, renameTo: undefined, diffOld: m[1], diffNew: m[2], create: false, remove: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (ln.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = diffPath(ln.slice(4));
        cur.pairNew = diffPath(lines[i + 1].slice(4));
        i += 2;
        continue;
      }
      cur = { pairOld: diffPath(ln.slice(4)), pairNew: diffPath(lines[i + 1].slice(4)), renameFrom: undefined, renameTo: undefined, diffOld: undefined, diffNew: undefined, create: false, remove: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (ln.startsWith('@@')) throw new ParseFault(i + 1);
      i++;
      continue;
    }
    if (inHeader) {
      if (ln.startsWith('--- ')) throw new ParseFault(i + 2);
      if (ln.startsWith('+++ ')) {
        cur.pairNew = diffPath(ln.slice(4));
        i++;
        continue;
      }
      if (ln.startsWith('rename from ')) {
        cur.renameFrom = ln.slice(12).trim();
        i++;
        continue;
      }
      if (ln.startsWith('rename to ')) {
        cur.renameTo = ln.slice(10).trim();
        i++;
        continue;
      }
      if (ln.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (ln.startsWith('deleted file mode')) {
        cur.remove = true;
        i++;
        continue;
      }
      if (ln.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        inHeader = false;
        i = h.next;
        continue;
      }
      i++;
      continue;
    }
    if (ln.startsWith('@@')) {
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new EditFail('missing', path);
    const file = readTextFile(content);
    const found = firstTier(file.lines, oldLines, strict, 0);
    if (found === null) throw new EditFail('no-match', path);
    if (found.occ.length > 1) throw new EditFail('ambiguous', path);
    const next: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oldIndex: -1 }));
    applyReplacement(file, found.occ[0], oldLines, next, found.tier);
    tree.now.set(path, writeTextFile(file));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchNo);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new ParseFault(searchNo);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseFault(searchNo);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface V4aChunk {
  anchor: string | null;
  body: BodyEntry[];
  eof: boolean;
}

/** A section's lines up to the next section start, with trailing blank lines removed. */
function sectionSpan(lines: string[], start: number, last: number): { items: Array<{ text: string; no: number }>; next: number } {
  const items: Array<{ text: string; no: number }> = [];
  let j = start;
  while (j < last) {
    const ln = lines[j];
    if (ln.startsWith('*** Add File: ') || ln.startsWith('*** Delete File: ') || ln.startsWith('*** Update File: ')) break;
    items.push({ text: ln, no: j + 1 });
    j++;
  }
  while (items.length > 0 && isBlank(items[items.length - 1].text)) items.pop();
  return { items, next: j };
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i], tier) === normLine(anchor, tier)) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    // SPEC.md section 10: every path an edit names is checked for safety
    // before anything else about it — both paths first, then existence.
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const file = readTextFile(content);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const ai = findAnchor(file.lines, chunk.anchor, cursor, strict);
        if (ai === -1) throw new EditFail('no-match', path);
        cursor = ai + 1;
      }
      const { old, next } = splitBody(chunk.body);
      if (old.length === 0) {
        const at = chunk.eof ? file.lines.length : cursor;
        file.lines.splice(at, 0, ...next.map((n) => n.text));
        cursor = at + next.length;
        continue;
      }
      const found = firstTier(file.lines, old, strict, cursor);
      if (found === null) throw new EditFail('no-match', path);
      let pos = found.occ[0];
      if (chunk.eof) {
        const endPos = file.lines.length - old.length;
        if (endPos < cursor || !found.occ.includes(endPos)) throw new EditFail('no-match', path);
        pos = endPos;
      }
      applyReplacement(file, pos, old, next, found.tier);
      cursor = pos + next.length;
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, writeTextFile(file));
      tree.now.set(path, null);
      tree.moves.push({ old: path, next: moveTo });
    } else {
      tree.now.set(path, writeTextFile(file));
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last])) last--;
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const ln = lines[i];
    if (ln.startsWith('*** Add File: ')) {
      const path = ln.slice(14).trim();
      const { items, next } = sectionSpan(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const { text, no } of items) {
        if (text.startsWith('+')) fileLines.push(text.slice(1));
        else if (text === '') fileLines.push('');
        else throw new ParseFault(no);
      }
      edits.push((tree: Tree) => {
        if (!isSafePath(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = next;
      continue;
    }
    if (ln.startsWith('*** Delete File: ')) {
      const path = ln.slice(17).trim();
      const { items, next } = sectionSpan(lines, i + 1, last);
      if (items.length > 0) throw new ParseFault(items[0].no);
      edits.push((tree: Tree) => {
        if (!isSafePath(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) === null) throw new EditFail('missing', path);
        tree.now.set(path, null);
      });
      i = next;
      continue;
    }
    if (ln.startsWith('*** Update File: ')) {
      const path = ln.slice(17).trim();
      const updateNo = i + 1;
      let m = i + 1;
      while (m < last && isBlank(lines[m])) m++;
      let moveTo: string | null = null;
      if (m < last && lines[m].startsWith('*** Move to: ')) {
        moveTo = lines[m].slice(13).trim();
        m++;
      }
      const { items, next } = sectionSpan(lines, m, last);
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (const { text, no } of items) {
        if (text.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          continue;
        }
        if (text === '*** End of File') {
          if (cur === null) throw new ParseFault(no);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          continue;
        }
        if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          const kind = text === '' ? 'ctx' : text[0] === ' ' ? 'ctx' : text[0] === '-' ? 'del' : 'add';
          cur.body.push({ kind, text: text === '' ? '' : text.slice(1), noNL: false });
          continue;
        }
        throw new ParseFault(no);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateNo);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = next;
      continue;
    }
    throw new ParseFault(i + 1);
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------- JSON edits (SPEC.md section 9) ----------

function isCRLF(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/** One JSON edit object, or null when it is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree: Tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: Tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const crlf = isCRLF(before);
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      const nw = norm(newStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count++;
        if (at === -1) at = k;
      }
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const out = t.slice(0, at) + nw + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree: Tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const file = readTextFile(before);
      if (line < 0 || line > file.lines.length) throw new EditFail('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.now.set(p, writeTextFile(file));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

// ---------- format detection (SPEC.md section 4) ----------

function detectFormat(lines: string[]): FormatName | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- invocation, output, atomicity (SPEC.md sections 1, 2, 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: FormatName | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && (FORMAT_NAMES as readonly string[]).includes(a.slice(9))) {
        format = a.slice(9) as FormatName;
        continue;
      }
      if (a === '--check' && !check) {
        check = true;
        continue;
      }
      if (a === '--strict' && !strict) {
        strict = true;
        continue;
      }
      return { code: 2, out: ['error: usage'] };
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind: FormatName | null = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? parseJson(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: Array<{ code: string; path: string }> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push({ code: e.code, path: e.path });
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const suppressed = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const wasNew = tree.original(mv.next);
    const nowNew = tree.get(mv.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.next, line: `R ${mv.old} -> ${mv.next}` });
      suppressed.add(mv.old);
      suppressed.add(mv.next);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

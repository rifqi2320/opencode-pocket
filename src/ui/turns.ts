/**
 * Projects raw OpenCode v2 session messages into conversation turns.
 *
 * OpenCode v2 stores one `assistant` message per model step (finish = "tool-calls" | "stop" | …),
 * each with `content` parts of type `text` | `reasoning` | `tool`. A user prompt is followed by N
 * assistant steps and usually an `idle` marker with the outcome. We fold those into:
 *   user turn  → the prompt text
 *   assistant  → collapsed process steps (reasoning, tools, narration, context notes) + final answer
 * Pure and defensive: unknown shapes fall back to readable text and never throw.
 */
import type { PocketStep, PocketToolStep, PocketTurn } from './types';

type Raw = Record<string, unknown>;
const MAX_DETAIL = 4000;

const isObj = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const times = (value: unknown) => isObj(value) ? { created: num(value.created), ran: num(value.ran), streamed: num(value.streamed), completed: num(value.completed) } : typeof value === 'number' ? { created: value, ran: undefined, streamed: undefined, completed: undefined } : { created: undefined, ran: undefined, streamed: undefined, completed: undefined };

export function truncate(text: string, max = MAX_DETAIL): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}
/** Tool output keeps its head and tail (summaries and exit status live at the end). */
export function truncateMiddle(text: string, max = MAX_DETAIL): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.25); const tail = max - head;
  return { text: `${text.slice(0, head)}\n… ${(text.length - max).toLocaleString('en-US')} characters omitted …\n${text.slice(-tail)}`, truncated: true };
}

function kindOf(message: Raw): string {
  const type = str(message.type); const role = str(message.role);
  if (type && type !== 'message') return type;
  if (role) return role;
  if (typeof message.agent === 'string' || Array.isArray(message.content)) return 'assistant';
  return 'unknown';
}

function sortKey(message: Raw, index: number): [number, string, number] {
  return [times(message.time).created ?? Number.NaN, str(message.id) ?? '', index];
}

/** Sorts chronologically when timestamps exist, preserving input order otherwise. */
function chronological(messages: Raw[]): Raw[] {
  const keyed = messages.map((message, index) => ({ message, key: sortKey(message, index) }));
  const allTimed = keyed.every(item => !Number.isNaN(item.key[0]));
  if (!allTimed) return messages;
  return keyed.sort((a, b) => a.key[0] - b.key[0] || (a.key[1] < b.key[1] ? -1 : a.key[1] > b.key[1] ? 1 : 0) || a.key[2] - b.key[2]).map(item => item.message);
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10)}s`.replace(/^0s$/, '<1s');
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60); const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60); return `${hours}h ${minutes % 60}m`;
}

function clock(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return undefined; }
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path;
}
function firstLine(text: string, max = 120): string {
  const line = text.split('\n').find(value => value.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}
function errorText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (isObj(value)) {
    const message = str(value.message) ?? (isObj(value.data) ? str(value.data.message) : undefined);
    const type = str(value.type) ?? str(value.name);
    return message ?? type ?? pretty(value);
  }
  return String(value);
}

/** One-line, human description of a tool call from its input. */
export function toolTitle(name: string, input: unknown, metadata?: unknown): string {
  if (typeof input === 'string') return firstLine(input) || name;
  const i = isObj(input) ? input : {};
  const pick = (...keys: string[]) => { for (const key of keys) { const v = str(i[key]); if (v && v.trim()) return v; } return undefined; };
  const lower = name.toLowerCase();
  if (lower === 'shell' || lower === 'bash') return firstLine(pick('description') ?? pick('command', 'cmd') ?? '') || name;
  if (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'list' || lower === 'ls') { const path = pick('path', 'filePath', 'file'); return path ? shortPath(path) : name; }
  if (lower === 'grep' || lower === 'glob' || lower === 'search') { const pattern = pick('pattern', 'query'); const path = pick('path', 'include'); return pattern ? `${pattern}${path ? `  in ${shortPath(path)}` : ''}` : name; }
  if (lower === 'patch' || lower === 'apply_patch') {
    const files = isObj(metadata) && Array.isArray(metadata.files) ? metadata.files.map(file => isObj(file) ? str(file.file) ?? str(file.path) : str(file)).filter((f): f is string => !!f) : [];
    const fromText = files.length ? files : [...(pick('patchText', 'patch') ?? '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m => m[1] ?? '').filter(Boolean);
    if (fromText.length) return fromText.length === 1 ? shortPath(fromText[0] ?? '') : `${fromText.length} files · ${shortPath(fromText[0] ?? '')}`;
    return name;
  }
  if (lower === 'webfetch' || lower === 'fetch') return pick('url') ?? name;
  if (lower === 'task' || lower === 'agent') return firstLine(pick('description', 'prompt') ?? '') || name;
  if (lower === 'skill') return pick('id', 'name') ?? name;
  if (lower === 'execute') return firstLine(pick('code') ?? '') || name;
  if (lower === 'question') { const q = Array.isArray(i.questions) ? i.questions[0] : undefined; const text = isObj(q) ? str(q.question) ?? str(q.header) : str(q); return text ? firstLine(text) : name; }
  if (lower.startsWith('todo')) { const todos = Array.isArray(i.todos) ? i.todos.length : undefined; return todos !== undefined ? `${todos} todo${todos === 1 ? '' : 's'}` : name; }
  const any = pick('description', 'title', 'command', 'path', 'url', 'query', 'pattern', 'prompt');
  if (any) return firstLine(any);
  const firstString = Object.values(i).find((v): v is string => typeof v === 'string' && !!v.trim());
  return firstString ? firstLine(firstString) : name;
}

function toolInputText(name: string, input: unknown): string {
  if (typeof input === 'string') return input;
  if (!isObj(input)) return input === undefined ? '' : pretty(input);
  const lower = name.toLowerCase();
  if ((lower === 'shell' || lower === 'bash') && typeof input.command === 'string') return `$ ${input.command}${typeof input.workdir === 'string' ? `\n# in ${input.workdir}` : ''}`;
  if ((lower === 'patch' || lower === 'apply_patch') && typeof input.patchText === 'string') return input.patchText;
  if (lower === 'execute' && typeof input.code === 'string') return input.code;
  // Flat inputs read better as `key: value` lines than as JSON.
  const entries = Object.entries(input);
  if (entries.length && entries.every(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)) && entries.every(([, value]) => typeof value !== 'string' || !value.includes('\n'))) return entries.map(([key, value]) => `${key}: ${String(value)}`).join('\n');
  return pretty(input);
}

function toolOutputText(state: Raw): string {
  const content = state.content ?? state.output;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => {
    if (typeof item === 'string') return item;
    if (!isObj(item)) return '';
    if (typeof item.text === 'string') return item.text;
    if (item.type === 'file') return `[file] ${str(item.name) ?? str(item.uri) ?? ''} ${str(item.mime) ?? ''}`.trim();
    return pretty(item);
  }).filter(Boolean).join('\n');
  return '';
}

function toolStep(part: Raw, fallbackId: string): PocketToolStep {
  const name = str(part.name) ?? str(part.tool) ?? 'tool';
  const state = isObj(part.state) ? part.state : {};
  const rawStatus = str(state.status) ?? str(part.status) ?? 'pending';
  const status: PocketToolStep['status'] = rawStatus === 'completed' || rawStatus === 'error' || rawStatus === 'running' ? rawStatus : rawStatus === 'streaming' ? 'running' : 'pending';
  const t = times(part.time ?? state.time);
  const start = t.ran ?? t.created;
  const durationMs = t.completed !== undefined && start !== undefined ? t.completed - start : undefined;
  const input = truncate(toolInputText(name, state.input));
  const output = truncateMiddle(toolOutputText(state));
  const error = errorText(state.error);
  const exit = isObj(state.metadata) ? num(state.metadata.exit) : undefined;
  return {
    kind: 'tool', id: str(part.id) ?? fallbackId, name, title: str(state.title) ?? str(part.title) ?? toolTitle(name, state.input, state.metadata), status,
    ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
    ...(input.text ? { input: input.text, inputTruncated: input.truncated } : {}),
    ...(output.text ? { output: output.text, outputTruncated: output.truncated } : {}),
    ...(error ? { error } : {}), ...(exit !== undefined && exit !== 0 ? { exitCode: exit } : {}),
  };
}

type Builder = { turn: Extract<PocketTurn, { kind: 'assistant' }>; parts: PocketStep[]; start?: number; end?: number; lastFinish?: string | null };

export function buildTurns(input: unknown): PocketTurn[] {
  const messages = chronological((Array.isArray(input) ? input : []).filter(isObj));
  const turns: PocketTurn[] = [];
  let current: Builder | undefined;

  const open = (id: string, at?: number): Builder => {
    if (current) return current;
    current = { turn: { kind: 'assistant', id: `turn:${id}`, steps: [], running: true }, parts: [], ...(at !== undefined ? { start: at } : {}) };
    turns.push(current.turn);
    return current;
  };
  const close = (outcome?: string) => {
    if (!current) return;
    finish(current, outcome);
    current = undefined;
  };

  messages.forEach((message, index) => {
    try {
      const id = str(message.id) ?? `m${index}`;
      const kind = kindOf(message);
      const t = times(message.time);
      if (kind === 'user') {
        close();
        const files = Array.isArray(message.files) ? message.files.map(file => isObj(file) ? str(file.name) ?? str(file.description) ?? str(file.mime) : undefined).filter((name): name is string => !!name) : [];
        const text = str(message.text) ?? plainContent(message.content) ?? '';
        const time = clock(t.created);
        turns.push({ kind: 'user', id, text, ...(time ? { time } : {}), ...(files.length ? { files } : {}) });
        return;
      }
      if (kind === 'idle') {
        const outcome = str(message.outcome);
        if (current) close(outcome);
        else {
          // Idle after a closed turn: attach the outcome to the latest assistant turn.
          const last = [...turns].reverse().find((turn): turn is Extract<PocketTurn, { kind: 'assistant' }> => turn.kind === 'assistant');
          if (last && outcome && outcome !== 'succeeded' && !last.outcome) last.outcome = outcome;
        }
        return;
      }
      const b = open(id, t.created);
      if (t.created !== undefined && (b.start === undefined || t.created < b.start)) b.start = t.created;
      const end = t.completed ?? t.streamed ?? t.created;
      if (end !== undefined && (b.end === undefined || end > b.end)) b.end = end;

      if (kind === 'assistant' || Array.isArray(message.content)) {
        if (!b.turn.agent && typeof message.agent === 'string') b.turn.agent = message.agent;
        const content = Array.isArray(message.content) ? message.content : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : typeof message.text === 'string' ? [{ type: 'text', text: message.text }] : [];
        content.forEach((part, partIndex) => {
          const pid = `${id}:${partIndex}`;
          if (typeof part === 'string') { if (part.trim()) b.parts.push({ kind: 'text', id: pid, text: part }); return; }
          if (!isObj(part)) return;
          const type = str(part.type);
          if (type === 'text') { const text = str(part.text) ?? ''; if (text.trim()) b.parts.push({ kind: 'text', id: pid, text }); return; }
          if (type === 'reasoning') {
            const text = (str(part.text) ?? '').trim(); const rt = times(part.time);
            const durationMs = rt.completed !== undefined && rt.created !== undefined ? rt.completed - rt.created : undefined;
            b.parts.push({ kind: 'reasoning', id: pid, text, ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}) });
            return;
          }
          if (type === 'tool' || type === 'tool-call' || typeof part.tool === 'string') { b.parts.push(toolStep(part, pid)); return; }
          const fallback = str(part.text) ?? str(part.summary);
          b.parts.push({ kind: 'note', id: pid, label: type ?? 'part', ...(fallback ? { text: fallback } : {}) });
        });
        const error = errorText(message.error);
        if (error) {
          const aborted = isObj(message.error) && message.error.type === 'aborted';
          if (aborted) b.turn.outcome = b.turn.outcome ?? 'interrupted'; else b.turn.error = error;
        }
        if (isObj(message.retry)) b.parts.push({ kind: 'note', id: `${id}:retry`, label: `Retry ${num(message.retry.attempt) ?? ''}`.trim(), ...(errorText(message.retry.error) ? { text: errorText(message.retry.error) } : {}) });
        b.lastFinish = typeof message.finish === 'string' ? message.finish : null;
        return;
      }
      if (kind === 'shell') {
        const output = isObj(message.output) ? str(message.output.output) ?? '' : '';
        const status = str(message.status);
        b.parts.push(toolStep({ id, name: 'shell', time: message.time, state: { status: status === 'running' ? 'running' : status === 'exited' && (num(message.exit) ?? 0) === 0 ? 'completed' : status ? 'error' : 'completed', input: { command: str(message.command) ?? '' }, content: output ? [{ type: 'text', text: output }] : [], ...(status && status !== 'exited' && status !== 'running' ? { error: `Shell ${status}` } : {}), metadata: { exit: num(message.exit) } } }, id));
        return;
      }
      if (kind === 'compaction') {
        const status = str(message.status);
        b.parts.push({ kind: 'note', id, label: status === 'failed' ? 'Compaction failed' : status === 'running' ? 'Compacting context' : 'Context compacted', ...(str(message.summary) ? { text: str(message.summary) } : errorText(message.error) ? { text: errorText(message.error) } : {}) });
        return;
      }
      if (kind === 'agent-switched') { b.parts.push({ kind: 'note', id, label: `Agent → ${str(message.agent) ?? 'unknown'}` }); return; }
      if (kind === 'model-switched') { const model = isObj(message.model) ? str(message.model.id) ?? str(message.model.modelID) : str(message.model); b.parts.push({ kind: 'note', id, label: `Model → ${model ?? 'unknown'}` }); return; }
      if (kind === 'location-switched') { const loc = isObj(message.location) ? str(message.location.directory) : undefined; b.parts.push({ kind: 'note', id, label: `Location → ${loc ? shortPath(loc) : 'changed'}` }); return; }
      if (kind === 'system' || kind === 'synthetic' || kind === 'skill') {
        const label = kind === 'skill' ? `Skill · ${str(message.name) ?? str(message.skill) ?? ''}` : `${kind === 'system' ? 'System' : 'Context'}${str(message.description) ? ` · ${firstLine(str(message.description) ?? '', 80)}` : ''}`;
        const text = str(message.text);
        b.parts.push({ kind: 'note', id, label, ...(text ? { text: truncate(text).text } : {}) });
        return;
      }
      if (kind === 'error') { b.turn.error = errorText(message.error) ?? str(message.text) ?? 'Error'; return; }
      // Unknown message: keep it readable rather than dropping it.
      const text = str(message.text) ?? plainContent(message.content);
      b.parts.push({ kind: 'note', id, label: kind === 'unknown' ? 'Activity' : kind, ...(text ? { text: truncate(text).text } : {}) });
    } catch { /* A single malformed message must never break the timeline. */ }
  });
  if (current) finish(current, undefined, true);
  return turns;
}

function plainContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) { const text = content.map(part => typeof part === 'string' ? part : isObj(part) && (part.type === undefined || part.type === 'text') ? str(part.text) ?? '' : '').filter(Boolean).join('\n'); return text || undefined; }
  return undefined;
}

function finish(b: Builder, outcome?: string, stillOpen = false) {
  const { turn, parts } = b;
  // The answer is the trailing run of text after the last tool call; earlier text is narration.
  let lastTool = -1;
  parts.forEach((part, index) => { if (part.kind === 'tool') lastTool = index; });
  const tail = parts.slice(lastTool + 1);
  const answer = tail.filter((part): part is Extract<PocketStep, { kind: 'text' }> => part.kind === 'text');
  const anyRunningTool = parts.some(part => part.kind === 'tool' && (part.status === 'running' || part.status === 'pending'));
  turn.steps = [...parts.slice(0, lastTool + 1), ...tail.filter(part => part.kind !== 'text')];
  if (answer.length) turn.finalText = answer.map(part => part.text.trim()).join('\n\n');
  if (outcome && outcome !== 'succeeded') turn.outcome = outcome;
  // Without an idle marker the turn may still be streaming: a pending tool, or a last step that
  // ended in tool calls (or has not finished) means more work follows. The UI also requires the
  // session itself to be running before showing a live indicator.
  const unfinished = anyRunningTool || b.lastFinish === null || b.lastFinish === 'tool-calls';
  turn.running = stillOpen && !outcome && !turn.outcome && (unfinished || b.lastFinish === undefined);
  if (b.start !== undefined && b.end !== undefined && b.end >= b.start) turn.durationMs = b.end - b.start;
  const time = clock(b.start); if (time) turn.time = time;
}

export function summarizeSteps(steps: PocketStep[]): { tools: number; failed: number; running?: PocketToolStep; label: string } {
  const tools = steps.filter((step): step is PocketToolStep => step.kind === 'tool');
  const failed = tools.filter(step => step.status === 'error').length;
  const running = [...tools].reverse().find(step => step.status === 'running' || step.status === 'pending');
  const bits = [`${steps.length} step${steps.length === 1 ? '' : 's'}`];
  if (tools.length) bits.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}`);
  if (failed) bits.push(`${failed} failed`);
  return { tools: tools.length, failed, ...(running ? { running } : {}), label: bits.join(' · ') };
}

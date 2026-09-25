import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineText, parseInline, parseMarkdown, safeHref } from './markdownParser.ts';
import { buildTurns, formatDuration, summarizeSteps, toolTitle, truncate, truncateMiddle } from './turns.ts';

test('markdown: headings, paragraphs and emphasis', () => {
  const blocks = parseMarkdown('# Title\n\nSome **bold**, *em*, ~~gone~~ and `code`.\nsecond line');
  assert.equal(blocks[0].type, 'heading'); assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].type, 'paragraph');
  const types = blocks[1].children.map(node => node.type);
  assert.deepEqual(types, ['text', 'strong', 'text', 'em', 'text', 'del', 'text', 'code', 'text', 'br', 'text']);
  assert.equal(inlineText(blocks[1].children), 'Some bold, em, gone and code.\nsecond line');
});

test('markdown: snake_case and lone asterisks stay literal', () => {
  assert.deepEqual(parseInline('call my_func_name now'), [{ type: 'text', text: 'call my_func_name now' }]);
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }]);
  assert.deepEqual(parseInline('\\*not em\\*'), [{ type: 'text', text: '*not em*' }]);
});

test('markdown: fenced code keeps content verbatim with language', () => {
  const [code, after] = parseMarkdown('```ts\nconst a = **1**;\n  indented\n```\nafter');
  assert.deepEqual(code, { type: 'code', lang: 'ts', text: 'const a = **1**;\n  indented' });
  assert.equal(after.type, 'paragraph');
  // Unterminated fence consumes to the end instead of throwing.
  assert.equal(parseMarkdown('```\nopen').at(0).text, 'open');
});

test('markdown: bullet, ordered and nested lists', () => {
  const [list, ordered] = parseMarkdown('- one\n- two\n  - nested **b**\n- three\n\n3. c\n4. d');
  assert.equal(list.type, 'list'); assert.equal(list.ordered, false); assert.equal(list.items.length, 3);
  const nested = list.items[1].children[1];
  assert.equal(nested.type, 'list'); assert.equal(nested.items.length, 1);
  assert.equal(ordered.ordered, true); assert.equal(ordered.start, 3); assert.equal(ordered.items.length, 2);
  const [tasks] = parseMarkdown('- [x] done\n- [ ] todo');
  assert.deepEqual(tasks.items.map(item => item.checked), [true, false]);
});

test('markdown: blockquote, rule and table', () => {
  const blocks = parseMarkdown('> quoted *text*\n> more\n\n---\n\n| a | b |\n|---|:-:|\n| 1 | `x\\|y` |\n| 2 |');
  assert.equal(blocks[0].type, 'blockquote'); assert.equal(blocks[0].children[0].type, 'paragraph');
  assert.equal(blocks[1].type, 'hr');
  const table = blocks[2];
  assert.equal(table.type, 'table'); assert.deepEqual(table.align, [undefined, 'center']);
  assert.equal(table.rows.length, 2); assert.equal(inlineText(table.rows[0][1]), 'x|y'); assert.deepEqual(table.rows[1][1], []);
});

test('markdown: links and autolinks only allow safe schemes', () => {
  const nodes = parseInline('see [docs](https://example.com/a) or https://x.dev/p. and [bad](javascript:alert(1))');
  const links = nodes.filter(node => node.type === 'link');
  assert.deepEqual(links.map(link => link.href), ['https://example.com/a', 'https://x.dev/p']);
  assert.equal(safeHref('javascript:alert(1)'), undefined);
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
});

test('markdown: never throws on odd input', () => {
  for (const input of ['', '***', '[', '`', '| a |\n|---|', '#', '>', '- ', '1.', '\t- tab', '**unclosed', undefined, null]) assert.ok(Array.isArray(parseMarkdown(input)));
});

const at = s => 1_000_000 + s * 1000;
const v2 = [
  { id: 'msg_1', type: 'user', text: 'Fix the tests', files: [{ name: 'log.txt', mime: 'text/plain' }], time: { created: at(0) } },
  { id: 'msg_2', type: 'assistant', agent: 'build', finish: 'tool-calls', time: { created: at(1), completed: at(4) }, content: [
    { type: 'reasoning', text: '**Checking tests**', time: { created: at(1), completed: at(2) } },
    { type: 'text', text: 'Running the suite first.' },
    { type: 'tool', id: 'call_1', name: 'shell', time: { created: at(2), ran: at(2), completed: at(4) }, state: { status: 'completed', input: { command: 'npm test', workdir: '/w' }, content: [{ type: 'text', text: '1 failing' }, { type: 'text', text: 'Command exited with code 1.' }], metadata: { exit: 1 } } },
  ] },
  { id: 'msg_3', type: 'assistant', agent: 'build', finish: 'stop', time: { created: at(5), completed: at(9) }, content: [
    { type: 'tool', id: 'call_2', name: 'read', time: { created: at(5) }, state: { status: 'error', input: { path: '/a/b/c/d/e.ts' }, error: { type: 'tool.execution', message: 'File not found' } } },
    { type: 'text', text: '## Fixed\n\nAll green.' },
  ] },
  { id: 'msg_4', type: 'idle', outcome: 'succeeded', time: { created: at(10) } },
];

test('turns: v2 steps fold into one assistant turn with a final answer', () => {
  const turns = buildTurns(v2);
  assert.equal(turns.length, 2);
  const [user, assistant] = turns;
  assert.equal(user.kind, 'user'); assert.equal(user.text, 'Fix the tests'); assert.deepEqual(user.files, ['log.txt']);
  assert.equal(assistant.kind, 'assistant');
  assert.equal(assistant.finalText, '## Fixed\n\nAll green.');
  assert.deepEqual(assistant.steps.map(step => step.kind), ['reasoning', 'text', 'tool', 'tool']);
  const [, , shell, read] = assistant.steps;
  assert.equal(shell.title, 'npm test'); assert.equal(shell.status, 'completed'); assert.equal(shell.exitCode, 1); assert.equal(shell.durationMs, 2000);
  assert.match(shell.input, /^\$ npm test/); assert.match(shell.output, /1 failing/);
  assert.equal(read.status, 'error'); assert.equal(read.error, 'File not found'); assert.equal(read.title, '…/c/d/e.ts');
  assert.equal(assistant.running, false); assert.equal(assistant.durationMs, 8000); assert.equal(assistant.agent, 'build');
  assert.equal(summarizeSteps(assistant.steps).label, '4 steps · 2 tools · 1 failed');
});

test('turns: accepts newest-first pages and an in-flight turn', () => {
  const inflight = [...v2.slice(0, 2)].reverse();
  const turns = buildTurns(inflight);
  assert.equal(turns[0].kind, 'user');
  assert.equal(turns[1].running, true); assert.equal(turns[1].finalText, undefined);
  const interrupted = buildTurns([...v2.slice(0, 2), { id: 'msg_x', type: 'assistant', finish: 'error', error: { type: 'aborted', message: 'Step interrupted' }, time: { created: at(5) }, content: [] }, { id: 'msg_y', type: 'idle', outcome: 'interrupted', time: { created: at(6) } }]);
  assert.equal(interrupted[1].outcome, 'interrupted'); assert.equal(interrupted[1].running, false); assert.equal(interrupted[1].error, undefined);
});

test('turns: tolerant of unknown and legacy shapes', () => {
  const turns = buildTurns([
    { id: 'a', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { id: 'b', role: 'assistant', content: 'hello **there**' },
    { id: 'c', type: 'compaction', status: 'completed', summary: 'Earlier work summarised', time: { created: 5 } },
    { id: 'd', type: 'mystery', text: 'odd' },
    null, 42, 'nope',
    { id: 'e', type: 'assistant', content: [{ type: 'image', url: 'x' }, { type: 'tool', name: 'custom', state: { status: 'streaming', input: '{"q":' } }] },
  ]);
  assert.equal(turns[0].text, 'hi');
  const assistant = turns[1];
  assert.deepEqual(assistant.steps.map(step => step.kind === 'note' ? step.label : step.kind), ['text', 'Context compacted', 'mystery', 'image', 'tool']);
  assert.equal(assistant.steps[4].status, 'running');
  assert.equal(buildTurns('garbage').length, 0);
});

test('turns: helpers', () => {
  assert.equal(toolTitle('grep', { pattern: 'TODO', path: '/x' }), 'TODO  in /x');
  assert.equal(toolTitle('patch', { patchText: '*** Update File: /r/a.ts\n*** Add File: /r/b.ts' }), '2 files · /r/a.ts');
  assert.equal(toolTitle('unknown', { anything: 'value here' }), 'value here');
  assert.deepEqual(truncate('x'.repeat(4001)), { text: 'x'.repeat(4000), truncated: true });
  const middle = truncateMiddle(`HEAD${'x'.repeat(10_000)}TAIL`);
  assert.ok(middle.truncated && middle.text.startsWith('HEAD') && middle.text.endsWith('TAIL') && middle.text.includes('characters omitted'));
  assert.equal(formatDuration(400), '0.4s'); assert.equal(formatDuration(12_000), '12s'); assert.equal(formatDuration(125_000), '2m 5s'); assert.equal(formatDuration(undefined), undefined);
});

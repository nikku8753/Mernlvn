// Phase 5 regressions plus Phase 6: isolated Chromium sessions exercise real Monaco,
// Yjs, Socket.IO, presence, cursor/selection decorations and PostgreSQL.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
require('dotenv').config({ path: new URL('../../api/.env', import.meta.url), quiet: true });
const { PrismaClient } = require('@prisma/client'); const db = new PrismaClient();
const executable = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!executable) throw new Error('Install Chrome or Edge.');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function browser(cookie, url) {
  const profile = await mkdtemp(join(tmpdir(), 'codesync-phase5-'));
  const process = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1440,1000'], { windowsHide: true, stdio: 'ignore' });
  let port;
  for (let n = 0; n < 100; n++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await delay(150); }
  if (!port) { process.kill(); throw new Error('Browser did not start.'); }
  const target = await (await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  const pending = new Map(); let serial = 0; const errors = [];
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve: data => { clearTimeout(timeout); resolve(data); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data); const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Page.javascriptDialogOpening') void cdp('Page.handleJavaScriptDialog', { accept: true });
  });
  const evaluate = async (fn, ...args) => {
    const result = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value;
  };
  const wait = async (fn, description, ...args) => { for (let n = 0; n < 240; n++) { try { if (await evaluate(fn, ...args)) return; } catch {} await delay(150); } throw new Error(`Timed out: ${description}; page: ${await evaluate(() => document.body.innerText)}; browser errors: ${errors.slice(0, 2).join('; ')}`); };
  const click = async selector => { await wait(selector => { const element = document.querySelector(selector); return element && !element.disabled; }, selector, selector); await evaluate(selector => document.querySelector(selector).click(), selector); };
  const field = async (selector, value) => evaluate((selector, value) => { const input = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }, selector, value);
  const content = () => evaluate(() => new Promise(resolve => window.require(['vs/editor/editor.main'], monaco => resolve(monaco.editor.getModels()[0]?.getValue()))));
  const insert = (text, beginning = false) => evaluate((text, beginning) => new Promise(resolve => window.require(['vs/editor/editor.main'], monaco => {
    const model = monaco.editor.getModels()[0]; const position = model.getPositionAt(beginning ? 0 : model.getValueLength());
    model.applyEdits([{ range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text }]); resolve();
  })), text, beginning);
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
  await cdp('Network.setCookie', { name: 'codesync_session', value: cookie.split('=')[1], url: 'http://localhost:4000', path: '/', httpOnly: true });
  await cdp('Page.navigate', { url });
  return { cdp, evaluate, wait, click, field, content, insert, errors, close: async () => { try { await cdp('Browser.close'); } catch {} socket.close(); if (process.exitCode === null) process.kill(); } };
}
const suffix = randomUUID().slice(0, 8); const emails = ['a', 'b', 'c'].map(name => `phase5-browser-${name}-${suffix}@example.com`);
const sessions = []; let workspaceId;
const request = async (path, method, cookie, body) => {
  const response = await fetch('http://localhost:4000' + path, { method, headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `API ${path}: ${response.status}`); return { body: response.status === 204 ? null : await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
};
try {
  const users = [];
  for (const [index, email] of emails.entries()) users.push(await request('/api/auth/register', 'POST', '', { email, username: `p5-browser-${index}-${suffix}`, password: 'Browser-test-password' }));
  const created = await request('/api/workspaces', 'POST', users[0].cookie, { name: `Browser collaboration ${suffix}` }); workspaceId = created.body.id;
  await db.workspaceMember.create({ data: { workspaceId, userId: users[1].body.id, role: 'EDITOR' } });
  const file = (await request(`/api/workspaces/${workspaceId}/files`, 'POST', users[0].cookie, { name: 'main.ts' })).body;
  const other = (await request(`/api/workspaces/${workspaceId}/files`, 'POST', users[0].cookie, { name: 'other.ts' })).body;
  const url = `http://localhost:3000/workspace/${workspaceId}?file=${file.id}`;
  const a = await browser(users[0].cookie, url); sessions.push(a);
  const b = await browser(users[1].cookie, url); sessions.push(b);
  const connected = page => page.wait(() => document.body.innerText.includes('Connected') && !!document.querySelector('.monaco-editor'), 'Monaco collaboration connected');
  await Promise.all([connected(a), connected(b)]);
  const presence = async (page, name) => page.wait(name => [...document.querySelectorAll('.collaborator-chip')].some(node => node.textContent === name) && document.querySelector('.file-collaborators')?.textContent.includes('Collaborators (1)'), 'one other authenticated collaborator', name);
  await presence(a, users[1].body.username); await presence(b, users[0].body.username);
  await a.insert('const a = 1;\n'); await b.wait(() => new Promise(resolve => window.require(['vs/editor/editor.main'], m => resolve(m.editor.getModels()[0].getValue().includes('const a = 1;')))), 'A to B');
  await b.insert('const b = 2;\n'); await a.wait(() => new Promise(resolve => window.require(['vs/editor/editor.main'], m => resolve(m.editor.getModels()[0].getValue().includes('const b = 2;')))), 'B to A');
  await Promise.all([a.insert('// beginning A\n', true), b.insert('// ending B\n')]); await delay(600);
  const expected = await a.content(); assert.equal(await b.content(), expected); assert.ok(expected.includes('// beginning A')); assert.ok(expected.includes('// ending B'));
  console.log('PASS: two authenticated Monaco bindings, bidirectional and concurrent convergence');
  const select = (page, start, end = start) => page.evaluate((start, end) => new Promise(resolve => window.require(['vs/editor/editor.main'], m => {
    const editor = m.editor.getEditors()[0]; const model = editor.getModel(); const a = model.getPositionAt(start); const b = model.getPositionAt(end);
    editor.focus(); editor.setSelection(new m.Selection(a.lineNumber, a.column, b.lineNumber, b.column)); resolve();
  })), start, end);
  const remoteRange = (page, start, end = start) => page.wait((start, end) => new Promise(resolve => window.require(['vs/editor/editor.main'], m => {
    const model = m.editor.getModels()[0]; resolve(model.getAllDecorations().some(d => d.options.className?.includes('remote-selection') && model.getOffsetAt(d.range.getStartPosition()) === Math.min(start, end) && model.getOffsetAt(d.range.getEndPosition()) === Math.max(start, end)));
  })), 'remote cursor/selection at expected offsets', start, end).catch(async error => {
    console.log('Cursor diagnostics', await page.evaluate(() => new Promise(resolve => window.require(['vs/editor/editor.main'], m => {
      const model = m.editor.getModels()[0]; resolve({ text: model.getValue(), eol: model.getEOL(), decorations: model.getAllDecorations().filter(d => d.options.className?.includes('remote-selection')).map(d => ({ start: model.getOffsetAt(d.range.getStartPosition()), end: model.getOffsetAt(d.range.getEndPosition()) })) });
    })))); throw error;
  });
  await select(a, 3); await remoteRange(b, 3);
  await b.wait(name => [...document.querySelectorAll('.remote-cursor-label')].some(node => node.textContent === name), 'A cursor name label', users[0].body.username);
  await select(b, 8); await remoteRange(a, 8);
  await select(a, 2, 20); await remoteRange(b, 2, 20);
  await select(b, 28, 4); await remoteRange(a, 4, 28);
  await a.insert('// relative shift\n', true);
  const shiftedLength = (await a.content()).length - expected.length;
  await remoteRange(a, 4 + shiftedLength, 28 + shiftedLength);
  // Only content edits change the durable snapshot; selections remain ephemeral.
  const phase6Expected = await a.content(); await b.wait(value => new Promise(resolve => window.require(['vs/editor/editor.main'], m => resolve(m.editor.getModels()[0].getValue() === value))), 'relative cursor edit converges', phase6Expected);
  console.log('PASS: Phase 6 presence, bidirectional cursors, labels, forward/reverse selections and relative positions');
  await a.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await a.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await a.wait(() => document.body.innerText.includes('Saved'), 'saved'); await delay(2000);
  assert.equal((await db.file.findUniqueOrThrow({ where: { id: file.id } })).content, phase6Expected);
  for (const page of [a, b]) { await page.cdp('Page.reload'); await connected(page); assert.equal(await page.content(), phase6Expected); }
  await presence(a, users[1].body.username); await presence(b, users[0].body.username);
  console.log('PASS: Ctrl+S, PostgreSQL content + CRDT snapshot, both browser refreshes');
  await a.click('[aria-label="Rename main.ts"]'); await a.field('#file-name', 'renamed.ts'); await a.click('.file-operation button');
  await b.wait(() => !!document.querySelector('[aria-label="Rename renamed.ts"]'), 'remote rename'); assert.equal(await a.content(), phase6Expected);
  await a.evaluate(() => Array.from(document.querySelectorAll('.file-select')).find(button => button.textContent.trim() === 'other.ts').click()); await connected(a);
  await a.wait(() => document.querySelector('.editor-filename')?.textContent === 'other.ts', 'file switch');
  await b.wait(() => document.querySelector('.file-collaborators')?.textContent.includes('Collaborators (0)') && !document.querySelector('.remote-cursor-label'), 'file switch removes presence and decorations');
  await b.insert('// main only\n'); await delay(300); assert.equal(await a.content(), '');
  console.log('PASS: rename preserves binding and file switching isolates documents');
  await b.cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await b.wait(() => /Offline|Reconnecting/.test(document.body.innerText), 'offline indicator'); await b.insert('// offline retained\n');
  assert.ok((await b.content()).includes('// offline retained'), 'Offline draft is editable before reconnect');
  await b.cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await connected(b);
  await delay(2000); assert.ok((await b.content()).includes('// offline retained'));
  assert.equal((await db.file.findUniqueOrThrow({ where: { id: file.id } })).content, await b.content());
  console.log('PASS: offline edits replay and persist after reconnect');
  await a.evaluate(() => Array.from(document.querySelectorAll('.file-select')).find(button => button.textContent.trim().startsWith('renamed.ts')).click()); await connected(a);
  await presence(a, users[1].body.username); await select(b, 2, 7); await remoteRange(a, 2, 7);
  const bTab = await browser(users[1].cookie, url); sessions.push(bTab); await connected(bTab); await presence(a, users[1].body.username);
  await bTab.close(); sessions.splice(sessions.indexOf(bTab), 1); await presence(a, users[1].body.username);
  await b.close(); sessions.splice(sessions.indexOf(b), 1);
  await a.wait(() => document.querySelector('.file-collaborators')?.textContent.includes('Collaborators (0)') && !document.querySelector('.remote-cursor-label'), 'tab close clears presence and cursor');
  const bReopened = await browser(users[1].cookie, url); sessions.push(bReopened); await connected(bReopened); await presence(a, users[1].body.username);
  console.log('PASS: Phase 6 file cleanup, reconnect cursors, deduplicated multiple tabs, close and rejoin');
  const otherVersion = (await request(`/api/files/${other.id}`, 'GET', users[0].cookie)).body;
  const lfContent = 'const first = 1;\nconst second = 2;\n';
  await request(`/api/files/${other.id}/save`, 'POST', users[0].cookie, { content: lfContent, updatedAt: otherVersion.updatedAt });
  for (const page of [a, bReopened]) {
    await page.evaluate(() => Array.from(document.querySelectorAll('.file-select')).find(button => button.textContent.trim() === 'other.ts').click()); await connected(page);
    await page.wait(() => document.querySelector('.editor-filename')?.textContent === 'other.ts', 'LF snapshot file opened');
  }
  await presence(a, users[1].body.username);
  const lfOffsets = await a.evaluate(() => new Promise(resolve => window.require(['vs/editor/editor.main'], m => { const model = m.editor.getModels()[0]; resolve([model.getOffsetAt({ lineNumber: 2, column: 3 }), model.getOffsetAt({ lineNumber: 2, column: 10 })]); })));
  await select(a, ...lfOffsets); await remoteRange(bReopened, ...lfOffsets);
  assert.equal((await db.file.findUniqueOrThrow({ where: { id: other.id } })).content, lfContent);
  for (const page of [a, bReopened]) {
    await page.evaluate(() => Array.from(document.querySelectorAll('.file-select')).find(button => button.textContent.trim().startsWith('renamed.ts')).click()); await connected(page);
    await page.wait(() => document.querySelector('.editor-filename')?.textContent === 'renamed.ts', 'return to main file');
  }
  console.log('PASS: Phase 6 multi-line cursors on LF snapshots in Windows Monaco, without content mutation');
  await presence(a, users[1].body.username); await select(bReopened, 2, 7); await remoteRange(a, 2, 7);
  const c = await browser(users[2].cookie, url); sessions.push(c);
  await c.wait(() => /access|permission|unavailable/i.test(document.body.innerText), 'unauthorized workspace'); assert.ok(!await c.evaluate(() => !!document.querySelector('.monaco-editor')));
  await a.click('[aria-label="Delete renamed.ts"]'); await a.click('.file-operation button');
  await bReopened.wait(() => document.body.innerText.includes('This file was deleted.') && !document.querySelector('.monaco-editor') && !document.querySelector('.remote-cursor-label') && !document.querySelector('.file-collaborators'), 'remote deletion');
  assert.equal(await db.file.count({ where: { id: file.id } }), 0);
  await a.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await a.cdp('Emulation.clearDeviceMetricsOverride');
  await a.click('a[href="/dashboard"]'); await a.wait(() => location.pathname === '/dashboard', 'dashboard');
  await a.evaluate(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out').click()); await a.wait(() => location.pathname === '/login', 'logout');
  await a.field('#email', emails[0]); await a.field('#password', 'Browser-test-password'); await a.click('.account-form button[type="submit"]'); await a.wait(() => location.pathname === '/dashboard', 'login');
  console.log('PASS: unauthorized third user, remote deletion, responsive layout and logout/login');
  for (const page of sessions) assert.deepEqual(page.errors, [], 'No uncaught browser errors');
} finally {
  for (const page of sessions) await page.close();
  if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { email: { in: emails } } }); await db.$disconnect();
}

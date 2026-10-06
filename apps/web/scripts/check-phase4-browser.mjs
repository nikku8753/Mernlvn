// Local end-to-end check using an installed Chromium browser and its DevTools API.
// Requires frontend, API, and PostgreSQL; uses only temporary test records.
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
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const executable = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!executable) throw new Error('Install Chrome or Edge to run this browser check.');
const profile = await mkdtemp(join(tmpdir(), 'codesync-phase4-'));
const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1440,1000'], { windowsHide: true, stdio: 'ignore' });
const suffix = randomUUID().slice(0, 8);
const email = `phase4-browser-${suffix}@example.com`;
let socket;
let workspaceId;
let serial = 0;
const pending = new Map();
let browserError;
browser.on('error', error => { browserError = error; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function cdp(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timed out: ${method}`)); }, 30_000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(fn, ...args) {
  const result = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
  return result.result.value;
}
async function wait(fn, description, ...args) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if (await evaluate(fn, ...args)) return; } catch {}
    await sleep(150);
  }
  throw new Error(`Browser check timed out: ${description}`);
}
async function field(selector, value) {
  await wait(selector => { const element = document.querySelector(selector); return element && Object.keys(element).some(key => key.startsWith('__reactFiber')); }, selector, selector);
  await evaluate((selector, value) => { const input = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, selector, value);
}
async function click(selector) {
  await wait(selector => { const element = document.querySelector(selector); return element && !element.disabled; }, selector, selector);
  await evaluate(selector => document.querySelector(selector).click(), selector);
}
async function editorContent() {
  return evaluate(() => new Promise(resolve => window.require(['vs/editor/editor.main'], monaco => resolve(monaco.editor.getModels().map(model => model.getValue())))));
}
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (browserError) throw browserError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    await sleep(150);
  }
  if (!port) throw new Error('Headless browser did not start.');
  const target = await (await fetch(`http://localhost:${port}/json/new?http://localhost:3000/register`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); }
    if (message.method === 'Page.javascriptDialogOpening') void cdp('Page.handleJavaScriptDialog', { accept: true });
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await field('#username', `phase4-browser-${suffix}`); await field('#email', email); await field('#password', 'Browser-test-password'); await field('#confirmPassword', 'Browser-test-password'); await click('.account-form button[type="submit"]');
  await wait(() => location.pathname === '/dashboard' && document.body.innerText.includes('Create Workspace'), 'registered dashboard');
  console.log('PASS: browser registration and protected dashboard');
  await click('a[href="/workspace/new"]'); await field('#workspace-name', `Browser workspace ${suffix}`); await click('.account-form button');
  await wait(() => /^\/workspace\/c[a-z0-9]{24}$/.test(location.pathname) && document.body.innerText.includes('No files yet.'), 'workspace explorer');
  workspaceId = await evaluate(() => location.pathname.split('/').pop());
  await click('[aria-label="New File"]'); await field('#file-name', 'index.ts'); await click('.file-operation button');
  await wait(() => !!document.querySelector('.monaco-editor') && document.body.innerText.includes('index.ts'), 'Monaco mounted');
  console.log('PASS: create/select file and load locally hosted Monaco');
  let code = 'const message: string = "Browser persisted";\nconsole.log(message);\n';
  await evaluate(() => document.querySelector('.monaco-editor textarea').focus());
  await cdp('Input.insertText', { text: code });
  await wait(() => document.body.innerText.includes('Unsaved changes'), 'editor dirty state');
  const typed = (await editorContent())[0];
  assert.equal(typed.replace(/\r\n/g, '\n'), code);
  code = typed; // Monaco uses the browser platform's native EOL for new empty models.
  await click('.editor-toolbar-actions button:last-child');
  await wait(() => document.body.innerText.includes('File saved.'), 'REST save');
  assert.equal((await db.file.findFirstOrThrow({ where: { workspaceId, name: 'index.ts' } })).content, code);
  await cdp('Page.reload');
  await wait(() => !!document.querySelector('.monaco-editor') && document.body.innerText.includes('index.ts'), 'refresh reopens file');
  assert.ok((await editorContent()).includes(code));
  console.log('PASS: edit/save/refresh with exact PostgreSQL content');
  await click('[aria-label="Rename index.ts"]'); await field('#file-name', 'app.ts'); await click('.file-operation button');
  await wait(() => document.body.innerText.includes('Renamed successfully.') && !!document.querySelector('[aria-label="Rename app.ts"]'), 'file rename');
  await cdp('Page.reload');
  await wait(() => !!document.querySelector('.monaco-editor') && !!document.querySelector('[aria-label="Rename app.ts"]'), 'renamed file after refresh');
  assert.ok((await editorContent()).includes(code));
  console.log('PASS: rename and refresh preserve code');
  await click('a[href="/dashboard"]');
  await wait(() => location.pathname === '/dashboard', 'dashboard before persistence login');
  await evaluate(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out').click());
  await wait(() => location.pathname === '/login', 'logout with saved file');
  await field('#email', email); await field('#password', 'Browser-test-password'); await click('.account-form button[type="submit"]');
  await wait(() => location.pathname === '/dashboard', 'login with saved file');
  await cdp('Page.navigate', { url: `http://localhost:3000/workspace/${workspaceId}` });
  await wait(() => !!document.querySelector('[aria-label="Rename app.ts"]'), 'file persists after login');
  await evaluate(() => Array.from(document.querySelectorAll('.file-select')).find(button => button.textContent.trim() === 'app.ts').click());
  await wait(() => !!document.querySelector('.monaco-editor') && document.querySelector('.editor-filename')?.textContent === 'app.ts', 'open persisted file after login');
  assert.ok((await editorContent()).includes(code));
  console.log('PASS: renamed file and saved code persist through browser logout/login');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await cdp('Emulation.clearDeviceMetricsOverride');
  const browserUser = await db.user.findUniqueOrThrow({ where: { email } });
  await db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: browserUser.id } }, data: { role: 'VIEWER' } });
  await cdp('Page.reload');
  await wait(() => !!document.querySelector('.monaco-editor') && document.body.innerText.includes('Your role: VIEWER'), 'viewer workspace');
  assert.ok(await evaluate(() => !document.querySelector('[aria-label="New File"]') && document.querySelector('.editor-toolbar-actions button:last-child').disabled));
  await evaluate(() => document.querySelector('.monaco-editor textarea').focus());
  await cdp('Input.insertText', { text: 'denied edit' });
  assert.ok((await editorContent()).includes(code));
  await db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: browserUser.id } }, data: { role: 'OWNER' } });
  await cdp('Page.reload');
  await wait(() => !!document.querySelector('.monaco-editor') && !!document.querySelector('[aria-label="New File"]'), 'owner controls restored');
  console.log('PASS: mobile editor layout and viewer read-only Monaco');
  await click('[aria-label="New Folder"]'); await field('#file-name', 'src'); await click('.file-operation button');
  await wait(() => !!document.querySelector('[aria-label="New file in src"]'), 'folder creation');
  await click('[aria-label="New file in src"]'); await field('#file-name', 'main.py'); await click('.file-operation button');
  await wait(() => !!document.querySelector('.monaco-editor') && document.body.innerText.includes('src/main.py'), 'nested file');
  await evaluate(() => document.querySelector('.monaco-editor textarea').focus());
  await cdp('Input.insertText', { text: 'print("nested")\n' });
  await wait(() => document.body.innerText.includes('Unsaved changes'), 'nested dirty state');
  const nestedCode = (await editorContent())[0];
  assert.equal(nestedCode.replace(/\r\n/g, '\n'), 'print("nested")\n');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await wait(() => document.body.innerText.includes('File saved.'), 'keyboard save');
  assert.equal((await db.file.findFirstOrThrow({ where: { workspaceId, name: 'main.py' } })).content, nestedCode);
  console.log('PASS: nested folders/files and Ctrl+S');
  await evaluate(() => Array.from(document.querySelectorAll('.file-select')).find(button => button.textContent.trim() === 'app.ts').click());
  await wait(() => !!document.querySelector('.monaco-editor') && document.querySelector('.editor-filename').textContent === 'app.ts', 'switch to app.ts');
  await evaluate(() => new Promise(resolve => window.require(['vs/editor/editor.main'], monaco => { const model = monaco.editor.getModels()[0]; model.setValue(model.getValue() + '// unsaved draft'); resolve(); })));
  await wait(() => document.body.innerText.includes('Unsaved changes'), 'draft edit');
  await evaluate(() => Array.from(document.querySelectorAll('.file-select')).find(button => button.textContent.trim() === 'main.py').click());
  await wait(() => document.querySelector('.editor-filename')?.textContent === 'src/main.py' && !!document.querySelector('.monaco-editor'), 'switch to nested file');
  await evaluate(() => Array.from(document.querySelectorAll('.file-select')).find(button => button.textContent.trim().startsWith('app.ts')).click());
  await wait(() => document.querySelector('.editor-filename')?.textContent === 'app.ts' && !!document.querySelector('.monaco-editor'), 'restore draft');
  assert.ok((await editorContent()).includes(code + '// unsaved draft'));
  const staleFile = await db.file.findFirstOrThrow({ where: { workspaceId, name: 'app.ts' } });
  const concurrentSaveStatus = await evaluate(async id => {
    const url = `http://localhost:4000/api/files/${id}`;
    const current = await (await fetch(url, { credentials: 'include' })).json();
    return (await fetch(`${url}/save`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: current.content, updatedAt: current.updatedAt }) })).status;
  }, staleFile.id);
  assert.equal(concurrentSaveStatus, 200);
  await click('.editor-toolbar-actions button:last-child');
  await wait(() => document.querySelector('.file-feedback[role="alert"]') && document.body.innerText.includes('Unsaved changes'), 'failed save preserves dirty state and reports error');
  assert.ok((await editorContent()).includes(code + '// unsaved draft'));
  assert.equal((await db.file.findUniqueOrThrow({ where: { id: staleFile.id } })).content, code);
  console.log('PASS: failed stale save reports an error and preserves editor draft');
  await click('.editor-toolbar-actions button:first-child');
  await wait(() => !document.body.innerText.includes('Unsaved changes'), 'discard draft with confirmed reload');
  assert.ok((await editorContent()).includes(code));
  console.log('PASS: unsaved draft survives file switching; confirmed reload restores saved code');
  await click('[aria-label="Delete src"]'); await click('.file-operation button[type="button"]');
  assert.ok(await evaluate(() => !!document.querySelector('[aria-label="Delete src"]')));
  await click('[aria-label="Delete src"]'); await click('.file-operation button');
  await wait(() => !document.querySelector('[aria-label="Delete src"]'), 'recursive folder delete');
  assert.equal(await db.file.count({ where: { workspaceId, name: 'main.py' } }), 0);
  await click('[aria-label="Delete app.ts"]'); await click('.file-operation button');
  await wait(() => document.body.innerText.includes('No files yet.'), 'file deletion empty state');
  assert.equal(await db.file.count({ where: { workspaceId } }), 0);
  await cdp('Page.reload');
  await wait(() => document.body.innerText.includes('No files yet.') && document.body.innerText.includes('No file selected'), 'deleted files stay deleted after refresh');
  assert.equal(await db.file.count({ where: { workspaceId } }), 0);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  console.log('PASS: delete confirmation/cancel/cascade, empty state and mobile layout');
  await click('a[href="/dashboard"]');
  await wait(() => location.pathname === '/dashboard', 'back to dashboard');
  await evaluate(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out').click());
  await wait(() => location.pathname === '/login', 'logout');
  await field('#email', email); await field('#password', 'Browser-test-password'); await click('.account-form button[type="submit"]');
  await wait(() => location.pathname === '/dashboard', 'login');
  console.log('PASS: Phase 2 logout/login regression');
} finally {
  if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
  if (socket?.readyState === WebSocket.OPEN) { try { await cdp('Browser.close'); } catch {} socket.close(); }
  if (browser.exitCode === null) browser.kill();
}

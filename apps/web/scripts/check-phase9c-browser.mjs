// Frontend Run regression: real auth/files/Yjs, mocked execution HTTP responses.
// No code is executed by this check and no Judge0 instance is required.
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
assert.ok(executable, 'Install Chrome or Edge to run the browser check.');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const suffix = randomUUID().slice(0, 8), emails = ['a', 'b'].map(name => `p9c-${name}-${suffix}@example.com`);
const errors = [], submissions = [], pending = new Map(); let serial = 0;
let process, socket, workspaceId, responseStatus = 200, responseBody, hold = false, heldRequest;
const accepted = { status: 'Accepted', statusId: 3, stdout: '<img src=x onerror="window.executionXss=true">\nhello', stderr: 'stderr text', compileOutput: 'compiler text', time: '0.01', memory: 1000, truncated: false };
const call = async (path, method = 'GET', cookie = '', body) => {
  const response = await fetch('http://localhost:4000' + path, { method, headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = response.status === 204 ? null : await response.json(); assert.ok(response.ok, `API ${path}: ${response.status}`);
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
  pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (fn, ...args) => {
  const reply = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
};
const wait = async (fn, description, ...args) => {
  for (let n = 0; n < 240; n++) { if (await evaluate(fn, ...args)) return; await delay(150); }
  throw new Error(`Timed out: ${description}; ${await evaluate(() => document.body.innerText)}`);
};
const fulfill = (requestId, status = responseStatus, body = responseBody ?? accepted) => cdp('Fetch.fulfillRequest', {
  requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: 'http://localhost:3000' }, { name: 'Access-Control-Allow-Credentials', value: 'true' }], body: Buffer.from(JSON.stringify(body)).toString('base64'),
});
const clickRun = async () => {
  await wait(() => { const button = document.querySelector('.execution-panel .button'); return button?.textContent === 'Run' && !button.disabled; }, 'Run enabled');
  await evaluate(() => document.querySelector('.execution-panel .button').click());
};
const editorReady = async fileId => {
  await wait(id => !!document.getElementById(`execution-stdin-${id}`) && document.querySelector('.editor-status')?.textContent.includes('Connected') && !document.querySelector('.execution-panel .button')?.disabled, 'editor ready', fileId);
};
const setSource = source => evaluate(source => new Promise(resolve => window.require(['vs/editor/editor.main'], monaco => { monaco.editor.getModels()[0].setValue(source); resolve(); })), source);
try {
  const users = [];
  for (const [index, email] of emails.entries()) users.push(await call('/api/auth/register', 'POST', '', { email, username: `p9c-${index}-${suffix}`, password: 'Browser-test-password' }));
  const [a, b] = users;
  workspaceId = (await call('/api/workspaces', 'POST', a.cookie, { name: `Phase 9C ${suffix}` })).data.id;
  const root = `/api/workspaces/${workspaceId}`;
  const first = (await call(`${root}/files`, 'POST', a.cookie, { name: 'first.js' })).data;
  const second = (await call(`${root}/files`, 'POST', a.cookie, { name: 'second.py' })).data;
  const unsupported = (await call(`${root}/files`, 'POST', a.cookie, { name: 'editor-only.ts' })).data;
  const invitation = (await call(`${root}/invites`, 'POST', a.cookie, { email: emails[1], role: 'EDITOR' })).data;
  await call(`/api/invites/${invitation.id}/accept`, 'POST', b.cookie, {});
  const profile = await mkdtemp(join(tmpdir(), 'codesync-phase9c-'));
  process = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1440,1000'], { windowsHide: true, stdio: 'ignore' });
  let port;
  for (let n = 0; n < 100; n++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await delay(150); }
  assert.ok(port, 'Browser started.');
  const target = await (await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map(arg => arg.value || arg.description || '').join(' ');
      // Chromium logs expected rejected HTTP requests as console errors.
      if (/unmount|React|root|render/i.test(text)) errors.push(text);
    }
    if (message.method === 'Page.javascriptDialogOpening') void cdp('Page.handleJavaScriptDialog', { accept: true });
    if (message.method === 'Fetch.requestPaused') void (async () => {
      const { requestId, request } = message.params;
      if (request.method !== 'POST') { await cdp('Fetch.continueRequest', { requestId }); return; }
      submissions.push({ url: request.url, ...JSON.parse(request.postData) });
      if (hold) heldRequest = requestId; else await fulfill(requestId);
    })().catch(error => errors.push(error.message));
  });
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/files/*/run' }] });
  await cdp('Network.setCookie', { name: 'codesync_session', value: b.cookie.split('=')[1], url: 'http://localhost:4000', path: '/', httpOnly: true });
  await cdp('Page.navigate', { url: `http://localhost:3000/workspace/${workspaceId}?file=${first.id}` });
  await editorReady(first.id);
  const source = `console.log("unsaved-${suffix}");\n`; await setSource(source);
  await evaluate(() => document.querySelector('.execution-input').open = true);
  await evaluate(() => {
    const input = document.querySelector('.execution-input textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'stdin text\n'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  hold = true; await clickRun();
  await wait(() => document.querySelector('.execution-panel .button')?.disabled && document.querySelector('.execution-panel [role="status"]')?.textContent.includes('Running'), 'running state');
  for (let i = 0; i < 100 && !heldRequest; i++) await delay(20); assert.ok(heldRequest);
  assert.equal(submissions[0].source, source); assert.equal(submissions[0].stdin, 'stdin text\n');
  assert.deepEqual(Object.keys(submissions[0]).sort(), ['source', 'stdin', 'url']);
  hold = false; await fulfill(heldRequest); heldRequest = undefined;
  await wait(() => !!document.querySelector('.execution-output'), 'output displayed');
  assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.execution-output pre')].map(node => node.textContent)), [accepted.stdout, accepted.stderr, accepted.compileOutput]);
  assert.equal(await evaluate(() => !!document.querySelector('.execution-output img') || !!window.executionXss), false);
  console.log('PASS: current unsaved Monaco source, optional stdin, running state, and plain-text output.');
  for (const status of [400, 401, 403, 404, 502, 504]) {
    responseStatus = status; responseBody = { error: `Expected ${status} execution error` };
    await clickRun(); await wait(() => !!document.querySelector('.execution-panel [role="alert"]'), `HTTP ${status} feedback`);
    assert.ok(await evaluate(() => document.querySelector('.execution-panel [role="alert"]').textContent.length > 10));
  }
  responseStatus = 200; responseBody = { ...accepted, status: 'Compilation Error', statusId: 6, truncated: true };
  await clickRun(); await wait(() => document.querySelector('.execution-result')?.textContent.includes('Compilation Error'), 'compile error status');
  assert.ok(await evaluate(() => document.querySelector('.execution-output').textContent.includes('Output truncated')));
  responseBody = accepted;
  console.log('PASS: useful HTTP 400/401/403/404/502/504 messages and compiler failure status.');
  // Keep a run in flight, switch files, and then deliver its old response.
  hold = true; await clickRun(); for (let i = 0; i < 100 && !heldRequest; i++) await delay(20); assert.ok(heldRequest);
  await evaluate(() => [...document.querySelectorAll('.file-select')].find(button => button.textContent === 'second.py').click());
  await editorReady(second.id); hold = false;
  // AbortController can make Chrome discard the paused request completely.
  try { await fulfill(heldRequest); } catch (error) { if (error.message !== 'Invalid InterceptionId.') throw error; }
  heldRequest = undefined; await delay(100);
  assert.equal(await evaluate(() => document.querySelectorAll('.execution-panel').length), 1);
  assert.equal(await evaluate(() => document.querySelectorAll('.execution-output').length), 0);
  await setSource('print("second")\n'); await clickRun(); await wait(() => !!document.querySelector('.execution-output'), 'second output');
  assert.ok(submissions.at(-1).url.includes(second.id)); assert.equal(submissions.at(-1).source, 'print("second")\n'); assert.equal(submissions.at(-1).stdin, '');
  await evaluate(() => [...document.querySelectorAll('.file-select')].find(button => button.textContent === 'editor-only.ts').click());
  await wait(() => document.querySelector('.execution-panel')?.textContent.includes('Run supports JavaScript'), 'unsupported file state');
  assert.equal(await evaluate(() => document.querySelector('.execution-panel .button').disabled), true);
  await evaluate(() => [...document.querySelectorAll('.file-select')].find(button => button.textContent === 'first.js').click()); await editorReady(first.id);
  await call(`${root}/members/${b.data.id}`, 'PATCH', a.cookie, { role: 'VIEWER' });
  await wait(() => document.querySelector('.execution-panel')?.textContent.includes('Read-only access.'), 'live viewer permission');
  assert.equal(await evaluate(() => document.querySelector('.execution-panel .button').disabled), true);
  await call(`${root}/members/${b.data.id}`, 'PATCH', a.cookie, { role: 'EDITOR' }); await editorReady(first.id);
  console.log('PASS: aborted file-switch requests, clean console state, unsupported files, and live role changes.');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await cdp('Page.navigate', { url: 'http://localhost:3000/dashboard' });
  await wait(() => location.pathname === '/dashboard' && !document.querySelector('.execution-panel'), 'workspace unmounted');
  assert.deepEqual(errors, [], 'No browser exceptions or nested-root cleanup errors.');
  console.log('PASS: responsive console and workspace unmount without React errors.');
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await cdp('Browser.close'); } catch {} socket.close(); }
  if (process && process.exitCode === null) process.kill();
  if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { email: { in: emails } } }); await db.$disconnect();
}

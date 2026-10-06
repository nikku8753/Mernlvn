// Phase 8 user workflow with isolated real Chrome sessions; no manual membership fixture.
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
  const field = async (selector, value) => evaluate((selector, value) => { const input = document.querySelector(selector); Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }, selector, value);
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
const suffix=randomUUID().slice(0,8);const emails=['a','b','c'].map(name=>`p8-browser-${name}-${suffix}@example.com`);
const sessions=[];let workspaceId;
const request=async(path,method,cookie,body)=>{
  const response=await fetch('http://localhost:4000'+path,{method,headers:{Origin:'http://localhost:3000','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=response.status===204?null:await response.json();assert.ok(response.ok,`API ${path}: ${response.status} ${JSON.stringify(data)}`);return{body:data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
};
const select=(page,selector,value)=>page.evaluate((selector,value)=>{const element=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('change',{bubbles:true}));},selector,value);
const editorReady=page=>page.wait(()=>document.querySelector('.editor-status')?.textContent.includes('Connected')&&!!document.querySelector('.monaco-editor'),'editor connected');
const chatReady=page=>page.wait(()=>document.querySelector('.workspace-chat [role="status"]')?.textContent==='Connected','chat connected');
const messageOnce=(page,text)=>page.wait(text=>[...document.querySelectorAll('.chat-message p')].filter(node=>node.textContent===text).length===1,'message appears exactly once',text);
const send=async(page,text)=>{await chatReady(page);await page.field('#chat-message',text);await page.click('.chat-compose button');};
try{
  const users=[];for(const[index,email]of emails.entries())users.push(await request('/api/auth/register','POST','',{email,username:`p8-browser-${index}-${suffix}`,password:'Browser-test-password'}));
  const created=await request('/api/workspaces','POST',users[0].cookie,{name:`Phase 8 browser ${suffix}`,language:'typescript'});workspaceId=created.body.id;
  const file=(await request(`/api/workspaces/${workspaceId}/files`,'POST',users[0].cookie,{name:'shared.ts'})).body;
  const url=`http://localhost:3000/workspace/${workspaceId}?file=${file.id}`;
  const a=await browser(users[0].cookie,url);sessions.push(a);await editorReady(a);await chatReady(a);await a.click('.workspace-settings summary');
  const b=await browser(users[1].cookie,'http://localhost:3000/dashboard');sessions.push(b);await b.wait(()=>!!document.querySelector('.invitation-inbox'),'dashboard inbox');
  const invite=async()=>{await a.field('#invite-email',emails[1]);await select(a,'#invite-role','EDITOR');await a.click('.invite-form button');await a.wait(()=>document.querySelector('.workspace-member-management')?.textContent.includes('Invitation sent.'),'invitation success');};
  const refreshInbox=async()=>{await b.click('.invitation-inbox .card-heading button');await b.wait(()=>!!document.querySelector('[data-invite-id]'),'pending invitation');};
  await invite();await refreshInbox();
  assert.ok(await b.evaluate(name=>document.querySelector('.invitation-inbox')?.textContent.includes(name),users[0].body.username));
  await a.field('#invite-email',emails[1]);await a.click('.invite-form button');await a.wait(()=>document.querySelector('.workspace-member-management')?.textContent.includes('already has a pending invitation'),'duplicate invite feedback');
  await b.click('[data-invite-id] .invitation-actions button');await b.wait(()=>location.pathname.startsWith('/workspace/'),'accepted invitation opens workspace');
  await b.wait(()=>[...document.querySelectorAll('.file-select')].some(button=>button.textContent.trim()==='shared.ts'&&!button.disabled),'invited member file list loaded');
  await b.evaluate(()=>[...document.querySelectorAll('.file-select')].find(button=>button.textContent.trim()==='shared.ts').click());await editorReady(b);await chatReady(b);
  await a.wait(name=>[...document.querySelectorAll('.collaborator-chip')].some(node=>node.textContent===name),'new editor presence',users[1].body.username);
  await a.insert('// Owner edit\n');await b.wait(()=>new Promise(resolve=>window.require(['vs/editor/editor.main'],m=>resolve(m.editor.getModels()[0].getValue().includes('// Owner edit')))),'owner edit received');
  await b.insert('// Invited editor edit\n');await a.wait(()=>new Promise(resolve=>window.require(['vs/editor/editor.main'],m=>resolve(m.editor.getModels()[0].getValue().includes('// Invited editor edit')))),'editor edit received');
  await send(a,'Owner chat');await messageOnce(b,'Owner chat');await send(b,'Invited editor chat');await messageOnce(a,'Invited editor chat');
  console.log('PASS: UI email invitation, dashboard acceptance, editor access, presence, bidirectional editing and chat');
  const setRole=async role=>{
    const selector=`select[aria-label="Role for ${users[1].body.username}"]`;
    await a.wait(selector=>!!document.querySelector(selector),'member row available',selector);await select(a,selector,role);
    await a.wait(selector=>[...document.querySelector(selector).closest('li').querySelectorAll('button')].some(button=>button.textContent==='Save role'&&!button.disabled),'role save enabled',selector);
    await a.evaluate(selector=>[...document.querySelector(selector).closest('li').querySelectorAll('button')].find(button=>button.textContent==='Save role').click(),selector);
    await b.wait(role=>document.querySelector('.dashboard-heading')?.textContent.includes('Your role: '+role),'live role changed',role).catch(async error=>{throw new Error(`${error.message}; owner page: ${await a.evaluate(()=>document.body.innerText)}`);});
    await editorReady(b);
  };
  await setRole('VIEWER');await b.wait(()=>document.querySelector('.editor-status')?.textContent.includes('Read-only access'),'read-only status');
  assert.equal(await b.evaluate(()=>!!document.querySelector('[aria-label="New File"]')),false);
  await b.wait(()=>new Promise(resolve=>window.require(['vs/editor/editor.main'],m=>resolve(m.editor.getEditors()[0].getRawOptions().readOnly))),'Monaco read-only after demotion');
  const viewerWrite=await b.evaluate(async(id)=>{const response=await fetch(`http://localhost:4000/api/workspaces/${id}/files`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'viewer-forbidden.ts'})});return response.status;},workspaceId);assert.equal(viewerWrite,403);
  await send(b,'Viewer chat allowed');await messageOnce(a,'Viewer chat allowed');await messageOnce(b,'Viewer chat allowed');
  await b.cdp('Page.reload');await editorReady(b);await chatReady(b);await b.wait(()=>document.querySelector('.dashboard-heading')?.textContent.includes('Your role: VIEWER'),'viewer survives refresh');await messageOnce(b,'Viewer chat allowed');
  await b.cdp('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  // Chrome's offline emulation can leave an already-open WebSocket alive. Close
  // the existing transport through the test harness; reconnect still uses the
  // actual client, network, session and server, with no application debug hook.
  assert.ok(await b.evaluate(()=>{
    const node=document.querySelector('.workspace-chat');const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$'));
    let fiber=node[key];
    while(fiber){let context=fiber.dependencies?.firstContext;while(context){const socket=context.memoizedValue;if(socket?.io?.engine&&typeof socket.emit==='function'){socket.io.engine.close();return true;}context=context.next;}fiber=fiber.return;}
    return false;
  }),'Existing workspace transport found');
  await b.wait(()=>document.querySelector('.workspace-chat [role="status"]')?.textContent!=='Connected','offline');
  await b.cdp('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await editorReady(b);await chatReady(b);await messageOnce(b,'Viewer chat allowed');
  assert.ok(await b.evaluate(()=>new Promise(resolve=>window.require(['vs/editor/editor.main'],m=>resolve(m.editor.getEditors()[0].getRawOptions().readOnly)))));
  await setRole('EDITOR');await b.wait(()=>new Promise(resolve=>window.require(['vs/editor/editor.main'],m=>resolve(!m.editor.getEditors()[0].getRawOptions().readOnly))),'editor upgraded');
  await b.insert('// Upgraded editor\n');await a.wait(()=>new Promise(resolve=>window.require(['vs/editor/editor.main'],m=>resolve(m.editor.getModels()[0].getValue().includes('// Upgraded editor')))),'upgraded editor writes');
  await send(b,'Editor again chat');await messageOnce(a,'Editor again chat');
  console.log('PASS: live editor/viewer/editor changes, read-only UI, direct REST denial, viewer chat and refresh/reconnect');
  const memberSelector=`select[aria-label="Role for ${users[1].body.username}"]`;
  await a.evaluate(selector=>[...document.querySelector(selector).closest('li').querySelectorAll('button')].find(button=>button.textContent==='Remove').click(),memberSelector);
  await a.evaluate(selector=>[...document.querySelector(selector).closest('li').querySelectorAll('button')].find(button=>button.textContent==='Confirm removal').click(),memberSelector);
  await b.wait(()=>document.body.innerText.includes('Workspace unavailable.')&&!document.querySelector('.monaco-editor')&&!document.querySelector('.workspace-chat'),'removed member loses editor/chat');
  await a.wait(()=>document.querySelector('.file-collaborators')?.textContent.includes('Collaborators (0)'),'removed presence cleaned');
  await b.cdp('Page.reload');await b.wait(()=>document.body.innerText.includes('Workspace access denied.'),'removed after refresh');
  await invite();await b.cdp('Page.navigate',{url:'http://localhost:3000/dashboard'});await refreshInbox();await b.click('[data-invite-id] .invitation-actions button:nth-child(2)');await b.wait(()=>document.querySelector('.invitation-inbox')?.textContent.includes('Declined invitation'),'declined');
  assert.equal(await db.workspaceMember.count({where:{workspaceId,userId:users[1].body.id}}),0);
  const c=await browser(users[2].cookie,url);sessions.push(c);await c.wait(()=>document.body.innerText.includes('Workspace access denied.'),'unauthorized C');
  const denied=await c.evaluate(async({workspaceId,memberId})=>{
    const base=`http://localhost:4000/api/workspaces/${workspaceId}`;
    const probes=[['POST',base+'/invites',{email:'someone@example.com',role:'EDITOR'}],['PATCH',base+'/members/'+memberId,{role:'EDITOR'}],['GET',base+'/messages',undefined]];
    return Promise.all(probes.map(async([method,path,body])=>(await fetch(path,{method,credentials:'include',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})).status));
  },{workspaceId,memberId:users[1].body.id});assert.deepEqual(denied,[403,403,403]);
  await a.cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  console.log('PASS: removal immediately closes private UI/presence, refresh preserves denial, re-invite/decline, C denial and responsive member controls');
  for(const page of sessions)assert.deepEqual(page.errors,[],'No uncaught browser errors');
}finally{
  for(const page of sessions)await page.close();
  if(workspaceId)await db.workspace.deleteMany({where:{id:workspaceId}});
  await db.user.deleteMany({where:{email:{in:emails}}});await db.$disconnect();
}

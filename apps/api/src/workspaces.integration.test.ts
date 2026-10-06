import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import request from 'supertest';
import { afterAll, expect, test } from 'vitest';
import { db } from './db.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { hashToken } from './auth.js';

const suffix = randomUUID().slice(0, 8);
const emailA = `phase3-a-${suffix}@example.com`;
const emailB = `phase3-b-${suffix}@example.com`;
const password = 'Workspace-test-password';
const workspaceIds: string[] = [];
let child: ChildProcess | undefined;
afterAll(async () => {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await db.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
  await db.$disconnect();
});

test('workspace CRUD, validation, permissions, PostgreSQL persistence and cascades', async () => {
  const app = createApp();
  const a = request.agent(app);
  const b = request.agent(app);
  const registerA = await a.post('/api/auth/register').set('Origin', config.WEB_ORIGIN).send({ username: `phase3-a-${suffix}`, email: emailA, password });
  const registerB = await b.post('/api/auth/register').set('Origin', config.WEB_ORIGIN).send({ username: `phase3-b-${suffix}`, email: emailB, password });
  expect(registerA.status).toBe(201); expect(registerB.status).toBe(201);
  const cookieA = String(registerA.headers['set-cookie'][0]).split(';')[0];
  const cookieB = String(registerB.headers['set-cookie'][0]).split(';')[0];
  expect((await a.get('/api/workspaces')).body).toEqual([]);
  for (const payload of [{}, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 'Valid', language: 'ruby' }, { name: 'Valid', ownerId: registerB.body.id }, { name: 'Valid', userId: registerB.body.id }]) {
    expect((await a.post('/api/workspaces').set('Origin', config.WEB_ORIGIN).send(payload)).status).toBe(400);
  }
  expect((await a.post('/api/workspaces').set('Origin', config.WEB_ORIGIN).set('Content-Type', 'application/json').send('{invalid')).status).toBe(400);
  expect((await a.post('/api/workspaces').set('Origin', 'https://other.example').send({ name: 'Valid' })).status).toBe(403);
  const created = await a.post('/api/workspaces').set('Origin', config.WEB_ORIGIN).send({ name: `  Workspace ${suffix}  `, language: 'typescript' });
  expect(created.status).toBe(201);
  const id = created.body.id; workspaceIds.push(id);
  const path = `/api/workspaces/${id}`;
  expect(created.body.name).toBe(`Workspace ${suffix}`);
  expect(created.body.ownerId).toBe(registerA.body.id);
  expect(await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId: registerA.body.id } } })).toMatchObject({ role: 'OWNER' });
  expect(await db.file.count({ where: { workspaceId: id } })).toBe(0);
  for (const method of ['get', 'patch', 'delete'] as const) {
    expect((await request(app)[method](path).set('Origin', config.WEB_ORIGIN).send(method === 'patch' ? { name: 'Denied' } : undefined)).status).toBe(401);
    expect((await b[method](path).set('Origin', config.WEB_ORIGIN).send(method === 'patch' ? { name: 'Denied' } : undefined)).status).toBe(403);
    expect((await a[method]('/api/workspaces/invalid').set('Origin', config.WEB_ORIGIN).send(method === 'patch' ? { name: 'Denied' } : undefined)).status).toBe(400);
    expect((await a[method]('/api/workspaces/c000000000000000000000000').set('Origin', config.WEB_ORIGIN).send(method === 'patch' ? { name: 'Denied' } : undefined)).status).toBe(404);
  }
  expect((await request(app).get('/api/workspaces')).status).toBe(401);
  expect((await request(app).post('/api/workspaces').set('Origin', config.WEB_ORIGIN).send({ name: 'Denied' })).status).toBe(401);
  expect((await b.get('/api/workspaces')).body).toEqual([]);
  const list = await a.get('/api/workspaces');
  expect(list.body).toHaveLength(1); expect(list.body[0]).toMatchObject({ id, role: 'OWNER' });
  expect(list.headers['cache-control']).toBe('no-store');
  expect((await a.get(path)).body).toMatchObject({ id, name: created.body.name, role: 'OWNER', owner: { id: registerA.body.id } });
  expect((await a.get(path)).body.members).toHaveLength(1);
  const page = await fetch(`${config.WEB_ORIGIN}/workspace/${id}`, { headers: { Cookie: cookieA } });
  expect(page.status).toBe(200); expect(await page.text()).toContain(created.body.name);
  const deniedPage = await fetch(`${config.WEB_ORIGIN}/workspace/${id}`, { headers: { Cookie: cookieB } });
  const deniedHtml = await deniedPage.text();
  expect(deniedHtml).toContain('Workspace access denied.'); expect(deniedHtml).not.toContain(created.body.name);
  const anonymousPage = await fetch(`${config.WEB_ORIGIN}/workspace/${id}`, { redirect: 'manual' });
  // Next may stream redirects when a loading boundary is present.
  if (anonymousPage.status === 307) expect(anonymousPage.headers.get('location')).toBe('/login');
  else expect(await anonymousPage.text()).toContain('NEXT_REDIRECT');
  for (const role of ['VIEWER', 'EDITOR'] as const) {
    await db.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: id, userId: registerB.body.id } }, create: { workspaceId: id, userId: registerB.body.id, role }, update: { role } });
    expect((await b.get(path)).body.role).toBe(role);
    expect((await b.patch(path).set('Origin', config.WEB_ORIGIN).send({ name: 'Denied' })).status).toBe(403);
    expect((await b.delete(path).set('Origin', config.WEB_ORIGIN)).status).toBe(403);
    const memberPage = await fetch(`${config.WEB_ORIGIN}/workspace/${id}`, { headers: { Cookie: cookieB } });
    const memberHtml = await memberPage.text();
    expect(memberHtml).toContain(created.body.name); expect(memberHtml).not.toContain('Delete workspace'); expect(memberHtml).not.toContain('rename-workspace');
  }
  await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: id, userId: registerB.body.id } } });
  for (const payload of [{ name: '' }, { name: 'x'.repeat(81) }, {}, { name: 'Valid', ownerId: registerB.body.id }, { name: 'Valid', language: 'python' }]) {
    expect((await a.patch(path).set('Origin', config.WEB_ORIGIN).send(payload)).status).toBe(400);
  }
  const renamed = `Renamed ${suffix}`;
  expect((await a.patch(path).set('Origin', config.WEB_ORIGIN).send({ name: `  ${renamed}  ` })).body.name).toBe(renamed);
  expect((await a.get(path)).body.name).toBe(renamed);
  expect((await db.workspace.findUniqueOrThrow({ where: { id } })).name).toBe(renamed);
  expect(await (await fetch(`${config.WEB_ORIGIN}/workspace/${id}`, { headers: { Cookie: cookieA } })).text()).toContain(renamed);
  expect((await a.post('/api/auth/logout').set('Origin', config.WEB_ORIGIN)).status).toBe(204);
  expect((await a.get(path)).status).toBe(401);
  expect((await a.post('/api/auth/login').set('Origin', config.WEB_ORIGIN).send({ email: emailA, password })).status).toBe(200);
  expect((await a.get('/api/workspaces')).body[0]).toMatchObject({ id, name: renamed });

  // Restart a separate real API process while retaining PostgreSQL data.
  const reservation = createServer(); reservation.listen(0); await once(reservation, 'listening');
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('No test port.');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  async function start() {
    let diagnostics = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Test API exited before becoming healthy: ${diagnostics}`);
      try { const response = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Test API did not become healthy.');
  }
  const restartedApi = `http://localhost:${port}`;
  await start();
  const login = await fetch(`${restartedApi}/api/auth/login`, { method: 'POST', headers: { Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailA, password }) });
  expect(login.status).toBe(200);
  const restartCookie = login.headers.get('set-cookie')!.split(';')[0];
  child!.kill(); await once(child!, 'exit'); await start();
  const persisted = await fetch(`${restartedApi}${path}`, { headers: { Cookie: restartCookie } });
  expect(persisted.status).toBe(200); expect((await persisted.json()).name).toBe(renamed);
  child!.kill(); await once(child!, 'exit'); child = undefined;

  // Existing relation fixtures verify cascade deletion without exposing later-phase CRUD UI.
  await db.file.create({ data: { workspaceId: id, name: 'test.txt', type: 'FILE' } });
  await db.message.create({ data: { workspaceId: id, userId: registerA.body.id, message: 'test fixture' } });
  await db.workspaceInvite.create({ data: { workspaceId: id, invitedBy: registerA.body.id, role: 'VIEWER', token: hashToken(randomUUID()), expiresAt: new Date(Date.now() + 60_000) } });
  expect((await a.delete(path).set('Origin', config.WEB_ORIGIN)).status).toBe(204);
  expect((await a.get('/api/workspaces')).body).toEqual([]);
  expect((await a.get(path)).status).toBe(404);
  expect(await db.workspace.findUnique({ where: { id } })).toBeNull();
  for (const count of [await db.workspaceMember.count({ where: { workspaceId: id } }), await db.file.count({ where: { workspaceId: id } }), await db.message.count({ where: { workspaceId: id } }), await db.workspaceInvite.count({ where: { workspaceId: id } })]) expect(count).toBe(0);
}, 120_000);

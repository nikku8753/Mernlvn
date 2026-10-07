import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { hashToken, token } from './auth.js';
import { fakeRunner } from './execution-test-runner.js';

const suffix = randomUUID().slice(0, 8), userIds: string[] = [], workspaceIds: string[] = [], cookies: string[] = [];
const original = { url: config.EXECUTION_URL, key: config.EXECUTION_API_KEY };
let runner: Awaited<ReturnType<typeof fakeRunner>>, app: ReturnType<typeof createApp>;
let workspaceId: string, mainFile: string, folder: string, foreignFile: string;
const files: Record<string, string> = {};
const call = (user: number, id = mainFile, body: unknown = { source: 'current editor source' }) => request(app).post(`/api/files/${id}/run`).set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[user]).send(body);
beforeAll(async () => {
  runner = await fakeRunner(); config.EXECUTION_URL = runner.url; config.EXECUTION_API_KEY = 'phase9-server-only-key';
  for (let i = 0; i < 4; i++) {
    const user = await db.user.create({ data: { username: `exec-${i}-${suffix}`, email: `exec-${i}-${suffix}@example.com`, passwordHash: 'test-fixture-not-a-login-password' } });
    userIds.push(user.id);
    const raw = token(); await db.session.create({ data: { id: hashToken(raw), userId: user.id, expiresAt: new Date(Date.now() + 3600000) } }); cookies.push(`codesync_session=${raw}`);
  }
  // Deliberately different workspace language: only each stored filename counts.
  const workspace = await db.workspace.create({ data: { name: `Execution ${suffix}`, language: 'typescript', ownerId: userIds[0], members: { create: [{ userId: userIds[0], role: 'OWNER' }, { userId: userIds[1], role: 'EDITOR' }, { userId: userIds[3], role: 'VIEWER' }] } } });
  workspaceId = workspace.id; workspaceIds.push(workspace.id);
  for (const name of ['main.js', 'main.py', 'Main.java', 'main.c', 'main.cpp', 'main.ts', 'main.jsx', 'main.txt']) {
    const file = await db.file.create({ data: { name, workspaceId, content: 'stale database content' } }); files[name] = file.id;
  }
  mainFile = files['main.js']; folder = (await db.file.create({ data: { name: 'folder', workspaceId, type: 'FOLDER' } })).id;
  const other = await db.workspace.create({ data: { name: `Other ${suffix}`, language: 'javascript', ownerId: userIds[2], members: { create: { userId: userIds[2], role: 'OWNER' } } } });
  workspaceIds.push(other.id); foreignFile = (await db.file.create({ data: { name: 'private.js', workspaceId: other.id } })).id;
}, 30_000);
beforeEach(async () => {
  runner.state.reset(); config.EXECUTION_URL = runner.url; config.EXECUTION_API_KEY = 'phase9-server-only-key'; app = createApp();
  await db.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId, userId: userIds[1] } }, update: { role: 'EDITOR' }, create: { workspaceId, userId: userIds[1], role: 'EDITOR' } });
});
afterAll(async () => {
  config.EXECUTION_URL = original.url; config.EXECUTION_API_KEY = original.key;
  if (runner) await runner.close();
  await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } }); await db.$disconnect();
});

test('requires existing session authentication and exact Origin', async () => {
  expect((await request(app).post(`/api/files/${mainFile}/run`).set('Origin', config.WEB_ORIGIN).send({ source: 'code' })).status).toBe(401);
  expect((await request(app).post(`/api/files/${mainFile}/run`).set('Origin', config.WEB_ORIGIN).set('Cookie', 'codesync_session=invalid').send({ source: 'code' })).status).toBe(401);
  expect((await request(app).post(`/api/files/${mainFile}/run`).set('Origin', 'https://untrusted.example').set('Cookie', cookies[0]).send({ source: 'code' })).status).toBe(403);
  expect((await request(app).post(`/api/files/${mainFile}/run`).set('Cookie', cookies[0]).send({ source: 'code' })).status).toBe(403);
  const expired = token(); await db.session.create({ data: { id: hashToken(expired), userId: userIds[0], expiresAt: new Date(Date.now() - 1000) } });
  expect((await request(app).post(`/api/files/${mainFile}/run`).set('Origin', config.WEB_ORIGIN).set('Cookie', `codesync_session=${expired}`).send({ source: 'code' })).status).toBe(401);
  expect(runner.state.requests).toHaveLength(0);
});

test('denies VIEWER and nonmembers and isolates workspaces server-side', async () => {
  expect((await call(3)).status).toBe(403); expect((await call(2)).status).toBe(403);
  expect((await call(1, foreignFile)).status).toBe(403);
  expect(runner.state.requests).toHaveLength(0);
});

test('OWNER and EDITOR submit request source and stdin without changing persisted content', async () => {
  for (const user of [0, 1]) {
    const response = await call(user, mainFile, { source: 'unsaved editor text', stdin: 'input\n' });
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ stdout: 'hello\n', status: 'Accepted', statusId: 3 });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toHaveProperty('token'); expect(response.body).not.toHaveProperty('message');
    expect(JSON.stringify(response.body)).not.toContain('phase9-server-only-key');
  }
  expect(runner.state.submissions).toHaveLength(2);
  for (const body of runner.state.submissions) { expect(Buffer.from(String(body.source_code), 'base64').toString()).toBe('unsaved editor text'); expect(Buffer.from(String(body.stdin), 'base64').toString()).toBe('input\n'); }
  expect((await db.file.findUniqueOrThrow({ where: { id: mainFile } })).content).toBe('stale database content');
  expect((await db.file.findUniqueOrThrow({ where: { id: mainFile } })).state).toBeNull();
});

test('uses each file extension for all five languages irrespective of workspace language', async () => {
  for (const name of ['main.js', 'main.py', 'Main.java', 'main.c', 'main.cpp']) expect((await call(0, files[name])).status).toBe(200);
  expect(runner.state.submissions.map(body => body.language_id)).toEqual([63, 71, 62, 50, 54]);
});

test('validates IDs, folders, unsupported file types and actual runner support', async () => {
  expect((await call(0, 'invalid')).status).toBe(400);
  expect((await call(0, 'c000000000000000000000000')).status).toBe(404);
  expect((await call(0, folder)).status).toBe(422);
  for (const name of ['main.ts', 'main.jsx', 'main.txt']) expect((await call(0, files[name])).status).toBe(422);
  runner.state.catalogue = runner.state.catalogue.filter(language => language.id !== 71);
  expect((await call(0, files['main.py'])).status).toBe(422); expect(runner.state.submissions).toHaveLength(0);
});

test('rejects missing, empty, invalid bodies and client identity/permission/language overrides', async () => {
  for (const body of [{}, { source: '' }, { source: '  \n' }, { source: 1 }, { source: 'code', stdin: 1 }, { source: 'code', role: 'OWNER' }, { source: 'code', userId: userIds[0] }, { source: 'code', workspaceId }, { source: 'code', language: 'python' }]) expect((await call(0, mainFile, body)).status).toBe(400);
  expect(runner.state.requests).toHaveLength(0);
});

test('enforces UTF-8 source/input byte limits, accepting the boundaries', async () => {
  for (const body of [{ source: 'x'.repeat(200001) }, { source: '€'.repeat(66667) }, { source: 'code', stdin: 'x'.repeat(4001) }, { source: 'code', stdin: '€'.repeat(1334) }]) expect((await call(0, mainFile, body)).status).toBe(400);
  const response = await call(0, mainFile, { source: 'x'.repeat(200000), stdin: 'x'.repeat(4000) });
  expect(response.status).toBe(200); expect(runner.state.submissions).toHaveLength(1);
});

test('returns compilation, runtime and code time-limit results as safe bounded output', async () => {
  for (const id of [6, 11, 5]) {
    runner.state.statusId = id; runner.state.compileOutput = 'compiler diagnostic'; runner.state.stderr = 'runtime diagnostic'; runner.state.stdout = 'x'.repeat(20000);
    const response = await call(0); expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ statusId: id, stderr: 'runtime diagnostic', compileOutput: 'compiler diagnostic', truncated: true });
    expect(Buffer.byteLength(response.body.stdout)).toBe(16000);
  }
});

test('returns useful sanitized errors for unconfigured, unavailable and malformed runners', async () => {
  config.EXECUTION_URL = ''; expect((await call(0)).status).toBe(503);
  config.EXECUTION_URL = 'http://127.0.0.1:1'; expect((await call(0)).status).toBe(503);
  config.EXECUTION_URL = runner.url;
  runner.state.httpStatus = 401; const denied = await call(0); expect(denied.status).toBe(503); expect(denied.body.error).toContain('credentials'); expect(denied.body.error).not.toContain('upstream private');
  runner.state.httpStatus = 200; runner.state.raw = 'broken JSON'; expect((await call(0)).status).toBe(502);
});

test('blocks stale editor permissions before submission and hides results after removal', async () => {
  runner.state.onLanguages = async () => { await db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: userIds[1] } }, data: { role: 'VIEWER' } }); };
  expect((await call(1)).status).toBe(403); expect(runner.state.submissions).toHaveLength(0);
  await db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: userIds[1] } }, data: { role: 'EDITOR' } });
  runner.state.onLanguages = undefined;
  runner.state.onSubmission = async () => { await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: userIds[1] } } }); };
  expect((await call(1)).status).toBe(403); expect(runner.state.submissions).toHaveLength(1);
});

test('retains the execution rate limit per authenticated user', async () => {
  for (let i = 0; i < 10; i++) expect((await call(0, mainFile, { source: '' })).status).toBe(400);
  expect((await call(0)).status).toBe(429);
  expect((await call(1)).status).toBe(200);
});

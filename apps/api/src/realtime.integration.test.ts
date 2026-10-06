import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { io as client, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { test, expect } from 'vitest';
import { createApp } from './app.js';
import { realtime } from './realtime.js';
import { db } from './db.js';
import { config } from './config.js';
import { documentOperation, discardDocuments } from './documents.js';
import { hashToken } from './auth.js';

test('authenticated Yjs collaboration, concurrency, isolation, persistence and revocation', async () => {
  const app = createApp(); const http = createServer(app); const server = realtime(http);
  await new Promise<void>(resolve => http.listen(0, resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const url = `http://localhost:${address.port}`;
  const suffix = randomUUID().slice(0, 8); const emails = ['a', 'b', 'c'].map(name => `phase5-${name}-${suffix}@example.com`);
  const sockets: Socket[] = []; const documents: Y.Doc[] = []; let workspaceId = '';
  const emit = (socket: Socket, event: string, payload: unknown): Promise<any> => new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error: Error | null, reply: unknown) => error ? reject(error) : resolve(reply)));
  const connect = async (cookie = '', origin = config.WEB_ORIGIN) => {
    const socket = client(url, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: origin }, reconnection: false }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }); return socket;
  };
  const eventually = async (check: () => Promise<boolean> | boolean) => { for (let n = 0; n < 80; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('State did not converge'); };
  try {
    const users = await Promise.all(emails.map((email, i) => request(app).post('/api/auth/register').set('Origin', config.WEB_ORIGIN).send({ username: `phase5-${i}-${suffix}`, email, password: 'Phase5-test-password' })));
    users.forEach(user => expect(user.status).toBe(201));
    const cookies = users.map(user => String(user.headers['set-cookie'][0]).split(';')[0]);
    const created = await request(app).post('/api/workspaces').set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[0]).send({ name: `Realtime ${suffix}` });
    workspaceId = created.body.id;
    await db.workspaceMember.create({ data: { workspaceId, userId: users[1].body.id, role: 'EDITOR' } });
    const f = await db.file.create({ data: { workspaceId, name: 'main.ts', content: 'console.log("CodeSync");' } });
    const other = await db.file.create({ data: { workspaceId, name: 'other.ts', content: 'isolated' } });
    await expect(connect()).rejects.toThrow(); await expect(connect(cookies[0], 'https://evil.example')).rejects.toThrow();
    const a = await connect(cookies[0]); const b = await connect(cookies[1]); const c = await connect(cookies[2]);
    expect((await emit(c, 'file:subscribe', { fileId: f.id })).status).toBe(403);
    expect((await emit(c, 'code:update', { fileId: f.id, update: [0, 0] })).ok).toBe(false);
    expect((await emit(a, 'file:subscribe', { fileId: '../bad' })).status).toBe(400);
    const da = new Y.Doc(); const dbb = new Y.Doc(); documents.push(da, dbb);
    const join = async (socket: Socket, doc: Y.Doc, id = f.id) => {
      const reply = await emit(socket, 'file:subscribe', { fileId: id, vector: Array.from(Y.encodeStateVector(doc)) }); expect(reply.ok).toBe(true);
      Y.applyUpdate(doc, Uint8Array.from(reply.data.update)); return reply.data.vector;
    };
    await join(a, da); await join(b, dbb);
    a.on('code:update', data => { if (data.fileId === f.id) Y.applyUpdate(da, Uint8Array.from(data.update)); });
    b.on('code:update', data => { if (data.fileId === f.id) Y.applyUpdate(dbb, Uint8Array.from(data.update)); });
    const edit = (doc: Y.Doc, at: number, text: string) => { let update!: Uint8Array; const capture = (value: Uint8Array) => { update = value; }; doc.on('update', capture); doc.getText('code').insert(at, text); doc.off('update', capture); return Array.from(update); };
    // Both edits are created BEFORE either reaches the server: genuine concurrency.
    const ua = edit(da, 0, '// A\n'); const ub = edit(dbb, dbb.getText('code').length, '\n// B');
    const replies = await Promise.all([emit(a, 'code:update', { fileId: f.id, update: ua }), emit(b, 'code:update', { fileId: f.id, update: ub })]); replies.forEach(reply => expect(reply.ok).toBe(true));
    await eventually(() => da.getText('code').toString() === dbb.getText('code').toString());
    const expected = da.getText('code').toString(); expect(expected).toContain('// A'); expect(expected).toContain('// B');
    const stale = await request(app).post(`/api/files/${f.id}/save`).set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[0]).send({ content: 'stale', updatedAt: f.updatedAt.toISOString() }); expect(stale.status).toBe(409);
    await eventually(async () => (await db.file.findUniqueOrThrow({ where: { id: f.id } })).content === expected);
    expect((await emit(a, 'file:save', { fileId: f.id })).data.content).toBe(expected);
    const renamed = await request(app).patch(`/api/files/${f.id}`).set('Cookie', cookies[0]).set('Origin', config.WEB_ORIGIN).send({ name: 'renamed.ts' }); expect(renamed.status).toBe(200);
    const isolated = new Y.Doc(); documents.push(isolated); await join(a, isolated, other.id);
    expect(isolated.getText('code').toString()).toBe('isolated');
    expect((await emit(a, 'code:update', { fileId: f.id, update: ua })).status).toBe(409);
    b.disconnect(); await eventually(async () => !!(await db.file.findUniqueOrThrow({ where: { id: f.id } })).state);
    const b2 = await connect(cookies[1]); const vector = await join(b2, dbb);
    expect(dbb.getText('code').toString()).toBe(expected);
    b2.disconnect(); edit(dbb, 0, '// offline\n');
    const b3 = await connect(cookies[1]); const nextVector = await join(b3, dbb);
    expect((await emit(b3, 'code:update', { fileId: f.id, update: Array.from(Y.encodeStateAsUpdate(dbb, Uint8Array.from(nextVector))) })).ok).toBe(true);
    expect((await emit(b3, 'file:save', { fileId: f.id })).data.content).toContain('// offline');
    expect(vector).toBeTruthy();
    await db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: users[1].body.id } }, data: { role: 'VIEWER' } });
    expect((await emit(b3, 'code:update', { fileId: f.id, update: [0, 0] })).status).toBe(403);
    expect((await emit(b3, 'file:save', { fileId: f.id })).status).toBe(403);
    expect((await emit(a, 'code:update', { fileId: other.id, update: [255] })).status).toBe(400);
    const removed = new Promise(resolve => b3.once('file:deleted', resolve));
    expect((await request(app).delete(`/api/files/${f.id}`).set('Cookie', cookies[0]).set('Origin', config.WEB_ORIGIN)).status).toBe(204); await removed;
    expect((await emit(b3, 'file:subscribe', { fileId: f.id })).status).toBe(404);
    await db.session.deleteMany({ where: { id: hashToken(cookies[0].split('=')[1]) } });
    // Session revocation is checked on every event, including existing sockets.
    const disconnected = new Promise(resolve => a.once('disconnect', resolve)); a.emit('file:save', { fileId: other.id }); await disconnected;
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await documentOperation(async () => { const files = await db.file.findMany({ where: { workspaceId }, select: { id: true } }); await discardDocuments(files.map(file => file.id)); });
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { email: { in: emails } } }); documents.forEach(doc => doc.destroy()); await db.$disconnect();
  }
}, 45000);

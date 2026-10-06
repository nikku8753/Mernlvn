import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { io as client, type Socket } from 'socket.io-client';
import { expect, test } from 'vitest';
import { createApp } from './app.js';
import { realtime } from './realtime.js';
import { config } from './config.js';
import { db } from './db.js';
import { hashToken } from './auth.js';
import { documentOperation, discardDocuments } from './documents.js';
import { mergeMessages } from '../../web/src/lib/chat.js';

test('workspace chat authenticates, persists, isolates, paginates and delivers across files/reconnects', async () => {
  const suffix = randomUUID().slice(0, 8);
  const emails = [0,1,2].map(i => `p7-${i}-${suffix}@example.com`);
  const app = createApp(); const server = createServer(app); const io = realtime(server);
  server.listen(0); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port.');
  const sockets: Socket[] = []; const workspaces: string[] = [];
  const emit = (socket: Socket, event: string, payload: unknown): Promise<any> => new Promise((resolve, reject) => socket.timeout(10000).emit(event, payload, (error: Error | null, reply: unknown) => error ? reject(error) : resolve(reply)));
  const connect = async (cookie = '') => {
    const socket = client(`http://localhost:${address.port}`, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: config.WEB_ORIGIN }, reconnection: false }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }); return socket;
  };
  try {
    const users = [];
    for (const [i,email] of emails.entries()) {
      const user = await request(app).post('/api/auth/register').set('Origin', config.WEB_ORIGIN).send({ email, username: `p7-${i}-${suffix}`, password: 'Phase7-test-password' }); expect(user.status).toBe(201); users.push(user);
    }
    const cookies = users.map(user => String(user.headers['set-cookie'][0]).split(';')[0]);
    for (let n = 0; n < 2; n++) {
      const workspace = await request(app).post('/api/workspaces').set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[0]).send({ name: `Chat ${suffix}-${n}` }); expect(workspace.status).toBe(201); workspaces.push(workspace.body.id);
    }
    const [workspaceId, isolatedId] = workspaces;
    await db.workspaceMember.create({ data: { workspaceId, userId: users[1].body.id, role: 'VIEWER' } });
    const path = `/api/workspaces/${workspaceId}/messages`;
    const get = (cookie = cookies[0], query = '') => request(app).get(path + query).set('Cookie', cookie);
    expect((await request(app).get(path)).status).toBe(401);
    expect((await get(cookies[2])).status).toBe(403);
    expect((await request(app).get('/api/workspaces/invalid/messages').set('Cookie', cookies[0])).status).toBe(400);
    expect((await get(cookies[0], '?before=invalid')).status).toBe(400);
    expect((await get()).body).toEqual([]);
    await expect(connect()).rejects.toThrow();
    const a = await connect(cookies[0]); const b = await connect(cookies[1]); const c = await connect(cookies[2]); const isolated = await connect(cookies[0]);
    const receivedA: any[] = []; const receivedB: any[] = []; const receivedC: any[] = []; const unrelated: any[] = [];
    a.on('chat:message', m => receivedA.push(m)); b.on('chat:message', m => receivedB.push(m)); c.on('chat:message', m => receivedC.push(m)); isolated.on('chat:message', m => unrelated.push(m));
    expect((await emit(c, 'chat:subscribe', { workspaceId })).status).toBe(403);
    expect((await emit(c, 'chat:send', { workspaceId, message: 'Denied' })).status).toBe(403);
    expect((await emit(a, 'chat:send', { workspaceId, message: 'Join first' })).status).toBe(409);
    for (const socket of [a,b]) expect((await emit(socket, 'chat:subscribe', { workspaceId })).ok).toBe(true);
    expect((await emit(isolated, 'chat:subscribe', { workspaceId: isolatedId })).ok).toBe(true);
    expect((await emit(a, 'chat:subscribe', { workspaceId: 'invalid' })).status).toBe(400);
    for (const message of ['', ' \n\t ', 'x'.repeat(2001)]) expect((await emit(a, 'chat:send', { workspaceId, message })).status).toBe(400);
    expect((await emit(a, 'chat:send', { workspaceId, message: 'Fake', userId: users[2].body.id })).status).toBe(400);
    const files = await Promise.all(['a.ts','b.ts'].map(name => db.file.create({ data: { workspaceId, name } })));
    expect((await emit(a, 'file:subscribe', { fileId: files[0].id })).ok).toBe(true);
    expect((await emit(b, 'file:subscribe', { fileId: files[1].id })).ok).toBe(true);
    const delivered = new Promise(resolve => b.once('chat:message', resolve));
    const first = await emit(a, 'chat:send', { workspaceId, message: '  Hello B\n<script>alert(1)</script>  ' }); expect(first.ok).toBe(true); await delivered;
    expect(first.data.message).toBe('Hello B\n<script>alert(1)</script>');
    expect(first.data.user).toEqual({ id: users[0].body.id, username: users[0].body.username });
    expect(Object.keys(first.data).sort()).toEqual(['createdAt','id','message','user','workspaceId']);
    expect((await db.message.findUniqueOrThrow({ where: { id: first.data.id } })).userId).toBe(users[0].body.id);
    const deliveredBack = new Promise(resolve => a.once('chat:message', resolve));
    const second = await emit(b, 'chat:send', { workspaceId, message: 'Hello A' }); expect(second.ok).toBe(true); await deliveredBack;
    expect(receivedA).toHaveLength(2); expect(receivedB).toHaveLength(2); expect(receivedC).toEqual([]); expect(unrelated).toEqual([]);
    const history = await get(); expect(history.headers['cache-control']).toBe('no-store'); expect(history.body).toEqual([first.data,second.data]);
    expect(mergeMessages(receivedA, [first.data,second.data,first.data])).toHaveLength(2);
    // File unsubscribe/switch preserves workspace chat; chat unsubscribe preserves file access.
    expect((await emit(a, 'file:unsubscribe', {})).ok).toBe(true);
    expect((await emit(a, 'file:subscribe', { fileId: files[1].id })).ok).toBe(true);
    const third = await emit(a, 'chat:send', { workspaceId, message: 'Still here' }); expect(third.ok).toBe(true);
    expect((await emit(a, 'chat:unsubscribe', { workspaceId })).ok).toBe(true);
    const beforeLeave = receivedA.length;
    expect((await emit(b, 'chat:send', { workspaceId, message: 'While A left chat' })).ok).toBe(true);
    expect(receivedA).toHaveLength(beforeLeave);
    expect((await emit(a, 'file:subscribe', { fileId: files[0].id })).ok).toBe(true);
    b.disconnect(); const b2 = await connect(cookies[1]);
    expect((await emit(b2, 'chat:subscribe', { workspaceId })).ok).toBe(true);
    const refreshed = (await get(cookies[1])).body;
    expect(refreshed).toHaveLength(4); expect(mergeMessages(receivedB, refreshed)).toHaveLength(4);
    expect((await get(cookies[0], `?after=${second.data.id}`)).body).toHaveLength(2);
    // Deterministic tied timestamps and bounded cursor pages with no overlap.
    await db.message.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ workspaceId, userId: users[0].body.id, message: `History ${i}`, createdAt: new Date('2099-01-01T00:00:00Z') })) });
    const latest = (await get()).body; expect(latest).toHaveLength(100);
    expect(latest.map((m:any) => m.id)).toEqual(latest.map((m:any) => m.id).sort());
    const earlier = (await get(cookies[0], `?before=${latest[0].id}`)).body; expect(earlier).toHaveLength(9);
    expect(new Set([...earlier,...latest].map(m => m.id)).size).toBe(109);
    const foreign = await db.message.create({ data: { workspaceId: isolatedId, userId: users[0].body.id, message: 'Private' } });
    expect((await get(cookies[0], `?before=${foreign.id}`)).status).toBe(400);
    expect((await get(cookies[0], '?after=invalid')).status).toBe(400);
    expect((await request(app).post(path).set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[2]).send({ message: 'Denied REST' })).status).toBe(403);
    expect((await request(app).post(path).set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[0]).send({ message: 'Fake REST', userId: users[2].body.id })).status).toBe(400);
    // Existing REST sends use the same validated publication path.
    const restDelivery = new Promise(resolve => b2.once('chat:message', resolve));
    expect((await request(app).post(path).set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[0]).send({ message: 'REST compatibility' })).status).toBe(201); await restDelivery;
    await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: users[1].body.id } } });
    const revoked = new Promise(resolve => b2.once('disconnect', resolve));
    expect((await request(app).post(path).set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[0]).send({ message: 'After removal' })).status).toBe(201); await revoked;
    expect((await get(cookies[1])).status).toBe(403);
    await db.session.deleteMany({ where: { id: hashToken(cookies[0].split('=')[1]) } });
    const expired = new Promise(resolve => a.once('disconnect', resolve));
    a.emit('chat:send', { workspaceId, message: 'Expired session' }); await expired;
    expect(await db.message.count({ where: { workspaceId, message: 'Expired session' } })).toBe(0);
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await documentOperation(async () => { const files = await db.file.findMany({ where: { workspaceId: { in: workspaces } }, select: { id: true } }); await discardDocuments(files.map(file => file.id)); });
    await new Promise<void>(resolve => io.close(() => resolve()));
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { email: { in: emails } } }); await db.$disconnect();
  }
}, 60000);

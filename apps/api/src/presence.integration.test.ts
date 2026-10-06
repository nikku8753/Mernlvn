import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { io as client, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { expect, test } from 'vitest';
import { createApp } from './app.js';
import { realtime } from './realtime.js';
import { config } from './config.js';
import { db } from './db.js';
import { discardDocuments, documentOperation } from './documents.js';
import { hashToken } from './auth.js';

test('Phase 6 authorized ephemeral presence, relative cursors, selections and lifecycle', async () => {
  const app = createApp(); const http = createServer(app); const server = realtime(http);
  await new Promise<void>(resolve => http.listen(0, resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const suffix = randomUUID().slice(0, 8);
  const emails = ['a', 'b', 'c'].map(n => `p6-${n}-${suffix}@example.com`);
  const sockets: Socket[] = []; const docs: Y.Doc[] = []; let workspaceId = '';
  const rosters = new Map<Socket, any[]>(); const cursors = new Map<Socket, any[]>();
  const emit = (socket: Socket, event: string, payload: unknown): Promise<any> => new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error: Error | null, reply: unknown) => error ? reject(error) : resolve(reply)));
  const eventually = async (check: () => boolean | Promise<boolean>) => { for (let n = 0; n < 100; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Presence did not converge'); };
  async function connect(cookie: string) {
    const socket = client(`http://localhost:${address && typeof address !== 'string' ? address.port : 0}`, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: config.WEB_ORIGIN }, reconnection: false });
    sockets.push(socket); rosters.set(socket, []); cursors.set(socket, []);
    socket.on('presence:state', data => rosters.set(socket, data.entries));
    socket.on('presence:cursor', data => cursors.get(socket)!.push(data));
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }); return socket;
  }
  async function join(socket: Socket, fileId: string) {
    const sync = await emit(socket, 'file:subscribe', { fileId }); expect(sync.ok).toBe(true);
    const doc = new Y.Doc(); docs.push(doc); Y.applyUpdate(doc, Uint8Array.from(sync.data.update)); return doc;
  }
  const selection = (doc: Y.Doc, anchor: number, head = anchor) => ({ anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.getText('code'), anchor)), head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.getText('code'), head)) });
  try {
    const users = await Promise.all(emails.map((email, i) => request(app).post('/api/auth/register').set('Origin', config.WEB_ORIGIN).send({ username: `p6-${i}-${suffix}`, email, password: 'Phase6-test-password' })));
    users.forEach(user => expect(user.status).toBe(201));
    const cookies = users.map(user => String(user.headers['set-cookie'][0]).split(';')[0]);
    workspaceId = (await request(app).post('/api/workspaces').set('Origin', config.WEB_ORIGIN).set('Cookie', cookies[0]).send({ name: `Presence ${suffix}` })).body.id;
    await db.workspaceMember.create({ data: { workspaceId, userId: users[1].body.id, role: 'EDITOR' } });
    const main = await db.file.create({ data: { workspaceId, name: 'main.ts', content: 'const message = "hello";\n' } });
    const other = await db.file.create({ data: { workspaceId, name: 'app.ts', content: 'isolated' } });
    const a = await connect(cookies[0]); const b = await connect(cookies[1]); const c = await connect(cookies[2]);
    expect((await emit(c, 'file:subscribe', { fileId: main.id })).status).toBe(403);
    expect((await emit(c, 'presence:update', { fileId: main.id, selection: null })).ok).toBe(false);
    const da = await join(a, main.id); const dbb = await join(b, main.id);
    await eventually(() => rosters.get(a)!.length === 2 && rosters.get(b)!.length === 2);
    const bEntry = rosters.get(a)!.find(entry => entry.connectionId === b.id);
    expect(bEntry.color).not.toBe(rosters.get(a)!.find(entry => entry.connectionId === a.id).color);
    expect(bEntry.userId).toBe(users[1].body.id); expect(bEntry.username).toBe(users[1].body.username);
    expect(Object.keys(bEntry).sort()).toEqual(['color', 'connectionId', 'selection', 'userId', 'username']);
    const snapshot = await db.file.findUniqueOrThrow({ where: { id: main.id } });
    for (const [sender, doc, receiver] of [[a, da, b], [b, dbb, a]] as const) {
      const value = selection(doc, 2, 12);
      expect((await emit(sender, 'presence:update', { fileId: main.id, selection: value })).ok).toBe(true);
      await eventually(() => cursors.get(receiver)!.some(data => data.entry.connectionId === sender.id && data.entry.selection?.head.item?.clock === value.head.item?.clock));
    }
    const after = await db.file.findUniqueOrThrow({ where: { id: main.id } });
    expect(after.content).toBe(snapshot.content); expect(after.state).toEqual(snapshot.state); expect(after.updatedAt).toEqual(snapshot.updatedAt);
    expect(rosters.get(c)).toEqual([]); expect(cursors.get(c)).toEqual([]);
    expect((await emit(a, 'presence:update', { fileId: main.id, selection: null, userId: users[1].body.id })).status).toBe(400);
    expect((await emit(a, 'presence:update', { fileId: main.id, selection: { anchor: { tname: 'secret', assoc: 0 }, head: { tname: 'code', assoc: 0 } } })).status).toBe(400);
    expect((await emit(a, 'presence:update', { fileId: main.id, selection: { anchor: { tname: 'code', assoc: 0, item: { client: 987654321, clock: 999 } }, head: { tname: 'code', assoc: 0 } } })).status).toBe(400);
    expect((await emit(a, 'presence:update', { fileId: '../bad', selection: null })).status).toBe(400);
    expect((await emit(a, 'presence:update', { fileId: other.id, selection: null })).status).toBe(409);
    // Relative positions survive inserts before the selection without cursor writes.
    const value = selection(da, 2, 12); const vector = Y.encodeStateVector(da); da.getText('code').insert(0, '// prefix\n');
    expect((await emit(a, 'code:update', { fileId: main.id, update: Array.from(Y.encodeStateAsUpdate(da, vector)) })).ok).toBe(true);
    expect(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(value.anchor), da)?.index).toBe(12);
    await join(b, other.id); await eventually(() => rosters.get(a)!.length === 1 && rosters.get(b)!.length === 1);
    const received = cursors.get(b)!.length;
    await emit(a, 'presence:update', { fileId: main.id, selection: value });
    await emit(a, 'file:save', { fileId: main.id }); expect(cursors.get(b)!.length).toBe(received);
    expect((await emit(b, 'presence:update', { fileId: main.id, selection: null })).status).toBe(409);
    await join(b, main.id); await eventually(() => rosters.get(a)!.length === 2);
    const bTab = await connect(cookies[1]); await join(bTab, main.id);
    await eventually(() => rosters.get(a)!.length === 3); b.disconnect();
    await eventually(() => rosters.get(a)!.length === 2 && rosters.get(a)!.some(entry => entry.connectionId === bTab.id));
    expect(rosters.get(a)!.find(entry => entry.connectionId === bTab.id).color).toBe(bEntry.color);
    await emit(bTab, 'file:unsubscribe', {}); await eventually(() => rosters.get(a)!.length === 1);
    const bAgain = await connect(cookies[1]); const fresh = await join(bAgain, main.id);
    await eventually(() => rosters.get(a)!.length === 2);
    expect((await emit(bAgain, 'presence:update', { fileId: main.id, selection: selection(fresh, 0) })).ok).toBe(true);
    // Viewers can show cursors but remain unable to edit the document.
    await db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: users[1].body.id } }, data: { role: 'VIEWER' } });
    expect((await emit(bAgain, 'presence:update', { fileId: main.id, selection: null })).ok).toBe(true);
    expect((await emit(bAgain, 'code:update', { fileId: main.id, update: [0, 0] })).status).toBe(403);
    // Recipient revalidation prevents information leaks after membership removal.
    await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: users[1].body.id } } });
    const revoked = new Promise(resolve => bAgain.once('disconnect', resolve));
    await emit(a, 'presence:update', { fileId: main.id, selection: null }); await revoked;
    await eventually(() => rosters.get(a)!.length === 1);
    const deleted = new Promise(resolve => a.once('file:deleted', resolve));
    expect((await request(app).delete(`/api/files/${main.id}`).set('Cookie', cookies[0]).set('Origin', config.WEB_ORIGIN)).status).toBe(204); await deleted;
    expect((await emit(a, 'presence:update', { fileId: main.id, selection: null })).status).toBe(409);
    expect(server.sockets.sockets.get(a.id!)!.data.presence).toBeUndefined();
    await join(a, other.id);
    await db.session.deleteMany({ where: { id: hashToken(cookies[0].split('=')[1]) } });
    const expired = new Promise(resolve => a.once('disconnect', resolve)); a.emit('presence:update', { fileId: other.id, selection: null }); await expired;
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await documentOperation(async () => { const files = await db.file.findMany({ where: { workspaceId }, select: { id: true } }); await discardDocuments(files.map(file => file.id)); });
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { email: { in: emails } } }); docs.forEach(doc => doc.destroy()); await db.$disconnect();
  }
}, 45000);

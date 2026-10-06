import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { expect, test } from 'vitest';
import { createApp } from './app.js';
import { config } from './config.js';
import { db } from './db.js';

test('collaborative CRDT identity and offline edits survive API process restart', async () => {
  const suffix = randomUUID().slice(0, 8); const email = `phase5-restart-${suffix}@example.com`;
  const reservation = createServer(); reservation.listen(0); await once(reservation, 'listening');
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  let child: ChildProcess | undefined; let socket: Socket | undefined; let workspaceId: string | undefined;
  const doc = new Y.Doc();
  async function start() {
    let diagnostics = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    for (let n = 0; n < 150; n++) {
      if (child.exitCode !== null) throw new Error(diagnostics);
      try { if ((await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('API did not start.');
  }
  const emit = (event: string, payload: unknown): Promise<any> => new Promise((resolve, reject) => socket!.timeout(15000).emit(event, payload, (error: Error | null, reply: any) => error ? reject(new Error(`${event}: ${error.message}`)) : reply.ok ? resolve(reply.data) : reject(new Error(reply.error))));
  try {
    const app = createApp(); const registered = await request(app).post('/api/auth/register').set('Origin', config.WEB_ORIGIN).send({ email, username: `p5-restart-${suffix}`, password: 'Phase5-test-password' }); expect(registered.status).toBe(201);
    const cookie = String(registered.headers['set-cookie'][0]).split(';')[0];
    const workspace = await request(app).post('/api/workspaces').set('Origin', config.WEB_ORIGIN).set('Cookie', cookie).send({ name: `Restart ${suffix}` }); workspaceId = workspace.body.id;
    const file = await db.file.create({ data: { workspaceId: workspaceId!, name: 'main.ts', content: 'seed\n' } });
    async function connect() {
      socket = io(`http://localhost:${port}`, { transports: ['websocket'], extraHeaders: { Origin: config.WEB_ORIGIN, Cookie: cookie }, reconnection: false });
      await new Promise<void>((resolve, reject) => { socket!.once('connect', resolve); socket!.once('connect_error', reject); });
      const sync = await emit('file:subscribe', { fileId: file.id, vector: Array.from(Y.encodeStateVector(doc)) });
      Y.applyUpdate(doc, Uint8Array.from(sync.update));
      await emit('code:update', { fileId: file.id, update: Array.from(Y.encodeStateAsUpdate(doc, Uint8Array.from(sync.vector))) });
    }
    await start(); await connect(); expect(doc.getText('code').toString()).toBe('seed\n');
    const vector = Y.encodeStateVector(doc); doc.getText('code').insert(doc.getText('code').length, 'persisted\n');
    await emit('code:update', { fileId: file.id, update: Array.from(Y.encodeStateAsUpdate(doc, vector)) });
    await emit('file:save', { fileId: file.id });
    socket!.disconnect(); child!.kill(); await once(child!, 'exit');
    doc.getText('code').insert(0, 'offline\n');
    await start(); await connect();
    expect(doc.getText('code').toString()).toBe('offline\nseed\npersisted\n');
    expect((await emit('file:save', { fileId: file.id })).content).toBe('offline\nseed\npersisted\n');
    const fresh = new Y.Doc(); const persisted = await db.file.findUniqueOrThrow({ where: { id: file.id } });
    Y.applyUpdate(fresh, persisted.state!); expect(fresh.getText('code').toString()).toBe(persisted.content); fresh.destroy();
  } finally {
    socket?.disconnect(); if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { email } }); doc.destroy(); await db.$disconnect();
  }
}, 120000);

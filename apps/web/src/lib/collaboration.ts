import { io, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { API_URL, ApiError } from './api';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string; status: number };
type Sync = { update: number[]; vector: number[] };
export type Persisted = { content: string; updatedAt: string };
export class Collaboration {
  readonly doc = new Y.Doc();
  readonly socket: Socket;
  private joined = false;
  private disposed = false;
  private pending: Promise<unknown> = Promise.resolve();
  private failure: Error | null = null;
  private ready = false;
  constructor(readonly fileId: string, readonly writable: boolean, private callbacks: {
    state: (state: string) => void; change: (content: string) => void;
    saved: (saved: Persisted) => void; error: (error: Error) => void;
    deleted: () => void; files: () => void; ready: () => void;
  }) {
    this.socket = io(API_URL, { withCredentials: true, autoConnect: false, reconnectionDelayMax: 3000 });
    this.doc.getText('code').observe(() => callbacks.change(this.doc.getText('code').toString()));
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this && this.joined && writable) this.send(update);
    });
    this.socket.on('connect', () => { void this.synchronize(); });
    this.socket.on('disconnect', () => { this.joined = false; callbacks.state('Reconnecting…'); });
    this.socket.on('connect_error', (error: Error) => {
      this.joined = false; callbacks.state('Offline');
      if (/sign in|authenticate/i.test(error.message)) callbacks.error(new Error('Please sign in again. Copy any pending edits before leaving this page.'));
    });
    this.socket.on('code:update', (data: { fileId: string; update: number[] }) => {
      if (data.fileId === fileId) Y.applyUpdate(this.doc, Uint8Array.from(data.update), this);
    });
    this.socket.on('file:persisted', (data: Persisted & { fileId: string; error?: string }) => {
      if (data.fileId !== fileId) return;
      if (data.error) callbacks.error(new Error(data.error)); else callbacks.saved(data);
    });
    this.socket.on('files:changed', callbacks.files);
    this.socket.on('file:deleted', (data: { fileId: string }) => { if (data.fileId === fileId) { this.joined = false; callbacks.deleted(); } });
    this.socket.on('access:revoked', () => { this.joined = false; callbacks.state('Offline'); callbacks.error(new ApiError('Your session or workspace access ended. Copy any pending edits before leaving.', 403)); });
    callbacks.state('Connecting…'); this.socket.connect();
  }
  private request<T>(event: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket.connected) return reject(new Error('Offline. Keep this page open and reconnect before saving.'));
      this.socket.timeout(10000).emit(event, payload, (error: Error | null, reply: Reply<T>) => {
        if (error) reject(new Error('The server did not acknowledge the update. Reconnect and retry Save.'));
        else if (!reply.ok) reject(new ApiError(reply.error, reply.status)); else resolve(reply.data);
      });
    });
  }
  private send(update: Uint8Array) {
    this.pending = this.pending.then(async () => {
      if (!this.joined || this.disposed) return;
      await this.request('code:update', { fileId: this.fileId, update: Array.from(update) });
    }).catch(error => { this.failure = error; if (!this.disposed) this.callbacks.error(error); });
  }
  private async synchronize() {
    this.joined = false; this.callbacks.state('Connecting…');
    try {
      const sync = await this.request<Sync>('file:subscribe', { fileId: this.fileId, vector: Array.from(Y.encodeStateVector(this.doc)) });
      if (this.disposed) return;
      Y.applyUpdate(this.doc, Uint8Array.from(sync.update), this);
      // Replays edits made while disconnected using the server's state vector.
      this.joined = true;
      if (this.writable) {
        this.pending = this.request('code:update', { fileId: this.fileId, update: Array.from(Y.encodeStateAsUpdate(this.doc, Uint8Array.from(sync.vector))) });
        await this.pending;
      }
      if (this.disposed) return;
      this.failure = null; this.joined = true; this.callbacks.state('Connected');
      if (!this.ready) { this.ready = true; this.callbacks.ready(); }
    } catch (error) { this.joined = false; this.failure = error as Error; if (!this.disposed) { this.callbacks.state('Offline'); this.callbacks.error(error as Error); } }
  }
  async save(): Promise<Persisted> {
    // Drain updates appended while a preceding acknowledgement was outstanding.
    let pending: Promise<unknown>;
    do { pending = this.pending; await pending.catch(() => undefined); } while (pending !== this.pending);
    if (!this.joined && this.socket.connected) await this.synchronize();
    if (!this.joined) throw new Error('Reconnect before saving. Your edits are retained in this page.');
    if (this.failure) { await this.synchronize(); if (this.failure) throw this.failure; }
    return this.request<Persisted>('file:save', { fileId: this.fileId });
  }
  destroy() { this.disposed = true; this.joined = false; this.socket.removeAllListeners(); this.socket.disconnect(); this.doc.destroy(); }
}

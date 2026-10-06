import { io, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { API_URL, ApiError } from './api';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string; status: number };
type Sync = { update: number[]; vector: number[] };
export type Persisted = { content: string; updatedAt: string };
export type RemoteSelection = { anchor: { tname: 'code'; item?: { client: number; clock: number }; assoc: number }; head: { tname: 'code'; item?: { client: number; clock: number }; assoc: number } } | null;
export type Presence = { connectionId: string; userId: string; username: string; color: number; selection: RemoteSelection };
export class Collaboration {
  readonly doc = new Y.Doc();
  readonly socket: Socket;
  private ownedListeners: Array<() => void> = [];
  private ownsSocket = true;
  private listen(event: string, listener: (...args: any[]) => void) {
    this.socket.on(event, listener);
    this.ownedListeners.push(() => this.socket.off(event, listener));
  }
  private joined = false;
  private disposed = false;
  private pending: Promise<unknown> = Promise.resolve();
  private failure: Error | null = null;
  private ready = false;
  private entries = new Map<string, Presence>();
  private presenceListeners = new Set<() => void>();
  private selection: RemoteSelection = null;
  private cursorTimer?: ReturnType<typeof setTimeout>;
  private cursorSending = false;
  private cursorVersion = 0;
  get presence() { return [...this.entries.values()]; }
  onPresence(listener: () => void) { this.presenceListeners.add(listener); return () => { this.presenceListeners.delete(listener); }; }
  private presenceChanged() { this.presenceListeners.forEach(listener => listener()); }
  private clearPresence() { this.entries.clear(); clearTimeout(this.cursorTimer); this.cursorTimer = undefined; this.presenceChanged(); }
  setSelection(selection: RemoteSelection) { this.selection = selection; this.cursorVersion++; this.scheduleCursor(); }
  private scheduleCursor() {
    if (!this.joined || this.disposed || this.cursorTimer || this.cursorSending) return;
    // One in-flight update; coalesce movement to at most 12.5 Hz.
    this.cursorTimer = setTimeout(() => { this.cursorTimer = undefined; void this.sendCursor(); }, 80);
  }
  private async sendCursor() {
    this.cursorSending = true;
    let version = this.cursorVersion;
    try {
      let pending: Promise<unknown>;
      do { pending = this.pending; await pending.catch(() => undefined); } while (pending !== this.pending);
      if (!this.joined || this.disposed) return;
      version = this.cursorVersion;
      await this.request('presence:update', { fileId: this.fileId, selection: this.selection });
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status) && !this.disposed) this.callbacks.error(error);
    } finally { this.cursorSending = false; if (version !== this.cursorVersion) this.scheduleCursor(); }
  }
  constructor(readonly fileId: string, readonly writable: boolean, private callbacks: {
    state: (state: string) => void; change: (content: string) => void;
    saved: (saved: Persisted) => void; error: (error: Error) => void;
    deleted: () => void; files: () => void; ready: () => void;
  }, sharedSocket?: Socket) {
    this.ownsSocket = !sharedSocket;
    this.socket = sharedSocket ?? io(API_URL, { withCredentials: true, autoConnect: false, reconnectionDelayMax: 3000 });
    this.doc.getText('code').observe(() => callbacks.change(this.doc.getText('code').toString()));
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this && this.joined && writable) this.send(update);
    });
    this.listen('connect', () => { void this.synchronize(); });
    this.listen('disconnect', () => { this.joined = false; this.clearPresence(); callbacks.state('Reconnecting…'); });
    this.listen('connect_error', (error: Error) => {
      this.joined = false; callbacks.state('Offline');
      if (/sign in|authenticate/i.test(error.message)) callbacks.error(new Error('Please sign in again. Copy any pending edits before leaving this page.'));
    });
    this.listen('code:update', (data: { fileId: string; update: number[] }) => {
      if (data.fileId === fileId) Y.applyUpdate(this.doc, Uint8Array.from(data.update), this);
    });
    this.listen('file:persisted', (data: Persisted & { fileId: string; error?: string }) => {
      if (data.fileId !== fileId) return;
      if (data.error) callbacks.error(new Error(data.error)); else callbacks.saved(data);
    });
    this.listen('files:changed', callbacks.files);
    this.listen('presence:state', (data: { fileId: string; entries: Presence[] }) => {
      if (data.fileId !== fileId || this.disposed) return;
      this.entries = new Map(data.entries.map(entry => [entry.connectionId, entry])); this.presenceChanged();
    });
    this.listen('presence:cursor', (data: { fileId: string; entry: Presence }) => {
      if (data.fileId !== fileId || this.disposed || !this.entries.has(data.entry.connectionId)) return;
      this.entries.set(data.entry.connectionId, data.entry); this.presenceChanged();
    });
    this.listen('file:deleted', (data: { fileId: string }) => { if (data.fileId === fileId) { this.joined = false; this.clearPresence(); callbacks.deleted(); } });
    this.listen('access:revoked', () => { this.joined = false; this.clearPresence(); callbacks.state('Offline'); callbacks.error(new ApiError('Your session or workspace access ended. Copy any pending edits before leaving.', 403)); });
    callbacks.state('Connecting…');
    if (this.socket.connected) void this.synchronize();
    else if (this.ownsSocket) this.socket.connect();
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
      this.scheduleCursor();
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
  destroy() { this.disposed = true; this.joined = false; this.clearPresence(); this.presenceListeners.clear(); this.ownedListeners.forEach(remove => remove()); this.ownedListeners = []; if (this.ownsSocket) this.socket.disconnect(); else if (this.socket.connected) this.socket.emit('file:unsubscribe', {}); this.doc.destroy(); }
}

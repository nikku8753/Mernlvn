'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { type ChatMessage, mergeMessages } from '@/lib/chat';
import { socketRequest, useWorkspaceSocket } from '@/lib/workspace-socket';

export function WorkspaceChat({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const socket = useWorkspaceSocket();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [older, setOlder] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const newest = useRef<ChatMessage | undefined>(undefined);
  const sendLock = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const add = (items: ChatMessage[]) => {
    setMessages(previous => mergeMessages(previous, items));
  };
  useEffect(() => {
    if (!socket) return;
    let active = true;
    let generation = 0;
    const controller = new AbortController();
    async function synchronize() {
      const version = ++generation;
      setConnected(false); setError(''); setLoading(true);
      const cursor = newest.current;
      let checkpoint = cursor;
      try {
        await socketRequest(socket!, 'chat:subscribe', { workspaceId });
        let after = cursor?.id;
        do {
          const page = await api<ChatMessage[]>(`/api/workspaces/${workspaceId}/messages${after ? `?after=${after}` : ''}`, { signal: controller.signal });
          if (!active || version !== generation) return;
          add(page);
          checkpoint = page.at(-1) || checkpoint;
          if (!cursor) { setOlder(page.length === 100); break; }
          if (page.length < 100) break;
          after = page.at(-1)!.id;
        } while (active);
        if (active && version === generation && socket!.connected) { newest.current = checkpoint; setConnected(true); }
      } catch (error) { if (active && version === generation) {
        if (error instanceof ApiError && [401,403,404].includes(error.status)) { setMessages([]); newest.current = undefined; }
        setError(error instanceof Error ? error.message : 'Unable to load chat.');
      } }
      finally { if (active && version === generation) setLoading(false); }
    }
    const receive = (message: ChatMessage) => { if (active && message.workspaceId === workspaceId) add([message]); };
    const offline = () => { generation++; setConnected(false); setLoading(false); };
    const revoked = () => { offline(); setMessages([]); newest.current = undefined; setError('Your session or workspace access ended.'); };
    const connectionError = (error: Error) => { offline(); setError(error.message); };
    socket.on('chat:message', receive); socket.on('connect', synchronize); socket.on('disconnect', offline);
    socket.on('access:revoked', revoked); socket.on('connect_error', connectionError);
    if (socket.connected) void synchronize();
    return () => {
      active = false; controller.abort(); generation++;
      socket.off('chat:message', receive); socket.off('connect', synchronize); socket.off('disconnect', offline);
      socket.off('access:revoked', revoked); socket.off('connect_error', connectionError);
      if (socket.connected) socket.emit('chat:unsubscribe', { workspaceId });
    };
  }, [socket, workspaceId, retry]);
  useEffect(() => { if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [messages]);
  async function loadOlder() {
    if (loading || !messages.length) return;
    setLoading(true); setError('');
    try {
      const page = await api<ChatMessage[]>(`/api/workspaces/${workspaceId}/messages?before=${messages[0].id}`);
      follow.current = false; add(page); setOlder(page.length === 100);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to load history.'); }
    finally { setLoading(false); }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!socket || !connected || sendLock.current || !draft.trim()) return;
    sendLock.current = true; setSending(true); setError('');
    try {
      const message = await socketRequest<ChatMessage>(socket, 'chat:send', { workspaceId, message: draft });
      follow.current = true; add([message]); setDraft('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to send message.'); }
    finally { sendLock.current = false; setSending(false); }
  }
  return <section className="dashboard-card workspace-chat" aria-labelledby="chat-heading">
    <div className="card-heading"><h2 id="chat-heading">Workspace chat</h2><span className="muted" role="status">{connected ? 'Connected' : loading ? 'Loading history…' : 'Offline / reconnecting'}</span></div>
    {error && <div><p className="form-error" role="alert">{error}</p>{!connected && socket?.connected && <button className="button button-secondary button-small" disabled={loading} onClick={() => setRetry(value => value + 1)}>Retry chat</button>}</div>}
    <div className="chat-history" ref={list} role="log" aria-label="Workspace messages" aria-live="polite" onScroll={() => { const element = list.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; }}>
      {older && <button className="button button-secondary button-small" disabled={loading} onClick={loadOlder}>Load earlier messages</button>}
      {!messages.length && <p className="muted">{loading ? 'Loading messages…' : 'No messages yet. Start the conversation.'}</p>}
      {messages.map(message => <article key={message.id} className={`chat-message${message.user.id === userId ? ' chat-message-own' : ''}`}>
        <div className="chat-message-heading"><strong>{message.user.username}{message.user.id === userId ? ' (you)' : ''}</strong><time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
        <p>{message.message}</p>
      </article>)}
    </div>
    <form className="chat-compose" onSubmit={send}><label htmlFor="chat-message">Message<textarea id="chat-message" rows={3} maxLength={2000} value={draft} disabled={sending} placeholder="Message everyone in this workspace" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /></label><div className="chat-compose-actions"><span className="muted">Enter to send · Shift+Enter for a new line · {draft.length}/2000</span><button className="button button-small" disabled={!connected || sending || !draft.trim()}>{sending ? 'Sending…' : 'Send'}</button></div></form>
  </section>;
}

'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, ApiError } from './api';

const WorkspaceSocket = createContext<Socket | null>(null);
export function WorkspaceSocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  useEffect(() => {
    const connection = io(API_URL, { withCredentials: true, autoConnect: false, reconnectionDelayMax: 3000 });
    setSocket(connection); connection.connect();
    return () => { connection.disconnect(); connection.removeAllListeners(); };
  }, []);
  return <WorkspaceSocket.Provider value={socket}>{children}</WorkspaceSocket.Provider>;
}
export function useWorkspaceSocket() { return useContext(WorkspaceSocket); }
export function socketRequest<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) return reject(new Error('Chat is offline. Reconnect before sending.'));
    socket.timeout(10000).emit(event, payload, (error: Error | null, reply: { ok: true; data: T } | { ok: false; status: number; error: string }) => {
      if (error) reject(new Error('Delivery was not confirmed. Check chat history after reconnecting before retrying.'));
      else if (!reply.ok) reject(new ApiError(reply.error, reply.status));
      else resolve(reply.data);
    });
  });
}

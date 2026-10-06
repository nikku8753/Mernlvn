'use client';
import { useEffect, useRef } from 'react';
import { useWorkspaceSocket } from '@/lib/workspace-socket';
import type { WorkspaceRole } from '@/lib/workspaces';

export function WorkspaceAccess({ workspaceId, onChanged, onRevoked }: { workspaceId: string; onChanged: (role?: WorkspaceRole) => void; onRevoked: () => void }) {
  const socket = useWorkspaceSocket();
  const callbacks = useRef({ onChanged,onRevoked }); callbacks.current = { onChanged,onRevoked };
  useEffect(() => {
    if (!socket) return;
    const changed = (event: { workspaceId: string; role: WorkspaceRole }) => {
      if (event.workspaceId === workspaceId && ['OWNER','EDITOR','VIEWER'].includes(event.role)) callbacks.current.onChanged(event.role);
    };
    const revoked = () => callbacks.current.onRevoked();
    const connected = () => { callbacks.current.onChanged(); };
    // Re-fetch permissions on reconnect as well as live membership changes.
    socket.on('workspace:changed',changed); socket.on('access:revoked',revoked); socket.on('connect',connected);
    return () => { socket.off('workspace:changed',changed); socket.off('access:revoked',revoked); socket.off('connect',connected); };
  },[socket,workspaceId]);
  return null;
}

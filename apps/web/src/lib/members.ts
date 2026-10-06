import type { WorkspaceRole } from './workspaces';
export type Invitation = {
  id: string; role: Exclude<WorkspaceRole,'OWNER'>; expiresAt: string;
  workspace: { id: string; name: string }; inviter: { id: string; username: string };
  invitee: { id: string; username: string; email: string } | null;
};

export type WorkspaceRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export type Workspace = {
  id: string; name: string; language: string; ownerId: string;
  createdAt: string; updatedAt: string; role: WorkspaceRole;
  owner: { id: string; username: string };
};
export type WorkspaceDetails = Workspace & {
  members: { userId: string; role: WorkspaceRole; user: { id: string; username: string; avatar: string | null } }[];
};
export const workspaceLanguages = ['javascript', 'typescript', 'python', 'java', 'cpp', 'c'] as const;
export function validateWorkspaceName(name: string) {
  return !name.trim() ? 'Workspace name is required.' : name.trim().length > 80 ? 'Workspace name must be at most 80 characters.' : '';
}
export function workspaceDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}

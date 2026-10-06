import { cookies } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { API_URL } from '@/lib/api';
import { WorkspaceView } from '@/components/workspace-view';
import { WorkspaceUnavailable } from '@/components/workspace-unavailable';

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  const { id } = await params;
  if (!/^c[a-z0-9]{24}$/.test(id)) return <WorkspaceUnavailable title="Invalid workspace link." message="Check the workspace address and try again." />;
  const session = (await cookies()).get('codesync_session');
  const response = await fetch(`${API_URL}/api/workspaces/${id}`, { headers: { Cookie: `codesync_session=${encodeURIComponent(session?.value || '')}` }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (response.status === 401) redirect('/login');
  if (response.status === 404) notFound();
  if (response.status === 403) return <WorkspaceUnavailable title="Workspace access denied." message="Your account does not have access to this workspace." />;
  if (!response.ok) throw new Error('Unable to load workspace. Please try again.');
  return <WorkspaceView initialWorkspace={await response.json()} username={user.username} />;
}

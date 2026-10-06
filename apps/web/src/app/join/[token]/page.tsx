import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { JoinInvitation } from '@/components/join-invitation';
import { WorkspaceUnavailable } from '@/components/workspace-unavailable';

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token }=await params;
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return <WorkspaceUnavailable title="Invalid invitation." message="Ask the owner for a new invitation."/>;
  // Login's existing dashboard destination exposes the same addressed invite in the inbox.
  if(!await currentUser())redirect('/login');
  return <JoinInvitation token={token}/>;
}

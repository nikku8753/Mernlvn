import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { WorkspaceCreate } from '@/components/workspace-create';
export default async function NewWorkspace() {
  if (!await currentUser()) redirect('/login');
  return <WorkspaceCreate />;
}

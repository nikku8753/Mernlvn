import { WorkspaceUnavailable } from '@/components/workspace-unavailable';
export default function MissingWorkspace() {
  return <WorkspaceUnavailable title="Workspace not found." message="This workspace may have been deleted. Return to your dashboard to see your accessible workspaces." />;
}

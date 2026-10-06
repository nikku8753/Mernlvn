'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, FolderGit2, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { type Workspace, workspaceDate } from '@/lib/workspaces';

export function WorkspaceList() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const saved = await api<Workspace[]>('/api/workspaces', { signal });
      if (!signal?.aborted) { setWorkspaces(saved); setError(''); }
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.status === 401) { router.replace('/login'); router.refresh(); }
      else setError(error instanceof Error ? error.message : 'Unable to load workspaces.');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [router]);
  useEffect(() => {
    const controller = new AbortController();
    const check = () => { void load(controller.signal); };
    check(); window.addEventListener('focus', check);
    return () => { controller.abort(); window.removeEventListener('focus', check); };
  }, [load]);
  return <section className="dashboard-card workspace-card"><div className="card-heading"><FolderGit2 size={21} /><h2>Workspaces</h2><Link href="/workspace/new" className="button button-small workspace-create"><Plus size={16} />Create Workspace</Link></div>
    {error && <div className="workspace-feedback"><p role="alert" className="form-error">{error}</p><button className="button button-secondary button-small" onClick={() => void load()} disabled={loading}>Try again</button></div>}
    {workspaces === null ? <p className="muted workspace-feedback" role="status">{loading ? 'Loading your workspaces…' : 'Your workspaces could not be loaded.'}</p> : workspaces.length === 0 ? <div className="workspace-empty"><span className="empty-icon"><FolderGit2 size={35} /></span><h3>No workspaces yet.</h3><p className="muted">Create your first workspace to start building.</p><Link href="/workspace/new" className="button">Create Workspace<Plus size={16} /></Link></div> : <div className="workspace-list">{workspaces.map(workspace => <article className="workspace-item" key={workspace.id}><div className="workspace-item-title"><h3>{workspace.name}</h3><span className="phase-badge">{workspace.role}</span></div><p className="muted">{workspace.language} · Owner: {workspace.owner.username}</p><p className="muted">Updated <time dateTime={workspace.updatedAt}>{workspaceDate(workspace.updatedAt)}</time></p><Link href={`/workspace/${workspace.id}`} className="button button-secondary button-small">Open Workspace<ArrowUpRight size={16} /></Link></article>)}</div>}
  </section>;
}

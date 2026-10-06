'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Code2, FolderGit2, Trash2 } from 'lucide-react';
import { Brand } from './brand';
import { WorkspaceUnavailable } from './workspace-unavailable';
import { api, ApiError } from '@/lib/api';
import { type WorkspaceDetails, validateWorkspaceName, workspaceDate } from '@/lib/workspaces';

export function WorkspaceView({ initialWorkspace, username }: { initialWorkspace: WorkspaceDetails; username: string }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [name, setName] = useState(initialWorkspace.name);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unavailable, setUnavailable] = useState('');
  const owner = workspace.role === 'OWNER';
  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) { router.replace('/login'); router.refresh(); }
    else if (error instanceof ApiError && [403, 404].includes(error.status)) setUnavailable(error.message);
    else setError(error instanceof Error ? error.message : 'Unable to complete your request.');
  }
  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      try {
        const current = await api<WorkspaceDetails>(`/api/workspaces/${initialWorkspace.id}`, { signal: controller.signal });
        if (!controller.signal.aborted) setWorkspace(current);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) { router.replace('/login'); router.refresh(); }
        else if (error instanceof ApiError && [403, 404].includes(error.status)) setUnavailable(error.message);
        else setError(error instanceof Error ? error.message : 'Unable to load workspace.');
      }
    }
    void check(); window.addEventListener('focus', check);
    const timer = window.setInterval(check, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', check); };
  }, [initialWorkspace.id, router]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice('');
    const validation = validateWorkspaceName(name); setError(validation); if (validation) return;
    setBusy('save');
    try {
      await api(`/api/workspaces/${workspace.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      const updated = await api<WorkspaceDetails>(`/api/workspaces/${workspace.id}`);
      setWorkspace(updated); setName(updated.name); setNotice('Workspace updated.'); router.refresh();
    } catch (error) { handleError(error); } finally { setBusy(null); }
  }
  async function remove() {
    setBusy('delete'); setError(''); setNotice('');
    try { await api(`/api/workspaces/${workspace.id}`, { method: 'DELETE' }); router.replace('/dashboard'); router.refresh(); }
    catch (error) { handleError(error); setBusy(null); }
  }
  if (unavailable) return <WorkspaceUnavailable title="Workspace unavailable." message={unavailable} />;
  return <><header className="site-header"><div className="container nav"><Brand /><Link href="/dashboard" className="button button-secondary button-small">Back to dashboard</Link></div></header><main className="container dashboard"><div className="dashboard-heading"><span className="section-kicker">YOUR WORKSPACE</span><h1>{workspace.name}</h1><p className="muted">Signed in as {username} · Your role: {workspace.role}</p></div>{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-success" role="status">{notice}</p>}<div className="dashboard-grid"><section className="dashboard-card"><div className="card-heading"><FolderGit2 size={21} /><h2>Workspace details</h2></div><dl className="workspace-details"><dt>Owner</dt><dd>{workspace.owner.username}</dd><dt>Language</dt><dd>{workspace.language}</dd><dt>Created</dt><dd><time dateTime={workspace.createdAt}>{workspaceDate(workspace.createdAt)}</time></dd><dt>Updated</dt><dd><time dateTime={workspace.updatedAt}>{workspaceDate(workspace.updatedAt)}</time></dd></dl><h3 className="workspace-members-title">Members ({workspace.members.length})</h3><ul className="workspace-members">{workspace.members.map(member => <li key={member.userId}><span>{member.user.username}</span><span className="phase-badge">{member.role}</span></li>)}</ul>
      {owner && <><form className="account-form" onSubmit={save}><label htmlFor="rename-workspace">Workspace Name<input id="rename-workspace" value={name} onChange={event => setName(event.target.value)} required maxLength={80} disabled={!!busy} /></label><button className="button" disabled={!!busy || name.trim() === workspace.name}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button></form><div className="workspace-delete">{confirming ? <div role="group" aria-labelledby="delete-title"><h3 id="delete-title">Delete this workspace?</h3><p className="muted">This action cannot be undone.</p><div className="workspace-delete-actions"><button className="button button-danger" disabled={!!busy} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Confirm delete'}</button><button className="button button-secondary" disabled={!!busy} onClick={() => setConfirming(false)}>Cancel</button></div></div> : <button className="button button-secondary" disabled={!!busy} onClick={() => setConfirming(true)}><Trash2 size={16} />Delete workspace</button>}</div></>}
    </section><section className="dashboard-card workspace-empty"><span className="empty-icon"><Code2 size={35} /></span><h3>Your project starts here.</h3><p className="muted">Code editor will be introduced in Phase 4.</p></section></div></main></>;
}

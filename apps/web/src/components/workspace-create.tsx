'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Brand } from './brand';
import { api, ApiError } from '@/lib/api';
import { validateWorkspaceName, workspaceLanguages } from '@/lib/workspaces';

export function WorkspaceCreate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get('name') || '').trim();
    const validation = validateWorkspaceName(name); setError(validation); if (validation) return;
    setBusy(true);
    try {
      const workspace = await api<{ id: string }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, language: fields.get('language') }) });
      router.replace(`/workspace/${workspace.id}`); router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { router.replace('/login'); router.refresh(); }
      else { setError(error instanceof Error ? error.message : 'Unable to create workspace.'); setBusy(false); }
    }
  }
  return <main className="auth-page"><Brand /><section className="auth-card"><span className="section-kicker">MAKE ROOM FOR YOUR NEXT IDEA</span><h1>Create a workspace.</h1><p className="muted">Give your project a name and choose its language.</p><form className="account-form" onSubmit={submit}><label htmlFor="workspace-name">Workspace Name<input id="workspace-name" name="name" required maxLength={80} disabled={busy} autoFocus /></label><label htmlFor="workspace-language">Language<select id="workspace-language" name="language" defaultValue="javascript" disabled={busy}>{workspaceLanguages.map(language => <option key={language} value={language}>{language}</option>)}</select></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button" disabled={busy}>{busy ? 'Creating…' : 'Create Workspace'}</button></form></section><Link href="/dashboard" className="auth-home muted">← Back to dashboard</Link></main>;
}

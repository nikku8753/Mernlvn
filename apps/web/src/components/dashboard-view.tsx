'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import { WorkspaceList } from './workspace-list';
import { Brand } from './brand';
import { api, ApiError, validateUsername, type User } from '@/lib/api';

export function DashboardView({ initialUser }: { initialUser: User }) {
  const router = useRouter();
  const [user, setUser] = useState(initialUser);
  const [username, setUsername] = useState(initialUser.username);
  const [busy, setBusy] = useState<'profile' | 'logout' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function signedOut() { router.replace('/login'); router.refresh(); }
  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const current = await api<User>('/api/auth/me');
        if (active) setUser(current);
      }
      catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) { router.replace('/login'); router.refresh(); }
        else setError(error instanceof Error ? error.message : 'Unable to verify your session.');
      }
    }
    void check();
    const onVisibility = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(check, 60_000);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', onVisibility); };
  }, [router]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice('');
    const validation = validateUsername(username); setError(validation); if (validation) return;
    setBusy('profile');
    try {
      const updated = await api<User>('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ username: username.trim() }) });
      setUser(updated); setUsername(updated.username); setNotice('Profile updated.'); router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) signedOut();
      else setError(error instanceof Error ? error.message : 'Unable to save your profile.');
    } finally { setBusy(null); }
  }
  async function logout() {
    setBusy('logout'); setError(''); setNotice('');
    try { await api<void>('/api/auth/logout', { method: 'POST' }); signedOut(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to sign out.'); setBusy(null); }
  }
  return <><header className="site-header"><div className="container nav"><Brand /><nav aria-label="Dashboard navigation"><Link href="/dashboard" aria-current="page">Dashboard</Link><a href="#profile">Profile</a></nav><button className="button button-secondary button-small" disabled={!!busy} onClick={logout}><LogOut size={16} />{busy === 'logout' ? 'Signing out…' : 'Sign out'}</button></div></header>
    <main className="container dashboard"><div className="dashboard-heading"><span className="section-kicker">YOUR SPACE TO BUILD</span><h1>Welcome, {user.username}.</h1><p className="muted">Your profile and a home for what comes next.</p></div>
      {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-success" role="status">{notice}</p>}
      <div className="dashboard-grid"><section className="dashboard-card" id="profile"><div className="card-heading"><UserRound size={21} /><h2>Your profile</h2></div><div className="profile-summary"><span className="profile-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><div><strong>{user.username}</strong><p className="muted">{user.email}</p></div></div>
        <form className="account-form" onSubmit={save}><label htmlFor="profile-username">Username<input id="profile-username" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} minLength={2} maxLength={32} required disabled={!!busy} /></label><label htmlFor="profile-email">Email<input id="profile-email" type="email" value={user.email} readOnly /></label><small className="muted">Your email is the address you use to sign in.</small><button className="button" disabled={!!busy || username.trim() === user.username}>{busy === 'profile' ? 'Saving…' : 'Save profile'}</button></form>
      </section><WorkspaceList /></div>
    </main></>;
}

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Brand } from './brand';
import { api, validateCredentials, validateUsername, type User } from '@/lib/api';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const registering = mode === 'register';
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const username = String(fields.get('username') || '').trim();
    const email = String(fields.get('email') || '').trim();
    const password = String(fields.get('password') || '');
    const validation = (registering ? validateUsername(username) : '') || validateCredentials(email, password) || (registering && password !== fields.get('confirmPassword') ? 'Passwords do not match.' : '');
    setError(validation);
    if (validation) return;
    setBusy(true);
    try {
      await api<User>(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(registering ? { username, email, password } : { email, password }) });
      router.replace('/dashboard');
      router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); setBusy(false); }
  }
  return <main className="auth-page"><Brand /><section className="auth-card">
    <span className="section-kicker">YOUR SHARED SPACE STARTS HERE</span>
    <h1>{registering ? 'Build something together.' : 'Welcome back.'}</h1>
    <p className="muted">{registering ? 'Create your CodeSync account and make room for your next idea.' : 'Sign in to your CodeSync account.'}</p>
    <form onSubmit={submit} className="account-form">
      {registering && <label htmlFor="username">Username<input id="username" name="username" autoComplete="username" required minLength={2} maxLength={32} disabled={busy} /></label>}
      <label htmlFor="email">Email<input id="email" name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} /></label>
      <label htmlFor="password">Password<input id="password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={10} maxLength={72} aria-describedby={registering ? 'password-hint' : undefined} disabled={busy} /></label>
      {registering && <><small id="password-hint" className="muted">At least 10 characters; at most 72 UTF-8 bytes.</small><label htmlFor="confirmPassword">Confirm password<input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={72} disabled={busy} /></label></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button" disabled={busy}>{busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}<ArrowRight size={17} /></button>
    </form>
    <p className="auth-switch">{registering ? 'Already have an account?' : 'New to CodeSync?'} <Link href={registering ? '/login' : '/register'}>{registering ? 'Sign in' : 'Create an account'}</Link></p>
    <div className="auth-note"><ShieldCheck size={16} /> Your account. Your space to build.</div>
  </section><Link className="auth-home muted" href="/">← Back to CodeSync</Link></main>;
}

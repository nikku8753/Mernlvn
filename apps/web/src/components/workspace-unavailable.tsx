import Link from 'next/link';
import { Brand } from './brand';
export function WorkspaceUnavailable({ title, message }: { title: string; message: string }) {
  return <main className="auth-page"><Brand /><section className="auth-card"><h1>{title}</h1><p className="muted">{message}</p><Link href="/dashboard" className="button">Back to dashboard</Link></section></main>;
}

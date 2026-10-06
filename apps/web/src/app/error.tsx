'use client';
import { Brand } from '@/components/brand';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="auth-page"><Brand /><section className="auth-card"><h1>Unable to load CodeSync.</h1><p className="muted">We couldn’t reach the service. Please try again.</p><button className="button" onClick={reset}>Try again</button></section></main>;
}

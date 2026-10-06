'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brand } from './brand';
import { api, ApiError } from '@/lib/api';
import type { Invitation } from '@/lib/members';

export function JoinInvitation({token}:{token:string}){
  const router=useRouter();const [invite,setInvite]=useState<Invitation|null>(null);
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [loading,setLoading]=useState(true);
  useEffect(()=>{const controller=new AbortController();void api<Invitation>(`/api/invites/token/${token}`,{signal:controller.signal}).then(invite=>{if(!controller.signal.aborted)setInvite(invite);}).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Unable to load invitation.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[token]);
  async function respond(action:'accept'|'decline'){
    if(!invite||busy)return;setBusy(true);setError('');
    try{const result=await api<{workspaceId:string}>(action==='accept'?'/api/invites/join':`/api/invites/${invite.id}/decline`,{method:'POST',body:action==='accept'?JSON.stringify({token}):'{}'});router.replace(action==='accept'?`/workspace/${result.workspaceId}`:'/dashboard');router.refresh();}
    catch(error){setError(error instanceof Error?error.message:'Unable to respond to invitation.');if(error instanceof ApiError&&error.status===401){router.replace('/login');router.refresh();}setBusy(false);}
  }
  return <main className="auth-page"><Brand/><section className="auth-card"><h1>Workspace invitation</h1>{loading&&<p className="muted" role="status">Loading invitation…</p>}{error&&<p className="form-error" role="alert">{error}</p>}{invite&&<><h2>{invite.workspace.name}</h2><p className="muted">{invite.inviter.username} invited you as {invite.role}. This invitation expires {new Date(invite.expiresAt).toLocaleString()}.</p><div className="invitation-actions"><button className="button" disabled={busy} onClick={()=>void respond('accept')}>Accept</button><button className="button button-secondary" disabled={busy} onClick={()=>void respond('decline')}>Decline</button></div></>}</section><Link href="/dashboard" className="button button-secondary">Back to dashboard</Link></main>;
}

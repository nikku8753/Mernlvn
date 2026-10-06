'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { Invitation } from '@/lib/members';

export function InvitationInbox(){
  const router=useRouter();const [invites,setInvites]=useState<Invitation[]>([]);
  const [loading,setLoading]=useState(true);const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const load=useCallback(async(signal?:AbortSignal)=>{
    setLoading(true);
    try{const result=await api<Invitation[]>('/api/invites',{signal});if(!signal?.aborted){setInvites(result);setError('');}}
    catch(error){if(signal?.aborted)return;if(error instanceof ApiError&&error.status===401){router.replace('/login');router.refresh();}else setError(error instanceof Error?error.message:'Unable to load invitations.');}
    finally{if(!signal?.aborted)setLoading(false);}
  },[router]);
  useEffect(()=>{const controller=new AbortController();const check=()=>void load(controller.signal);check();window.addEventListener('focus',check);const timer=window.setInterval(check,30_000);return()=>{controller.abort();window.removeEventListener('focus',check);window.clearInterval(timer);};},[load]);
  async function resolve(invite:Invitation,action:'accept'|'decline'){
    if(busy)return;setBusy(invite.id);setError('');setNotice('');
    try{
      const result=await api<{workspaceId:string}>(`/api/invites/${invite.id}/${action}`,{method:'POST',body:'{}'});
      setInvites(previous=>previous.filter(item=>item.id!==invite.id));
      if(action==='accept'){router.push(`/workspace/${result.workspaceId}`);router.refresh();}
      else setNotice(`Declined invitation to ${invite.workspace.name}.`);
    }catch(error){setError(error instanceof Error?error.message:'Unable to respond to invitation.');if(error instanceof ApiError&&[404,409,410].includes(error.status))setInvites(previous=>previous.filter(item=>item.id!==invite.id));if(error instanceof ApiError&&error.status===401){router.replace('/login');router.refresh();}}
    finally{setBusy(null);}
  }
  return <section className="dashboard-card invitation-inbox" aria-labelledby="inbox-heading"><div className="card-heading"><h2 id="inbox-heading">Workspace invitations</h2><button className="button button-secondary button-small" disabled={loading||!!busy} onClick={()=>void load()}>Refresh invitations</button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="form-success" role="status">{notice}</p>}
    {loading&&<p className="muted" role="status">Loading invitations…</p>}{!loading&&!invites.length&&<p className="muted">No pending invitations.</p>}
    <div className="invitation-list">{invites.map(invite=><article className="workspace-item" key={invite.id} data-invite-id={invite.id}><div className="workspace-item-title"><h3>{invite.workspace.name}</h3><span className="phase-badge">{invite.role}</span></div><p className="muted">Invited by {invite.inviter.username} · Expires {new Date(invite.expiresAt).toLocaleString()}</p><div className="invitation-actions"><button className="button button-small" disabled={!!busy} onClick={()=>void resolve(invite,'accept')}>Accept</button><button className="button button-secondary button-small" disabled={!!busy} onClick={()=>void resolve(invite,'decline')}>Decline</button></div></article>)}</div>
  </section>;
}

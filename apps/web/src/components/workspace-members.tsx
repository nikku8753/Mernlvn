'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Invitation } from '@/lib/members';
import type { WorkspaceDetails } from '@/lib/workspaces';

type Member = WorkspaceDetails['members'][number];
type EditableRole = 'EDITOR' | 'VIEWER';
function MemberRow({ member, owner, busy, mutate }: { member: Member; owner: boolean; busy: boolean; mutate: (userId: string, role?: EditableRole) => Promise<void> }) {
  const [role,setRole]=useState<EditableRole>(member.role==='VIEWER'?'VIEWER':'EDITOR');
  const [removing,setRemoving]=useState(false);
  useEffect(() => { setRole(member.role==='VIEWER'?'VIEWER':'EDITOR'); },[member.role]);
  return <li className="member-row"><span>{member.user.username}</span><span className="phase-badge">{member.role}</span>{owner&&member.role!=='OWNER'&&<div className="member-controls">
    <select aria-label={`Role for ${member.user.username}`} value={role} disabled={busy} onChange={event=>setRole(event.target.value as EditableRole)}><option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option></select>
    <button className="button button-secondary button-small" disabled={busy||role===member.role} onClick={()=>void mutate(member.userId,role)}>Save role</button>
    {removing?<><span>Remove {member.user.username}?</span><button className="button button-danger button-small" disabled={busy} onClick={()=>void mutate(member.userId)}>Confirm removal</button><button className="button button-secondary button-small" disabled={busy} onClick={()=>setRemoving(false)}>Cancel</button></>:<button className="button button-secondary button-small" disabled={busy} onClick={()=>setRemoving(true)}>Remove</button>}
  </div>}</li>;
}

export function WorkspaceMembers({ workspace, refresh }: { workspace: WorkspaceDetails; refresh: () => void }) {
  const owner=workspace.role==='OWNER';
  const [email,setEmail]=useState(''); const [role,setRole]=useState<EditableRole>('EDITOR');
  const [pending,setPending]=useState<Invitation[]>([]); const [busy,setBusy]=useState(false);
  const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  const [loading,setLoading]=useState(false);
  const load=useCallback(async(signal?:AbortSignal)=>{
    if(!owner)return;
    setLoading(true);
    try{const result=await api<Invitation[]>(`/api/workspaces/${workspace.id}/invites`,{signal});if(!signal?.aborted)setPending(result);}
    catch(error){if(!signal?.aborted)setError(error instanceof Error?error.message:'Unable to load invitations.');}
    finally{if(!signal?.aborted)setLoading(false);}
  },[workspace.id,owner]);
  useEffect(()=>{
    const controller=new AbortController();const check=()=>{void load(controller.signal);};check();
    if(!owner){setPending([]);return()=>controller.abort();}
    window.addEventListener('focus',check);const timer=window.setInterval(check,30_000);
    return()=>{controller.abort();window.removeEventListener('focus',check);window.clearInterval(timer);};
  },[load,owner,workspace.members.length]);
  async function invite(event:FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setError('');setNotice('');
    try{await api(`/api/workspaces/${workspace.id}/invites`,{method:'POST',body:JSON.stringify({email:email.trim(),role})});setEmail('');setNotice('Invitation sent. They can accept it from their dashboard.');await load();}
    catch(error){setError(error instanceof Error?error.message:'Unable to send invitation.');if(error instanceof ApiError&&[401,403].includes(error.status))refresh();}
    finally{setBusy(false);}
  }
  async function mutate(userId:string,role?:EditableRole){
    if(busy)return;setBusy(true);setError('');setNotice('');
    try{await api(`/api/workspaces/${workspace.id}/members/${userId}`,{method:role?'PATCH':'DELETE',...(role?{body:JSON.stringify({role})}:{})});setNotice(role?'Member role updated.':'Member removed.');refresh();await load();}
    catch(error){setError(error instanceof Error?error.message:'Unable to update member.');refresh();}
    finally{setBusy(false);}
  }
  async function revoke(id:string){
    if(busy)return;setBusy(true);setError('');setNotice('');
    try{await api(`/api/workspaces/${workspace.id}/invites/${id}`,{method:'DELETE'});setNotice('Invitation revoked.');await load();}
    catch(error){setError(error instanceof Error?error.message:'Unable to revoke invitation.');}
    finally{setBusy(false);}
  }
  return <section className="workspace-member-management" aria-labelledby="members-title">
    <h3 id="members-title" className="workspace-members-title">Members ({workspace.members.length})</h3>
    <p className="muted member-help">Owners manage the workspace and members. Editors can edit files. Viewers have read-only file access. All members can use chat.</p>
    <ul className="workspace-members">{workspace.members.map(member=><MemberRow key={member.userId} member={member} owner={owner} busy={busy} mutate={mutate}/>)}</ul>
    {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="form-success" role="status">{notice}</p>}
    {owner&&<><form className="account-form invite-form" onSubmit={invite}><h3>Invite a registered user</h3><label htmlFor="invite-email">Email<input id="invite-email" type="email" autoComplete="off" required maxLength={254} value={email} disabled={busy} onChange={event=>setEmail(event.target.value)}/></label><label htmlFor="invite-role">Workspace role<select id="invite-role" value={role} disabled={busy} onChange={event=>setRole(event.target.value as EditableRole)}><option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option></select></label><button className="button button-small" disabled={busy}>{busy?'Please wait…':'Send invitation'}</button><small className="muted">In-app invitation, valid for 24 hours. No email is sent.</small></form>
      <h3 className="workspace-members-title">Pending invitations</h3>{loading&&<p className="muted" role="status">Loading invitations…</p>}<button className="button button-secondary button-small" disabled={loading||busy} onClick={()=>void load()}>Refresh invitations</button>
      {!pending.length&&!loading&&<p className="muted member-help">No pending invitations.</p>}<ul className="workspace-members">{pending.map(invite=><li key={invite.id}><div><strong>{invite.invitee?.email||'Legacy invitation link'}</strong><p className="muted">{invite.role} · Expires {new Date(invite.expiresAt).toLocaleString()}</p></div><button className="button button-secondary button-small" disabled={busy} onClick={()=>void revoke(invite.id)}>Revoke</button></li>)}</ul>
    </>}
  </section>;
}

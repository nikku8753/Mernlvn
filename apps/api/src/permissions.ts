import { db } from './db.js';
import { canEdit } from './validation.js';
export class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
export async function membership(workspaceId:string,userId:string,write=false,owner=false) {
  const member=await db.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId,userId}}});
  if(!member) throw new HttpError(403,'You do not have access to this workspace. Ask the owner for an invite.');
  if(owner && member.role!=='OWNER' || write && !canEdit(member.role)) throw new HttpError(403,'Your workspace role does not allow this action.');
  return member;
}

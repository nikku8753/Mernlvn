import { db } from './db.js';
import { canEdit } from './validation.js';
export class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
export async function membership(workspaceId:string,userId:string,write=false,owner=false) {
  const member=await db.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId,userId}}});
  if(!member) {
    if(!await db.workspace.findUnique({where:{id:workspaceId},select:{id:true}})) throw new HttpError(404,'Workspace not found.');
    throw new HttpError(403,'You do not have access to this workspace.');
  }
  if(owner && member.role!=='OWNER' || write && !canEdit(member.role)) throw new HttpError(403,'Your workspace role does not allow this action.');
  return member;
}

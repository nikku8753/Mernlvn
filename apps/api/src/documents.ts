import * as Y from 'yjs';
import { db } from './db.js';
import { HttpError } from './permissions.js';
type Document = { doc:Y.Doc; workspaceId:string; dirty:boolean; timer?:ReturnType<typeof setTimeout>; deadline?:ReturnType<typeof setTimeout> };
const docs=new Map<string,Document>();
let queue:Promise<unknown>=Promise.resolve();
// REST mutations and realtime operations serialize through the same queue.
export function documentOperation<T>(action:()=>Promise<T>):Promise<T>{const result=queue.then(action);queue=result.catch(()=>undefined);return result;}
export function hasDocument(id:string){return docs.has(id);}
export async function loadDocument(id:string){
  const existing=docs.get(id);if(existing)return existing;
  const file=await db.file.findUnique({where:{id}});if(!file||file.type!=='FILE')throw new HttpError(404,'File not found.');
  const doc=new Y.Doc();if(file.state)Y.applyUpdate(doc,file.state);else doc.getText('code').insert(0,file.content);
  const item:Document={doc,workspaceId:file.workspaceId,dirty:!file.state};docs.set(id,item);
  // Persist the seed's CRDT identity before exposing it, even to read-only users.
  // Otherwise evict/rejoin could seed identical text with different item IDs.
  if(item.dirty) { try { await flushDocument(id); } catch(error) { docs.delete(id);doc.destroy();throw error; } }
  return item;
}
let status:(id:string,data:{content?:string;updatedAt?:string;error?:string})=>void=()=>{};
export function onDocumentStatus(callback:typeof status){status=callback;}
export async function flushDocument(id:string){
  const item=docs.get(id);if(!item)return;
  if(!item.dirty)return db.file.findUniqueOrThrow({where:{id}});
  const content=item.doc.getText('code').toString();
  const file=await db.$transaction(async tx=>{
    const prior=await tx.file.findUniqueOrThrow({where:{id}});
    const saved=await tx.file.update({where:{id},data:{content,state:Buffer.from(Y.encodeStateAsUpdate(item.doc)),updatedAt:new Date(Math.max(Date.now(),prior.updatedAt.getTime()+1))}});
    await tx.workspace.update({where:{id:item.workspaceId},data:{updatedAt:new Date()}});return saved;
  });
  item.dirty=false;clearTimeout(item.timer);clearTimeout(item.deadline);item.deadline=undefined;
  status(id,{content,updatedAt:file.updatedAt.toISOString()});return file;
}
function schedule(id:string,item:Document){
  const persist=()=>void documentOperation(()=>flushDocument(id)).catch(()=>{
    status(id,{error:'Unable to persist collaborative edits. Retry Save; keep this page open.'});
    if(docs.get(id)===item)item.timer=setTimeout(persist,5000);
  });
  clearTimeout(item.timer);item.timer=setTimeout(persist,1500);item.deadline??=setTimeout(persist,10000);
}
export async function updateDocument(id:string,update:Uint8Array){
  const item=await loadDocument(id);const candidate=new Y.Doc();
  try{
    Y.applyUpdate(candidate,Y.encodeStateAsUpdate(item.doc));Y.applyUpdate(candidate,update);
    if(Buffer.byteLength(candidate.getText('code').toString())>200_000||Y.encodeStateAsUpdate(candidate).length>2_000_000)throw new HttpError(413,'File is too large (200 KB text / 2 MB document limit).');
    if([...candidate.share.keys()].some(key=>key!=='code'))throw new HttpError(400,'Invalid document update.');
  }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'Invalid document update.');}
  finally{candidate.destroy();}
  Y.applyUpdate(item.doc,update);item.dirty=true;schedule(id,item);
}
export async function evictDocument(id:string){await flushDocument(id);await discardDocuments([id]);}
export async function discardDocuments(ids:string[]){for(const id of ids){const item=docs.get(id);if(item){clearTimeout(item.timer);clearTimeout(item.deadline);item.doc.destroy();docs.delete(id);}}}
export async function flushAll(){for(const id of docs.keys())await flushDocument(id);}

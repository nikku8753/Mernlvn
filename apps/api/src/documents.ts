import * as Y from 'yjs';
import { db } from './db.js';
import { HttpError } from './permissions.js';
type Document = {doc:Y.Doc;workspaceId:string;dirty:boolean;version:number;timer?:ReturnType<typeof setTimeout>;saving?:Promise<void>};
const docs=new Map<string,Promise<Document>>();
export async function loadDocument(id:string) {
  let pending=docs.get(id);
  if(!pending) {
    pending=(async()=>{const file=await db.file.findUnique({where:{id}});if(!file||file.type!=='FILE')throw new HttpError(404,'File not found.');const doc=new Y.Doc();if(file.state)Y.applyUpdate(doc,file.state);else doc.getText('code').insert(0,file.content);return {doc,workspaceId:file.workspaceId,dirty:false,version:0};})();
    docs.set(id,pending); pending.catch(()=>docs.delete(id));
  }
  return pending;
}
export async function flushDocument(id:string) {
  const pending=docs.get(id);if(!pending)return;
  const item=await pending;
  if(item.saving) {await item.saving;return flushDocument(id);}
  if(!item.dirty)return;
  const version=item.version;
  item.saving=(async()=>{await db.$transaction([db.file.update({where:{id},data:{state:Buffer.from(Y.encodeStateAsUpdate(item.doc)),content:item.doc.getText('code').toString()}}),db.workspace.update({where:{id:item.workspaceId},data:{updatedAt:new Date()}})]);if(item.version===version)item.dirty=false;})();
  try {await item.saving;} finally {item.saving=undefined;}
}
export async function updateDocument(id:string,update:Uint8Array) {
  const item=await loadDocument(id);
  const candidate=new Y.Doc();
  try {Y.applyUpdate(candidate,Y.encodeStateAsUpdate(item.doc));Y.applyUpdate(candidate,update);if(candidate.getText('code').length>200_000||Y.encodeStateAsUpdate(candidate).length>2_000_000)throw new HttpError(413,'File is too large (200 KB limit).');} finally {candidate.destroy();}
  Y.applyUpdate(item.doc,update);item.dirty=true;item.version++;
  clearTimeout(item.timer);item.timer=setTimeout(()=>{flushDocument(id).catch(e=>{console.error('Snapshot failed:',e.message);item.timer=setTimeout(()=>void flushDocument(id).catch(console.error),5000);});},1500);
}
export async function evictDocument(id:string) {const item=await docs.get(id);if(item){clearTimeout(item.timer);await flushDocument(id);item.doc.destroy();docs.delete(id);}}
export async function discardDocuments(ids:string[]) {for(const id of ids){const item=await docs.get(id);if(item){clearTimeout(item.timer);if(item.saving)await item.saving;item.doc.destroy();docs.delete(id);}}}
export async function flushAll(){await Promise.all([...docs.keys()].map(flushDocument));}

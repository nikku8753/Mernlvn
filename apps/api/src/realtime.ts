import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import * as Y from 'yjs';
import { z } from 'zod';
import { config } from './config.js';
import { getSession } from './auth.js';
import { db } from './db.js';
import { HttpError, membership } from './permissions.js';
import { documentOperation,loadDocument,updateDocument,evictDocument,flushDocument,onDocumentStatus } from './documents.js';
import { workspaceIdSchema } from './validation.js';
export let io:Server;
const room=(id:string)=>'workspace:'+id;
const fileRoom=(workspace:string,id:string)=>room(workspace)+':file:'+id;
const bytes=z.array(z.number().int().min(0).max(255)).max(2_000_000);
const identity=z.object({fileId:workspaceIdSchema});
export function notifyFiles(id:string){io?.to(room(id)).emit('files:changed');}
export function deletedFiles(workspaceId:string,ids:string[]){for(const id of ids)io?.to(fileRoom(workspaceId,id)).emit('file:deleted',{fileId:id});notifyFiles(workspaceId);}
export async function revokeAccess(workspaceId:string,userId?:string){
  if(!io)return;for(const socket of await io.in(room(workspaceId)).fetchSockets())if(!userId||socket.data.user.id===userId){socket.emit('access:revoked');socket.disconnect(true);}
}
async function authenticate(socket:Socket){
  const session=await getSession(socket.handshake.headers.cookie);
  if(!session){socket.emit('access:revoked');socket.disconnect(true);throw new HttpError(401,'Please sign in again.');}
  socket.data.user=session.user;return session.user;
}
async function access(socket:Socket,id:string,write=false){
  const user=await authenticate(socket);const file=await db.file.findUnique({where:{id},select:{workspaceId:true,type:true}});
  if(!file||file.type!=='FILE')throw new HttpError(404,'File not found.');await membership(file.workspaceId,user.id,write);return file;
}
async function broadcast(id:string,event:string,payload:unknown,except?:string){
  if(!io)return;for(const socket of io.sockets.sockets.values())if(socket.data.fileId===id&&socket.id!==except){
    try{await access(socket,id);socket.emit(event,payload);}catch{socket.emit('access:revoked');socket.disconnect(true);}
  }
}
export function realtime(server:HttpServer){
  io=new Server(server,{cors:{origin:config.WEB_ORIGIN,credentials:true},maxHttpBufferSize:8_000_000,allowRequest:(req,cb)=>cb(null,req.headers.origin===config.WEB_ORIGIN)});
  io.use(async(socket,next)=>{try{const session=await getSession(socket.handshake.headers.cookie);if(!session)return next(new Error('Please sign in.'));socket.data.user=session.user;next();}catch{next(new Error('Unable to authenticate.'));}});
  onDocumentStatus((fileId,status)=>{void broadcast(fileId,'file:persisted',{fileId,...status});});
  io.on('connection',socket=>{
    let count=0;let start=Date.now();
    const handle=(event:string,fn:(payload:unknown)=>Promise<unknown>)=>socket.on(event,(payload,ack)=>{
      void documentOperation(async()=>{
        if(!socket.connected)throw new HttpError(401,'Connection ended. Reconnect before editing.');
        if(Date.now()-start>1000){count=0;start=Date.now();}if(++count>100)throw new HttpError(429,'Too many updates. Please wait.');
        await authenticate(socket);return fn(payload);
      }).then(data=>{if(typeof ack==='function')ack({ok:true,data});}).catch(error=>{
        if(typeof ack==='function')ack({ok:false,status:error instanceof HttpError?error.status:400,error:error instanceof HttpError?error.message:error instanceof z.ZodError?'Invalid realtime request.':'Unable to complete realtime operation.'});
      });
    });
    async function leave(){
      const id=socket.data.fileId;const workspace=socket.data.workspaceId;socket.data.fileId=undefined;if(!id)return;
      await socket.leave(fileRoom(workspace,id));
      if(![...io.sockets.sockets.values()].some(s=>s.data.fileId===id))await evictDocument(id);
    }
    handle('file:subscribe',async payload=>{
      const {fileId,vector}=identity.extend({vector:bytes.optional()}).strict().parse(payload);const file=await access(socket,fileId);
      if(socket.data.fileId!==fileId)await leave();
      if(socket.data.workspaceId)await socket.leave(room(socket.data.workspaceId));
      const item=await loadDocument(fileId);socket.data.workspaceId=file.workspaceId;socket.data.fileId=fileId;
      await socket.join(room(file.workspaceId));await socket.join(fileRoom(file.workspaceId,fileId));
      return {update:Array.from(Y.encodeStateAsUpdate(item.doc,vector?Uint8Array.from(vector):undefined)),vector:Array.from(Y.encodeStateVector(item.doc))};
    });
    handle('file:unsubscribe',async()=>{await leave();});
    handle('code:update',async payload=>{
      const {fileId,update}=identity.extend({update:bytes}).strict().parse(payload);
      if(socket.data.fileId!==fileId)throw new HttpError(409,'Subscribe to this file first.');
      await access(socket,fileId,true);await updateDocument(fileId,Uint8Array.from(update));await broadcast(fileId,'code:update',{fileId,update},socket.id);
    });
    handle('file:save',async payload=>{
      const {fileId}=identity.strict().parse(payload);if(socket.data.fileId!==fileId)throw new HttpError(409,'Subscribe to this file first.');
      await access(socket,fileId,true);const file=await flushDocument(fileId);return file&&{content:file.content,updatedAt:file.updatedAt.toISOString()};
    });
    socket.on('disconnect',()=>{void documentOperation(leave).catch(()=>console.error('Unable to flush disconnected document.'));});
  });return io;
}

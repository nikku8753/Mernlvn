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
import { selectionSchema, validateSelection, userColor } from './presence.js';
export let io:Server;
const room=(id:string)=>'workspace:'+id;
const fileRoom=(workspace:string,id:string)=>room(workspace)+':file:'+id;
const bytes=z.array(z.number().int().min(0).max(255)).max(2_000_000);
const identity=z.object({fileId:workspaceIdSchema});
export function notifyFiles(id:string){io?.to(room(id)).emit('files:changed');}
export function deletedFiles(workspaceId:string,ids:string[]){
  for(const id of ids){
    io?.to(fileRoom(workspaceId,id)).emit('file:deleted',{fileId:id});
    for(const socket of io?.sockets.sockets.values()??[])if(socket.data.fileId===id){
      socket.data.fileId=undefined;socket.data.presence=undefined;
      void socket.leave(fileRoom(workspaceId,id));
    }
  }
  notifyFiles(workspaceId);
}
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
async function publishPresence(id:string){
  // Revalidate every recipient AND contributor before exposing a roster.
  for(const socket of io.sockets.sockets.values())if(socket.data.fileId===id){
    try{await access(socket,id);}catch{socket.data.presence=undefined;socket.emit('access:revoked');socket.disconnect(true);}
  }
  const entries=[...io.sockets.sockets.values()].filter(s=>s.connected&&s.data.fileId===id&&s.data.presence).map(s=>s.data.presence);
  await broadcast(id,'presence:state',{fileId:id,entries});
}
function collaboratorColor(fileId:string,userId:string){
  const entries=[...io.sockets.sockets.values()].filter(s=>s.data.fileId===fileId&&s.data.presence).map(s=>s.data.presence);
  const existing=entries.find(entry=>entry.userId===userId);
  if(existing)return existing.color;
  const preferred=userColor(userId);const used=new Set(entries.map(entry=>entry.color));
  for(let offset=0;offset<8;offset++){const color=(preferred+offset)%8;if(!used.has(color))return color;}
  return preferred;
}
export function realtime(server:HttpServer){
  io=new Server(server,{cors:{origin:config.WEB_ORIGIN,credentials:true},maxHttpBufferSize:8_000_000,allowRequest:(req,cb)=>cb(null,req.headers.origin===config.WEB_ORIGIN)});
  io.use(async(socket,next)=>{try{const session=await getSession(socket.handshake.headers.cookie);if(!session)return next(new Error('Please sign in.'));socket.data.user=session.user;next();}catch{next(new Error('Unable to authenticate.'));}});
  onDocumentStatus((fileId,status)=>{void broadcast(fileId,'file:persisted',{fileId,...status});});
  // Expired sessions / externally removed memberships cannot remain online forever.
  const sweep=setInterval(()=>{void documentOperation(async()=>{
    const ids=new Set<string>([...io.sockets.sockets.values()].map(s=>s.data.fileId).filter(Boolean));
    for(const id of ids)await publishPresence(id);
  }).catch(()=>console.error('Unable to refresh presence.'));},15000);
  sweep.unref();server.on('close',()=>clearInterval(sweep));
  io.on('connection',socket=>{
    let count=0;let cursorCount=0;let start=Date.now();
    const handle=(event:string,fn:(payload:unknown)=>Promise<unknown>)=>socket.on(event,(payload,ack)=>{
      void documentOperation(async()=>{
        if(!socket.connected)throw new HttpError(401,'Connection ended. Reconnect before editing.');
        if(Date.now()-start>1000){count=0;cursorCount=0;start=Date.now();}if(++count>100||event==='presence:update'&&++cursorCount>25)throw new HttpError(429,'Too many updates. Please wait.');
        await authenticate(socket);return fn(payload);
      }).then(data=>{if(typeof ack==='function')ack({ok:true,data});}).catch(error=>{
        if(typeof ack==='function')ack({ok:false,status:error instanceof HttpError?error.status:400,error:error instanceof HttpError?error.message:error instanceof z.ZodError?'Invalid realtime request.':'Unable to complete realtime operation.'});
      });
    });
    async function leave(){
      const id=socket.data.fileId;const workspace=socket.data.workspaceId;socket.data.fileId=undefined;socket.data.presence=undefined;if(!id)return;
      await socket.leave(fileRoom(workspace,id));
      await publishPresence(id);
      if(![...io.sockets.sockets.values()].some(s=>s.data.fileId===id))await evictDocument(id);
    }
    handle('file:subscribe',async payload=>{
      const {fileId,vector}=identity.extend({vector:bytes.optional()}).strict().parse(payload);const file=await access(socket,fileId);
      if(socket.data.fileId!==fileId)await leave();
      if(socket.data.workspaceId)await socket.leave(room(socket.data.workspaceId));
      const item=await loadDocument(fileId);socket.data.workspaceId=file.workspaceId;socket.data.fileId=fileId;
      await socket.join(room(file.workspaceId));await socket.join(fileRoom(file.workspaceId,fileId));
      socket.data.presence={connectionId:socket.id,userId:socket.data.user.id,username:socket.data.user.username,color:collaboratorColor(fileId,socket.data.user.id),selection:null};
      await publishPresence(fileId);
      return {update:Array.from(Y.encodeStateAsUpdate(item.doc,vector?Uint8Array.from(vector):undefined)),vector:Array.from(Y.encodeStateVector(item.doc))};
    });
    handle('file:unsubscribe',async()=>{await leave();});
    handle('presence:update',async payload=>{
      const {fileId,selection}=identity.extend({selection:selectionSchema}).strict().parse(payload);
      if(socket.data.fileId!==fileId||!socket.data.presence)throw new HttpError(409,'Subscribe to this file first.');
      await access(socket,fileId);
      validateSelection((await loadDocument(fileId)).doc,selection);
      socket.data.presence={...socket.data.presence,selection};
      await broadcast(fileId,'presence:cursor',{fileId,entry:socket.data.presence},socket.id);
    });
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

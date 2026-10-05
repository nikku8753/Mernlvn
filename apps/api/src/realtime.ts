import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import * as Y from 'yjs';
import { z } from 'zod';
import { config } from './config.js';
import { getSession } from './auth.js';
import { db } from './db.js';
import { membership } from './permissions.js';
import { loadDocument, updateDocument, evictDocument } from './documents.js';
import { messageSchema } from './validation.js';
export let io:Server;
const room=(id:string)=>`workspace:${id}`;
export function notifyFiles(id:string){io?.to(room(id)).emit('files:changed');}
export async function revokeAccess(workspaceId:string,userId?:string) {
  const sockets=await io.in(room(workspaceId)).fetchSockets();
  for(const socket of sockets)if(!userId||socket.data.user.id===userId){socket.emit('access:revoked');socket.disconnect(true);}
}
export function realtime(server:HttpServer) {
  io=new Server(server,{cors:{origin:config.WEB_ORIGIN,credentials:true},maxHttpBufferSize:256_000,allowRequest:(req,cb)=>cb(null,req.headers.origin===config.WEB_ORIGIN)});
  io.use(async(socket,next)=>{try{const session=await getSession(socket.handshake.headers.cookie);if(!session)return next(new Error('Please sign in.'));socket.data.user=session.user;socket.data.expiresAt=session.expiresAt.getTime();next();}catch{next(new Error('Unable to authenticate.'));}});
  async function presence(id:string) {const sockets=await io.in(room(id)).fetchSockets();io.to(room(id)).emit('presence',sockets.map(s=>({socketId:s.id,id:s.data.user.id,username:s.data.user.username,avatar:s.data.user.avatar})));}
  io.on('connection',socket=>{
    let eventCount=0;let windowStart=Date.now();
    const handle=(event:string,fn:(payload:any)=>Promise<unknown>)=>socket.on(event,async(payload,ack)=>{try{if(Date.now()>socket.data.expiresAt)throw new Error('Session expired. Please sign in again.');if(Date.now()-windowStart>1000){eventCount=0;windowStart=Date.now();}if(++eventCount>100)throw new Error('Too many events. Slow down.');const result=await fn(payload);if(typeof ack==='function')ack({ok:true,data:result});}catch(e){if(typeof ack==='function')ack({ok:false,error:e instanceof Error?e.message:'Unable to complete action.'});}});
    handle('workspace:join',async(payload)=>{const {workspaceId}=z.object({workspaceId:z.string().min(1)}).parse(payload);await membership(workspaceId,socket.data.user.id);const previous=socket.data.workspaceId;if(previous)await socket.leave(room(previous));socket.data.workspaceId=workspaceId;await socket.join(room(workspaceId));if(previous)await presence(previous);await presence(workspaceId);socket.to(room(workspaceId)).emit('activity',`${socket.data.user.username} joined the workspace`);});
    handle('file:subscribe',async(payload)=>{const {fileId,vector}=z.object({fileId:z.string(),vector:z.array(z.number().int().min(0).max(255)).max(256000).optional()}).parse(payload);const file=await db.file.findUnique({where:{id:fileId},select:{workspaceId:true}});if(!file)throw new Error('File not found.');await membership(file.workspaceId,socket.data.user.id);if(file.workspaceId!==socket.data.workspaceId)throw new Error('Join the workspace first.');const item=await loadDocument(fileId);const old=socket.data.fileId;if(old)await socket.leave(`file:${old}`);socket.data.fileId=fileId;await socket.join(`file:${fileId}`);return {update:Array.from(Y.encodeStateAsUpdate(item.doc,vector?Uint8Array.from(vector):undefined)),vector:Array.from(Y.encodeStateVector(item.doc))};});
    handle('code:update',async(payload)=>{const {fileId,update}=z.object({fileId:z.string(),update:z.array(z.number().int().min(0).max(255)).max(256000)}).parse(payload);const file=await db.file.findUnique({where:{id:fileId},select:{workspaceId:true}});if(!file||socket.data.fileId!==fileId)throw new Error('Subscribe to this file first.');await membership(file.workspaceId,socket.data.user.id,true);await updateDocument(fileId,Uint8Array.from(update));socket.to(`file:${fileId}`).emit('code:update',{fileId,update});});
    handle('cursor',async(payload)=>{const p=z.object({fileId:z.string(),position:z.object({lineNumber:z.number().int().min(1).max(200000),column:z.number().int().min(1).max(200000)}),selection:z.object({startLineNumber:z.number().int().min(1),startColumn:z.number().int().min(1),endLineNumber:z.number().int().min(1),endColumn:z.number().int().min(1)}).optional()}).parse(payload);if(p.fileId!==socket.data.fileId)throw new Error('Invalid file.');await membership(socket.data.workspaceId,socket.data.user.id);socket.to(`file:${p.fileId}`).emit('cursor',{...p,socketId:socket.id,username:socket.data.user.username});});
    handle('chat:send',async(payload)=>{const {message}=messageSchema.parse(payload);const workspaceId=socket.data.workspaceId;if(!workspaceId)throw new Error('Join a workspace first.');await membership(workspaceId,socket.data.user.id);const result=await db.message.create({data:{workspaceId,userId:socket.data.user.id,message},include:{user:{select:{id:true,username:true,avatar:true}}}});io.to(room(workspaceId)).emit('chat:message',result);return result;});
    socket.on('disconnect',async()=>{const id=socket.data.workspaceId;if(id){socket.to(room(id)).emit('activity',`${socket.data.user.username} left the workspace`);await presence(id);}const file=socket.data.fileId;if(file&&!(await io.in(`file:${file}`).fetchSockets()).length)await evictDocument(file).catch(console.error);});
  });
  return io;
}

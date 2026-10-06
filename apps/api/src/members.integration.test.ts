import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { io as client, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { expect,test } from 'vitest';
import { createApp } from './app.js';
import { realtime } from './realtime.js';
import { config } from './config.js';
import { db } from './db.js';
import { documentOperation,discardDocuments } from './documents.js';
import { hashToken, token } from './auth.js';

test('addressed invitations, owner administration and live role/removal enforcement preserve chat and editing',async()=>{
  const suffix=randomUUID().slice(0,8);const emails=[0,1,2].map(i=>`p8-${i}-${suffix}@example.com`);
  const app=createApp();const server=createServer(app);const io=realtime(server);server.listen(0);await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('No port.');
  const sockets:Socket[]=[];const workspaces:string[]=[];const docs:Y.Doc[]=[];
  const emit=(socket:Socket,event:string,payload:unknown):Promise<any>=>new Promise((resolve,reject)=>socket.timeout(10000).emit(event,payload,(error:Error|null,reply:unknown)=>error?reject(error):resolve(reply)));
  const connect=async(cookie:string)=>{const socket=client(`http://localhost:${address.port}`,{transports:['websocket'],extraHeaders:{Origin:config.WEB_ORIGIN,Cookie:cookie},reconnection:false});sockets.push(socket);await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;};
  try{
    const users=[];for(const [i,email]of emails.entries()){const user=await request(app).post('/api/auth/register').set('Origin',config.WEB_ORIGIN).send({email,username:`p8-${i}-${suffix}`,password:'Phase8-test-password'});expect(user.status).toBe(201);users.push(user);}
    const cookies=users.map(user=>String(user.headers['set-cookie'][0]).split(';')[0]);
    const call=(index:number,path:string,method:'get'|'post'|'patch'|'delete'='get',body?:unknown)=>request(app)[method](path).set('Cookie',cookies[index]).set('Origin',config.WEB_ORIGIN).send(body);
    for(let i=0;i<2;i++){const workspace=await call(0,'/api/workspaces','post',{name:`Members ${suffix}-${i}`});expect(workspace.status).toBe(201);workspaces.push(workspace.body.id);}
    const [id,otherId]=workspaces;const root=`/api/workspaces/${id}`;
    const invite=(role='EDITOR',email=emails[1])=>call(0,`${root}/invites`,'post',{email,role});
    expect((await request(app).get('/api/invites')).status).toBe(401);
    expect((await call(2,`${root}/invites`,'post',{email:emails[1],role:'EDITOR'})).status).toBe(403);
    expect((await call(0,`${root}/invites`,'post',{email:'bad',role:'EDITOR'})).status).toBe(400);
    expect((await invite('OWNER')).status).toBe(400);
    expect((await call(0,`${root}/invites`,'post',{email:emails[1],role:'EDITOR',userId:users[2].body.id})).status).toBe(400);
    expect((await invite('EDITOR',emails[0])).status).toBe(422);
    expect((await invite('EDITOR',`unknown-${suffix}@example.com`)).status).toBe(404);
    expect((await call(0,'/api/workspaces/invalid/invites','post',{email:emails[1]})).status).toBe(400);
    const created=await invite('EDITOR',`  ${emails[1].toUpperCase()}  `);expect(created.status).toBe(201);
    const inviteId=created.body.id;const raw=created.body.url.split('/').at(-1);
    expect(created.body.role).toBe('EDITOR');expect(created.body.invitee.id).toBe(users[1].body.id);
    expect(created.body).not.toHaveProperty('token');expect(created.body.invitee).not.toHaveProperty('passwordHash');
    const stored=await db.workspaceInvite.findUniqueOrThrow({where:{id:inviteId}});expect(stored.token).toBe(hashToken(raw));expect(stored.token).not.toBe(raw);
    expect((await call(1,'/api/auth/logout','post')).status).toBe(204);
    const login=await call(1,'/api/auth/login','post',{email:emails[1],password:'Phase8-test-password'});expect(login.status).toBe(200);cookies[1]=String(login.headers['set-cookie'][0]).split(';')[0];
    expect((await invite()).status).toBe(409);expect(await db.workspaceInvite.count({where:{workspaceId:id,inviteeId:users[1].body.id}})).toBe(1);
    const inbox=await call(1,'/api/invites');expect(inbox.headers['cache-control']).toBe('no-store');expect(inbox.body.map((i:any)=>i.id)).toEqual([inviteId]);expect((await call(2,'/api/invites')).body).toEqual([]);
    expect((await call(1,`${root}/files`)).status).toBe(403); // pending is not membership
    expect((await call(2,`/api/invites/${inviteId}/accept`,'post',{})).status).toBe(403);
    expect((await call(2,`/api/invites/${inviteId}/decline`,'post',{})).status).toBe(403);
    expect((await call(2,`/api/invites/token/${raw}`)).status).toBe(403);
    expect((await call(2,'/api/invites/join','post',{token:raw})).status).toBe(403);
    expect((await call(1,'/api/invites/invalid/accept','post',{})).status).toBe(400);
    expect((await call(1,`/api/invites/${inviteId}/accept`,'post',{role:'OWNER'})).status).toBe(400);
    const acceptance=await call(1,`/api/invites/${inviteId}/accept`,'post',{});expect(acceptance.status).toBe(200);expect(acceptance.body).toEqual({workspaceId:id,role:'EDITOR'});
    expect(await db.workspaceInvite.findUnique({where:{id:inviteId}})).toBeNull();expect((await call(1,'/api/invites')).body).toEqual([]);
    expect((await call(1,'/api/invites/join','post',{token:raw})).status).toBe(410);
    expect((await call(1,root)).body.role).toBe('EDITOR');expect((await call(1,'/api/workspaces')).body.map((w:any)=>w.id)).toContain(id);
    expect((await invite()).status).toBe(409);
    const members=await call(0,`${root}/members`);expect(members.status).toBe(200);expect(members.body).toHaveLength(2);members.body.forEach((m:any)=>{expect(m.user).not.toHaveProperty('email');expect(m.user).not.toHaveProperty('passwordHash');});
    expect((await call(1,`${root}/members`)).status).toBe(200);expect((await call(2,`${root}/members`)).status).toBe(403);
    for(const index of [1,2]){
      expect((await call(index,`${root}/invites`,'post',{email:emails[2],role:'VIEWER'})).status).toBe(403);
      expect((await call(index,`${root}/invites`)).status).toBe(403);
      expect((await call(index,`${root}/members/${users[1].body.id}`,'patch',{role:'EDITOR'})).status).toBe(403);
      expect((await call(index,`${root}/members/${users[0].body.id}`,'delete')).status).toBe(403);
      expect((await call(index,root,'patch',{name:'Forbidden'})).status).toBe(403);
      expect((await call(index,root,'delete')).status).toBe(403);
    }
    expect((await call(0,`${root}/members/${users[0].body.id}`,'patch',{role:'VIEWER'})).status).toBe(422);
    expect((await call(0,`${root}/members/${users[0].body.id}`,'delete')).status).toBe(422);
    expect((await call(0,`${root}/members/${users[1].body.id}`,'patch',{role:'OWNER'})).status).toBe(400);
    expect((await call(0,`${root}/members/invalid`,'patch',{role:'VIEWER'})).status).toBe(400);
    expect((await call(0,`${root}/members/${users[2].body.id}`,'patch',{role:'VIEWER'})).status).toBe(404);
    const file=await call(1,`${root}/files`,'post',{name:'shared.ts'});expect(file.status).toBe(201);
    const a=await connect(cookies[0]);const b=await connect(cookies[1]);const bTab=await connect(cookies[1]);const c=await connect(cookies[2]);
    for(const socket of [a,b,bTab])expect((await emit(socket,'chat:subscribe',{workspaceId:id})).ok).toBe(true);
    expect((await emit(c,'chat:subscribe',{workspaceId:id})).status).toBe(403);
    const doc=new Y.Doc();docs.push(doc);
    expect((await emit(a,'file:subscribe',{fileId:file.body.id})).ok).toBe(true);
    const sync=await emit(b,'file:subscribe',{fileId:file.body.id});expect(sync.ok).toBe(true);Y.applyUpdate(doc,Uint8Array.from(sync.data.update));
    const edit=async(text:string)=>{const vector=Y.encodeStateVector(doc);doc.getText('code').insert(doc.getText('code').length,text);return emit(b,'code:update',{fileId:file.body.id,update:Array.from(Y.encodeStateAsUpdate(doc,vector))});};
    expect((await edit('Editor writes\n')).ok).toBe(true);expect((await emit(b,'file:save',{fileId:file.body.id})).data.content).toContain('Editor writes');
    let delivered=0;b.on('chat:message',()=>delivered++);
    const received=new Promise(resolve=>b.once('chat:message',resolve));expect((await emit(a,'chat:send',{workspaceId:id,message:'Editor chat'})).ok).toBe(true);await received;
    const roleChange=new Promise<any>(resolve=>b.once('workspace:changed',resolve));
    expect((await call(0,`${root}/members/${users[1].body.id}`,'patch',{role:'VIEWER'})).status).toBe(200);expect((await roleChange).role).toBe('VIEWER');expect(b.connected).toBe(true);expect(bTab.connected).toBe(true);
    expect((await call(1,root)).body.role).toBe('VIEWER');
    for(const [method,path,body]of [
      ['post',`${root}/files`,{name:'forbidden.ts'}],
      ['patch',`/api/files/${file.body.id}`,{name:'renamed.ts'}],
      ['post',`/api/files/${file.body.id}/save`,{content:'forbidden',updatedAt:file.body.updatedAt}],
      ['delete',`/api/files/${file.body.id}`,undefined],
    ]as const)expect((await call(1,path,method,body)).status).toBe(403);
    expect((await call(1,`${root}/files`)).status).toBe(200);expect((await call(1,`/api/files/${file.body.id}`)).status).toBe(200);
    expect((await emit(b,'code:update',{fileId:file.body.id,update:[0,0]})).status).toBe(403);
    expect((await emit(b,'file:save',{fileId:file.body.id})).status).toBe(403);
    expect((await emit(b,'presence:update',{fileId:file.body.id,selection:null})).ok).toBe(true);
    expect((await emit(b,'chat:send',{workspaceId:id,message:'Viewer chat allowed'})).ok).toBe(true);expect(delivered).toBe(2);
    expect((await call(1,`${root}/messages`)).status).toBe(200);
    const reconnect=await connect(cookies[1]);expect((await emit(reconnect,'file:subscribe',{fileId:file.body.id})).ok).toBe(true);expect((await emit(reconnect,'code:update',{fileId:file.body.id,update:[0,0]})).status).toBe(403);
    expect((await call(0,`${root}/members/${users[1].body.id}`,'patch',{role:'EDITOR'})).status).toBe(200);
    expect((await edit('Editor again\n')).ok).toBe(true);expect((await emit(b,'file:save',{fileId:file.body.id})).data.content).toContain('Editor again');
    expect((await call(1,`${root}/files`,'post',{name:'editor-again.ts'})).status).toBe(201);
    const disconnected=Promise.all([b,bTab,reconnect].map(socket=>new Promise(resolve=>socket.once('disconnect',resolve))));
    expect((await call(0,`${root}/members/${users[1].body.id}`,'delete',{userId:users[0].body.id})).status).toBe(400);
    expect((await call(0,`${root}/members/${users[1].body.id}`,'delete')).status).toBe(204);await disconnected;
    expect((await call(1,root)).status).toBe(403);expect((await call(1,`${root}/files`)).status).toBe(403);expect((await call(1,`${root}/messages`)).status).toBe(403);
    expect((await call(1,`${root}/messages`,'post',{message:'Removed REST'})).status).toBe(403);
    const removedSocket=await connect(cookies[1]);expect((await emit(removedSocket,'file:subscribe',{fileId:file.body.id})).status).toBe(403);expect((await emit(removedSocket,'chat:subscribe',{workspaceId:id})).status).toBe(403);expect((await emit(removedSocket,'chat:send',{workspaceId:id,message:'Removed socket'})).status).toBe(403);
    expect([...io.sockets.sockets.values()].filter(socket=>socket.data.fileId===file.body.id).map(socket=>socket.data.user.id)).toEqual([users[0].body.id]);
    expect((await emit(a,'chat:send',{workspaceId:id,message:'After removal'})).ok).toBe(true);expect(delivered).toBe(2);
    const declined=await invite('VIEWER');expect(declined.status).toBe(201);expect((await call(1,`/api/invites/${declined.body.id}/decline`,'post',{})).status).toBe(204);expect(await db.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:id,userId:users[1].body.id}}})).toBeNull();expect((await call(1,`/api/invites/${declined.body.id}/accept`,'post',{})).status).toBe(410);
    const expired=await invite();expect(expired.status).toBe(201);await db.workspaceInvite.update({where:{id:expired.body.id},data:{expiresAt:new Date(0)}});expect((await call(1,'/api/invites')).body).toEqual([]);expect((await call(1,`/api/invites/${expired.body.id}/accept`,'post',{})).status).toBe(410);
    const reissued=await invite();expect(reissued.status).toBe(201);expect(reissued.body.id).not.toBe(expired.body.id);
    expect((await call(1,`${root}/invites/${reissued.body.id}`,'delete')).status).toBe(403);
    expect((await call(0,`/api/workspaces/${otherId}/invites/${reissued.body.id}`,'delete')).status).toBe(404);
    expect((await call(0,`${root}/invites/${reissued.body.id}`,'delete',{role:'OWNER'})).status).toBe(400);
    expect((await call(0,`${root}/invites/${reissued.body.id}`,'delete')).status).toBe(204);expect((await call(1,'/api/invites/join','post',{token:reissued.body.url.split('/').at(-1)})).status).toBe(410);
    const tokenInvite=await invite('VIEWER');expect(tokenInvite.status).toBe(201);const tokenRaw=tokenInvite.body.url.split('/').at(-1);
    expect((await call(1,`/api/invites/token/${tokenRaw}`)).status).toBe(200);
    const accepts=await Promise.all([call(1,'/api/invites/join','post',{token:tokenRaw}),call(1,`/api/invites/${tokenInvite.body.id}/accept`,'post',{})]);expect(accepts.map(response=>response.status).sort()).toEqual([200,410]);
    expect(await db.workspaceMember.count({where:{workspaceId:id,userId:users[1].body.id}})).toBe(1);expect((await call(1,root)).body.role).toBe('VIEWER');expect((await call(1,`/api/workspaces/${otherId}/members`)).status).toBe(403);
    expect((await call(1,`${root}/members/${users[1].body.id}`,'patch',{role:'EDITOR'})).status).toBe(403);
    const duplicateCreates=await Promise.all([invite('EDITOR',emails[2]),invite('VIEWER',emails[2])]);expect(duplicateCreates.map(response=>response.status).sort()).toEqual([201,409]);
    expect(await db.workspaceInvite.count({where:{workspaceId:id,inviteeId:users[2].body.id}})).toBe(1);
    const legacyRaw=token();await db.workspaceInvite.create({data:{workspaceId:id,invitedBy:users[0].body.id,token:hashToken(legacyRaw),role:'VIEWER',expiresAt:new Date(Date.now()+60000)}});
    expect((await call(1,'/api/invites/join','post',{token:legacyRaw})).status).toBe(410);
  }finally{
    sockets.forEach(socket=>socket.disconnect());await documentOperation(async()=>{const files=await db.file.findMany({where:{workspaceId:{in:workspaces}},select:{id:true}});await discardDocuments(files.map(file=>file.id));});await new Promise<void>(resolve=>io.close(()=>resolve()));await db.workspace.deleteMany({where:{id:{in:workspaces}}});await db.user.deleteMany({where:{email:{in:emails}}});docs.forEach(doc=>doc.destroy());await db.$disconnect();
  }
},90000);

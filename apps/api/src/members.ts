import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from './db.js';
import { config } from './config.js';
import { hashToken, token } from './auth.js';
import { HttpError, membership } from './permissions.js';
import { workspaceIdSchema } from './validation.js';
import { documentOperation } from './documents.js';
import { notifyWorkspaceChanged, revokeAccess } from './realtime.js';

const memberRole = z.enum(['EDITOR','VIEWER']);
const inviteSchema = z.object({ email: z.string().trim().pipe(z.email().max(254)).transform(email => email.toLowerCase()), role: memberRole.default('EDITOR') }).strict();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid invitation token.');
const safeInvite = { id: true, role: true, expiresAt: true, workspace: { select: { id: true, name: true } }, inviter: { select: { id: true, username: true } }, invitee: { select: { id: true, username: true, email: true } } } as const;
const safeMember = { userId: true, role: true, joinedAt: true, user: { select: { id: true, username: true, avatar: true } } } as const;

async function nonOwnerMember(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  const member=await tx.workspaceMember.findUnique({ where:{ workspaceId_userId:{ workspaceId,userId } } });
  if(!member)throw new HttpError(404,'Member not found in this workspace.');
  const workspace=await tx.workspace.findUniqueOrThrow({ where:{ id:workspaceId },select:{ ownerId:true } });
  if(member.role==='OWNER'||workspace.ownerId===userId)throw new HttpError(422,'The workspace owner cannot be changed or removed.');
  return member;
}

async function addressedInvite(tx: Prisma.TransactionClient, userId: string, where: { id: string } | { token: string }) {
  const invite = await tx.workspaceInvite.findUnique({ where });
  if (!invite || !invite.inviteeId || invite.expiresAt <= new Date() || invite.role === 'OWNER') throw new HttpError(410, 'This invitation is invalid, expired, or already used. Ask the owner for a new invitation.');
  if (invite.inviteeId !== userId) throw new HttpError(403, 'This invitation belongs to another account. Sign in with the invited email.');
  return invite;
}

async function accept(userId: string, where: { id: string } | { token: string }) {
  return documentOperation(async () => {
    const result = await db.$transaction(async tx => {
      const invite = await addressedInvite(tx, userId, where);
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: invite.workspaceId }, select: { ownerId: true } });
      if (workspace.ownerId === userId || await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } } })) throw new HttpError(409, 'You are already a member of this workspace.');
      await tx.workspaceMember.create({ data: { workspaceId: invite.workspaceId, userId, role: invite.role } });
      await tx.workspaceInvite.delete({ where: { id: invite.id } });
      return { workspaceId: invite.workspaceId, role: invite.role };
    }, { isolationLevel: 'Serializable' });
    await notifyWorkspaceChanged(result.workspaceId);
    return result;
  });
}

export function memberRoutes() {
  const router = Router();
  router.use('/invites', (_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  router.use('/invites/:inviteId', (req,_res,next) => { if(req.params.inviteId!=='join'&&req.params.inviteId!=='token')workspaceIdSchema.parse(req.params.inviteId); next(); });
  router.use('/workspaces/:id/members/:userId', (req,_res,next) => { workspaceIdSchema.parse(req.params.userId); next(); });
  router.use('/workspaces/:id/invites/:inviteId', (req,_res,next) => { workspaceIdSchema.parse(req.params.inviteId); next(); });

  router.get('/invites', async (req,res) => {
    res.json(await db.workspaceInvite.findMany({ where: { inviteeId: req.user.id, expiresAt: { gt: new Date() } }, select: safeInvite, orderBy: [{ expiresAt:'asc' },{ id:'asc' }] }));
  });
  router.get('/invites/token/:token', async (req,res) => {
    const raw = tokenSchema.parse(req.params.token);
    const invite = await db.$transaction(tx => addressedInvite(tx,req.user.id,{ token:hashToken(raw) }));
    res.json(await db.workspaceInvite.findUniqueOrThrow({ where: { id:invite.id },select:safeInvite }));
  });
  router.post('/invites/join', async (req,res) => {
    const { token:raw }=z.object({ token:tokenSchema }).strict().parse(req.body);
    res.json(await accept(req.user.id,{ token:hashToken(raw) }));
  });
  router.post('/invites/:inviteId/accept', async (req,res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(await accept(req.user.id,{ id:String(req.params.inviteId) }));
  });
  router.post('/invites/:inviteId/decline', async (req,res) => {
    z.object({}).strict().parse(req.body ?? {});
    await documentOperation(() => db.$transaction(async tx => {
      const invite = await addressedInvite(tx,req.user.id,{ id:String(req.params.inviteId) });
      await tx.workspaceInvite.delete({ where:{ id:invite.id } });
    },{ isolationLevel:'Serializable' }));
    res.status(204).end();
  });
  router.get('/workspaces/:id/members', async (req,res) => {
    const id=String(req.params.id); await membership(id,req.user.id);
    res.json(await db.workspaceMember.findMany({ where:{ workspaceId:id },select:safeMember,orderBy:[{ joinedAt:'asc' },{ userId:'asc' }] }));
  });
  router.get('/workspaces/:id/invites', async (req,res) => {
    const id=String(req.params.id); await membership(id,req.user.id,false,true);
    res.json(await db.workspaceInvite.findMany({ where:{ workspaceId:id,expiresAt:{ gt:new Date() } },select:safeInvite,orderBy:[{ expiresAt:'asc' },{ id:'asc' }] }));
  });
  router.post('/workspaces/:id/invites', rateLimit({ windowMs:60_000,limit:20 }), async (req,res) => {
    const id=String(req.params.id); await membership(id,req.user.id,false,true);
    const { email,role }=inviteSchema.parse(req.body); const raw=token(); const expiresAt=new Date(Date.now()+24*3600*1000);
    const invite=await documentOperation(() => db.$transaction(async tx => {
      await membership(id,req.user.id,false,true,tx);
      const workspace=await tx.workspace.findUniqueOrThrow({ where:{ id },select:{ ownerId:true } });
      const invitee=await tx.user.findUnique({ where:{ email },select:{ id:true } });
      if(!invitee)throw new HttpError(404,'No registered CodeSync user has this email. Ask them to register first.');
      if(invitee.id===workspace.ownerId)throw new HttpError(422,'The workspace owner is already a member.');
      if(await tx.workspaceMember.findUnique({ where:{ workspaceId_userId:{ workspaceId:id,userId:invitee.id } } }))throw new HttpError(409,'This user is already a workspace member.');
      const pending=await tx.workspaceInvite.findUnique({ where:{ workspaceId_inviteeId:{ workspaceId:id,inviteeId:invitee.id } } });
      if(pending&&pending.expiresAt>new Date())throw new HttpError(409,'This user already has a pending invitation. Revoke it before sending another.');
      if(pending)await tx.workspaceInvite.delete({ where:{ id:pending.id } });
      if(await tx.workspaceInvite.count({ where:{ workspaceId:id,expiresAt:{ gt:new Date() } } })>=100)throw new HttpError(422,'A workspace can have up to 100 pending invitations.');
      return tx.workspaceInvite.create({ data:{ workspaceId:id,invitedBy:req.user.id,inviteeId:invitee.id,role,token:hashToken(raw),expiresAt },select:safeInvite });
    },{ isolationLevel:'Serializable' }));
    res.status(201).json({ ...invite,url:`${config.WEB_ORIGIN}/join/${raw}` });
  });
  router.delete('/workspaces/:id/invites/:inviteId', async (req,res) => {
    const id=String(req.params.id);
    await documentOperation(() => db.$transaction(async tx => {
      await membership(id,req.user.id,false,true,tx);
      z.object({}).strict().parse(req.body ?? {});
      const result=await tx.workspaceInvite.deleteMany({ where:{ id:String(req.params.inviteId),workspaceId:id } });
      if(!result.count)throw new HttpError(404,'Invitation not found in this workspace.');
    },{ isolationLevel:'Serializable' }));
    res.status(204).end();
  });
  router.patch('/workspaces/:id/members/:userId', async (req,res) => {
    const id=String(req.params.id),userId=String(req.params.userId);
    await membership(id,req.user.id,false,true);
    const { role }=z.object({ role:memberRole }).strict().parse(req.body);
    await documentOperation(async () => {
      await db.$transaction(async tx => {
        await membership(id,req.user.id,false,true,tx);
        await nonOwnerMember(tx,id,userId);
        await tx.workspaceMember.update({ where:{ workspaceId_userId:{ workspaceId:id,userId } },data:{ role } });
      },{ isolationLevel:'Serializable' });
      await notifyWorkspaceChanged(id);
    });
    res.json({ role });
  });
  router.delete('/workspaces/:id/members/:userId', async (req,res) => {
    const id=String(req.params.id),userId=String(req.params.userId);
    await documentOperation(async () => {
      await db.$transaction(async tx => {
        await membership(id,req.user.id,false,true,tx);
        z.object({}).strict().parse(req.body ?? {});
        await nonOwnerMember(tx,id,userId);
        await tx.workspaceMember.delete({ where:{ workspaceId_userId:{ workspaceId:id,userId } } });
        await tx.workspaceInvite.deleteMany({ where:{ workspaceId:id,inviteeId:userId } });
      },{ isolationLevel:'Serializable' });
      await revokeAccess(id,userId); await notifyWorkspaceChanged(id);
    });
    res.status(204).end();
  });
  return router;
}

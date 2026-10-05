import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { parse } from 'cookie';
import { db } from './db.js';
import { config } from './config.js';
export const publicUser = {id:true,username:true,email:true,avatar:true,createdAt:true} as const;
export const hashToken = (token:string)=>createHash('sha256').update(token).digest('hex');
export const token = ()=>randomBytes(32).toString('base64url');
export const cookieOptions = {httpOnly:true,secure:config.NODE_ENV==='production',sameSite:config.COOKIE_CROSS_SITE==='true'?'none' as const:'lax' as const,path:'/'};
export async function getSession(cookie?:string) {
  const raw = parse(cookie || '').codesync_session;
  if (!raw) return null;
  const session = await db.session.findUnique({where:{id:hashToken(raw)},include:{user:{select:publicUser}}});
  return session && session.expiresAt > new Date() ? session : null;
}
declare global { namespace Express { interface Request { user: NonNullable<Awaited<ReturnType<typeof getSession>>>['user'] } } }
export async function requireAuth(req:Request,res:Response,next:NextFunction) {
  try { const session = await getSession(req.headers.cookie); if(!session) {res.status(401).json({error:'Please sign in to continue.'});return;} req.user=session.user; next(); } catch(e) {next(e);}
}
export async function issueSession(res:Response,userId:string) {
  const raw=token(); const expiresAt=new Date(Date.now()+7*24*3600*1000);
  await db.session.create({data:{id:hashToken(raw),userId,expiresAt}});
  res.cookie('codesync_session',raw,{...cookieOptions,expires:expiresAt});
}

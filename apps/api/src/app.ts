import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { z, ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from './config.js';
import { db } from './db.js';
import { requireAuth,issueSession,publicUser,hashToken,cookieOptions } from './auth.js';
import { HttpError,membership } from './permissions.js';
import { registerSchema,loginSchema,profileSchema,workspaceSchema,workspaceIdSchema } from './validation.js';
import { io,revokeAccess,broadcastChat } from './realtime.js';
import { messageHistory, persistMessage } from './chat.js';
import { loadDocument,discardDocuments,documentOperation } from './documents.js';
import { execute } from './execution.js';
import { fileRoutes } from './files.js';
import { memberRoutes } from './members.js';
export function createApp() {
  const app=express();app.set('trust proxy',1);
  app.use(helmet(),cors({origin:config.WEB_ORIGIN,credentials:true}),express.json({limit:'300kb'}),cookieParser());
  app.use('/api',rateLimit({windowMs:60_000,limit:200,standardHeaders:'draft-8',legacyHeaders:false}));
  app.use((req,res,next)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin!==config.WEB_ORIGIN){res.status(403).json({error:'Request origin is not allowed.'});return;}next();});
  app.get('/health',async(_req,res)=>{await db.$queryRaw`SELECT 1`;res.json({status:'ok'});});
  const authLimit=rateLimit({windowMs:15*60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});
  app.use('/api/auth',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.post('/api/auth/register',authLimit,async(req,res)=>{const data=registerSchema.parse(req.body);const passwordHash=await bcrypt.hash(data.password,12);const user=await db.user.create({data:{username:data.username,email:data.email,passwordHash},select:publicUser});await issueSession(res,user.id);res.status(201).json(user);});
  app.post('/api/auth/login',authLimit,async(req,res)=>{const data=loginSchema.parse(req.body);const user=await db.user.findUnique({where:{email:data.email}});const fallback='$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';const valid=await bcrypt.compare(data.password,user?.passwordHash||fallback);if(!user||!valid)throw new HttpError(401,'Email or password is incorrect.');await issueSession(res,user.id);const {passwordHash,...safe}=user;res.json(safe);});
  app.post('/api/auth/logout',async(req,res)=>{if(req.cookies.codesync_session)await db.session.deleteMany({where:{id:hashToken(req.cookies.codesync_session)}});res.clearCookie('codesync_session',cookieOptions);res.status(204).end();});
  app.use('/api',requireAuth);
  app.get('/api/auth/me',(req,res)=>res.json(req.user));
  app.patch('/api/auth/me',async(req,res)=>{const data=profileSchema.parse(req.body);res.json(await db.user.update({where:{id:req.user.id},data,select:publicUser}));});
  app.use('/api/workspaces',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.use('/api/workspaces/:id',(req,_res,next)=>{workspaceIdSchema.parse(req.params.id);next();});
  app.get('/api/workspaces',async(req,res)=>{const members=await db.workspaceMember.findMany({where:{userId:req.user.id},orderBy:[{lastOpenedAt:'desc'},{workspaceId:'asc'}],include:{workspace:{include:{owner:{select:{id:true,username:true}},_count:{select:{members:true,files:true}}}}}});res.json(members.map(m=>({...m.workspace,role:m.role,lastOpenedAt:m.lastOpenedAt})));});
  // Prisma nested writes atomically create the workspace and its owner membership.
  app.post('/api/workspaces',async(req,res)=>{const data=workspaceSchema.parse(req.body);const workspace=await db.workspace.create({data:{...data,ownerId:req.user.id,members:{create:{userId:req.user.id,role:'OWNER'}}}});res.status(201).json(workspace);});
  app.get('/api/workspaces/:id',async(req,res)=>{const id=String(req.params.id);const member=await membership(id,req.user.id);const workspace=await db.workspace.findUnique({where:{id},include:{owner:{select:{id:true,username:true}},members:{include:{user:{select:{id:true,username:true,avatar:true}}}}}});if(!workspace)throw new HttpError(404,'Workspace not found.');await db.workspaceMember.update({where:{workspaceId_userId:{workspaceId:id,userId:req.user.id}},data:{lastOpenedAt:new Date()}});res.json({...workspace,role:member.role});});
  app.patch('/api/workspaces/:id',async(req,res)=>{const id=String(req.params.id);await membership(id,req.user.id,false,true);const data=workspaceSchema.pick({name:true}).parse(req.body);res.json(await db.workspace.update({where:{id},data}));});
  app.delete('/api/workspaces/:id',async(req,res)=>{const id=String(req.params.id);await documentOperation(async()=>{await membership(id,req.user.id,false,true);if(io)await revokeAccess(id);const files=await db.file.findMany({where:{workspaceId:id},select:{id:true}});await discardDocuments(files.map(f=>f.id));await db.workspace.delete({where:{id}});});res.status(204).end();});
  app.use('/api',memberRoutes());
  app.use('/api',fileRoutes());
  app.get('/api/workspaces/:id/messages',async(req,res)=>{res.json(await messageHistory(String(req.params.id),req.user.id,req.query));});
  app.post('/api/workspaces/:id/messages',async(req,res)=>{const message=await documentOperation(async()=>{const saved=await persistMessage(String(req.params.id),req.user.id,req.body);await broadcastChat(saved);return saved;});res.status(201).json(message);});
  app.post('/api/files/:id/run',rateLimit({windowMs:60_000,limit:10}),async(req,res)=>{const id=String(req.params.id);const file=await db.file.findUnique({where:{id}});if(!file||file.type!=='FILE')throw new HttpError(404,'File not found.');await membership(file.workspaceId,req.user.id);const {stdin}=z.object({stdin:z.string().max(4000).default('')}).parse(req.body);const workspace=await db.workspace.findUniqueOrThrow({where:{id:file.workspaceId}});const item=await loadDocument(id);res.json(await execute(workspace.language,item.doc.getText('code').toString(),stdin));});
  app.use((_req,res)=>{res.status(404).json({error:'Endpoint not found.'});});
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(error instanceof Error && 'type' in error && error.type==='entity.too.large'){res.status(413).json({error:'Request is too large. File content is limited to 200 KB.'});return;}
    if(error instanceof SyntaxError && 'type' in error && error.type==='entity.parse.failed'){res.status(400).json({error:'Request body must be valid JSON.'});return;}
    if(error instanceof Prisma.PrismaClientKnownRequestError && error.code==='P2002' && _req.path.startsWith('/api/auth/')){const target=String(error.meta?.target);res.status(409).json({error:target.includes('email')?'An account with this email already exists.':target.includes('username')?'This username is already taken.':'This email or username is already taken.'});return;}
    if(error instanceof ZodError){res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')});return;}
    if(error instanceof HttpError){res.status(error.status).json({error:error.message});return;}
    if(error instanceof Prisma.PrismaClientKnownRequestError){const status=error.code==='P2002'||error.code==='P2034'?409:error.code==='P2025'?404:500;res.status(status).json({error:status===409?'A conflicting change occurred. Try again or use a different name.':status===404?'This item no longer exists.':'Database operation failed. Please try again.'});return;}
    if(error instanceof Error && (error.name==='TimeoutError'||error.name==='AbortError')){res.status(504).json({error:'Code execution timed out.'});return;}
    console.error(error);res.status(500).json({error:'Unable to complete your request. Please try again.'});
  });
  return app;
}

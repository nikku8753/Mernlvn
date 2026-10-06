// Local test setup only; no production HTTP authorization bypass or sharing UI.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const [workspaceId, ownerEmail, memberEmail, operation = 'add'] = process.argv.slice(2);
if (process.env.NODE_ENV === 'production') throw new Error('Development fixture is disabled in production.');
if (!workspaceId || !ownerEmail || !memberEmail || !['add', 'remove'].includes(operation)) throw new Error('Usage: node scripts/phase5-member.mjs WORKSPACE_ID OWNER_EMAIL MEMBER_EMAIL [add|remove]');
const db = new PrismaClient();
try {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, include: { owner: true } });
  if (workspace.owner.email !== ownerEmail) throw new Error('Owner email does not match this workspace.');
  const member = await db.user.findUniqueOrThrow({ where: { email: memberEmail } });
  if (member.id === workspace.ownerId) throw new Error('Cannot alter the owner membership.');
  const where = { workspaceId_userId: { workspaceId, userId: member.id } };
  if (operation === 'remove') await db.workspaceMember.delete({ where });
  else await db.workspaceMember.upsert({ where, create: { workspaceId, userId: member.id, role: 'EDITOR' }, update: { role: 'EDITOR' } });
  console.log(`Development editor membership ${operation === 'add' ? 'added' : 'removed'}.`);
} finally { await db.$disconnect(); }

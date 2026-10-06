import { z } from 'zod';
import { db } from './db.js';
import { HttpError, membership } from './permissions.js';
import { messageSchema, workspaceIdSchema } from './validation.js';

export const chatIdentity = z.object({ workspaceId: workspaceIdSchema }).strict();
export const chatSend = chatIdentity.extend(messageSchema.shape).strict();
const safeMessage = { id: true, workspaceId: true, message: true, createdAt: true, user: { select: { id: true, username: true } } } as const;
const historyQuery = z.object({ before: workspaceIdSchema.optional(), after: workspaceIdSchema.optional() }).strict().refine(q => !q.before || !q.after, 'Use only one history cursor.');

export async function messageHistory(workspaceId: string, userId: string, query: unknown) {
  await membership(workspaceId, userId);
  const { before, after } = historyQuery.parse(query);
  const cursorId = before || after;
  const cursor = cursorId ? await db.message.findFirst({ where: { id: cursorId, workspaceId }, select: { id: true, createdAt: true } }) : null;
  if (cursorId && !cursor) throw new HttpError(400, 'Invalid message history cursor.');
  const direction = after ? 'asc' : 'desc';
  const messages = await db.message.findMany({
    where: { workspaceId, ...(cursor ? { OR: [
      { createdAt: after ? { gt: cursor.createdAt } : { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: after ? { gt: cursor.id } : { lt: cursor.id } },
    ] } : {}) },
    take: 100, orderBy: [{ createdAt: direction }, { id: direction }], select: safeMessage,
  });
  return after ? messages : messages.reverse();
}

export async function persistMessage(workspaceId: string, userId: string, payload: unknown) {
  await membership(workspaceId, userId);
  const { message } = messageSchema.parse(payload);
  return db.message.create({ data: { workspaceId, userId, message }, select: safeMessage });
}

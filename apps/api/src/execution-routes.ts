import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from './db.js';
import { HttpError, membership } from './permissions.js';
import { fileContent, workspaceIdSchema } from './validation.js';
import { execute, executionLanguage } from './execution.js';

const runSchema = z.object({
  source: fileContent.refine(value => value.trim().length > 0, 'Source code must not be empty.'),
  stdin: z.string().max(4000).refine(value => Buffer.byteLength(value, 'utf8') <= 4000, 'Input must be at most 4 KB.').default(''),
}).strict();
async function executableFile(id: string, userId: string) {
  const file = await db.file.findUnique({ where: { id }, select: { id: true, workspaceId: true, name: true, type: true } });
  if (!file) throw new HttpError(404, 'File not found.');
  await membership(file.workspaceId, userId, true);
  if (file.type !== 'FILE') throw new HttpError(422, 'Select a file to execute.');
  return file;
}
export function executionRoutes() {
  const router = Router();
  router.post('/files/:id/run', rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: req => req.user.id, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = workspaceIdSchema.parse(req.params.id);
    const file = await executableFile(id, req.user.id);
    const { source, stdin } = runSchema.parse(req.body);
    const language = executionLanguage(file.name);
    const checkAccess = async () => {
      const current = await executableFile(id, req.user.id);
      if (current.workspaceId !== file.workspaceId || executionLanguage(current.name) !== language) throw new HttpError(409, 'The file changed while starting execution. Please retry.');
    };
    const result = await execute(language, source, stdin, checkAccess);
    await checkAccess();
    res.json(result);
  });
  return router;
}

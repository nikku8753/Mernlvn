import { Router } from 'express';
import { db } from './db.js';
import { HttpError, membership } from './permissions.js';
import { fileSchema, fileSaveSchema, fileUpdateSchema, workspaceIdSchema } from './validation.js';
import { documentOperation, hasDocument, discardDocuments } from './documents.js';
import { deletedFiles, notifyFiles } from './realtime.js';

const metadata = { id: true, name: true, type: true, parentId: true, workspaceId: true, createdAt: true, updatedAt: true } as const;

export function fileRoutes() {
  const router = Router();
  router.use('/files/:id', (req, res, next) => { workspaceIdSchema.parse(req.params.id); res.set('Cache-Control', 'no-store'); next(); });
  router.get('/workspaces/:id/files', async (req, res) => {
    const id = String(req.params.id);
    await membership(id, req.user.id);
    res.json(await db.file.findMany({ where: { workspaceId: id }, select: metadata, orderBy: [{ type: 'desc' }, { name: 'asc' }, { id: 'asc' }] }));
  });
  router.post('/workspaces/:id/files', async (req, res) => {
    const id = String(req.params.id);
    await membership(id, req.user.id, true);
    const data = fileSchema.parse(req.body);
    const file = await db.$transaction(async tx => {
      await membership(id, req.user.id, true, false, tx);
      if (data.parentId) {
        const parent = await tx.file.findUnique({ where: { id: data.parentId } });
        if (parent?.workspaceId !== id || parent.type !== 'FOLDER') throw new HttpError(422, 'Choose a folder in this workspace.');
      }
      if (await tx.file.count({ where: { workspaceId: id } }) >= 100) throw new HttpError(422, 'A workspace can contain up to 100 files and folders.');
      if (await tx.file.findFirst({ where: { workspaceId: id, parentId: data.parentId, name: data.name } })) throw new HttpError(409, 'A file or folder with this name already exists here.');
      const result = await tx.file.create({ data: { ...data, workspaceId: id }, select: metadata });
      await tx.workspace.update({ where: { id }, data: { updatedAt: new Date() } });
      return result;
    }, { isolationLevel: 'Serializable' });
    res.status(201).json(file);
    notifyFiles(id);
  });
  router.get('/files/:id', async (req, res) => {
    const file = await db.file.findUnique({ where: { id: String(req.params.id) }, select: { ...metadata, content: true } });
    if (!file) throw new HttpError(404, 'File not found.');
    await membership(file.workspaceId, req.user.id);
    if (file.type === 'FOLDER') throw new HttpError(422, 'Select a file to open it.');
    res.json(file);
  });
  async function update(id: string, userId: string, data: { name?: string; content?: string; updatedAt?: string }) {
    return documentOperation(async () => {
      if (data.content !== undefined && hasDocument(id)) throw new HttpError(409, 'This file is open for collaboration. Save the shared document in the editor instead of replacing its content.');
      const result = await db.$transaction(async tx => {
      const file = await tx.file.findUnique({ where: { id } });
      if (!file) throw new HttpError(404, 'File not found.');
      await membership(file.workspaceId, userId, true, false, tx);
      if (data.content !== undefined && file.type !== 'FILE') throw new HttpError(422, 'Folders cannot contain code.');
      if (data.name !== undefined && await tx.file.findFirst({ where: { workspaceId: file.workspaceId, parentId: file.parentId, name: data.name, id: { not: id } } })) throw new HttpError(409, 'That name is already in use here.');
      const result = await tx.file.updateMany({ where: { id, ...(data.updatedAt ? { updatedAt: new Date(data.updatedAt) } : {}) }, data: { updatedAt: new Date(Math.max(Date.now(), file.updatedAt.getTime() + 1)), ...(data.name !== undefined ? { name: data.name } : {}), ...(data.content !== undefined ? { content: data.content, state: null } : {}) } });
      if (!result.count) throw new HttpError(409, 'This file changed since you opened it. Reload it before saving; your unsaved edits are still in the editor.');
      await tx.workspace.update({ where: { id: file.workspaceId }, data: { updatedAt: new Date() } });
      return tx.file.findUniqueOrThrow({ where: { id }, select: { ...metadata, content: true } });
      }, { isolationLevel: 'Serializable' });
      notifyFiles(result.workspaceId);
      return result;
    });
  }
  router.patch('/files/:id', async (req, res) => {
    // Check access before validating mutation fields.
    const id = String(req.params.id);
    const file = await db.file.findUnique({ where: { id }, select: { workspaceId: true } });
    if (!file) throw new HttpError(404, 'File not found.');
    await membership(file.workspaceId, req.user.id, true);
    res.json(await update(id, req.user.id, fileUpdateSchema.parse(req.body)));
  });
  router.post('/files/:id/save', async (req, res) => {
    const id = String(req.params.id);
    const file = await db.file.findUnique({ where: { id }, select: { workspaceId: true } });
    if (!file) throw new HttpError(404, 'File not found.');
    await membership(file.workspaceId, req.user.id, true);
    res.json(await update(id, req.user.id, fileSaveSchema.parse(req.body)));
  });
  router.delete('/files/:id', async (req, res) => {
    const id = String(req.params.id);
    await documentOperation(async () => {
      const target = await db.file.findUnique({ where: { id } });
      if (!target) throw new HttpError(404, 'File not found.');
      await membership(target.workspaceId, req.user.id, true);
      const all = await db.file.findMany({ where: { workspaceId: target.workspaceId }, select: { id: true, parentId: true } });
      const removed = new Set([id]);
      let changed = true;
      while (changed) { changed = false; for (const file of all) if (file.parentId && removed.has(file.parentId) && !removed.has(file.id)) { removed.add(file.id); changed = true; } }
      await db.$transaction(async tx => {
      const file = await tx.file.findUnique({ where: { id } });
      if (!file) throw new HttpError(404, 'File not found.');
      await membership(file.workspaceId, req.user.id, true, false, tx);
      await tx.file.delete({ where: { id } });
      await tx.workspace.update({ where: { id: file.workspaceId }, data: { updatedAt: new Date() } });
      }, { isolationLevel: 'Serializable' });
      await discardDocuments([...removed]);
      deletedFiles(target.workspaceId, [...removed]);
    });
    res.status(204).end();
  });
  return router;
}

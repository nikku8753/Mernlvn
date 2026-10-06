import * as Y from 'yjs';
import { z } from 'zod';
import { HttpError } from './permissions.js';

const item = z.object({ client: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), clock: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
// Only positions in the existing root Y.Text are accepted, never nested types.
const position = z.object({ tname: z.literal('code'), item: item.optional(), assoc: z.number().int().min(-1).max(1) }).strict();
export const selectionSchema = z.object({ anchor: position, head: position }).strict().nullable();
export type Selection = z.infer<typeof selectionSchema>;
export function validateSelection(doc: Y.Doc, selection: Selection) {
  if (!selection) return;
  // A restored snapshot initially has an AbstractType until getText materializes it.
  const text = doc.getText('code');
  for (const value of [selection.anchor, selection.head]) {
    const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(value), doc);
    if (!absolute || absolute.type !== text || absolute.index < 0 || absolute.index > text.length) throw new HttpError(400, 'Invalid cursor position. Synchronize the document first.');
  }
}
export function userColor(id: string) {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % 8;
}

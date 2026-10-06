export type FileEntry = { id: string; workspaceId: string; parentId: string | null; name: string; type: 'FILE' | 'FOLDER'; createdAt: string; updatedAt: string };
export type CodeFile = FileEntry & { content: string };
export function validateFilename(value: string) {
  const name = value.trim();
  if (!name || name.length > 100) return 'Use a filename between 1 and 100 characters.';
  if (!/^[\w. -]+$/.test(name) || name === '.' || name === '..') return 'Use letters, numbers, spaces, dots, dashes, or underscores. Paths and slashes are not allowed.';
  return '';
}
export function fileLanguage(name: string) {
  const extension = name.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', html: 'html', css: 'css', md: 'markdown', py: 'python', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp' };
  return languages[extension || ''] || 'plaintext';
}
export function filePath(file: FileEntry, files: FileEntry[]): string {
  const parent = file.parentId ? files.find(item => item.id === file.parentId) : undefined;
  return parent ? `${filePath(parent, files)}/${file.name}` : file.name;
}
export function descendants(id: string, files: FileEntry[]): Set<string> {
  const result = new Set([id]);
  let previous = 0;
  while (previous !== result.size) { previous = result.size; for (const file of files) if (file.parentId && result.has(file.parentId)) result.add(file.id); }
  return result;
}

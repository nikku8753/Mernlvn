'use client';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Code2, FilePlus2, FileText, Folder, FolderPlus, Pencil, RefreshCw, Save, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { type CodeFile, type FileEntry, descendants, fileLanguage, filePath, validateFilename } from '@/lib/files';
import type { WorkspaceRole } from '@/lib/workspaces';

const CodeEditor = dynamic(() => import('./code-editor'), { ssr: false, loading: () => <div className="editor-empty" role="status">Loading editor…</div> });
type Buffer = { file: CodeFile; content: string; savedContent: string };
type Action = { kind: 'file'; parentId: string | null } | { kind: 'folder'; parentId: string | null } | { kind: 'rename'; file: FileEntry } | { kind: 'delete'; file: FileEntry };

export function WorkspaceFiles({ workspaceId, role }: { workspaceId: string; role: WorkspaceRole }) {
  const router = useRouter();
  const editable = role === 'OWNER' || role === 'EDITOR';
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'mutate' | 'save' | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const selection = useRef(0);
  const restoredSelection = useRef(false);
  const active = activeId ? buffers[activeId] : undefined;
  const dirty = Object.values(buffers).some(buffer => buffer.content !== buffer.savedContent);
  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) { router.replace('/login'); router.refresh(); }
    else setError(error instanceof Error ? error.message : 'Unable to complete the file operation.');
  }
  const loadList = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api<FileEntry[]>(`/api/workspaces/${workspaceId}/files`, { signal });
      if (!signal?.aborted) { setFiles(result); setListError(''); }
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.status === 401) { router.replace('/login'); router.refresh(); }
      else setListError(error instanceof Error ? error.message : 'Unable to load files.');
    }
  }, [workspaceId, router]);
  useEffect(() => { const controller = new AbortController(); void loadList(controller.signal); return () => { controller.abort(); selection.current++; }; }, [loadList]);
  useEffect(() => {
    if (!files || restoredSelection.current) return;
    restoredSelection.current = true;
    const id = new URLSearchParams(window.location.search).get('file');
    const file = files.find(item => item.id === id && item.type === 'FILE');
    if (file) {
      const parents = new Set<string>(); let parent = file.parentId;
      while (parent) { parents.add(parent); parent = files.find(item => item.id === parent)?.parentId || null; }
      setExpanded(parents); void open(file);
    }
  }, [files]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const leave = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor || anchor.pathname === window.location.pathname || anchor.target === '_blank') return;
      if (!window.confirm('Leave this workspace and discard unsaved file changes?')) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', leave, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', leave, true); };
  }, [dirty]);
  async function open(file: FileEntry, reload = false) {
    if (file.type === 'FOLDER') { setExpanded(previous => { const next = new Set(previous); next.has(file.id) ? next.delete(file.id) : next.add(file.id); return next; }); return; }
    if (reload && buffers[file.id]?.content !== buffers[file.id]?.savedContent && !window.confirm('Reload this file and discard its unsaved edits?')) return;
    const requestId = ++selection.current;
    setActiveId(file.id); setError(''); setNotice('');
    const url = new URL(window.location.href); url.searchParams.set('file', file.id); window.history.replaceState(null, '', url);
    if (!reload && buffers[file.id] && buffers[file.id].content !== buffers[file.id].savedContent) { setLoadingFile(false); return; }
    setLoadingFile(true);
    try {
      const loaded = await api<CodeFile>(`/api/files/${file.id}`);
      if (selection.current !== requestId) return;
      setBuffers(previous => ({ ...previous, [file.id]: { file: loaded, content: loaded.content, savedContent: loaded.content } }));
    } catch (error) { if (selection.current === requestId) fail(error); }
    finally { if (selection.current === requestId) setLoadingFile(false); }
  }
  async function save() {
    if (!active || busy || !editable || active.content === active.savedContent) return;
    if (new TextEncoder().encode(active.content).length > 200_000) { setError('File content must be at most 200 KB.'); return; }
    setBusy('save'); setError(''); setNotice('');
    try {
      const saved = await api<CodeFile>(`/api/files/${active.file.id}/save`, { method: 'POST', body: JSON.stringify({ content: active.content, updatedAt: active.file.updatedAt }) });
      setBuffers(previous => ({ ...previous, [saved.id]: { file: saved, content: saved.content, savedContent: saved.content } }));
      setFiles(previous => previous?.map(file => file.id === saved.id ? saved : file) || null);
      setNotice('File saved.');
    } catch (error) { fail(error); } finally { setBusy(null); }
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  });
  function start(action: Action) { setAction(action); setName('file' in action ? action.file.name : ''); setError(''); setNotice(''); }
  function edit(content: string) {
    if (!activeId || !editable || busy || active?.content === content) return;
    setNotice('');
    setBuffers(previous => previous[activeId] ? { ...previous, [activeId]: { ...previous[activeId], content } } : previous);
  }
  async function mutate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!action || busy || !editable) return;
    const validation = action.kind === 'delete' ? '' : validateFilename(name); setError(validation); if (validation) return;
    setBusy('mutate'); setNotice('');
    try {
      if (action.kind === 'file' || action.kind === 'folder') {
        const created = await api<FileEntry>(`/api/workspaces/${workspaceId}/files`, { method: 'POST', body: JSON.stringify({ name: name.trim(), type: action.kind === 'folder' ? 'FOLDER' : 'FILE', parentId: action.parentId }) });
        setFiles(previous => [...(previous || []), created]);
        if (created.parentId) setExpanded(previous => new Set([...previous, created.parentId!]));
        if (created.type === 'FILE') await open(created);
        setNotice(created.type === 'FILE' ? 'File created.' : 'Folder created.');
      } else if (action.kind === 'rename') {
        const buffer = buffers[action.file.id];
        const updated = await api<CodeFile>(`/api/files/${action.file.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), updatedAt: buffer?.file.updatedAt || action.file.updatedAt }) });
        setFiles(previous => previous?.map(file => file.id === updated.id ? updated : file) || null);
        if (buffer) setBuffers(previous => ({ ...previous, [updated.id]: { ...previous[updated.id], file: updated } }));
        setNotice('Renamed successfully.');
      } else {
        const removed = descendants(action.file.id, files || []);
        await api(`/api/files/${action.file.id}`, { method: 'DELETE' });
        setFiles(previous => previous?.filter(file => !removed.has(file.id)) || null);
        setBuffers(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))));
        if (activeId && removed.has(activeId)) { selection.current++; setActiveId(null); setLoadingFile(false); const url = new URL(window.location.href); url.searchParams.delete('file'); window.history.replaceState(null, '', url); }
        setNotice('Deleted successfully.');
      }
      setAction(null);
    } catch (error) { fail(error); } finally { setBusy(null); }
  }
  function tree(parentId: string | null, depth = 0): React.ReactNode {
    return (files || []).filter(file => file.parentId === parentId).sort((a, b) => a.type !== b.type ? a.type === 'FOLDER' ? -1 : 1 : a.name.localeCompare(b.name)).map(file => <li key={file.id}><div className={`file-row ${activeId === file.id ? 'is-active' : ''}`} style={{ paddingLeft: 10 + depth * 14 }}><button className="file-select" onClick={() => void open(file)} disabled={!!busy} aria-current={activeId === file.id ? 'true' : undefined} aria-expanded={file.type === 'FOLDER' ? expanded.has(file.id) : undefined}>{file.type === 'FOLDER' ? <>{expanded.has(file.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={15} /></> : <FileText size={15} />}<span>{file.name}</span>{buffers[file.id] && buffers[file.id].content !== buffers[file.id].savedContent && <span className="file-dirty" aria-label="Unsaved changes">●</span>}</button>{editable && <div className="file-actions">{file.type === 'FOLDER' && <><button title={`New file in ${file.name}`} aria-label={`New file in ${file.name}`} disabled={!!busy} onClick={() => start({ kind: 'file', parentId: file.id })}><FilePlus2 size={14} /></button><button title={`New folder in ${file.name}`} aria-label={`New folder in ${file.name}`} disabled={!!busy} onClick={() => start({ kind: 'folder', parentId: file.id })}><FolderPlus size={14} /></button></>}<button title={`Rename ${file.name}`} aria-label={`Rename ${file.name}`} disabled={!!busy} onClick={() => start({ kind: 'rename', file })}><Pencil size={14} /></button><button title={`Delete ${file.name}`} aria-label={`Delete ${file.name}`} disabled={!!busy} onClick={() => start({ kind: 'delete', file })}><Trash2 size={14} /></button></div>}</div>{file.type === 'FOLDER' && expanded.has(file.id) && <ul>{tree(file.id, depth + 1)}</ul>}</li>);
  }
  return <section className="coding-workspace" aria-label="Workspace files and code editor"><aside className="file-explorer"><div className="explorer-heading"><h2>Files</h2>{editable && <div className="file-actions"><button aria-label="New File" title="New File" disabled={!!busy || files === null} onClick={() => start({ kind: 'file', parentId: null })}><FilePlus2 size={17} /></button><button aria-label="New Folder" title="New Folder" disabled={!!busy || files === null} onClick={() => start({ kind: 'folder', parentId: null })}><FolderPlus size={17} /></button></div>}<button className="icon-button" aria-label="Refresh files" title="Refresh files" disabled={!!busy} onClick={() => void loadList()}><RefreshCw size={15} /></button></div>
    {listError && <div className="explorer-message"><p role="alert" className="form-error">{listError}</p><button className="button button-secondary button-small" onClick={() => void loadList()}>Retry</button></div>}{files === null ? <p className="explorer-message muted" role="status">{listError ? 'Files are unavailable.' : 'Loading files…'}</p> : files.length === 0 ? <div className="explorer-message"><p className="muted">No files yet.</p>{editable ? <button className="button button-small" onClick={() => start({ kind: 'file', parentId: null })}>Create your first file</button> : <p className="muted">An owner or editor can add files.</p>}</div> : <ul className="file-tree">{tree(null)}</ul>}
    {action && <form className="file-operation account-form" onSubmit={mutate}>{action.kind === 'delete' ? <><h3>Delete {action.file.name}?</h3><p className="muted">This action cannot be undone.{action.file.type === 'FOLDER' ? ' All files and folders inside will also be deleted.' : ''} Unsaved edits to deleted files will be discarded.</p></> : <label htmlFor="file-name">{action.kind === 'rename' ? 'Rename' : action.kind === 'folder' ? 'New Folder' : 'New File'}<input id="file-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required autoFocus disabled={!!busy} /></label>}<div className="file-operation-actions"><button className={`button button-small ${action.kind === 'delete' ? 'button-danger' : ''}`} disabled={!!busy}>{busy === 'mutate' ? 'Please wait…' : action.kind === 'delete' ? 'Confirm delete' : action.kind === 'rename' ? 'Rename' : 'Create'}</button><button type="button" className="button button-secondary button-small" disabled={!!busy} onClick={() => setAction(null)}>Cancel</button></div></form>}
  </aside><div className="editor-panel"><div className="editor-toolbar"><span className="editor-filename">{active ? filePath(active.file, files || []) : 'No file selected'}</span>{active && <span className="editor-save-state">{active.content !== active.savedContent ? 'Unsaved changes' : 'Saved'}</span>}<div className="editor-toolbar-actions">{active && <button className="button button-secondary button-small" disabled={!!busy || loadingFile} onClick={() => void open(active.file, true)}>Reload file</button>}<button className="button button-small" disabled={!active || !editable || !!busy || loadingFile || active.content === active.savedContent} onClick={() => void save()}><Save size={15} />{busy === 'save' ? 'Saving…' : 'Save'}</button></div></div>{error && <p className="form-error file-feedback" role="alert">{error}</p>}{notice && <p className="form-success file-feedback" role="status">{notice}</p>}<div className="editor-surface">{loadingFile ? <div className="editor-empty" role="status">Loading file…</div> : active ? <CodeEditor key={`${active.file.id}:${active.file.name}`} id={active.file.id} name={active.file.name} language={fileLanguage(active.file.name)} content={active.content} readOnly={!editable || !!busy} onChange={edit} /> : <div className="editor-empty"><Code2 size={35} /><h3>Select a file to start coding.</h3><p className="muted">{editable ? 'Choose a file from the explorer, or create your first file.' : 'You have read-only access to this workspace.'}</p></div>}</div><div className="editor-status"><span>{active ? fileLanguage(active.file.name) : 'CodeSync'}</span><span>{editable ? 'Ctrl / ⌘ + S to save' : 'Read-only access'}</span></div></div></section>;
}

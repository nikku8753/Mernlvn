'use client';
import Editor, { loader } from '@monaco-editor/react';
import { useEffect, useRef, useState } from 'react';
import { MonacoBinding } from 'y-monaco';
import { Collaboration, type Persisted } from '@/lib/collaboration';
import type { editor } from 'monaco-editor';

// Serve the installed Monaco version and its workers locally, without a CDN.
loader.config({ paths: { vs: '/monaco/vs' } });

type Props = { id: string; name: string; language: string; content: string; readOnly: boolean; writable: boolean; onChange: (content: string) => void; onState: (state: string) => void; onSaved: (saved: Persisted) => void; onError: (error: Error) => void; onDeleted: () => void; onFiles: () => void; onSession: (session: Collaboration | null) => void };
export default function CodeEditor(props: Props) {
  const { id, name, language, readOnly } = props;
  const latest = useRef(props); latest.current = props;
  const [mounted, setMounted] = useState<editor.IStandaloneCodeEditor | null>(null);
  const [synced, setSynced] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    loader.config({ paths: { vs: new URL('/monaco/vs', window.location.href).href } });
    loader.init().then(() => { if (active) setReady(true); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!mounted) return;
    let binding: MonacoBinding | undefined;
    const session = new Collaboration(id, props.writable, {
      state: state => latest.current.onState(state), change: content => latest.current.onChange(content),
      saved: saved => latest.current.onSaved(saved), error: error => latest.current.onError(error),
      deleted: () => latest.current.onDeleted(), files: () => latest.current.onFiles(),
      ready: () => { const model = mounted.getModel(); if (model) { binding = new MonacoBinding(session.doc.getText('code'), model, new Set([mounted])); setSynced(true); } },
    });
    latest.current.onSession(session);
    return () => { binding?.destroy(); session.destroy(); latest.current.onSession(null); };
  }, [mounted, id, props.writable]);
  if (error) return <div className="editor-empty"><h3>Unable to load the editor.</h3><p className="muted">Your changes are still available in this page. Retry when the service is available.</p><button className="button button-secondary" onClick={() => { setError(false); loader.init().then(() => setReady(true)).catch(() => setError(true)); }}>Retry editor</button></div>;
  if (!ready) return <div className="editor-empty" role="status">Loading Monaco editor…</div>;
  return <Editor height="100%" path={`codesync://file/${id}`} language={language} defaultValue="" theme="vs-dark" onMount={setMounted} loading={<span role="status">Loading editor…</span>} options={{ readOnly: readOnly || !synced, automaticLayout: true, minimap: { enabled: false }, fontSize: 14, scrollBeyondLastLine: false, padding: { top: 18 }, wordWrap: 'on', tabSize: 2, ariaLabel: `File code editor: ${name}` }} />;
}

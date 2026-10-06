'use client';
import Editor, { loader } from '@monaco-editor/react';
import { useEffect, useState } from 'react';

// Serve the installed Monaco version and its workers locally, without a CDN.
loader.config({ paths: { vs: '/monaco/vs' } });

export default function CodeEditor({ id, name, language, content, readOnly, onChange }: { id: string; name: string; language: string; content: string; readOnly: boolean; onChange: (content: string) => void }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    loader.init().then(() => { if (active) setReady(true); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  if (error) return <div className="editor-empty"><h3>Unable to load the editor.</h3><p className="muted">Your changes are still available in this page. Retry when the service is available.</p><button className="button button-secondary" onClick={() => { setError(false); loader.init().then(() => setReady(true)).catch(() => setError(true)); }}>Retry editor</button></div>;
  if (!ready) return <div className="editor-empty" role="status">Loading Monaco editor…</div>;
  return <Editor height="100%" path={`codesync://file/${id}/${encodeURIComponent(name)}`} language={language} value={content} theme="vs-dark" onChange={value => onChange(value || '')} loading={<span role="status">Loading editor…</span>} options={{ readOnly, automaticLayout: true, minimap: { enabled: false }, fontSize: 14, scrollBeyondLastLine: false, padding: { top: 18 }, wordWrap: 'on', tabSize: 2, ariaLabel: 'File code editor' }} />;
}

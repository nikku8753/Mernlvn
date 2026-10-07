'use client';
import { useEffect, useRef, useState } from 'react';
import { Play, Terminal } from 'lucide-react';
import { api, ApiError } from '@/lib/api';

type ExecutionResult = {
  status: string; statusId: number; stdout: string; stderr: string; compileOutput: string;
  time: string | number | null; memory: number | null; truncated: boolean;
};
type Props = { fileId: string; filename: string; writable: boolean; ready: boolean; getSource: () => string | undefined };
function executionError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Sign in again to run code.';
    if (error.status === 403) return 'You no longer have permission to run code in this workspace.';
    if (error.status === 404) return 'This file is no longer available. Select another file or refresh the workspace.';
    if (error.message && error.message !== 'Unable to complete your request.') return error.message;
    const messages: Record<number, string> = {
      400: 'Unable to run this source or input. Check the code and input sizes.',
      502: 'The execution runner returned an invalid response. Please try again.',
      503: 'The execution runner is unavailable. Please try again later.',
      504: 'The execution runner did not finish in time. Please try again later.',
    };
    return messages[error.status] || 'Unable to run this file. Please try again.';
  }
  return 'Unable to run this file. Please try again.';
}

export function FileExecution({ fileId, filename, writable, ready, getSource }: Props) {
  const [stdin, setStdin] = useState('');
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const request = useRef<AbortController | null>(null);
  const supported = /\.(js|mjs|cjs|py|java|c|cpp|cc|cxx)$/i.test(filename);
  useEffect(() => {
    request.current?.abort(); request.current = null;
    setResult(null); setError(''); setRunning(false); setStdin('');
    // Abort only the pending HTTP request; React owns the entire console tree.
    return () => { request.current?.abort(); request.current = null; };
  }, [fileId, filename, writable]);

  async function run() {
    if (!writable || !ready || !supported || request.current) return;
    // Read at click time, after Monaco/Yjs edits, rather than from saved props.
    const source = getSource();
    if (source === undefined) { setError('Wait for the editor to finish loading before running.'); return; }
    if (!source.trim()) { setError('Source code must not be empty.'); return; }
    if (new TextEncoder().encode(source).length > 200_000) { setError('Source code must be at most 200 KB.'); return; }
    if (new TextEncoder().encode(stdin).length > 4000) { setError('Standard input must be at most 4 KB.'); return; }
    const controller = new AbortController(); request.current = controller;
    setRunning(true); setError(''); setResult(null);
    try {
      const output = await api<ExecutionResult>(`/api/files/${fileId}/run`, {
        method: 'POST', body: JSON.stringify({ source, stdin }), signal: controller.signal,
      });
      if (!controller.signal.aborted) setResult(output);
    } catch (error) { if (!controller.signal.aborted) setError(executionError(error)); }
    finally { if (request.current === controller) { request.current = null; setRunning(false); } }
  }

  return <section className="execution-panel" aria-label="Code execution console" aria-busy={running}>
    <div className="execution-heading"><h2><Terminal size={14} /> Console</h2><span className="muted">{filename}</span>
      <button type="button" className="button button-small" onClick={() => void run()} disabled={!writable || !ready || !supported || running}><Play size={14} />{running ? 'Running…' : 'Run'}</button>
    </div>
    {!writable ? <p className="execution-note muted">Read-only access. Only owners and editors can run code.</p> : <>
      {supported ? <details className="execution-input"><summary>Standard input (optional)</summary><label htmlFor={`execution-stdin-${fileId}`} className="sr-only">Standard input for {filename}</label><textarea id={`execution-stdin-${fileId}`} rows={2} value={stdin} maxLength={4000} onChange={event => setStdin(event.target.value)} disabled={running} placeholder="Input sent when the program starts" /></details> : <p className="execution-note muted">Run supports JavaScript, Python, Java, C and C++ files when available on the runner.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {running && <p className="execution-note muted" role="status">Running the current editor snapshot…</p>}
      {result && <div className="execution-output"><p className={`execution-result ${result.statusId === 3 ? 'execution-ok' : 'execution-failed'}`} role="status">{result.status}{result.time !== null && ` · ${result.time}s`}{result.memory !== null && ` · ${result.memory} KB`}</p>
        {result.stdout && <div><h3>stdout</h3><pre>{result.stdout}</pre></div>}
        {result.stderr && <div><h3>stderr</h3><pre>{result.stderr}</pre></div>}
        {result.compileOutput && <div><h3>Compiler output</h3><pre>{result.compileOutput}</pre></div>}
        {!result.stdout && !result.stderr && !result.compileOutput && <p className="muted">No output.</p>}
        {result.truncated && <p className="muted">Output truncated to 16 KB per stream.</p>}
      </div>}
    </>}
  </section>;
}

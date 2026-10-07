// Test-only HTTP fixture. It stores submitted source as text and never runs it.
import { createServer } from 'node:http';
import { once } from 'node:events';
export const runnerLanguages = [
  { id: 63, name: 'JavaScript (Node.js 22)' }, { id: 71, name: 'Python (3.12)' },
  { id: 62, name: 'Java (OpenJDK 17)' }, { id: 50, name: 'C (GCC 12)' }, { id: 54, name: 'C++ (GCC 12)' },
];
export async function fakeRunner() {
  const state = {
    catalogue: [...runnerLanguages], httpStatus: 200, statusId: 3, polls: 0, queuedPolls: 0,
    stdout: 'hello\n', stderr: '', compileOutput: '', raw: undefined as string | undefined,
    invalidBase64: false, requests: [] as { path: string; key: string | undefined }[],
    submissions: [] as Record<string, unknown>[],
    onLanguages: undefined as (() => Promise<void>) | undefined,
    onSubmission: undefined as (() => Promise<void>) | undefined,
    reset() {
      this.catalogue = [...runnerLanguages]; this.httpStatus = 200; this.statusId = 3;
      this.polls = 0; this.queuedPolls = 0; this.stdout = 'hello\n'; this.stderr = ''; this.compileOutput = '';
      this.raw = undefined; this.invalidBase64 = false; this.requests = []; this.submissions = [];
      this.onLanguages = undefined; this.onSubmission = undefined;
    },
  };
  const server = createServer(async (req, res) => {
    try {
      const path = req.url || '';
      state.requests.push({ path, key: req.headers['x-auth-token'] as string | undefined });
      res.setHeader('Content-Type', 'application/json');
      if (state.httpStatus !== 200) { res.statusCode = state.httpStatus; res.end('upstream private token and host details'); return; }
      if (state.raw !== undefined) { res.end(state.raw); return; }
      if (path === '/languages') { await state.onLanguages?.(); res.end(JSON.stringify(state.catalogue)); return; }
      if (req.method === 'POST' && path.startsWith('/submissions?')) {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        state.submissions.push(JSON.parse(Buffer.concat(chunks).toString()));
        await state.onSubmission?.();
        res.statusCode = 201; res.end(JSON.stringify({ token: 'fixture-token' })); return;
      }
      if (path.startsWith('/submissions/fixture-token?')) {
        state.polls++;
        if (state.polls <= state.queuedPolls) { res.end(JSON.stringify({ status: { id: 2 } })); return; }
        const encode = (value: string) => Buffer.from(value).toString('base64');
        res.end(JSON.stringify({
          status: { id: state.statusId, description: 'Untrusted description must not be returned' },
          stdout: state.invalidBase64 ? 'invalid%' : encode(state.stdout), stderr: encode(state.stderr), compile_output: encode(state.compileOutput),
          time: '0.01', memory: 1000, token: 'private-runner-token', message: 'private worker details',
        })); return;
      }
      res.statusCode = 404; res.end('{}');
    } catch { if (!res.destroyed) { res.statusCode = 500; res.end('{}'); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fake runner port.');
  return { state, url: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

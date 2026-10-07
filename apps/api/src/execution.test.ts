import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createExecutionClient, executionLanguage } from './execution.js';
import { fakeRunner } from './execution-test-runner.js';

let runner: Awaited<ReturnType<typeof fakeRunner>>;
beforeAll(async () => { runner = await fakeRunner(); });
beforeEach(() => runner.state.reset());
afterAll(async () => { await runner.close(); });
const client = (timeoutMs = 2000) => createExecutionClient({ url: runner.url, apiKey: 'server-only-test-key', timeoutMs, pollIntervalMs: 1 });

test('derives only supported extension languages', () => {
  for (const [file, language] of Object.entries({ 'main.js': 'javascript', 'main.mjs': 'javascript', 'main.cjs': 'javascript', 'main.PY': 'python', 'Main.java': 'java', 'main.c': 'c', 'main.cpp': 'cpp', 'main.cc': 'cpp', 'main.cxx': 'cpp' })) expect(executionLanguage(file)).toBe(language);
  for (const file of ['main.ts', 'main.tsx', 'main.jsx', 'main.sh', 'py', 'main.js.txt']) expect(() => executionLanguage(file)).toThrow('Unsupported file type');
});

test('submits all five discovered languages with source, stdin, private header and sandbox limits', async () => {
  for (const language of ['javascript', 'python', 'java', 'c', 'cpp'] as const) {
    const result = await client().execute(language, 'current source', 'input\n');
    expect(result).toMatchObject({ statusId: 3, status: 'Accepted', stdout: 'hello\n', stderr: '', compileOutput: '', truncated: false });
  }
  expect(runner.state.submissions.map(body => body.language_id)).toEqual([63, 71, 62, 50, 54]);
  for (const body of runner.state.submissions) {
    expect(Buffer.from(String(body.source_code), 'base64').toString()).toBe('current source');
    expect(Buffer.from(String(body.stdin), 'base64').toString()).toBe('input\n');
    expect(body).toMatchObject({ enable_network: false, cpu_time_limit: 2, wall_time_limit: 5, number_of_runs: 1 });
    expect(body).not.toHaveProperty('callback_url'); expect(body).not.toHaveProperty('compiler_options');
  }
  expect(runner.state.requests.every(request => request.key === 'server-only-test-key')).toBe(true);
  expect(runner.state.requests.some(request => request.path.includes('wait=false'))).toBe(true);
});

test('rejects a language absent from the runner without submitting', async () => {
  runner.state.catalogue = runner.state.catalogue.filter(item => item.id !== 71);
  await expect(client().execute('python', 'code', '')).rejects.toMatchObject({ status: 422 });
  expect(runner.state.submissions).toHaveLength(0);
});

test.each([[6, 'Compilation Error'], [11, 'Runtime Error (NZEC)'], [5, 'Time Limit Exceeded']])('preserves status %s and stdout/stderr/compiler output', async (id, status) => {
  runner.state.statusId = id as number; runner.state.stdout = 'output'; runner.state.stderr = 'runtime diagnostics'; runner.state.compileOutput = 'compiler diagnostics';
  expect(await client().execute('c', 'code', '')).toMatchObject({ statusId: id, status, stdout: 'output', stderr: 'runtime diagnostics', compileOutput: 'compiler diagnostics' });
});

test('polls queued submissions until completion', async () => {
  runner.state.queuedPolls = 2;
  expect((await client().execute('javascript', 'code', '')).statusId).toBe(3);
  expect(runner.state.polls).toBe(3); expect(runner.state.submissions).toHaveLength(1);
});

test('times out queued work and an unresponsive runner', async () => {
  runner.state.queuedPolls = Number.MAX_SAFE_INTEGER;
  await expect(client(100).execute('javascript', 'code', '')).rejects.toMatchObject({ status: 504 });
  runner.state.reset(); runner.state.onLanguages = () => new Promise(resolve => setTimeout(resolve, 200));
  await expect(client(100).execute('javascript', 'code', '')).rejects.toMatchObject({ status: 504 });
});

test.each([401, 403, 422, 429, 500, 503])('sanitizes upstream HTTP %s errors', async status => {
  runner.state.httpStatus = status;
  await expect(client().execute('javascript', 'code', '')).rejects.toMatchObject({ status: 503 });
  await expect(client().execute('javascript', 'code', '')).rejects.not.toThrow('upstream private');
});

test('handles missing configuration, unreachable runner, and invalid URL without local fallback', async () => {
  await expect(createExecutionClient({ url: '', apiKey: '' }).execute('c', 'code', '')).rejects.toMatchObject({ status: 503 });
  await expect(createExecutionClient({ url: 'http://127.0.0.1:1', apiKey: '' }).execute('c', 'code', '')).rejects.toMatchObject({ status: 503 });
  await expect(createExecutionClient({ url: 'file:///tmp/runner', apiKey: '' }).execute('c', 'code', '')).rejects.toMatchObject({ status: 503 });
});

test('rejects invalid JSON, schema, encoded output, internal errors and excessive responses', async () => {
  for (const raw of ['not json', '{}', 'x'.repeat(300_001)]) {
    runner.state.raw = raw; await expect(client().execute('c', 'code', '')).rejects.toMatchObject({ status: 502 });
  }
  runner.state.reset(); runner.state.invalidBase64 = true;
  await expect(client().execute('c', 'code', '')).rejects.toMatchObject({ status: 502 });
  runner.state.reset(); runner.state.statusId = 13;
  await expect(client().execute('c', 'code', '')).rejects.toMatchObject({ status: 503 });
});

test('bounds each decoded stream and preserves UTF-8 characters', async () => {
  runner.state.stdout = '€'.repeat(8000); runner.state.stderr = 'x'.repeat(20000); runner.state.compileOutput = 'x'.repeat(20000);
  const result = await client().execute('c', 'code', '');
  expect(result.truncated).toBe(true);
  for (const output of [result.stdout, result.stderr, result.compileOutput]) expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16000);
  expect(result.stdout).not.toContain('�');
  runner.state.reset();
  runner.state.onSubmission = async () => {
    runner.state.raw = JSON.stringify({ status: { id: 3 }, stdout: Buffer.alloc(20000, 0xff).toString('base64') });
  };
  const malformedUtf8 = await client().execute('c', 'code', '');
  expect(malformedUtf8.truncated).toBe(true);
  expect(Buffer.byteLength(malformedUtf8.stdout)).toBeLessThanOrEqual(16000);
});

test('does not submit after permissions are revoked during discovery', async () => {
  const { HttpError } = await import('./permissions.js');
  await expect(client().execute('c', 'code', '', async () => { throw new HttpError(403, 'Revoked'); })).rejects.toMatchObject({ status: 403 });
  expect(runner.state.submissions).toHaveLength(0);
});

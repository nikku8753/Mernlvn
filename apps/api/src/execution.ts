import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { config } from './config.js';
import { HttpError } from './permissions.js';

// HTTP adapter only. Source is data sent to an external sandbox, never a local
// command or executable module. Compiler IDs come from the runner catalogue.
const languages = [
  { language: 'javascript', extensions: ['js', 'mjs', 'cjs'], name: /^JavaScript \(Node\.js / },
  { language: 'python', extensions: ['py'], name: /^Python \(3\./ },
  { language: 'java', extensions: ['java'], name: /^Java \(OpenJDK / },
  { language: 'c', extensions: ['c'], name: /^C \(GCC / },
  { language: 'cpp', extensions: ['cpp', 'cc', 'cxx'], name: /^C\+\+ \(GCC / },
] as const;
export type ExecutionLanguage = typeof languages[number]['language'];
export function executionLanguage(filename: string): ExecutionLanguage {
  const dot = filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  const match = languages.find(item => (item.extensions as readonly string[]).includes(extension));
  if (!match) throw new HttpError(422, 'Unsupported file type. Run supports JavaScript, Python, Java, C and C++ when available on the execution runner.');
  return match.language;
}
const catalogueSchema = z.array(z.object({ id: z.number().int().positive(), name: z.string().max(200) })).max(500);
const encodedOutput = z.string().max(100_000).nullable().optional();
const resultSchema = z.object({
  status: z.object({ id: z.number().int().min(1).max(14) }),
  stdout: encodedOutput, stderr: encodedOutput, compile_output: encodedOutput,
  time: z.union([z.string().max(32).regex(/^\d+(\.\d+)?$/), z.number().finite().nonnegative()]).nullable().optional(),
  memory: z.number().finite().nonnegative().nullable().optional(),
});
const statusNames: Record<number, string> = {
  3: 'Accepted', 4: 'Wrong Answer', 5: 'Time Limit Exceeded', 6: 'Compilation Error',
  7: 'Runtime Error (SIGSEGV)', 8: 'Runtime Error (SIGXFSZ)', 9: 'Runtime Error (SIGFPE)',
  10: 'Runtime Error (SIGABRT)', 11: 'Runtime Error (NZEC)', 12: 'Runtime Error (Other)', 14: 'Exec Format Error',
};
type RunnerOptions = { url: string; apiKey: string; timeoutMs?: number; pollIntervalMs?: number };
export function createExecutionClient({ url, apiKey, timeoutMs = 20_000, pollIntervalMs = 250 }: RunnerOptions) {
  return {
    async execute(language: ExecutionLanguage, source: string, stdin: string, beforeSubmit?: () => Promise<void>) {
      if (!url) throw new HttpError(503, 'Code execution is unavailable. Configure an isolated execution runner to enable it.');
      let base: string;
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid URL');
        base = parsed.toString().replace(/\/+$/, '');
      } catch { throw new HttpError(503, 'The execution runner URL is invalid. Ask the administrator to check its configuration.'); }
      const signal = AbortSignal.timeout(timeoutMs);
      async function json(path: string, body?: unknown): Promise<unknown> {
        const response = await fetch(`${base}${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-Auth-Token': apiKey } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpError(503, response.status === 401 || response.status === 403
            ? 'The execution runner rejected its server credentials. Ask the administrator to check its configuration.'
            : 'The execution runner is unavailable or busy. Please try again later.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new HttpError(502, 'The execution runner returned an invalid response.');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 300_000) { await reader.cancel(); throw new HttpError(502, 'Execution output exceeded the runner response limit.'); }
            chunks.push(value);
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } finally { reader.releaseLock(); }
      }
      try {
        const catalogue = catalogueSchema.parse(await json('/languages'));
        const type = languages.find(item => item.language === language)!;
        const selected = catalogue.filter(item => type.name.test(item.name)).sort((a, b) => b.id - a.id)[0];
        if (!selected) throw new HttpError(422, 'The configured runner does not support this file language.');
        // Discovery is an external await: recheck current permissions before
        // handing the source to the runner, without locking collaboration.
        await beforeSubmit?.();
        signal.throwIfAborted();
        const submission = z.object({ token: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/) }).parse(await json('/submissions?base64_encoded=true&wait=false', {
          language_id: selected.id, source_code: Buffer.from(source).toString('base64'), stdin: Buffer.from(stdin).toString('base64'),
          cpu_time_limit: 2, cpu_extra_time: 0.5, wall_time_limit: 5, memory_limit: 256_000,
          max_processes_and_or_threads: 60, max_file_size: 64, number_of_runs: 1,
          enable_network: false, enable_per_process_and_thread_time_limit: false,
          enable_per_process_and_thread_memory_limit: false,
        }));
        let result;
        do {
          await delay(pollIntervalMs, undefined, { signal });
          result = resultSchema.parse(await json(`/submissions/${encodeURIComponent(submission.token)}?base64_encoded=true&fields=stdout,stderr,compile_output,status,time,memory`));
        } while (result.status.id <= 2);
        if (result.status.id === 13) throw new HttpError(503, 'The execution runner could not initialize its sandbox. Ask the administrator to check the runner configuration.');
        let truncated = false;
        function decode(value: string | null | undefined) {
          if (!value) return '';
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new HttpError(502, 'The execution runner returned invalid encoded output.');
          // Normalize invalid UTF-8 before measuring the returned text: replacement
          // characters can otherwise expand a 16 KB byte slice past the limit.
          const bytes = Buffer.from(Buffer.from(value, 'base64').toString('utf8'), 'utf8');
          if (bytes.length > 16_000) truncated = true;
          // Avoid splitting a UTF-8 character at the display limit.
          let end = Math.min(bytes.length, 16_000);
          if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
          return bytes.subarray(0, end).toString('utf8');
        }
        const stdout = decode(result.stdout), stderr = decode(result.stderr), compileOutput = decode(result.compile_output);
        return { stdout, stderr, compileOutput, statusId: result.status.id, status: statusNames[result.status.id], time: result.time ?? null, memory: result.memory ?? null, truncated };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new HttpError(504, 'The execution runner did not finish in time. Please try again later.');
        if (error instanceof z.ZodError || error instanceof SyntaxError) throw new HttpError(502, 'The execution runner returned an invalid response.');
        throw new HttpError(503, 'Unable to reach the isolated execution runner. Ask the administrator to start it or check its configuration.');
      }
    },
  };
}
export async function execute(language: ExecutionLanguage, source: string, stdin: string, beforeSubmit?: () => Promise<void>) {
  return createExecutionClient({ url: config.EXECUTION_URL, apiKey: config.EXECUTION_API_KEY }).execute(language, source, stdin, beforeSubmit);
}

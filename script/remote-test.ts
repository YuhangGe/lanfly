import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_BODY = 20 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_TIMEOUT = 10 * 60_000;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

interface Job {
  id: string;
  state: 'running' | 'done';
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  artifacts: string[];
}

interface JobInput {
  source: string;
  runtime?: 'bun' | 'node' | 'sh';
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected an object');
  }
  return value as Record<string, unknown>;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request exceeds 20 MiB');
    chunks.push(bytes);
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON');
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function validPath(relative: string): boolean {
  const parts = relative.split('/');
  return (
    relative.length > 0 &&
    !relative.includes('\\') &&
    !path.isAbsolute(relative) &&
    !parts.some(
      (part) => !part || part.startsWith('.') || ['node_modules', 'target', 'dist'].includes(part),
    ) &&
    parts[0] !== 'data.json' &&
    !relative.endsWith('.node')
  );
}

async function checkedPath(root: string, relative: string): Promise<string> {
  if (!validPath(relative)) throw new HttpError(400, `Invalid source path: ${relative}`);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new HttpError(400, `Symlink path: ${relative}`);
  }
  return current;
}

function jobInput(value: Record<string, unknown>): JobInput {
  if (
    typeof value.source !== 'string' ||
    !value.source.trim() ||
    value.source.length > MAX_OUTPUT
  ) {
    throw new HttpError(400, 'Expected a script of at most 1 MiB');
  }
  const runtime = value.runtime ?? 'bun';
  if (typeof runtime !== 'string' || !['bun', 'node', 'sh'].includes(runtime)) {
    throw new HttpError(400, 'Invalid runtime');
  }
  const timeoutMs = value.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > MAX_TIMEOUT) {
    throw new HttpError(400, 'Timeout must be between 1 and 600000 ms');
  }
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new HttpError(400, 'Invalid script arguments');
  }
  const env = value.env === undefined ? {} : object(value.env);
  if (
    Object.entries(env).some(
      ([key, val]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== 'string',
    )
  ) {
    throw new HttpError(400, 'Invalid environment');
  }
  return {
    source: value.source,
    runtime: runtime as JobInput['runtime'],
    timeoutMs: Number(timeoutMs),
    args,
    env: env as Record<string, string>,
  };
}

/** Development-only remote execution. Kept outside the application's HTTP server. */
export async function createRemoteTestServer(options: {
  root: string;
  token: string;
  host?: string;
  port?: number;
  log?: (message: string) => void;
}) {
  const root = path.resolve(options.root);
  if (options.token.length < 16) throw new Error('Token must contain at least 16 characters');
  const directory = path.join(root, '.tmp/remote-test');
  await mkdir(directory, { recursive: true });
  const jobs = new Map<string, Job>();
  let active: { job: Job; child?: ChildProcess; stop: () => void } | undefined;
  let syncing = false;
  const expected = Buffer.from(`Bearer ${options.token}`);

  async function run(job: Job, input: JobInput): Promise<void> {
    const folder = path.join(directory, 'jobs', job.id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    try {
      await mkdir(path.join(folder, 'artifacts'), { recursive: true });
      const file = path.join(
        folder,
        input.runtime === 'sh' ? 'task.sh' : input.runtime === 'node' ? 'task.mjs' : 'task.ts',
      );
      await writeFile(file, input.source);
      const executable =
        input.runtime === 'sh' ? '/bin/sh' : input.runtime === 'node' ? 'node' : process.execPath;
      const child = spawn(executable, [file, ...(input.args ?? [])], {
        cwd: root,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LANFLY_INPUT_DEBUG: '1',
          ...input.env,
          LANFLY_REMOTE_ROOT: root,
          LANFLY_REMOTE_JOB_ID: job.id,
          LANFLY_REMOTE_ARTIFACTS: path.join(folder, 'artifacts'),
        },
      });
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      const stop = () => {
        kill('SIGTERM');
        force ??= setTimeout(() => kill('SIGKILL'), 1_000);
      };
      if (active?.job === job) {
        active.child = child;
        active.stop = stop;
      }
      // A cancellation can arrive while the job directory is being prepared.
      if (job.cancelled) stop();
      for (const key of ['stdout', 'stderr'] as const) {
        child[key]!.on('data', (chunk: Buffer) => {
          const combined = Buffer.concat([Buffer.from(job[key]), chunk]);
          if (combined.length > MAX_OUTPUT) job.truncated = true;
          job[key] = combined.subarray(-MAX_OUTPUT).toString('utf8');
        });
      }
      timeout = setTimeout(() => {
        job.timedOut = true;
        stop();
      }, input.timeoutMs);
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          job.exitCode = code;
          if (signal) job.signal = signal;
          resolve();
        });
      });
    } catch (error) {
      job.stderr += `${String(error)}\n`;
      job.exitCode = 1;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (force) clearTimeout(force);
      job.artifacts = (
        await readdir(path.join(folder, 'artifacts'), { withFileTypes: true }).catch(() => [])
      )
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
      job.finishedAt = new Date().toISOString();
      job.state = 'done';
      if (active?.job === job) active = undefined;
      options.log?.(
        `[remote-test] done ${job.id} exit=${job.exitCode} timeout=${job.timedOut} cancelled=${job.cancelled}`,
      );
      await writeFile(path.join(folder, 'result.json'), JSON.stringify(job, null, 2)).catch(
        () => undefined,
      );
    }
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const actual = Buffer.from(request.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new HttpError(401, 'Invalid bearer token');
      }
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/health') {
        return json(response, 200, {
          root,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          busy: !!active || syncing,
        });
      }
      if (request.method === 'POST' && pathname === '/jobs') {
        const input = jobInput(await body(request));
        if (active || syncing) throw new HttpError(409, 'Another job or source upload is running');
        const job: Job = {
          id: randomUUID(),
          state: 'running',
          startedAt: new Date().toISOString(),
          exitCode: null,
          timedOut: false,
          cancelled: false,
          stdout: '',
          stderr: '',
          truncated: false,
          artifacts: [],
        };
        jobs.set(job.id, job);
        // Bound in-memory history; on-disk results remain under .tmp/remote-test.
        if (jobs.size > 25) jobs.delete(jobs.keys().next().value!);
        active = { job, stop: () => undefined };
        options.log?.(
          `[remote-test] start ${job.id} runtime=${input.runtime} timeout=${input.timeoutMs}ms`,
        );
        void run(job, input);
        return json(response, 202, { id: job.id });
      }
      const match = /^\/jobs\/([a-f0-9-]+)(?:\/(cancel|artifacts)(?:\/([^/]+))?)?$/.exec(pathname);
      if (match) {
        const job =
          jobs.get(match[1]) ??
          (await readFile(path.join(directory, 'jobs', match[1], 'result.json'), 'utf8')
            .then((text) => JSON.parse(text) as Job)
            .catch(() => undefined));
        if (!job) throw new HttpError(404, 'Unknown job');
        if (request.method === 'GET' && !match[2]) return json(response, 200, job);
        if (request.method === 'POST' && match[2] === 'cancel') {
          if (active?.job === job) {
            job.cancelled = true;
            active.stop();
          }
          return json(response, 200, { id: job.id, cancelled: job.cancelled });
        }
        if (request.method === 'GET' && match[2] === 'artifacts' && match[3]) {
          const name = decodeURIComponent(match[3]);
          if (job.state !== 'done' || !job.artifacts.includes(name) || name !== path.basename(name))
            throw new HttpError(404, 'Unknown artifact');
          const file = path.join(directory, 'jobs', job.id, 'artifacts', name);
          const stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BODY)
            throw new HttpError(400, 'Expected a regular artifact of at most 20 MiB');
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
          });
          response.end(await readFile(file));
          return;
        }
      }
      if (request.method === 'POST' && pathname === '/files') {
        const value = await body(request);
        if (!Array.isArray(value.files) || !value.files.length || value.files.length > 100)
          throw new HttpError(400, 'Expected 1..100 source files');
        if (active || syncing) throw new HttpError(409, 'Another job or source upload is running');
        syncing = true;
        try {
          const files = await Promise.all(
            value.files.map(async (raw) => {
              const file = object(raw);
              if (
                typeof file.path !== 'string' ||
                typeof file.base64 !== 'string' ||
                typeof file.sha256 !== 'string'
              )
                throw new HttpError(400, 'Invalid source file');
              const destination = await checkedPath(root, file.path);
              const data = Buffer.from(file.base64, 'base64');
              if (hash(data) !== file.sha256) throw new HttpError(400, 'Source checksum mismatch');
              const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return undefined;
                throw error;
              });
              if (existing && !existing.isFile())
                throw new HttpError(400, 'Expected a regular source file');
              return { relative: file.path, destination, data, existing };
            }),
          );
          if (new Set(files.map((file) => file.destination)).size !== files.length)
            throw new HttpError(400, 'Duplicate source paths');
          const backup = randomUUID();
          const backupDirectory = path.join(directory, 'backups', backup);
          for (const file of files) {
            if (!file.existing) continue;
            const previous = path.join(backupDirectory, file.relative);
            await mkdir(path.dirname(previous), { recursive: true });
            await writeFile(previous, await readFile(file.destination));
          }
          await mkdir(backupDirectory, { recursive: true });
          await writeFile(
            path.join(backupDirectory, 'manifest.json'),
            JSON.stringify(
              files.map((file) => ({ path: file.relative, existed: !!file.existing })),
              null,
              2,
            ),
          );
          for (const file of files) {
            await mkdir(path.dirname(file.destination), { recursive: true });
            const temporary = path.join(directory, `upload-${randomUUID()}`);
            await writeFile(temporary, file.data, { mode: file.existing?.mode ?? 0o644 });
            await rename(temporary, file.destination);
          }
          options.log?.(
            `[remote-test] updated ${files.map((file) => file.relative).join(', ')} backup=${backup}`,
          );
          return json(response, 200, {
            backup,
            files: files.map((file) => ({ path: file.relative, sha256: hash(file.data) })),
          });
        } finally {
          syncing = false;
        }
      }
      throw new HttpError(404, 'Unknown endpoint');
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(response, error instanceof HttpError ? error.status : 500, { error: String(error) });
    });
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8098, options.host ?? '0.0.0.0', resolve);
  });
  return {
    server,
    async close() {
      const job = active?.job;
      if (active) {
        active.job.cancelled = true;
        active.stop();
      }
      server.closeIdleConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const until = Date.now() + 5_000;
      while (job?.state === 'running' && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

async function remote(endpoint: string, value?: unknown): Promise<Response> {
  const url = process.env.LANFLY_REMOTE_URL;
  const token = process.env.LANFLY_REMOTE_TOKEN;
  if (!url || !token)
    throw new Error('Set LANFLY_REMOTE_URL and LANFLY_REMOTE_TOKEN from the receiver output');
  const response = await fetch(new URL(endpoint, url), {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Remote ${response.status}: ${await response.text()}`);
  return response;
}

async function download(job: Job): Promise<void> {
  const folder = path.join(ROOT, '.tmp/remote-test/downloads', job.id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'result.json'), JSON.stringify(job, null, 2));
  await mkdir(path.join(folder, 'artifacts'), { recursive: true });
  for (const name of job.artifacts) {
    if (!name || name !== path.basename(name)) continue;
    const response = await remote(`/jobs/${job.id}/artifacts/${encodeURIComponent(name)}`);
    await writeFile(
      path.join(folder, 'artifacts', name),
      Buffer.from(await response.arrayBuffer()),
    );
  }
  console.log(`\n结果：${folder}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'serve') {
    const tokenFile = path.join(ROOT, '.tmp/remote-test/token');
    await mkdir(path.dirname(tokenFile), { recursive: true });
    let token =
      process.env.LANFLY_REMOTE_TOKEN ?? (await readFile(tokenFile, 'utf8').catch(() => ''));
    if (!token.trim()) token = randomBytes(24).toString('hex');
    token = token.trim();
    await writeFile(tokenFile, token, { mode: 0o600 });
    const port = Number(process.env.LANFLY_REMOTE_PORT ?? '8098');
    const receiver = await createRemoteTestServer({
      root: ROOT,
      token,
      port,
      host: process.env.LANFLY_REMOTE_HOST,
      log: console.log,
    });
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter((address) => address?.family === 'IPv4' && !address.internal)
      .map((address) => address!.address);
    const host = process.env.LANFLY_REMOTE_HOST;
    const advertised = host && !['0.0.0.0', '::'].includes(host) ? [host] : addresses;
    const bound = receiver.server.address();
    const actualPort = bound && typeof bound !== 'string' ? bound.port : port;
    console.log(`调试接收端已启动：${ROOT}\n仅用于当前用户权限下的远程脚本执行，结束时按 Ctrl+C。`);
    for (const address of advertised.length ? advertised : ['127.0.0.1']) {
      console.log(
        `LANFLY_REMOTE_URL=http://${address.includes(':') ? `[${address}]` : address}:${actualPort} LANFLY_REMOTE_TOKEN=${token}`,
      );
    }
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void receiver.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  if (command === 'status') {
    console.log(
      JSON.stringify(
        await (await remote(args[0] ? `/jobs/${args[0]}` : '/health')).json(),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'cancel' && args[0]) {
    console.log(await (await remote(`/jobs/${args[0]}/cancel`, {})).text());
    return;
  }
  if (command === 'get' && args[0]) {
    await download((await (await remote(`/jobs/${args[0]}`)).json()) as Job);
    return;
  }
  if (command === 'push' && args.length) {
    const files = await Promise.all(
      args.map(async (relative) => {
        const file = await checkedPath(ROOT, relative);
        const data = await readFile(file);
        return { path: relative, base64: data.toString('base64'), sha256: hash(data) };
      }),
    );
    console.log(JSON.stringify(await (await remote('/files', { files })).json(), null, 2));
    return;
  }
  if (command === 'run' && args[0]) {
    const [file, ...scriptArgs] = args;
    const extension = path.extname(file);
    const submitted = (await (
      await remote('/jobs', {
        source: await readFile(path.resolve(ROOT, file), 'utf8'),
        runtime: extension === '.sh' ? 'sh' : extension === '.mjs' ? 'node' : 'bun',
        args: scriptArgs,
        timeoutMs: Number(process.env.LANFLY_REMOTE_TIMEOUT_MS ?? '120000'),
      })
    ).json()) as { id: string };
    console.log(`远端任务：${submitted.id}`);
    let previous = { stdout: '', stderr: '' };
    for (;;) {
      const job = (await (await remote(`/jobs/${submitted.id}`)).json()) as Job;
      for (const key of ['stdout', 'stderr'] as const) {
        const added = job[key].startsWith(previous[key])
          ? job[key].slice(previous[key].length)
          : job[key];
        process[key].write(added);
      }
      previous = { stdout: job.stdout, stderr: job.stderr };
      if (job.state === 'done') {
        await download(job);
        if (job.exitCode !== 0 || job.timedOut || job.cancelled) {
          throw new Error(
            `Job failed: exit=${job.exitCode} signal=${job.signal} timeout=${job.timedOut} cancelled=${job.cancelled}`,
          );
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  console.log(
    'Usage: pnpm remote-test serve | status [JOB] | push FILE... | run SCRIPT [ARGS...] | cancel JOB | get JOB',
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}

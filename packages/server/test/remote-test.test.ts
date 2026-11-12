import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRemoteTestServer } from '../../../script/remote-test';

const token = 'test-token-0123456789';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function receiver() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lanfly-remote-test-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = await createRemoteTestServer({ root, token, host: '127.0.0.1', port: 0 });
  cleanup.push(() => service.close());
  const address = service.server.address();
  if (!address || typeof address === 'string') throw new Error('No receiver port');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (endpoint: string, value?: unknown, authorization = `Bearer ${token}`) =>
    fetch(base + endpoint, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  const submit = async (value: unknown) => {
    const response = await request('/jobs', value);
    expect(response.status).toBe(202);
    return ((await response.json()) as { id: string }).id;
  };
  const done = async (id: string) => {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const job = (await (await request(`/jobs/${id}`)).json()) as {
        state: string;
        exitCode: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        cancelled: boolean;
        artifacts: string[];
      };
      if (job.state === 'done') return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Job did not complete');
  };
  return { root, request, submit, done };
}

function file(relative: string, content: string) {
  const bytes = Buffer.from(content);
  return {
    path: relative,
    base64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('development remote test receiver', () => {
  it('requires the bearer token for both status and execution', async () => {
    const r = await receiver();
    expect((await r.request('/health', undefined, '')).status).toBe(401);
    expect(
      (await r.request('/jobs', { source: 'console.log("bad")' }, 'Bearer wrong')).status,
    ).toBe(401);
    expect((await r.request('/health')).status).toBe(200);
    expect((await r.request('/jobs', { source: '', timeoutMs: 0 })).status).toBe(400);
  });

  it('executes successive updated scripts in the repo and returns artifacts', async () => {
    const r = await receiver();
    const first = await r.submit({ source: 'console.log("first", process.cwd());' });
    expect((await r.done(first)).stdout).toContain(`first ${r.root}`);
    const second = await r.submit({
      source:
        'import {writeFile} from "node:fs/promises"; await writeFile(process.env.LANFLY_REMOTE_ARTIFACTS+"/report.txt", "artifact"); console.log("updated"); console.error("diagnostic");',
    });
    const result = await r.done(second);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('updated');
    expect(result.stderr).toContain('diagnostic');
    expect(result.artifacts).toEqual(['report.txt']);
    expect(await (await r.request(`/jobs/${second}/artifacts/report.txt`)).text()).toBe('artifact');
  });

  it('serializes execution and updates, and cancels active jobs', async () => {
    const r = await receiver();
    const id = await r.submit({ source: 'setInterval(() => {}, 100);' });
    expect((await r.request('/jobs', { source: 'console.log("second")' })).status).toBe(409);
    expect((await r.request('/files', { files: [file('script/task.ts', 'updated')] })).status).toBe(
      409,
    );
    expect((await r.request(`/jobs/${id}/cancel`, {})).status).toBe(200);
    expect((await r.done(id)).cancelled).toBe(true);
  });

  it('times out a job and kills its process group', async () => {
    const r = await receiver();
    const id = await r.submit({
      source: 'trap "" TERM; sleep 30 & wait',
      runtime: 'sh',
      timeoutMs: 80,
    });
    const result = await r.done(id);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('verifies source checksums and backs up overwritten files', async () => {
    const r = await receiver();
    await mkdir(path.join(r.root, 'script'));
    await writeFile(path.join(r.root, 'script/task.ts'), 'original');
    const response = await r.request('/files', {
      files: [file('script/task.ts', 'updated'), file('native/src/new.rs', 'new source')],
    });
    expect(response.status).toBe(200);
    const receipt = (await response.json()) as { backup: string };
    expect(await readFile(path.join(r.root, 'script/task.ts'), 'utf8')).toBe('updated');
    expect(
      await readFile(
        path.join(r.root, '.tmp/remote-test/backups', receipt.backup, 'script/task.ts'),
        'utf8',
      ),
    ).toBe('original');
    expect(await readFile(path.join(r.root, 'native/src/new.rs'), 'utf8')).toBe('new source');
    expect(
      (
        await r.request('/files', {
          files: [{ ...file('script/task.ts', 'invalid'), sha256: 'bad' }],
        })
      ).status,
    ).toBe(400);
    expect(await readFile(path.join(r.root, 'script/task.ts'), 'utf8')).toBe('updated');
  });

  it('rejects traversal, config, build output, and symlink uploads', async () => {
    const r = await receiver();
    for (const relative of [
      '../escape',
      '.git/config',
      'data.json',
      'native/index.node',
      'native/target/binary',
    ]) {
      expect((await r.request('/files', { files: [file(relative, 'bad')] })).status).toBe(400);
    }
    await symlink(os.tmpdir(), path.join(r.root, 'linked'));
    expect((await r.request('/files', { files: [file('linked/escape', 'bad')] })).status).toBe(400);
  });

  it('retrieves completed results after the receiver restarts', async () => {
    const r = await receiver();
    const id = await r.submit({ source: 'console.log("persisted");' });
    await r.done(id);
    const restarted = await createRemoteTestServer({
      root: r.root,
      token,
      host: '127.0.0.1',
      port: 0,
    });
    cleanup.push(() => restarted.close());
    const address = restarted.server.address();
    if (!address || typeof address === 'string') throw new Error('No receiver port');
    const response = await fetch(`http://127.0.0.1:${address.port}/jobs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { stdout: string }).stdout).toContain('persisted');
  });
});

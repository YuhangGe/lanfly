import type {
  AppState,
  ChatMessage,
  DesktopSessionView,
  PeerInfo,
  TransferView,
} from '@lanfly/common';

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'superjson';

import { InputStore } from '../src/input/store';

const CLI = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));

interface Instance {
  process: ChildProcess;
  base: string;
  port: number;
  out: string;
  logs: string[];
}

interface RpcResult<T> {
  error?: string;
  data?: T;
}

const instances: Instance[] = [];
const dirs: string[] = [];

async function startInstance(options: {
  name: string;
  roomId?: string;
  omitRoomId?: boolean;
  out: string;
  port?: number;
  discovery?: boolean;
  cli?: string;
  cwd?: string;
  useCliConfig?: boolean;
}): Promise<Instance> {
  const args = [options.cli ?? CLI, '--no-open', '--name', options.name, '--out', options.out];
  if (options.port !== undefined) args.push('--port', String(options.port));
  else args.push('--port', '0');
  if (!options.discovery) args.push('--no-discovery');
  if (!options.omitRoomId) args.push(options.roomId ?? '123456');

  const env: NodeJS.ProcessEnv = { ...process.env, LANFLY_NO_OPEN: '1' };
  if (options.useCliConfig) delete env.LANFLY_CONFIG_DIR;
  else env.LANFLY_CONFIG_DIR = path.join(options.out, 'config');
  const child = spawn(process.execPath, args, {
    env,
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

  return await new Promise<Instance>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`启动超时：\n${logs.join('')}`));
    }, 15_000);
    const onData = (chunk: Buffer) => {
      logs.push(chunk.toString());
      const text = logs.join('');
      const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      const instance: Instance = {
        process: child,
        base: `http://127.0.0.1:${match[1]}`,
        port: Number(match[1]),
        out: options.out,
        logs,
      };
      instances.push(instance);
      resolve(instance);
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出（${code}）：\n${logs.join('')}`));
    });
  });
}

async function rpc<T>(instance: Instance, action: string, input?: unknown): Promise<RpcResult<T>> {
  const body = input === undefined ? undefined : stringify(input);
  const response = await fetch(`${instance.base}/__rpc/${action}`, {
    method: 'POST',
    body,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`RPC ${action} 返回 ${response.status}: ${text}`);
  }
  const [failure, data] = parse<[{ code: string } | null, T?]>(text);
  return failure ? { error: failure.code } : { data };
}

async function state(instance: Instance): Promise<AppState> {
  const result = await rpc<AppState>(instance, 'appState');
  if (!result.data) throw new Error(`无法读取状态：${result.error}`);
  return result.data;
}

async function waitFor<T>(
  describe: string,
  fn: () => Promise<T | undefined>,
  timeout = 8_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${describe}`);
}

async function connect(from: Instance, to: Instance): Promise<RpcResult<PeerInfo>> {
  return rpc<PeerInfo>(from, 'connectPeer', {
    address: `127.0.0.1:${to.port}`,
  });
}

async function sendFileTo(
  from: Instance,
  to: Instance,
  peerName: string,
  name: string,
  content: Buffer,
): Promise<TransferView> {
  const peer = await waitFor(`${peerName} 出现在发送方列表`, async () => {
    const current = await state(from);
    return current.peers.find((item) => item.name === peerName);
  });
  const result = await rpc<{ transferId: string; uploadUrl: string }>(from, 'sendFile', {
    peerId: peer.id,
    file: { name, size: content.length, mime: 'text/plain' },
  });
  if (result.error || !result.data) throw new Error(`创建传输失败：${result.error}`);
  const response = await fetch(`${from.base}${result.data.uploadUrl}`, {
    method: 'POST',
    body: content as unknown as BodyInit,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(content.length),
    },
  });
  expect(response.status).toBe(200);
  const transfer = await waitFor(`传输 ${result.data.transferId} 完成`, async () => {
    const current = await state(to);
    return current.transfers.find(
      (item) => item.id === result.data!.transferId && item.status === 'completed',
    );
  });
  return transfer;
}

async function newOutDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lanfly-int-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    instances.splice(0).map(
      (instance) =>
        new Promise<void>((resolve) => {
          if (instance.process.exitCode !== null) {
            resolve();
            return;
          }
          instance.process.once('exit', () => resolve());
          instance.process.kill('SIGTERM');
          setTimeout(() => {
            instance.process.kill('SIGKILL');
            resolve();
          }, 2_000).unref();
        }),
    ),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('双实例集成', () => {
  it('使用 cli.js 同目录的 data.json，不依赖 shell 工作目录', async () => {
    const dir = await newOutDir();
    const bin = path.join(dir, 'bin');
    const cwd = path.join(dir, 'working');
    await mkdir(bin);
    await mkdir(cwd);
    await copyFile(CLI, path.join(bin, 'cli.js'));
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ type: 'module', version: '0.2.0' }),
    );
    const saved = new InputStore(bin);
    await saved.load();
    saved.data!.settings = { role: 'client', edge: 'left' };
    saved.data!.target = {
      id: saved.data!.id,
      roomId: '123456',
      name: 'Saved configuration',
      host: '127.0.0.1',
      port: 8087,
    };
    await saved.save();
    const instance = await startInstance({
      name: 'Config',
      out: path.join(dir, 'downloads'),
      cli: path.join(bin, 'cli.js'),
      cwd,
      useCliConfig: true,
    });
    const result = await rpc<{ targetName: string; enabled: boolean; settings: unknown }>(
      instance,
      'inputStatus',
    );
    expect(result.data?.targetName).toBe('Saved configuration');
    expect(result.data?.settings).toEqual({ role: 'client', edge: 'left' });
    expect(result.data?.enabled).toBe(false);
    await expect(access(path.join(cwd, 'data.json'))).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('手动连接后可以互发消息和文件，重名自动加序号', async () => {
    await access(CLI).catch(() => {
      throw new Error('未找到 dist/cli.js，请先运行 pnpm build');
    });
    const outA = await newOutDir();
    const outB = await newOutDir();
    const a = await startInstance({ name: 'Alpha', out: outA });
    const b = await startInstance({ name: 'Beta', out: outB });

    const index = await fetch(`${a.base}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<div id="root">');

    const connected = await connect(a, b);
    expect(connected.error).toBeUndefined();
    expect(connected.data?.name).toBe('Beta');

    const bPeers = await waitFor('Beta 看到 Alpha', async () => {
      const current = await state(b);
      return current.peers.find((peer) => peer.name === 'Alpha');
    });
    expect(bPeers.online).toBe(true);

    const aPeers = await waitFor('Alpha 看到 Beta', async () => {
      const current = await state(a);
      return current.peers.find((peer) => peer.name === 'Beta');
    });

    const message = '集成测试消息\n第二行';
    const sent = await rpc<ChatMessage>(a, 'sendMessage', {
      peerId: aPeers.id,
      text: message,
    });
    expect(sent.error).toBeUndefined();
    expect(sent.data?.status).toBe('sent');

    const received = await waitFor('Beta 收到消息', async () => {
      const current = await state(b);
      return current.messages.find((item) => item.text === message);
    });
    expect(received.direction).toBe('in');

    const content = Buffer.from('file from Alpha\n', 'utf8');
    const first = await sendFileTo(a, b, 'Beta', 'note.txt', content);
    expect(first.savedName).toBe('note.txt');
    expect(await readFile(path.join(outB, 'note.txt'), 'utf8')).toBe(content.toString());

    const second = await sendFileTo(a, b, 'Beta', 'note.txt', content);
    expect(second.savedName).toBe('note (1).txt');

    const third = await sendFileTo(a, b, 'Beta', '../../escape.txt', content);
    expect(third.savedName).toBe('escape.txt');
    expect(await readFile(path.join(outB, 'escape.txt'), 'utf8')).toBe(content.toString());

    const empty = await sendFileTo(a, b, 'Beta', 'empty.bin', Buffer.alloc(0));
    expect(empty.savedName).toBe('empty.bin');
    expect(empty.bytes).toBe(0);
    expect((await readFile(path.join(outB, 'empty.bin'))).length).toBe(0);
  });

  it('不同 Room ID 的主机无法连接，相同 Room ID 可以连接', async () => {
    await access(CLI).catch(() => {
      throw new Error('未找到 dist/cli.js，请先运行 pnpm build');
    });
    const a = await startInstance({ name: 'SecretA', roomId: 'alpha', out: await newOutDir() });
    const b = await startInstance({ name: 'SecretB', roomId: 'beta', out: await newOutDir() });
    const c = await startInstance({ name: 'SecretC', roomId: 'alpha', out: await newOutDir() });

    const denied = await connect(a, b);
    expect(denied.error).toBe('ROOM_MISMATCH');

    const accepted = await connect(a, c);
    expect(accepted.error).toBeUndefined();
    const cPeers = await waitFor('SecretC 看到 SecretA', async () => {
      const current = await state(c);
      return current.peers.find((peer) => peer.name === 'SecretA');
    });
    expect(cPeers.online).toBe(true);
  });

  it('Room ID 首次生成后持久化、重启沿用、显式覆盖后再次沿用，旧参数被移除', async () => {
    const out = await newOutDir();
    const a = await startInstance({ name: 'RandomRoom', omitRoomId: true, out });
    const current = (await state(a)).self.roomId;
    expect(current).toMatch(/^\d{6}$/);
    expect(a.logs.join('')).toContain(`Room ID   ${current}`);
    const file = path.join(out, 'config', 'data.json');
    const initial = JSON.parse(await readFile(file, 'utf8')) as {
      roomId: string;
      input: { id: string };
      browser: { key: string };
    };
    expect(initial.roomId).toBe(current);
    const stop = async (instance: Instance) => {
      await new Promise<void>((resolve) => {
        instance.process.once('exit', () => resolve());
        instance.process.kill('SIGTERM');
      });
    };
    await stop(a);
    const b = await startInstance({ name: 'SavedRoom', omitRoomId: true, out });
    expect((await state(b)).self.roomId).toBe(current);
    await stop(b);
    const c = await startInstance({ name: 'OverrideRoom', roomId: '000123', out });
    expect((await state(c)).self.roomId).toBe('000123');
    await stop(c);
    const d = await startInstance({ name: 'RestoredOverride', omitRoomId: true, out });
    expect((await state(d)).self.roomId).toBe('000123');
    const saved = JSON.parse(await readFile(file, 'utf8')) as typeof initial;
    expect(saved.roomId).toBe('000123');
    expect(saved.input.id).toBe(initial.input.id);
    expect(saved.browser.key).toBe(initial.browser.key);

    const result = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, '--secret', 'removed'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout?.on('data', (b: Buffer) => {
        text += b;
      });
      child.stderr?.on('data', (b: Buffer) => {
        text += b;
      });
      child.on('exit', (code) => resolve({ code, text }));
    });
    expect(result.code).toBe(1);
    expect(result.text).toContain('--secret');
  });

  it('远程桌面请求需要被控端确认，并拒绝伪造的设备身份', async () => {
    await access(CLI).catch(() => {
      throw new Error('未找到 dist/cli.js，请先运行 pnpm build');
    });
    const a = await startInstance({ name: 'DeskA', out: await newOutDir() });
    const b = await startInstance({ name: 'DeskB', out: await newOutDir() });
    await connect(a, b);
    const target = await waitFor('A 看到 B', async () => {
      const current = await state(a);
      return current.peers.find((peer) => peer.name === 'DeskB');
    });
    const requested = await rpc<DesktopSessionView>(a, 'desktopRequest', {
      peerId: target.id,
      control: true,
    });
    expect(requested.error).toBeUndefined();
    const incoming = await waitFor('B 收到授权请求', async () => {
      const current = await rpc<{ sessions: DesktopSessionView[] }>(b, 'desktopState');
      return current.data?.sessions.find(
        (session) => session.sessionId === requested.data?.sessionId,
      );
    });
    expect(incoming.role).toBe('controlled');
    expect(incoming.phase).toBe('pending');
    expect(incoming.controlRequested).toBe(true);
    expect(incoming.control).toBe(false);

    // A request alone must never start media or bypass the controlled-side confirmation.
    const early = await rpc(a, 'desktopOffer', {
      sessionId: incoming.sessionId,
      sdp: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n',
    });
    expect(early.error).toBe('DESKTOP_STATE');

    const rejected = await rpc(b, 'desktopReject', { sessionId: incoming.sessionId });
    expect(rejected.error).toBeUndefined();
    await waitFor('B 清除被拒绝的会话', async () => {
      const current = await rpc<{ sessions: DesktopSessionView[] }>(b, 'desktopState');
      return current.data?.sessions.length === 0 ? true : undefined;
    });

    const canceled = await rpc<DesktopSessionView>(a, 'desktopRequest', {
      peerId: target.id,
      control: false,
    });
    expect(canceled.error).toBeUndefined();
    await waitFor('B 再次收到授权请求', async () => {
      const current = await rpc<{ sessions: DesktopSessionView[] }>(b, 'desktopState');
      return current.data?.sessions.some(
        (session) => session.sessionId === canceled.data?.sessionId,
      )
        ? true
        : undefined;
    });
    const stopped = await rpc(a, 'desktopStop', {
      sessionId: canceled.data!.sessionId,
      reason: 'CANCELED',
    });
    expect(stopped.error).toBeUndefined();
    await waitFor('发起方取消后 B 清除请求', async () => {
      const current = await rpc<{ sessions: DesktopSessionView[] }>(b, 'desktopState');
      return current.data?.sessions.length === 0 ? true : undefined;
    });

    const forgedId = crypto.randomUUID();
    const forged = await fetch(`${b.base}/api/v1/peer/desktop/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lanfly-room': '123456',
        'x-lanfly-id': forgedId,
      },
      body: JSON.stringify({
        sessionId: crypto.randomUUID(),
        from: {
          id: forgedId,
          name: 'Forged',
          port: 9,
          version: '0.2.0',
          roomId: '123456',
        },
        control: true,
      }),
    });
    expect(forged.status).toBe(403);
  });

  it('端口被占用时自动顺延', async () => {
    await access(CLI).catch(() => {
      throw new Error('未找到 dist/cli.js，请先运行 pnpm build');
    });
    const freePort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
    const a = await startInstance({
      name: 'PortA',
      out: await newOutDir(),
      port: freePort,
    });
    const b = await startInstance({
      name: 'PortB',
      out: await newOutDir(),
      port: freePort,
    });
    expect(a.port).toBe(freePort);
    expect(b.port).toBe(freePort + 1);
    const bState = await state(b);
    expect(bState.self.port).toBe(freePort + 1);
  });
});

import type { InputSettings, InputStatus } from '@lanfly/common';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import http, { type IncomingMessage } from 'node:http';
import { z } from 'zod';

import type { EventHub } from '../services/events';
import type { PeerTarget } from '../services/remote';

import { errorCode, throwActionError } from '../core/errors';
import { logger } from '../logger';
import { InputChannel } from './channel';
import { loadNative, type NativeInput, type NativeStatus } from './native';
import { InputStore } from './store';

export const INPUT_PATH = '/api/v1/peer/input';
const UPGRADE = 'lanfly-input-v2';
const eventSchema = z.object({ kind: z.enum(['enter', 'event', 'input-source']) }).passthrough();
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('layout'), edge: z.enum(['left', 'right', 'top', 'bottom']) }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('leave') }),
  z.object({ type: z.literal('events'), events: z.array(eventSchema).min(1).max(1024) }),
]);
const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;

/** One room-scoped input connection. Either host may initiate either role. */
export class InputService {
  readonly store: InputStore;
  readonly roomId: string;
  #port = 8087;
  #stopping = false;
  #revision = 0;
  #native?: NativeInput;
  #status: InputStatus;
  #initialized = false;
  #channel?: InputChannel;
  #request?: http.ClientRequest;
  #timer?: NodeJS.Timeout;
  #poll?: NodeJS.Timeout;
  #target?: PeerTarget;
  #ingress?: string;
  #prepared = false;
  #preparing = false;
  #ready = false;
  #accepting = false;
  #lastReceive = 0;
  #lastConnect = 0;
  #deadline = 0;

  constructor(
    private readonly name: string,
    private readonly events: EventHub,
    options: { roomId: string; store?: InputStore; native?: NativeInput; supported?: boolean },
  ) {
    this.roomId = options.roomId;
    this.store = options.store ?? new InputStore();
    this.#native = options.native;
    this.#status = {
      supported:
        options.supported ??
        (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)),
      available: false,
      accessibility: false,
      inputMonitoring: false,
      screens: 0,
      settings: this.store.settings,
      enabled: false,
      phase: 'disabled',
      controlling: false,
    };
  }
  listen(port: number): void {
    this.#port = port;
  }
  async initialize(): Promise<void> {
    try {
      await this.store.load();
      this.#initialized = true;
      this.#status.settings = this.store.settings;
      this.#status.targetName = this.store.data?.target?.name;
    } catch {
      this.#status.error = 'INPUT_CONFIG_ERROR';
      logger.warn(`无法读取或保存配置文件 ${this.store.file}`);
    }
  }
  resume(): void {
    if (
      !this.#initialized ||
      !this.store.data?.autoStart ||
      this.store.data.target?.roomId !== this.roomId
    )
      return;
    try {
      this.#enableRuntime();
      this.#target = this.store.data.target;
      this.#tick();
    } catch (error) {
      this.#status.error = errorCode(error, 'INPUT_START_FAILED');
      this.#publish();
    }
  }
  status(): InputStatus {
    if (this.#status.supported) {
      this.#native ??= loadNative();
      this.#status.available = Boolean(this.#native);
      if (this.#native) {
        try {
          Object.assign(this.#status, JSON.parse(this.#native.status()) as NativeStatus);
          if (
            this.#status.error === 'INPUT_PERMISSION' &&
            this.#status.accessibility &&
            this.#status.inputMonitoring
          )
            this.#status.error = undefined;
        } catch {
          this.#status.error = 'INPUT_NATIVE_ERROR';
        }
      }
    }
    return { ...this.#status, settings: { ...this.#status.settings } };
  }
  #publish(): void {
    this.events.broadcast('input', this.status());
  }
  #check(): void {
    const s = this.status();
    if (!s.supported) throwActionError('INPUT_UNSUPPORTED');
    if (!s.available) throwActionError('INPUT_NATIVE_MISSING');
    if (!this.#initialized) throwActionError('INPUT_CONFIG_ERROR');
    if (s.screens !== 1) throwActionError('INPUT_SINGLE_SCREEN');
    if (!s.accessibility || !s.inputMonitoring) throwActionError('INPUT_PERMISSION');
  }
  refresh(): InputStatus {
    const s = this.status();
    if (!s.enabled && s.accessibility && s.inputMonitoring) this.resume();
    this.#publish();
    return this.status();
  }
  permissions(): InputStatus {
    if (!this.status().supported) throwActionError('INPUT_UNSUPPORTED');
    if (!this.#native) throwActionError('INPUT_NATIVE_MISSING');
    this.#native.requestPermissions();
    return this.status();
  }
  async configure(settings: InputSettings): Promise<InputStatus> {
    if (!this.#initialized) throwActionError('INPUT_CONFIG_ERROR');
    this.#stopRuntime();
    this.store.data!.settings = settings;
    this.store.data!.autoStart = false;
    await this.#save();
    this.#status.settings = settings;
    this.#publish();
    return this.status();
  }
  async enable(): Promise<InputStatus> {
    this.#enableRuntime();
    this.store.data!.autoStart = true;
    await this.#save();
    this.#tick();
    return this.status();
  }
  #enableRuntime(): void {
    this.#check();
    if (this.#status.enabled) return;
    this.#status.enabled = true;
    this.#status.phase = 'waiting';
    this.#status.error = undefined;
    this.#timer = setInterval(() => this.#tick(), 500);
    this.#timer.unref();
    this.#publish();
  }
  async connect(target: PeerTarget, settings = this.store.settings): Promise<InputStatus> {
    this.#check();
    if (this.#accepting) throwActionError('INPUT_BUSY');
    this.#stopRuntime();
    const revision = this.#revision;
    this.store.data!.settings = settings;
    this.store.data!.target = undefined;
    this.store.data!.autoStart = true;
    this.#status.settings = settings;
    this.#status.targetName = undefined;
    this.#target = target;
    await this.#save();
    if (revision !== this.#revision || this.#stopping) return this.status();
    this.#enableRuntime();
    this.#connect(target);
    return this.status();
  }
  async forget(): Promise<InputStatus> {
    await this.disable();
    this.#target = undefined;
    this.store.data!.target = undefined;
    this.#status.targetName = undefined;
    await this.#save();
    return this.status();
  }
  async disable(notify = true): Promise<InputStatus> {
    if (notify && this.#channel?.peer) {
      this.#channel.send({ type: 'stop' });
      this.#channel.close(true);
    }
    this.#stopRuntime();
    if (!this.#initialized) throwActionError('INPUT_CONFIG_ERROR');
    this.store.data!.autoStart = false;
    await this.#save();
    return this.status();
  }
  async #save(): Promise<void> {
    try {
      await this.store.save();
    } catch {
      this.#stopRuntime();
      throwActionError('INPUT_CONFIG_ERROR');
    }
  }
  #stopRuntime(): void {
    this.#revision++;
    this.#status.enabled = false;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#disconnect();
    this.#publish();
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#stopRuntime();
    await this.store.flush();
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    void this.#upgrade(request, socket, head);
  }
  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const role = request.headers['x-lanfly-input-role'];
    const id = request.headers['x-lanfly-input-id'];
    const port = Number(request.headers['x-lanfly-input-port']);
    if (
      this.#stopping ||
      request.url !== INPUT_PATH ||
      request.headers.upgrade?.toLowerCase() !== UPGRADE ||
      request.headers['x-lanfly-room'] !== this.roomId ||
      !['server', 'client'].includes(String(role)) ||
      !z.string().uuid().safeParse(id).success ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (this.#accepting || this.#channel || (this.#request && String(id) >= this.store.data!.id)) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return;
    }
    this.#accepting = true;
    try {
      this.#check();
      this.#stopRuntime();
      const revision = this.#revision;
      const edge = z
        .enum(['left', 'right', 'top', 'bottom'])
        .parse(request.headers['x-lanfly-input-edge']);
      const settings: InputSettings = { edge, role: role === 'server' ? 'client' : 'server' };
      this.store.data!.settings = settings;
      this.store.data!.target = undefined;
      this.store.data!.autoStart = true;
      this.#status.settings = settings;
      await this.#save();
      if (socket.destroyed || this.#stopping || revision !== this.#revision) {
        socket.destroy();
        return;
      }
      this.#enableRuntime();
      const target = { host: (request.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), port };
      this.#target = target;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${UPGRADE}\r\n\r\n`,
      );
      this.#attach(socket, target, head, String(id));
    } catch {
      if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    } finally {
      this.#accepting = false;
    }
  }
  #connect(target: PeerTarget): void {
    if (this.#request || this.#channel || this.#accepting) return;
    this.#lastConnect = Date.now();
    this.#status.phase = 'connecting';
    this.#status.error = undefined;
    const request = http.request({
      hostname: target.host,
      port: target.port,
      path: INPUT_PATH,
      headers: {
        connection: 'Upgrade',
        upgrade: UPGRADE,
        'x-lanfly-room': this.roomId,
        'x-lanfly-input-role': this.store.settings.role,
        'x-lanfly-input-id': this.store.data!.id,
        'x-lanfly-input-port': String(this.#port),
        'x-lanfly-input-edge': this.store.settings.edge,
      },
      timeout: 5000,
    });
    this.#request = request;
    const failure = () => {
      if (this.#request !== request) return;
      this.#request = undefined;
      this.#status.phase = this.#status.enabled ? 'waiting' : 'disabled';
      this.#status.error = 'INPUT_CONNECT_FAILED';
      request.destroy();
      this.#publish();
    };
    request.on('timeout', failure);
    request.on('error', failure);
    request.on('response', (response) => {
      response.resume();
      failure();
    });
    request.on('upgrade', (response, socket, head) => {
      if (
        this.#request !== request ||
        !this.#status.enabled ||
        response.headers.upgrade?.toLowerCase() !== UPGRADE
      ) {
        socket.destroy();
        failure();
        return;
      }
      this.#request = undefined;
      socket.setTimeout(0);
      this.#attach(socket, target, head);
    });
    request.end();
    this.#publish();
  }
  #attach(socket: Duplex, target: PeerTarget, head: Buffer, expectedId?: string): void {
    if ('setNoDelay' in socket) (socket as Socket).setNoDelay(true);
    const c = new InputChannel(socket, {
      role: this.store.settings.role,
      name: this.name,
      id: this.store.data!.id,
      roomId: this.roomId,
    });
    this.#channel = c;
    this.#deadline = Date.now() + 10_000;
    this.#lastReceive = Date.now();
    c.on('hello', () => {
      if (expectedId && c.peer!.id !== expectedId) {
        c.close();
        return;
      }
      this.#status.peerName = c.peer!.name;
      if (this.store.settings.role === 'server') {
        c.send({ type: 'layout', edge: this.store.settings.edge });
        void this.#prepare(c, target);
      }
      this.#publish();
    });
    c.on('message', (raw: unknown) => {
      if (this.#channel !== c) return;
      const parsed = messageSchema.safeParse(raw);
      if (!parsed.success) {
        c.close();
        return;
      }
      const m = parsed.data;
      this.#lastReceive = Date.now();
      try {
        if (m.type === 'stop') {
          void this.disable(false).catch(() => {
            this.#status.error = 'INPUT_CONFIG_ERROR';
            this.#publish();
          });
        } else if (m.type === 'layout') {
          if (this.store.settings.role !== 'client' || this.#preparing || this.#prepared) {
            c.close();
            return;
          }
          this.#ingress = opposite[m.edge];
          void this.#prepare(c, target);
        } else if (m.type === 'ready') {
          this.#ready = true;
          this.#activate(c);
        } else if (m.type === 'heartbeat') {
          if (this.#prepared && this.store.settings.role === 'client')
            this.#native!.inject('{"kind":"heartbeat"}');
        } else {
          if (this.#status.phase !== 'connected') {
            c.close();
            return;
          }
          if (m.type === 'leave') {
            this.#native!.reset();
            this.#status.controlling = false;
            this.#publish();
          } else {
            if (this.store.settings.role !== 'client') {
              c.close();
              return;
            }
            for (const event of m.events) {
              this.#native!.inject(JSON.stringify(event));
              if (event.kind === 'enter') {
                this.#status.controlling = true;
                this.#publish();
              }
            }
          }
        }
      } catch {
        this.#status.error = 'INPUT_NATIVE_ERROR';
        c.close();
      }
    });
    c.on('closed', () => {
      if (this.#channel === c) {
        this.#disconnect();
        this.#publish();
      }
    });
    c.start(head);
  }
  async #prepare(c: InputChannel, target: PeerTarget): Promise<void> {
    if (this.#channel !== c || this.#prepared || this.#preparing || !c.peer) return;
    this.#preparing = true;
    try {
      this.#check();
      this.store.data!.target = {
        ...target,
        id: c.peer.id,
        name: c.peer.name,
        roomId: this.roomId,
      };
      await this.#save();
      if (this.#channel !== c || c.closed) return;
      this.#status.targetName = c.peer.name;
      if (this.store.settings.role === 'client') {
        if (!this.#ingress) throw new Error('missing layout');
        this.#native!.start('client', this.#ingress);
        this.#startPoll(c);
      }
      this.#prepared = true;
      if (this.store.settings.role === 'client') c.send({ type: 'ready' });
      this.#activate(c);
    } catch {
      if (this.#channel === c) {
        this.#status.error = 'INPUT_START_FAILED';
        c.close();
      }
    } finally {
      if (this.#channel === c) this.#preparing = false;
    }
  }
  #activate(c: InputChannel): void {
    if (
      this.#channel !== c ||
      !this.#prepared ||
      !this.#ready ||
      this.#status.phase === 'connected'
    )
      return;
    try {
      if (this.store.settings.role === 'server') {
        this.#native!.start('server', this.store.settings.edge);
        c.send({ type: 'ready' });
      }
      this.#status.phase = 'connected';
      this.#status.error = undefined;
      this.#startPoll(c);
      this.#publish();
    } catch (error) {
      this.#status.error =
        error instanceof Error && error.message === 'INPUT_CURSOR_CAPTURE'
          ? 'INPUT_CURSOR_CAPTURE'
          : 'INPUT_START_FAILED';
      this.#stopRuntime();
    }
  }
  #startPoll(c: InputChannel): void {
    if (!this.#poll) {
      this.#poll = setInterval(() => this.#drain(c), 4);
      this.#poll.unref();
    }
  }
  #drain(c: InputChannel): void {
    try {
      const events = JSON.parse(this.#native!.poll()) as { kind: string; reason?: string }[];
      if (events.some((e) => e.kind === 'fault' && e.reason === 'cursor')) {
        this.#status.error = 'INPUT_CURSOR_CAPTURE';
        this.#stopRuntime();
        return;
      }
      if (events.some((e) => e.kind === 'fault')) {
        this.#status.error = 'INPUT_INTERRUPTED';
        c.close();
        return;
      }
      if (events.some((e) => e.kind === 'emergency')) {
        void this.disable().catch(() => {
          this.#status.error = 'INPUT_CONFIG_ERROR';
          this.#publish();
        });
        return;
      }
      if (events.some((e) => e.kind === 'leave')) {
        c.send({ type: 'leave' });
        this.#status.controlling = false;
        this.#publish();
      }
      const inputs = events.filter((e) => ['enter', 'event', 'input-source'].includes(e.kind));
      if (inputs.length && this.store.settings.role === 'server') {
        for (let i = 0; i < inputs.length; i += 64)
          c.send({ type: 'events', events: inputs.slice(i, i + 64) });
        if (inputs.some((e) => e.kind === 'enter')) {
          this.#status.controlling = true;
          this.#publish();
        }
      }
    } catch {
      this.#status.error = 'INPUT_NATIVE_ERROR';
      c.close();
    }
  }
  #disconnect(): void {
    this.#request?.destroy();
    this.#request = undefined;
    const c = this.#channel;
    this.#channel = undefined;
    c?.close();
    clearInterval(this.#poll);
    this.#poll = undefined;
    this.#native?.stop();
    this.#ready = false;
    this.#prepared = false;
    this.#preparing = false;
    this.#ingress = undefined;
    this.#status.phase = this.#status.enabled ? 'waiting' : 'disabled';
    this.#status.controlling = false;
    this.#status.peerName = undefined;
  }
  #tick(): void {
    if (!this.#status.enabled) return;
    const s = this.status();
    if (s.screens !== 1 || !s.accessibility || !s.inputMonitoring) {
      this.#status.error = s.screens !== 1 ? 'INPUT_SINGLE_SCREEN' : 'INPUT_PERMISSION';
      this.#stopRuntime();
      return;
    }
    const c = this.#channel;
    if (c) {
      if (
        Date.now() - this.#lastReceive > 2500 ||
        (s.phase !== 'connected' && Date.now() > this.#deadline)
      ) {
        this.#status.error = 'INPUT_CONNECTION_LOST';
        c.close();
        return;
      }
      if (c.peer) c.send({ type: 'heartbeat' });
    } else if (Date.now() - this.#lastConnect > 3000) {
      const target =
        this.#target ??
        (this.store.data?.target?.roomId === this.roomId ? this.store.data.target : undefined);
      // Either role can reconnect. Simultaneous attempts use the stable IDs to pick one stream.
      if (target?.host) this.#connect(target);
    }
  }
}

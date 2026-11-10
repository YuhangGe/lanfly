import type { InputSettings, InputStatus } from '@lanfly/common';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import http, { type IncomingMessage } from 'node:http';
import { z } from 'zod';

import type { EventHub } from '../services/events';
import type { PeerTarget } from '../services/remote';

import { throwActionError } from '../core/errors';
import { InputChannel } from './channel';
import { loadNative, type NativeInput, type NativeStatus } from './native';
import { InputStore } from './store';

export const INPUT_PATH = '/api/v1/peer/input';
const eventSchema = z.object({ kind: z.enum(['enter', 'event']) }).passthrough();
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('confirm') }),
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('layout'), edge: z.enum(['left', 'right', 'top', 'bottom']) }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('leave') }),
  z.object({ type: z.literal('events'), events: z.array(eventSchema).min(1).max(1024) }),
]);
const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;

/** One native session and one authenticated channel per local process. */
export class InputService {
  readonly store: InputStore;
  #native: NativeInput | undefined;
  #status: InputStatus;
  #channel: InputChannel | undefined;
  #request: http.ClientRequest | undefined;
  #timer: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  #remoteConfirmed = false;
  #remoteReady = false;
  #prepared = false;
  #preparing = false;
  #lastReceive = 0;
  #deadline = 0;
  #lastConnect = 0;
  #target: PeerTarget | undefined;
  #ingress: string | undefined;
  #initialized = false;

  constructor(
    private readonly name: string,
    private readonly events: EventHub,
    options: { store?: InputStore; native?: NativeInput; supported?: boolean } = {},
  ) {
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
      confirmed: false,
    };
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    try {
      await this.store.load();
      this.#initialized = true;
      this.#status.settings = this.store.settings;
      this.#status.pairedName = this.store.data?.paired?.name;
    } catch {
      this.#status.error = 'INPUT_CONFIG_ERROR';
    }
  }

  status(): InputStatus {
    if (this.#status.supported) {
      this.#native ??= loadNative();
      this.#status.available = Boolean(this.#native);
      if (this.#native) {
        try {
          Object.assign(this.#status, JSON.parse(this.#native.status()) as NativeStatus);
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

  permissions(): InputStatus {
    if (!this.status().supported) throwActionError('INPUT_UNSUPPORTED');
    if (!this.#native) throwActionError('INPUT_NATIVE_MISSING');
    this.#native.requestPermissions();
    return this.status();
  }

  async configure(settings: InputSettings): Promise<InputStatus> {
    if (!this.#initialized) throwActionError('INPUT_CONFIG_ERROR');
    this.disable();
    const previous = this.store.data!.settings;
    this.store.data!.settings = settings;
    try {
      await this.store.save();
    } catch {
      this.store.data!.settings = previous;
      throwActionError('INPUT_CONFIG_ERROR');
    }
    this.#status.settings = settings;
    this.#publish();
    return this.status();
  }

  enable(): InputStatus {
    this.#check();
    if (this.#status.enabled) return this.status();
    this.#status.enabled = true;
    this.#status.phase = 'waiting';
    this.#status.error = undefined;
    // Unknown peers require a deliberate, time-limited pairing window.
    if (this.store.settings.role === 'server' && !this.store.data?.paired) this.openPairing();
    this.#timer = setInterval(() => this.#tick(), 500);
    this.#timer.unref();
    this.#tick();
    this.#publish();
    return this.status();
  }

  openPairing(): InputStatus {
    this.#check();
    if (!this.#status.enabled || this.store.settings.role !== 'server')
      throwActionError('INPUT_NOT_READY');
    this.#status.pairingUntil = Date.now() + 120_000;
    this.#publish();
    return this.status();
  }

  async connect(target: PeerTarget): Promise<InputStatus> {
    this.#check();
    if (!this.#status.enabled || this.store.settings.role !== 'client')
      throwActionError('INPUT_NOT_READY');
    this.#target = target;
    this.#disconnect();
    this.#connect(target);
    return this.status();
  }

  confirm(code: string): InputStatus {
    const c = this.#channel;
    if (
      !c?.peer ||
      this.#status.phase !== 'pairing' ||
      code !== c.code ||
      Date.now() > this.#deadline
    )
      throwActionError('INPUT_PAIR_EXPIRED');
    this.#status.confirmed = true;
    c.send({ type: 'confirm' });
    void this.#prepare(c);
    this.#publish();
    return this.status();
  }

  async forget(): Promise<InputStatus> {
    this.disable();
    this.#target = undefined;
    if (!this.#initialized) throwActionError('INPUT_CONFIG_ERROR');
    const previous = this.store.data!.paired;
    this.store.data!.paired = undefined;
    try {
      await this.store.save();
    } catch {
      this.store.data!.paired = previous;
      throwActionError('INPUT_CONFIG_ERROR');
    }
    this.#status.pairedName = undefined;
    this.#publish();
    return this.status();
  }

  disable(): InputStatus {
    this.#status.enabled = false;
    this.#status.pairingUntil = undefined;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#disconnect();
    this.#status.phase = 'disabled';
    this.#publish();
    return this.status();
  }

  stop(): void {
    this.disable();
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (
      request.url !== INPUT_PATH ||
      request.headers.upgrade?.toLowerCase() !== 'lanfly-input-v1' ||
      !this.#status.enabled ||
      this.store.settings.role !== 'server' ||
      this.#channel ||
      (!this.store.data?.paired && (this.#status.pairingUntil ?? 0) < Date.now())
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    try {
      this.#check();
    } catch {
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: lanfly-input-v1\r\n\r\n',
    );
    this.#attach(socket, { host: request.socket.remoteAddress ?? '', port: 8087 }, head);
  }

  #connect(target: PeerTarget): void {
    if (this.#request || this.#channel) return;
    this.#lastConnect = Date.now();
    this.#status.phase = 'connecting';
    this.#status.error = undefined;
    const request = http.request({
      hostname: target.host,
      port: target.port,
      path: INPUT_PATH,
      headers: { connection: 'Upgrade', upgrade: 'lanfly-input-v1' },
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
        response.headers.upgrade?.toLowerCase() !== 'lanfly-input-v1'
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

  #attach(socket: Duplex, target: PeerTarget, head: Buffer): void {
    if ('setNoDelay' in socket) (socket as Socket).setNoDelay(true);
    const c = new InputChannel(socket, {
      role: this.store.settings.role,
      name: this.name,
      key: this.store.key!,
      publicKey: this.store.publicKey,
    });
    this.#channel = c;
    this.#deadline = Date.now() + 120_000;
    this.#lastReceive = Date.now();
    c.on('hello', () => {
      const paired = this.store.data?.paired;
      if (paired && paired.key !== c.peer!.key) {
        this.#status.error = 'INPUT_PEER_CHANGED';
        c.close();
        return;
      }
      if (
        !paired &&
        this.store.settings.role === 'server' &&
        (this.#status.pairingUntil ?? 0) < Date.now()
      ) {
        c.close();
        return;
      }
      this.#status.peerName = c.peer!.name;
      this.#status.phase = 'pairing';
      this.#status.pairingCode = c.code;
      this.#status.confirmed = Boolean(paired);
      if (this.store.settings.role === 'server')
        c.send({ type: 'layout', edge: this.store.settings.edge });
      if (paired) c.send({ type: 'confirm' });
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
        if (m.type === 'confirm') {
          this.#remoteConfirmed = true;
          void this.#prepare(c, target);
        } else if (m.type === 'layout') {
          if (this.store.settings.role !== 'client' || this.#prepared) {
            c.close();
            return;
          }
          this.#ingress = opposite[m.edge];
        } else if (m.type === 'ready') {
          if (!this.#status.confirmed || !this.#remoteConfirmed) {
            c.close();
            return;
          }
          this.#remoteReady = true;
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
      if (this.#channel !== c) return;
      this.#disconnect();
      this.#publish();
    });
    // Retain actual client target for confirmation initiated from local UI.
    this.#target = this.store.settings.role === 'client' ? target : this.#target;
    c.start(head);
  }

  async #prepare(c: InputChannel, target = this.#target): Promise<void> {
    if (
      this.#channel !== c ||
      !this.#status.confirmed ||
      !this.#remoteConfirmed ||
      this.#prepared ||
      this.#preparing
    )
      return;
    this.#preparing = true;
    try {
      this.#check();
      this.store.data!.paired = {
        key: c.peer!.key,
        name: c.peer!.name,
        host: target?.host ?? '',
        port: target?.port ?? 8087,
      };
      await this.store.save();
      if (this.#channel !== c || c.closed) return;
      this.#status.pairedName = c.peer!.name;
      this.#status.pairingUntil = undefined;
      if (this.store.settings.role === 'client') {
        if (!this.#ingress) throw new Error('missing layout');
        this.#native!.start('client', this.#ingress);
        this.#poll = setInterval(() => this.#drain(c), 4);
        this.#poll.unref();
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
      !this.#remoteReady ||
      this.#status.phase === 'connected'
    )
      return;
    try {
      if (this.store.settings.role === 'server') {
        this.#native!.start('server', this.store.settings.edge);
        c.send({ type: 'ready' });
      }
      this.#status.phase = 'connected';
      this.#status.pairingCode = undefined;
      this.#status.error = undefined;
      if (!this.#poll) {
        this.#poll = setInterval(() => this.#drain(c), 4);
        this.#poll.unref();
      }
      this.#publish();
    } catch (error) {
      if (error instanceof Error && error.message === 'INPUT_CURSOR_CAPTURE') {
        this.#status.error = 'INPUT_CURSOR_CAPTURE';
        this.disable();
      } else {
        this.#status.error = 'INPUT_START_FAILED';
        c.close();
      }
    }
  }

  #drain(c: InputChannel): void {
    try {
      const events = JSON.parse(this.#native!.poll()) as { kind: string; reason?: string }[];
      if (events.some((e) => e.kind === 'fault' && e.reason === 'cursor')) {
        this.#status.error = 'INPUT_CURSOR_CAPTURE';
        this.disable();
        return;
      }
      if (events.some((e) => e.kind === 'fault')) {
        this.#status.error = 'INPUT_INTERRUPTED';
        c.close();
        return;
      }
      if (events.some((e) => e.kind === 'emergency')) {
        // Stop the session on either device; emergency never silently reconnects.
        this.disable();
        return;
      }
      if (events.some((e) => e.kind === 'leave')) {
        c.send({ type: 'leave' });
        this.#status.controlling = false;
        this.#publish();
      }
      const inputs = events.filter((e) => e.kind === 'enter' || e.kind === 'event');
      if (inputs.length && this.store.settings.role === 'server') {
        for (let i = 0; i < inputs.length; i += 64) {
          c.send({ type: 'events', events: inputs.slice(i, i + 64) });
        }
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
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = undefined;
    this.#native?.stop();
    this.#remoteConfirmed = false;
    this.#remoteReady = false;
    this.#prepared = false;
    this.#preparing = false;
    this.#ingress = undefined;
    this.#status.phase = this.#status.enabled ? 'waiting' : 'disabled';
    this.#status.controlling = false;
    this.#status.confirmed = false;
    this.#status.peerName = undefined;
    this.#status.pairingCode = undefined;
  }

  #tick(): void {
    if (!this.#status.enabled) return;
    const s = this.status();
    if (s.screens !== 1 || !s.accessibility || !s.inputMonitoring) {
      this.#status.error = s.screens !== 1 ? 'INPUT_SINGLE_SCREEN' : 'INPUT_PERMISSION';
      this.disable();
      return;
    }
    if ((s.pairingUntil ?? Infinity) < Date.now()) {
      this.#status.pairingUntil = undefined;
      this.#publish();
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
    } else if (
      this.store.settings.role === 'client' &&
      Date.now() - this.#lastConnect > 3000 &&
      this.#status.error !== 'INPUT_PEER_CHANGED'
    ) {
      const target = this.#target ?? this.store.data?.paired;
      if (target?.host) this.#connect(target);
    }
  }
}

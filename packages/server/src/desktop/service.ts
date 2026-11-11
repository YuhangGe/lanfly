import {
  DESKTOP_ACCEPT_TTL_MS,
  DESKTOP_DEFAULT_BITRATE,
  DESKTOP_EVENT,
  DESKTOP_FPS,
  DESKTOP_MAX_BITRATE,
  DESKTOP_MAX_HEIGHT,
  DESKTOP_MAX_WIDTH,
  DESKTOP_MIN_BITRATE,
  DESKTOP_REQUEST_TTL_MS,
  type DesktopEvent,
  type DesktopIceCandidate,
  type DesktopOfferResult,
  type DesktopPhase,
  type DesktopRequestInput,
  type DesktopSessionView,
  type DesktopStatus,
  desktopPeerAcceptSchema,
  desktopPeerErrorSchema,
  desktopPeerIceSchema,
  desktopPeerOfferSchema,
  desktopPeerRejectSchema,
  desktopPeerRequestSchema,
  desktopPeerStateSchema,
  desktopPeerStopSchema,
} from '@lanfly/common';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import type { Application } from '../app';

import { ErrorCodes, throwActionError } from '../core/errors';
import { randomToken, safeTokenEquals } from '../core/security';
import { loadDesktopNative, type NativeDesktop } from '../input/native';
import { logger } from '../logger';

type Role = 'controller' | 'controlled';

interface Session {
  id: string;
  role: Role;
  owner: string;
  peerId: string;
  peerName: string;
  peerHost: string;
  peerPort: number;
  token?: string;
  controlRequested: boolean;
  control: boolean;
  phase: DesktopPhase;
  width: number;
  height: number;
  bitrate: number;
  createdAt: number;
  expiresAt: number;
  nativeStarted: boolean;
  error?: string;
}

const BITRATES_KEY = 'desktopBitrates';

const ACTIVE_PHASES = new Set<DesktopPhase>([
  'pending',
  'accepted',
  'connecting',
  'connected',
  'disconnected',
]);
function isActive(phase: DesktopPhase): boolean {
  return ACTIVE_PHASES.has(phase);
}

/** The host-side authority for desktop requests, authorization, signaling and native lifecycle. */
export class DesktopService {
  #sessions = new Map<string, Session>();
  #native: NativeDesktop | null | undefined;
  #poll?: NodeJS.Timeout;
  #cleanup?: NodeJS.Timeout;
  #polling = false;
  #stopped = false;

  constructor(private readonly app: Application) {}

  start(): void {
    this.#cleanup = setInterval(() => this.#expire(), 5_000);
    this.#cleanup.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#cleanup);
    clearInterval(this.#poll);
    this.#poll = undefined;
    for (const session of Array.from(this.#sessions.values())) {
      this.#finish(session, 'stopped', 'STOPPED', false);
    }
    try {
      this.#native?.desktopStopAll();
    } catch {
      // Native teardown is best-effort during process shutdown.
    }
  }

  status(): DesktopStatus {
    const native = this.#binding();
    if (!native) {
      return {
        supported: process.platform === 'darwin',
        available: false,
        screenRecording: false,
        accessibility: false,
        screens: 0,
      };
    }
    try {
      return JSON.parse(native.desktopStatus()) as DesktopStatus;
    } catch (error) {
      logger.debug(`读取远程桌面状态失败：${String(error)}`);
      return {
        supported: true,
        available: true,
        screenRecording: false,
        accessibility: false,
        screens: 0,
      };
    }
  }

  permissions(): DesktopStatus {
    const native = this.#requireNative();
    native.desktopRequestPermissions();
    return this.status();
  }

  hasActive(): boolean {
    return Boolean(this.#activeSession());
  }

  /** The quality choice is remembered per target display name, not by ephemeral peer ID. */
  bitrates(): Record<string, number> {
    const stored = this.app.state.get(BITRATES_KEY);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const result: Record<string, number> = {};
    for (const [name, value] of Object.entries(stored)) {
      if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= DESKTOP_MIN_BITRATE &&
        value <= DESKTOP_MAX_BITRATE
      ) {
        result[name] = value;
      }
    }
    return result;
  }

  bitrateFor(name: string): number {
    return this.bitrates()[name] ?? DESKTOP_DEFAULT_BITRATE;
  }

  #rememberBitrate(name: string, bitrate: number): void {
    const bitrates = this.bitrates();
    if (bitrates[name] === bitrate) return;
    bitrates[name] = bitrate;
    void this.app.state.set(BITRATES_KEY, bitrates).catch((error) => {
      logger.debug(`保存远程桌面清晰度失败：${String(error)}`);
    });
  }

  async request(owner: string, input: DesktopRequestInput): Promise<DesktopSessionView> {
    if (this.#activeSession()) throwActionError(ErrorCodes.DESKTOP_BUSY);
    const target = this.app.network.peers().find((peer) => peer.id === input.peerId);
    if (!target || target.id === this.app.identity.id) throwActionError(ErrorCodes.PEER_NOT_FOUND);
    if (target.kind === 'browser') throwActionError(ErrorCodes.DESKTOP_UNSUPPORTED);
    if (!target.online) throwActionError(ErrorCodes.PEER_OFFLINE);
    const viewer =
      owner === this.app.identity.id ? undefined : this.app.network.browsers.get(owner)?.info.name;
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      role: 'controller',
      owner,
      peerId: target.id,
      peerName: target.name,
      peerHost: target.host,
      peerPort: target.port,
      controlRequested: true,
      control: true,
      phase: 'pending',
      width: 0,
      height: 0,
      bitrate: input.bitrate ?? this.bitrateFor(target.name),
      createdAt: now,
      expiresAt: now + DESKTOP_REQUEST_TTL_MS,
      nativeStarted: false,
    };
    this.#sessions.set(session.id, session);
    this.#rememberBitrate(target.name, session.bitrate);
    try {
      const accepted = await this.app.remote.desktopRequest(this.#target(session), {
        sessionId: session.id,
        from: this.app.identity.info,
        control: true,
        viewer,
        bitrate: session.bitrate,
      });
      if (accepted.from.id !== session.peerId) {
        throwActionError(ErrorCodes.DESKTOP_PEER_MISMATCH);
      }
      session.token = accepted.token;
      session.control = true;
      session.controlRequested = true;
      session.phase = 'accepted';
      session.width = accepted.width;
      session.height = accepted.height;
      session.expiresAt = Date.now() + DESKTOP_ACCEPT_TTL_MS;
      if (!accepted.screenRecording) {
        session.error = ErrorCodes.DESKTOP_PERMISSION;
        await this.app.remote
          .desktopStop(
            this.#target(session),
            {
              sessionId: session.id,
              from: this.app.identity.info,
              reason: ErrorCodes.DESKTOP_PERMISSION,
            },
            session.token,
          )
          .catch(() => undefined);
      }
      await this.#disableInput();
      this.#emit(session.owner, { type: 'accepted', session: this.#view(session) });
    } catch (error) {
      this.#sessions.delete(session.id);
      logger.debug(`远程桌面请求失败：${String(error)}`);
      if (error && typeof error === 'object' && 'code' in error) {
        const code = String((error as { code: unknown }).code);
        if (code.startsWith('DESKTOP_')) throwActionError(code);
      }
      throwActionError(ErrorCodes.PEER_UNREACHABLE);
    }
    return this.#view(session);
  }

  async accept(sessionId: string, control: boolean): Promise<DesktopSessionView> {
    const session = this.#requireSession(sessionId, 'controlled');
    if (session.phase !== 'pending') throwActionError(ErrorCodes.DESKTOP_STATE);
    const status = this.status();
    if (!status.available) throwActionError(ErrorCodes.DESKTOP_NATIVE_MISSING);
    if (!status.screenRecording) throwActionError(ErrorCodes.DESKTOP_PERMISSION);
    if (status.screens < 1) throwActionError(ErrorCodes.DESKTOP_CAPTURE_FAILED);
    await this.#disableInput();
    session.control = control && session.controlRequested;
    session.phase = 'accepted';
    session.expiresAt = Date.now() + DESKTOP_ACCEPT_TTL_MS;
    session.error = undefined;
    try {
      await this.app.remote.desktopAccept(this.#target(session), {
        sessionId: session.id,
        from: this.app.identity.info,
        token: session.token,
        control: session.control,
        width: status.display?.width ?? DESKTOP_MAX_WIDTH,
        height: status.display?.height ?? DESKTOP_MAX_HEIGHT,
      });
    } catch (error) {
      this.#finish(session, 'failed', 'PEER_UNREACHABLE', false);
      logger.debug(`发送远程桌面授权失败：${String(error)}`);
      throwActionError(ErrorCodes.PEER_UNREACHABLE);
    }
    this.#emit(session.owner, { type: 'accepted', session: this.#view(session) });
    return this.#view(session);
  }

  async reject(sessionId: string, reason?: string): Promise<void> {
    const session = this.#requireSession(sessionId, 'controlled');
    if (session.phase !== 'pending') throwActionError(ErrorCodes.DESKTOP_STATE);
    try {
      await this.app.remote.desktopReject(this.#target(session), {
        sessionId: session.id,
        from: this.app.identity.info,
        reason,
      });
    } catch (error) {
      logger.debug(`发送远程桌面拒绝失败：${String(error)}`);
    }
    this.#finish(session, 'rejected', reason, false);
  }

  async offer(owner: string, sessionId: string, sdp: string): Promise<DesktopOfferResult> {
    const session = this.#requireSession(sessionId, 'controller');
    this.#assertOwner(session, owner);
    if (!isActive(session.phase) || session.phase === 'pending')
      throwActionError(ErrorCodes.DESKTOP_STATE);
    if (!session.token) throwActionError(ErrorCodes.DESKTOP_STATE);
    const wasConnected = session.phase === 'connected';
    if (!wasConnected) session.phase = 'connecting';
    session.expiresAt = Date.now() + DESKTOP_ACCEPT_TTL_MS;
    if (!wasConnected) {
      this.#emit(session.owner, {
        type: 'state',
        sessionId: session.id,
        phase: 'connecting',
      });
    }
    try {
      const result = await this.app.remote.desktopOffer(
        this.#target(session),
        { sessionId: session.id, from: this.app.identity.info, sdp },
        session.token,
      );
      session.width = result.width || session.width;
      session.height = result.height || session.height;
      return result;
    } catch (error) {
      session.error = 'PEER_UNREACHABLE';
      this.#finish(session, 'failed', 'PEER_UNREACHABLE', false);
      logger.debug(`远程桌面 SDP 交换失败：${String(error)}`);
      throwActionError(ErrorCodes.PEER_UNREACHABLE);
    }
  }

  async ice(owner: string, sessionId: string, candidate: DesktopIceCandidate): Promise<void> {
    const session = this.#requireSession(sessionId, 'controller');
    this.#assertOwner(session, owner);
    if (!session.token || !isActive(session.phase)) throwActionError(ErrorCodes.DESKTOP_STATE);
    try {
      await this.app.remote.desktopIce(
        this.#target(session),
        { sessionId: session.id, from: this.app.identity.info, candidate },
        session.token,
      );
    } catch (error) {
      logger.debug(`发送 ICE candidate 失败：${String(error)}`);
      throwActionError(ErrorCodes.PEER_UNREACHABLE);
    }
  }

  async setBitrate(owner: string, sessionId: string, bitrate: number): Promise<void> {
    const session = this.#requireSession(sessionId, 'controlled');
    this.#assertOwner(session, owner);
    if (!session.nativeStarted) throwActionError(ErrorCodes.DESKTOP_STATE);
    const native = this.#requireNative();
    try {
      native.desktopBitrate(session.id, bitrate);
    } catch (error) {
      throwActionError(this.#nativeError(error));
    }
  }

  async stopSession(owner: string | undefined, sessionId: string, reason?: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    if (owner && session.owner !== owner) throwActionError(ErrorCodes.DESKTOP_NOT_FOUND);
    await this.#notifyStop(session, reason);
    this.#finish(session, 'stopped', reason, true);
  }

  state(owner: string): { sessions: DesktopSessionView[]; bitrates: Record<string, number> } {
    return {
      bitrates: this.bitrates(),
      sessions: [...this.#sessions.values()]
        .filter(
          (session) =>
            session.owner === owner ||
            (session.role === 'controlled' && owner === this.app.identity.id),
        )
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((session) => this.#view(session)),
    };
  }

  /** Called only after the peer route verified the Room ID and source device header. */
  async handlePeer(
    action: string,
    payload: unknown,
    sourceHost: string,
    sourceId: string,
    token: string | undefined,
  ): Promise<unknown> {
    switch (action) {
      case 'request':
        return this.#peerRequest(payload, sourceHost, sourceId);
      case 'accept':
        return this.#peerAccept(payload, sourceHost, sourceId);
      case 'reject':
        return this.#peerReject(payload, sourceHost, sourceId);
      case 'offer':
        return this.#peerOffer(payload, sourceHost, sourceId, token);
      case 'ice':
        return this.#peerIce(payload, sourceHost, sourceId, token);
      case 'stop':
        return this.#peerStop(payload, sourceHost, sourceId, token);
      case 'state':
        return this.#peerState(payload, sourceHost, sourceId, token);
      case 'error':
        return this.#peerError(payload, sourceHost, sourceId, token);
      default:
        throwActionError(ErrorCodes.DESKTOP_NOT_FOUND);
    }
  }

  #binding(): NativeDesktop | undefined {
    if (this.#native === undefined) this.#native = loadDesktopNative() ?? null;
    return this.#native ?? undefined;
  }

  #requireNative(): NativeDesktop {
    const native = this.#binding();
    if (!native) {
      if (process.platform !== 'darwin') throwActionError(ErrorCodes.DESKTOP_UNSUPPORTED);
      throwActionError(ErrorCodes.DESKTOP_NATIVE_MISSING);
    }
    return native;
  }

  #target(session: Session) {
    return { host: session.peerHost, port: session.peerPort };
  }

  #view(session: Session): DesktopSessionView {
    return {
      sessionId: session.id,
      role: session.role,
      peerId: session.peerId,
      peerName: session.peerName,
      phase: session.phase,
      controlRequested: session.controlRequested,
      control: session.control,
      width: session.width,
      height: session.height,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      error: session.error,
    };
  }

  #emit(owner: string, event: DesktopEvent): void {
    if (owner === this.app.identity.id) this.app.events.broadcast(DESKTOP_EVENT, event);
    else this.app.network.browsers.get(owner)?.events.broadcast(DESKTOP_EVENT, event);
  }

  #activeSession(): Session | undefined {
    for (const session of this.#sessions.values()) if (isActive(session.phase)) return session;
    return undefined;
  }

  #requireSession(sessionId: string, role: Role): Session {
    const session = this.#sessions.get(sessionId);
    if (!session || session.role !== role) throwActionError(ErrorCodes.DESKTOP_NOT_FOUND);
    return session;
  }

  #assertOwner(session: Session, owner: string): void {
    if (session.owner !== owner) throwActionError(ErrorCodes.DESKTOP_NOT_FOUND);
  }

  async #disableInput(): Promise<void> {
    try {
      if (this.app.input.status().enabled) await this.app.input.disable();
    } catch (error) {
      logger.debug(`关闭键鼠共享失败：${String(error)}`);
    }
  }

  async #notifyStop(session: Session, reason?: string): Promise<void> {
    if (session.phase === 'pending') {
      // A request may be cancelled before acceptance; the peer has not received a token yet.
      await this.app.remote
        .desktopStop(
          this.#target(session),
          { sessionId: session.id, from: this.app.identity.info, reason },
          session.token ?? '',
        )
        .catch(() => undefined);
      return;
    }
    if (!session.token) return;
    await this.app.remote
      .desktopStop(
        this.#target(session),
        { sessionId: session.id, from: this.app.identity.info, reason },
        session.token,
      )
      .catch((error) => logger.debug(`通知远端停止远程桌面失败：${String(error)}`));
  }

  #finish(
    session: Session,
    phase: DesktopPhase,
    reason: string | undefined,
    notify: boolean,
  ): void {
    if (!this.#sessions.has(session.id)) return;
    this.#sessions.delete(session.id);
    session.phase = phase;
    if (session.role === 'controlled' && session.nativeStarted) {
      try {
        this.#binding()?.desktopStop(session.id);
      } catch (error) {
        logger.debug(`停止原生桌面会话失败：${String(error)}`);
      }
      session.nativeStarted = false;
    }
    this.#stopPollIfIdle();
    if (notify) {
      this.#emit(session.owner, { type: 'ended', sessionId: session.id, reason });
    }
    if (phase === 'failed') session.error = reason;
  }

  #stopPollIfIdle(): void {
    const hasControlled = [...this.#sessions.values()].some(
      (session) => session.role === 'controlled' && session.nativeStarted,
    );
    if (!hasControlled && this.#poll) {
      clearInterval(this.#poll);
      this.#poll = undefined;
    }
  }

  #startPolling(): void {
    if (this.#poll) return;
    this.#poll = setInterval(() => void this.#pollNative(), 40);
    this.#poll.unref();
  }

  async #pollNative(): Promise<void> {
    if (this.#polling || this.#stopped) return;
    const session = [...this.#sessions.values()].find(
      (value) => value.role === 'controlled' && value.nativeStarted,
    );
    if (!session) {
      this.#stopPollIfIdle();
      return;
    }
    const native = this.#binding();
    if (!native) return;
    this.#polling = true;
    try {
      const events = JSON.parse(native.desktopPoll()) as Array<Record<string, unknown>>;
      for (const event of events) {
        const kind = event.kind;
        if (kind === 'ice') {
          const candidate = event.candidate;
          if (!candidate) continue;
          await this.#forwardIce(session, candidate);
        } else if (kind === 'state') {
          const state = typeof event.state === 'string' ? event.state : '';
          if (state === 'connected') {
            session.phase = 'connected';
            session.expiresAt = Date.now() + 24 * 60 * 60_000;
            this.#emit(session.owner, {
              type: 'state',
              sessionId: session.id,
              phase: 'connected',
            });
            void this.#sendPeerState(session, 'connected');
          } else if (state === 'disconnected') {
            session.phase = 'disconnected';
            this.#emit(session.owner, {
              type: 'state',
              sessionId: session.id,
              phase: 'disconnected',
            });
            void this.#sendPeerState(session, 'disconnected');
          } else if (state === 'failed' || state === 'closed') {
            this.#emit(session.owner, {
              type: 'state',
              sessionId: session.id,
              phase: 'failed',
              error: 'DESKTOP_CONNECTION_LOST',
            });
            await this.#sendPeerError(session, 'DESKTOP_CONNECTION_LOST');
            await this.#sendPeerState(session, 'failed', 'DESKTOP_CONNECTION_LOST');
            await this.#notifyStop(session, 'DESKTOP_CONNECTION_LOST');
            this.#finish(session, 'failed', 'DESKTOP_CONNECTION_LOST', true);
          }
        } else if (kind === 'error') {
          const message =
            typeof event.message === 'string' ? event.message : 'DESKTOP_CAPTURE_FAILED';
          this.#emit(session.owner, {
            type: 'state',
            sessionId: session.id,
            phase: 'failed',
            error: message,
          });
          await this.#sendPeerError(session, message);
          await this.#sendPeerState(session, 'failed', message);
          await this.#notifyStop(session, message);
          this.#finish(session, 'failed', message, true);
        } else if (kind === 'input-error') {
          this.#emit(session.owner, {
            type: 'state',
            sessionId: session.id,
            phase: session.phase,
            error: typeof event.message === 'string' ? event.message : 'DESKTOP_INPUT_PERMISSION',
          });
        }
      }
    } catch (error) {
      logger.debug(`轮询原生桌面事件失败：${String(error)}`);
      this.#emit(session.owner, {
        type: 'state',
        sessionId: session.id,
        phase: 'failed',
        error: 'DESKTOP_CAPTURE_FAILED',
      });
      await this.#notifyStop(session, 'DESKTOP_CAPTURE_FAILED');
      this.#finish(session, 'failed', 'DESKTOP_CAPTURE_FAILED', true);
    } finally {
      this.#polling = false;
    }
  }

  #expire(): void {
    const now = Date.now();
    for (const session of Array.from(this.#sessions.values())) {
      if (session.phase === 'pending' && now > session.expiresAt) {
        if (session.role === 'controlled') {
          void this.app.remote
            .desktopReject(this.#target(session), {
              sessionId: session.id,
              from: this.app.identity.info,
              reason: 'REQUEST_TIMEOUT',
            })
            .catch(() => undefined);
          this.#finish(session, 'rejected', 'REQUEST_TIMEOUT', true);
        } else {
          void this.app.remote
            .desktopStop(
              this.#target(session),
              { sessionId: session.id, from: this.app.identity.info, reason: 'REQUEST_TIMEOUT' },
              session.token ?? '',
            )
            .catch(() => undefined);
          this.#finish(session, 'failed', 'REQUEST_TIMEOUT', true);
        }
      } else if (session.phase === 'accepted' && now > session.expiresAt) {
        void this.#notifyStop(session, 'ACCEPT_TIMEOUT');
        this.#finish(session, 'failed', 'ACCEPT_TIMEOUT', true);
      }
    }
  }

  async #peerRequest(payload: unknown, sourceHost: string, sourceId: string): Promise<unknown> {
    const value = desktopPeerRequestSchema.parse(payload);
    await this.#verifyPeer(value.from, sourceHost, sourceId, true);
    if (this.#activeSession()) throwActionError(ErrorCodes.DESKTOP_BUSY);
    const status = this.status();
    const now = Date.now();
    const session: Session = {
      id: value.sessionId,
      role: 'controlled',
      owner: this.app.identity.id,
      peerId: value.from.id,
      peerName: value.viewer ? `${value.from.name}（${value.viewer}）` : value.from.name,
      peerHost: sourceHost,
      peerPort: value.from.port,
      token: randomToken(),
      controlRequested: true,
      control: true,
      phase: 'accepted',
      width: status.display?.width ?? 0,
      height: status.display?.height ?? 0,
      bitrate: value.bitrate ?? DESKTOP_DEFAULT_BITRATE,
      createdAt: now,
      expiresAt: now + DESKTOP_ACCEPT_TTL_MS,
      nativeStarted: false,
    };
    this.#sessions.set(session.id, session);
    await this.#disableInput();
    this.#emit(session.owner, { type: 'accepted', session: this.#view(session) });
    return {
      accepted: true,
      from: this.app.identity.info,
      token: session.token,
      control: true,
      width: session.width,
      height: session.height,
      screenRecording: status.screenRecording,
    };
  }

  async #peerAccept(payload: unknown, sourceHost: string, sourceId: string): Promise<unknown> {
    const value = desktopPeerAcceptSchema.parse(payload);
    const session = this.#requireSession(value.sessionId, 'controller');
    await this.#verifySessionPeer(session, value.from, sourceHost, sourceId);
    if (session.phase !== 'pending') throwActionError(ErrorCodes.DESKTOP_STATE);
    session.token = value.token;
    session.control = value.control;
    session.width = value.width;
    session.height = value.height;
    session.phase = 'accepted';
    session.expiresAt = Date.now() + DESKTOP_ACCEPT_TTL_MS;
    session.error = undefined;
    await this.#disableInput();
    this.#emit(session.owner, { type: 'accepted', session: this.#view(session) });
    return { ok: true };
  }

  async #peerReject(payload: unknown, sourceHost: string, sourceId: string): Promise<unknown> {
    const value = desktopPeerRejectSchema.parse(payload);
    const session = this.#requireSession(value.sessionId, 'controller');
    await this.#verifySessionPeer(session, value.from, sourceHost, sourceId);
    if (!isActive(session.phase)) throwActionError(ErrorCodes.DESKTOP_STATE);
    this.#finish(session, 'rejected', value.reason ?? 'REJECTED', true);
    return { ok: true };
  }

  async #peerOffer(
    payload: unknown,
    sourceHost: string,
    sourceId: string,
    token: string | undefined,
  ): Promise<unknown> {
    const value = desktopPeerOfferSchema.parse(payload);
    const session = this.#requireSession(value.sessionId, 'controlled');
    await this.#verifySessionPeer(session, value.from, sourceHost, sourceId);
    this.#verifyToken(session, token);
    if (
      session.phase !== 'accepted' &&
      session.phase !== 'connecting' &&
      session.phase !== 'connected'
    )
      throwActionError(ErrorCodes.DESKTOP_STATE);
    const native = this.#requireNative();
    let started: { width?: number; height?: number } = {};
    try {
      if (!session.nativeStarted) {
        started = JSON.parse(
          native.desktopStart(
            session.id,
            JSON.stringify({
              maxWidth: DESKTOP_MAX_WIDTH,
              maxHeight: DESKTOP_MAX_HEIGHT,
              fps: DESKTOP_FPS,
              bitrate: session.bitrate,
              // Bind the wildcard so ICE can advertise every LAN interface, not just the
              // discovery-selected primary IPv4 address.
              localAddress: '0.0.0.0',
              control: true,
            }),
          ),
        ) as { width?: number; height?: number };
        session.nativeStarted = true;
      }
      const answer = JSON.parse(
        native.desktopOffer(session.id, JSON.stringify({ type: 'offer', sdp: value.sdp })),
      ) as { sdp?: unknown };
      if (typeof answer.sdp !== 'string') throw new Error('DESKTOP_SDP_INVALID');
      session.width = started.width ?? session.width;
      session.height = started.height ?? session.height;
      if (session.phase !== 'connected') {
        session.phase = 'connecting';
        this.#emit(session.owner, {
          type: 'state',
          sessionId: session.id,
          phase: 'connecting',
        });
      }
      session.expiresAt = Date.now() + DESKTOP_ACCEPT_TTL_MS;
      this.#startPolling();
      return { sdp: answer.sdp, width: session.width, height: session.height };
    } catch (error) {
      const code = this.#nativeError(error);
      await this.#sendPeerError(session, code);
      this.#finish(session, 'failed', code, false);
      throwActionError(code);
    }
  }

  async #forwardIce(session: Session, candidate: unknown): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.app.remote.desktopIce(
          this.#target(session),
          { sessionId: session.id, from: this.app.identity.info, candidate },
          session.token!,
        );
        return;
      } catch (error) {
        if (attempt === 2) {
          logger.debug(`转发 ICE 失败：${String(error)}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }
  }

  async #peerIce(
    payload: unknown,
    sourceHost: string,
    sourceId: string,
    token: string | undefined,
  ): Promise<unknown> {
    const value = desktopPeerIceSchema.parse(payload);
    const session = this.#sessions.get(value.sessionId);
    if (!session) throwActionError(ErrorCodes.DESKTOP_NOT_FOUND);
    await this.#verifySessionPeer(session, value.from, sourceHost, sourceId);
    this.#verifyToken(session, token);
    if (session.role === 'controlled') {
      const native = this.#requireNative();
      try {
        native.desktopIce(session.id, JSON.stringify(value.candidate));
      } catch (error) {
        throwActionError(this.#nativeError(error));
      }
    } else {
      this.#emit(session.owner, {
        type: 'ice',
        sessionId: session.id,
        candidate: value.candidate,
      });
    }
    return { ok: true };
  }

  async #peerState(
    payload: unknown,
    sourceHost: string,
    sourceId: string,
    token: string | undefined,
  ): Promise<unknown> {
    const value = desktopPeerStateSchema.parse(payload);
    const session = this.#requireSession(value.sessionId, 'controller');
    await this.#verifySessionPeer(session, value.from, sourceHost, sourceId);
    this.#verifyToken(session, token);
    if (value.phase === 'failed') {
      session.phase = 'failed';
      session.error = value.error;
    } else {
      session.phase = value.phase;
      if (value.phase === 'connected') session.expiresAt = Date.now() + 24 * 60 * 60_000;
    }
    this.#emit(session.owner, {
      type: 'state',
      sessionId: session.id,
      phase: value.phase,
      error: value.error,
    });
    return { ok: true };
  }

  async #peerError(
    payload: unknown,
    sourceHost: string,
    sourceId: string,
    token: string | undefined,
  ): Promise<unknown> {
    const value = desktopPeerErrorSchema.parse(payload);
    const session = this.#requireSession(value.sessionId, 'controller');
    await this.#verifySessionPeer(session, value.from, sourceHost, sourceId);
    this.#verifyToken(session, token);
    session.phase = 'failed';
    session.error = value.error;
    this.#emit(session.owner, {
      type: 'state',
      sessionId: session.id,
      phase: 'failed',
      error: value.error,
    });
    return { ok: true };
  }

  async #sendPeerError(session: Session, error: string): Promise<void> {
    if (session.role !== 'controlled' || !session.token) return;
    await this.app.remote
      .desktopError(
        this.#target(session),
        { sessionId: session.id, from: this.app.identity.info, error },
        session.token,
      )
      .catch((failure) => logger.debug(`发送远程桌面错误失败：${String(failure)}`));
  }

  async #sendPeerState(
    session: Session,
    phase: 'connected' | 'disconnected' | 'failed',
    error?: string,
  ): Promise<void> {
    if (session.role !== 'controlled' || !session.token) return;
    await this.app.remote
      .desktopState(
        this.#target(session),
        { sessionId: session.id, from: this.app.identity.info, phase, error },
        session.token,
      )
      .catch((failure) => logger.debug(`同步远程桌面状态失败：${String(failure)}`));
  }

  async #peerStop(
    payload: unknown,
    sourceHost: string,
    sourceId: string,
    token: string | undefined,
  ): Promise<unknown> {
    const value = desktopPeerStopSchema.parse(payload);
    const session = this.#sessions.get(value.sessionId);
    if (!session) return { ok: true };
    await this.#verifySessionPeer(session, value.from, sourceHost, sourceId);
    if (session.phase !== 'pending') this.#verifyToken(session, token);
    this.#finish(session, 'stopped', value.reason ?? 'STOPPED', true);
    return { ok: true };
  }

  async #verifyPeer(
    from: { id: string; roomId: string },
    sourceHost: string,
    sourceId: string,
    requireKnown: boolean,
  ): Promise<void> {
    if (from.roomId !== this.app.identity.roomId || from.id !== sourceId)
      throwActionError(ErrorCodes.DESKTOP_UNAUTHORIZED);
    if (from.id === this.app.identity.id) throwActionError(ErrorCodes.DESKTOP_PEER_MISMATCH);
    if (!requireKnown) return;
    const peer = this.app.peers.get(from.id);
    if (!peer || !(await this.#sameHost(peer.host, sourceHost)))
      throwActionError(ErrorCodes.DESKTOP_UNAUTHORIZED);
  }

  async #verifySessionPeer(
    session: Session,
    from: { id: string; roomId: string },
    sourceHost: string,
    sourceId: string,
  ): Promise<void> {
    if (
      from.id !== session.peerId ||
      from.id !== sourceId ||
      from.roomId !== this.app.identity.roomId ||
      !(await this.#sameHost(session.peerHost, sourceHost))
    )
      throwActionError(ErrorCodes.DESKTOP_PEER_MISMATCH);
  }

  #verifyToken(session: Session, token: string | undefined): void {
    if (!session.token || !token || !safeTokenEquals(token, session.token))
      throwActionError(ErrorCodes.DESKTOP_TOKEN_INVALID);
  }

  async #sameHost(expected: string, actual: string): Promise<boolean> {
    if (expected === actual) return true;
    if (expected.includes(':') || actual.includes(':')) {
      // Avoid DNS resolution of bare IPv6 strings; the source and stored host must match.
      return expected === actual;
    }
    const addresses = await lookup(expected, { all: true }).catch(() => []);
    return addresses.some((address) => address.address === actual);
  }

  #nativeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/DESKTOP_[A-Z_]+/);
    const code = match?.[0]?.replace(/_$/, '');
    return code || ErrorCodes.DESKTOP_CAPTURE_FAILED;
  }
}

import type {
  DesktopKeyboardEvent,
  DesktopKeyboardInput,
  DesktopKeyboardResult,
} from '@lanfly/common';

import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

import type { Application } from '../src/app';
import type { NativeDesktop } from '../src/input/native';

import { NativeDesktopKeyboard } from '../../webui/src/service/desktop-keyboard';
import { DesktopKeyboardCapture } from '../src/desktop/keyboard';
import { DesktopService } from '../src/desktop/service';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture() {
  let starts = 0;
  let stops = 0;
  let active = true;
  const events: DesktopKeyboardEvent[] = [];
  const capture = new DesktopKeyboardCapture(
    () =>
      ({
        desktopKeyboardStart() {
          starts++;
          active = true;
        },
        desktopKeyboardPoll() {
          return JSON.stringify({ active, events: events.splice(0) });
        },
        desktopKeyboardStop() {
          stops++;
          active = false;
        },
      }) as NativeDesktop,
  );
  const clientId = randomUUID();
  const input = (revision: number, enabled = true): DesktopKeyboardInput => ({
    sessionId: 'session',
    clientId,
    revision,
    active: enabled,
  });
  return {
    capture,
    input,
    events,
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    expire() {
      active = false;
    },
  };
}

describe('focused native desktop keyboard', () => {
  it('does not rearm on a late poll or let a late release stop a new focus', () => {
    const f = fixture();
    expect(f.capture.poll(f.input(1)).active).toBe(true);
    f.capture.poll(f.input(2, false));
    expect(f.capture.poll(f.input(1)).active).toBe(false);
    expect(f.starts).toBe(1);
    expect(f.capture.poll(f.input(3)).active).toBe(true);
    f.capture.poll(f.input(2, false));
    expect(f.stops).toBe(1);
    expect(f.capture.poll(f.input(3)).active).toBe(true);
    f.capture.stop();
  });

  it('fences the previous page when another page obtains focus', () => {
    const f = fixture();
    f.capture.poll(f.input(1));
    const other = { ...f.input(1), clientId: randomUUID() };
    expect(f.capture.poll(other).active).toBe(true);
    expect(f.capture.poll(f.input(1)).active).toBe(false);
    expect(f.starts).toBe(2);
    expect(f.stops).toBe(1);
    f.capture.stop();
  });

  it('keeps Caps and following letters ordered and fails closed after lease expiry', () => {
    const f = fixture();
    f.capture.poll(f.input(1));
    f.events.push({ t: 'source' }, { t: 'key', key: 0, down: true, flags: 0 });
    expect(f.capture.poll(f.input(1)).events.map((e) => e.t)).toEqual(['source', 'key']);
    f.expire();
    expect(f.capture.poll(f.input(1)).active).toBe(false);
    expect(f.capture.poll(f.input(1)).active).toBe(false);
    expect(f.starts).toBe(1);
  });

  it('does not enable a native capture for a session owned by a browser device', async () => {
    const app = {
      identity: { id: 'host', info: { id: 'host' } },
      network: {
        peers: () => [{ id: 'peer', name: 'Peer', host: '127.0.0.1', port: 8087, online: true }],
        browsers: new Map(),
      },
      state: { get: () => undefined, set: async () => undefined },
      input: { status: () => ({ enabled: false }) },
      events: { broadcast: () => undefined },
      remote: {
        desktopRequest: async () => ({
          from: { id: 'peer' },
          token: 'a'.repeat(40),
          width: 100,
          height: 100,
          screenRecording: true,
        }),
      },
    } as unknown as Application;
    const service = new DesktopService(app);
    const session = await service.request('browser-device', { peerId: 'peer' });
    const input = {
      sessionId: session.sessionId,
      clientId: randomUUID(),
      revision: 1,
      active: true,
    };
    expect(() => service.keyboard('browser-device', input)).toThrow();
    expect(() => service.keyboard('host', input)).toThrow();
    await service.stop();
  });

  it('drops a late native response after the page loses focus', async () => {
    const received: DesktopKeyboardEvent[] = [];
    const calls: Array<Omit<DesktopKeyboardInput, 'sessionId'>> = [];
    let reply!: (value: DesktopKeyboardResult) => void;
    const keyboard = new NativeDesktopKeyboard(
      async (input) => {
        calls.push(input);
        if (!input.active) return { supported: true, active: false, events: [] };
        return await new Promise((resolve) => {
          reply = resolve;
        });
      },
      (events) => received.push(...events),
      () => undefined,
      () => undefined,
    );
    cleanup.push(() => keyboard.blur());
    keyboard.focus();
    expect(keyboard.ownsKeyboard).toBe(true);
    keyboard.blur();
    reply({ supported: true, active: true, events: [{ t: 'source' }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(keyboard.ownsKeyboard).toBe(false);
    expect(received).toEqual([]);
    expect(calls.map((call) => [call.revision, call.active])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('returns keyboard ownership to the page after an RPC failure', async () => {
    const received: DesktopKeyboardEvent[] = [];
    let stopped = false;
    const keyboard = new NativeDesktopKeyboard(
      async () => {
        throw new Error('disconnected');
      },
      (events) => received.push(...events),
      () => {
        stopped = true;
      },
      () => undefined,
    );
    cleanup.push(() => keyboard.blur());
    keyboard.focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(true);
    expect(keyboard.ownsKeyboard).toBe(false);
    expect(received).toEqual([{ t: 'release' }]);
  });
});

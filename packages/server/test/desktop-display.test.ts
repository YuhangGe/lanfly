import {
  desktopPeerRequestSchema,
  desktopRequestInput,
  fitDesktopResolution,
  type DesktopDisplayModes,
} from '@lanfly/common';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Application } from '../src/app';
import type { NativeDesktop } from '../src/input/native';

import { desktopViewportFrame } from '../../webui/src/service/desktop-viewport';
import { DataStore } from '../src/data';
import { DesktopService } from '../src/desktop/service';

const modes: DesktopDisplayModes = {
  supported: true,
  current: { width: 2560, height: 1600 },
  modes: [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1600 },
  ],
};
describe('remote display size and viewport', () => {
  it('fits the usable logical viewport while preserving the remote aspect ratio', () => {
    expect(fitDesktopResolution(modes, 1500, 950)).toEqual({ width: 1440, height: 900 });
    expect(fitDesktopResolution(modes, 1920, 1100)).toEqual({ width: 1440, height: 900 });
    expect(fitDesktopResolution(modes, 500, 300)).toEqual({ width: 1280, height: 800 });
    expect(fitDesktopResolution(modes, Number.NaN, 900)).toBeUndefined();
    expect(fitDesktopResolution({ supported: false, modes: [] }, 1200, 800)).toBeUndefined();
  });
  it('matches Retina controller pixels without doubling a Retina remote logical desktop', () => {
    const standard: DesktopDisplayModes = {
      supported: true,
      current: { width: 2560, height: 1440 },
      modes: [
        { width: 1280, height: 720, pixelWidth: 1280, pixelHeight: 720 },
        { width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080 },
        { width: 2560, height: 1440, pixelWidth: 2560, pixelHeight: 1440 },
      ],
    };
    expect(fitDesktopResolution(standard, 2940, 1912)).toEqual({ width: 2560, height: 1440 });
    const retina: DesktopDisplayModes = {
      ...standard,
      modes: standard.modes.map((mode) => ({
        ...mode,
        pixelWidth: mode.width * 2,
        pixelHeight: mode.height * 2,
      })),
    };
    expect(fitDesktopResolution(retina, 2940, 1912)).toEqual({ width: 1280, height: 720 });
  });

  it('persists the choice by controller/controlled names and reloads it across process identities', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lanfly-display-prefs-'));
    const services: DesktopService[] = [];
    const serviceFor = (data: DataStore, controller: string, controlled: string) => {
      const owner = crypto.randomUUID(),
        peerId = crypto.randomUUID();
      const app = {
        identity: { id: owner, name: controller, info: { id: owner, name: controller } },
        state: data,
        network: {
          peers: () => [
            { id: peerId, name: controlled, host: '127.0.0.1', port: 8087, online: true },
          ],
          browsers: new Map(),
        },
        input: { status: () => ({ enabled: false }) },
        events: { broadcast: () => undefined },
        remote: {
          desktopRequest: async () => ({
            from: { id: peerId },
            token: 'a'.repeat(40),
            width: 1920,
            height: 1080,
            screenRecording: true,
          }),
        },
      } as unknown as Application;
      const service = new DesktopService(app, () => undefined);
      services.push(service);
      return { service, owner, peerId };
    };
    try {
      const data = new DataStore(dir);
      await data.load();
      await data.set('unrelated', { preserved: true });
      const ab = serviceFor(data, '主控 A', '受控 B');
      await ab.service.request(ab.owner, {
        peerId: ab.peerId,
        resolutionChoice: 'fit',
        resolution: { width: 2560, height: 1440 },
      });
      const ba = serviceFor(data, '受控 B', '主控 A');
      await ba.service.request(ba.owner, {
        peerId: ba.peerId,
        resolutionChoice: { width: 1280, height: 800 },
        resolution: { width: 1280, height: 800 },
      });
      const saved = JSON.parse(await readFile(data.file, 'utf8'));
      expect(saved.unrelated).toEqual({ preserved: true });
      expect(saved.desktopResolutions).toEqual([
        { controller: '主控 A', controlled: '受控 B', choice: 'fit' },
        { controller: '受控 B', controlled: '主控 A', choice: { width: 1280, height: 800 } },
      ]);
      const loaded = new DataStore(dir);
      await loaded.load();
      const fresh = serviceFor(loaded, '主控 A', '受控 B');
      expect(fresh.service.state(fresh.owner).resolutions).toEqual({ '受控 B': 'fit' });
      const reverse = serviceFor(loaded, '受控 B', '主控 A');
      expect(reverse.service.state(reverse.owner).resolutions).toEqual({
        '主控 A': { width: 1280, height: 800 },
      });
      const ac = serviceFor(loaded, '主控 A', '受控 C');
      expect(ac.service.state(ac.owner).resolutions['受控 C']).toBeUndefined();
    } finally {
      for (const service of services) await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps the visible center correctly after zooming and panning to an edge', () => {
    const fit = desktopViewportFrame(1000, 600, 2000, 1200, 'fit');
    expect(fit).toMatchObject({ width: 1000, height: 600, left: 0, top: 0 });
    const zoom = desktopViewportFrame(1000, 600, 2000, 1200, '2', 9999, -9999);
    expect(zoom).toMatchObject({ width: 2000, height: 1200, left: 0, top: -600 });
    expect((500 - zoom.left) / zoom.width).toBe(0.25);
    expect((300 - zoom.top) / zoom.height).toBe(0.75);
    const retina = desktopViewportFrame(1000, 600, 2000, 1200, 'actual', 0, 0, 2);
    expect(retina).toMatchObject({ width: 1000, height: 600 });
  });
  it('rejects invalid requested sizes on both browser and peer schemas', () => {
    expect(
      desktopRequestInput.safeParse({ peerId: 'p', resolution: { width: 0, height: 900 } }).success,
    ).toBe(false);
    expect(
      desktopRequestInput.safeParse({ peerId: 'p', resolution: { width: 1280, height: 800 } })
        .success,
    ).toBe(true);
  });
  it('forwards supported choices only when starting capture and restores on stop/failure', async () => {
    const from = { id: 'peer', name: 'Peer', port: 8087, roomId: '123456', version: '0.3.0' };
    const calls: string[] = [];
    let config: { resolution?: { width: number; height: number } } | undefined;
    const native = {
      desktopStatus: () =>
        JSON.stringify({
          supported: true,
          available: true,
          screenRecording: true,
          accessibility: true,
          screens: 1,
          display: { width: 2560, height: 1600 },
        }),
      desktopDisplayModes: () => JSON.stringify(modes),
      desktopStart: (_id: string, value: string) => {
        calls.push('start');
        config = JSON.parse(value);
        return JSON.stringify({ width: 2560, height: 1600 });
      },
      desktopOffer: () => JSON.stringify({ sdp: 'answer' }),
      desktopPoll: () => '[]',
      desktopStop: () => {
        calls.push('restore');
      },
      desktopStopAll: () => undefined,
    } as unknown as NativeDesktop;
    const app = {
      identity: { id: 'host', roomId: '123456', info: { id: 'host' } },
      peers: new Map([['peer', { host: '127.0.0.1' }]]),
      input: { status: () => ({ enabled: false }) },
      events: { broadcast: () => undefined },
      remote: { desktopError: async () => undefined },
    } as unknown as Application;
    const service = new DesktopService(app, () => native);
    const request = (id: string, resolution?: { width: number; height: number }) => ({
      sessionId: id,
      from,
      resolution,
    });
    expect(
      desktopPeerRequestSchema.safeParse(request('invalid', { width: 10000, height: 900 })).success,
    ).toBe(false);
    await expect(
      service.handlePeer(
        'request',
        request('unsupported', { width: 1600, height: 900 }),
        '127.0.0.1',
        'peer',
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'DESKTOP_RESOLUTION_UNSUPPORTED' });
    expect(calls).toEqual([]);
    const accepted = (await service.handlePeer(
      'request',
      request('s1', { width: 1280, height: 800 }),
      '127.0.0.1',
      'peer',
      undefined,
    )) as { token: string };
    expect(calls).toEqual([]);
    await service.handlePeer(
      'offer',
      { sessionId: 's1', from, sdp: 'offer' },
      '127.0.0.1',
      'peer',
      accepted.token,
    );
    expect(config?.resolution).toEqual({ width: 1280, height: 800 });
    await service.handlePeer(
      'stop',
      { sessionId: 's1', from },
      '127.0.0.1',
      'peer',
      accepted.token,
    );
    expect(calls).toEqual(['start', 'restore']);
    const second = (await service.handlePeer(
      'request',
      request('s2'),
      '127.0.0.1',
      'peer',
      undefined,
    )) as { token: string };
    native.desktopOffer = () => {
      throw Error('DESKTOP_SDP_INVALID');
    };
    await expect(
      service.handlePeer(
        'offer',
        { sessionId: 's2', from, sdp: 'broken' },
        '127.0.0.1',
        'peer',
        second.token,
      ),
    ).rejects.toMatchObject({ code: 'DESKTOP_SDP_INVALID' });
    expect(config?.resolution).toBeUndefined();
    expect(calls).toEqual(['start', 'restore', 'start', 'restore']);
    await service.stop();
  });
});

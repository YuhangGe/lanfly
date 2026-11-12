export type DesktopZoom = 'fit' | 'actual' | '1.25' | '1.5' | '2' | '3';

/** Video bounds are also the coordinate transform used by DesktopControl. */
export function desktopViewportFrame(
  stageWidth: number,
  stageHeight: number,
  videoWidth: number,
  videoHeight: number,
  zoom: DesktopZoom,
  panX = 0,
  panY = 0,
  density = 1,
) {
  const fit = Math.min(stageWidth / videoWidth, stageHeight / videoHeight);
  const scale =
    zoom === 'actual' ? 1 / Math.max(1, density) : fit * (zoom === 'fit' ? 1 : Number(zoom));
  const width = videoWidth * scale,
    height = videoHeight * scale;
  const limitX = Math.max(0, (width - stageWidth) / 2),
    limitY = Math.max(0, (height - stageHeight) / 2);
  const x = Math.max(-limitX, Math.min(limitX, panX)),
    y = Math.max(-limitY, Math.min(limitY, panY));
  return {
    width,
    height,
    left: (stageWidth - width) / 2 + x,
    top: (stageHeight - height) / 2 + y,
    panX: x,
    panY: y,
  };
}

export class DesktopViewport {
  #zoom: DesktopZoom = 'fit';
  #pan = false;
  #x = 0;
  #y = 0;
  #drag?: { id: number; x: number; y: number };
  #observer: ResizeObserver;
  #cleanup: Array<() => void> = [];

  constructor(
    private readonly stage: HTMLElement,
    private readonly video: HTMLVideoElement,
  ) {
    this.#observer = new ResizeObserver(() => this.refresh());
    this.#observer.observe(stage);
    const listen = (type: string, handler: (event: PointerEvent) => void) => {
      const listener = handler as EventListener;
      stage.addEventListener(type, listener, true);
      this.#cleanup.push(() => stage.removeEventListener(type, listener, true));
    };
    listen('pointerdown', (event) => {
      if ((!this.#pan && event.button !== 1) || (event.button !== 0 && event.button !== 1)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stage.blur();
      this.#drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      try {
        stage.setPointerCapture(event.pointerId);
      } catch {
        /* optional */
      }
    });
    listen('pointermove', (event) => {
      if (!this.#drag || this.#drag.id !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#x += event.clientX - this.#drag.x;
      this.#y += event.clientY - this.#drag.y;
      this.#drag.x = event.clientX;
      this.#drag.y = event.clientY;
      this.refresh();
    });
    const end = (event: PointerEvent) => {
      if (!this.#drag || this.#drag.id !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#drag = undefined;
      try {
        stage.releasePointerCapture(event.pointerId);
      } catch {
        /* optional */
      }
    };
    listen('pointerup', end);
    listen('pointercancel', end);
    listen('lostpointercapture', end);
    this.refresh();
  }

  setView(zoom: DesktopZoom, pan: boolean): void {
    if (this.#zoom !== zoom) {
      this.#x = 0;
      this.#y = 0;
    }
    this.#zoom = zoom;
    this.#pan = pan;
    this.#drag = undefined;
    this.stage.style.cursor = pan ? 'grab' : '';
    this.refresh();
  }

  refresh(): void {
    if (
      !this.video.videoWidth ||
      !this.video.videoHeight ||
      !this.stage.clientWidth ||
      !this.stage.clientHeight
    )
      return;
    const frame = desktopViewportFrame(
      this.stage.clientWidth,
      this.stage.clientHeight,
      this.video.videoWidth,
      this.video.videoHeight,
      this.#zoom,
      this.#x,
      this.#y,
      window.devicePixelRatio,
    );
    this.#x = frame.panX;
    this.#y = frame.panY;
    Object.assign(this.video.style, {
      width: `${frame.width}px`,
      height: `${frame.height}px`,
      left: `${frame.left}px`,
      top: `${frame.top}px`,
    });
  }

  destroy(): void {
    this.#observer.disconnect();
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    this.#drag = undefined;
    this.stage.style.cursor = '';
  }
}

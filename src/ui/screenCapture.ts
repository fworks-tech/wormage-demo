import type { GameScreenshot } from '../api/types';

export type { GameScreenshot };
export type CaptureErrorCode = 'unsupported' | 'denied' | 'wrong-surface' | 'failed';

export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CaptureError';
  }
}

// The server accepts a 4 MB JSON body. A 2.4 MB PNG becomes about 3.2 MB in
// base64, leaving room for the report and halving the unauthenticated upload cost.
const MAX_RAW_BYTES = 2_400_000;
const FRAME_TIMEOUT_MS = 4_000;

/**
 * Records one frame of the current tab. The pause overlay must be hidden by
 * the caller before the stream starts; the browser picker is chrome UI and
 * never reaches the video track.
 */
export async function captureGameTab(): Promise<GameScreenshot> {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!media || typeof media.getDisplayMedia !== 'function') {
    throw new CaptureError('unsupported', 'This browser cannot capture a tab');
  }

  let stream: MediaStream;
  try {
    stream = await media.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      throw new CaptureError('denied', 'Screen capture was cancelled');
    }
    throw new CaptureError('failed', 'Screen capture failed');
  }

  const video = document.createElement('video');
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new CaptureError('failed', 'No video track');
    const surface = track.getSettings().displaySurface;
    if (surface !== 'browser') {
      throw new CaptureError('wrong-surface', 'Share this tab, not a window or the screen.');
    }

    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
    video.srcObject = stream;
    await withTimeout(video.play(), 'The capture did not start');
    if (!video.videoWidth) {
      await withTimeout(
        new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true })),
        'The capture sent no video',
      );
    }
    // Two painted frames: one for the paused scene, one so the hidden pause
    // card is definitely absent from the compositor output.
    await waitForFrame(video);
    await waitForFrame(video);

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context || canvas.width === 0 || canvas.height === 0) throw new CaptureError('failed', 'Empty frame');
    context.drawImage(video, 0, 0);
    return await encode(canvas);
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    video.remove();
  }
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new CaptureError('failed', 'Timed out waiting for a frame')), FRAME_TIMEOUT_MS);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => done());
    else window.setTimeout(done, 80);
  });
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new CaptureError('failed', message)), FRAME_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function encode(source: HTMLCanvasElement): Promise<GameScreenshot> {
  let scale = 1;
  for (;;) {
    const canvas = scaleCanvas(source, scale);
    const png = await toBlob(canvas, 'image/png');
    if (png.size <= MAX_RAW_BYTES) return fromBlob(png, 'image/png', canvas);
    if (canvas.width <= 640) {
      const jpeg = await toBlob(canvas, 'image/jpeg', 0.92);
      if (jpeg.size <= MAX_RAW_BYTES) return fromBlob(jpeg, 'image/jpeg', canvas);
      throw new CaptureError('failed', 'Screenshot is too large to upload');
    }
    scale *= 0.8;
  }
}

function scaleCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  if (scale === 1) return source;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new CaptureError('failed', 'Could not resize the screenshot');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new CaptureError('failed', 'Could not encode the screenshot'))),
      type,
      quality,
    );
  });
}

async function fromBlob(blob: Blob, mime: GameScreenshot['mime'], canvas: HTMLCanvasElement): Promise<GameScreenshot> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new CaptureError('failed', 'Could not read the screenshot'));
    reader.readAsDataURL(blob);
  });
  return { dataUrl, mime, width: canvas.width, height: canvas.height, bytes: blob.size };
}

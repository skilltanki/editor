// FILE-COUNT loading progress with a byte ticker.
//
// Began as a copy of packages/game/src/game/AssetProgress.ts (byte-accurate
// against a build-time size manifest); the editor has no manifest — the
// production store is never re-uploaded for editor features — and probing
// sizes over HTTP put HEAD/Range requests in the network log that the bar
// did not account for. So the editor counts FILES instead, by direct order:
// the light map XML downloads first and names every file; the bar then
// advances one unit per finished file. The ONLY network requests are the
// downloads themselves.
//
//  - the TOTAL is the number of files the parsed XML names (plus one slot
//    per mesh whose texture is named inside the .3ds — the slot count is
//    known up front, so the total never grows mid-flight);
//  - the LOADED count ticks as each file's promise settles, cache hits
//    included, errors included (a broken prop must not hang the bar);
//  - the MEGABYTES shown are bytes actually received, information only.

import * as pc from 'playcanvas';
import { assetUrl } from './assetUrl';

export type ProgressListener =
  (receivedBytes: number, loadedUnits: number, totalUnits: number) => void;

export class AssetProgress {
  private receivedBytes = 0;
  private unitsLoaded = 0;
  private unitsTotal = 0;
  /** Bytes already counted per URL, so a re-request cannot double-count. */
  private readonly counted = new Map<string, number>();
  private listener: ProgressListener | null = null;

  onProgress(listener: ProgressListener | null): void {
    this.listener = listener;
  }

  /** Starts a new stage. `units` is the file count when already known. */
  begin(units = 0): void {
    this.receivedBytes = 0;
    this.unitsLoaded = 0;
    this.unitsTotal = units;
    this.counted.clear();
    this.emit();
  }

  /** Widens the stage by `count` files — called ONCE, when the list is known. */
  addUnits(count: number): void {
    if (count > 0) {
      this.unitsTotal += count;
      this.emit();
    }
  }

  /** One file finished (downloaded, cache-served or failed — all count). */
  unitDone(): void {
    if (this.unitsLoaded < this.unitsTotal) {
      this.unitsLoaded++;
      this.emit();
    }
  }

  /**
   * Credits bytes for one URL. `loaded` is cumulative for that URL, not a
   * delta — both PlayCanvas's progress event and the stream reader below
   * report running totals — so the difference against the last value is what
   * gets added.
   */
  report(url: string, loaded: number): void {
    const key = normalise(url);
    const previous = this.counted.get(key) ?? 0;
    if (loaded <= previous) {
      return;
    }
    this.counted.set(key, loaded);
    this.receivedBytes += loaded - previous;
    this.emit();
  }

  private emit(): void {
    this.listener?.(this.receivedBytes, this.unitsLoaded, this.unitsTotal);
  }

  /**
   * Hooks PlayCanvas's asset registry once, so every texture the engine
   * downloads ticks the byte counter — `loadFromUrl` fires 'add' before it
   * starts the download, so a listener here sees them all.
   */
  attachTo(app: pc.AppBase): void {
    app.assets.on('add', (asset: pc.Asset) => {
      const url = asset.getFileUrl();
      if (url == null) {
        return;
      }
      asset.on('progress', (loaded: number) => this.report(url, loaded));
    });
  }

  /** fetch() that reports bytes as they arrive. */
  async trackedFetch(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    if (response.body == null) {
      // No streaming support: credit the whole file once it is here.
      const buffer = await response.arrayBuffer();
      this.report(url, buffer.byteLength);
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      loaded += value.byteLength;
      this.report(url, loaded);
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }
}

/**
 * Absolute URLs reach us from PlayCanvas and the renderer; the byte counter
 * must key them identically, so everything is reduced to the store-root path
 * (the asset base — / in dev, /assets/ in prod — stripped off).
 */
let basePath: string | null = null;

function normalise(url: string): string {
  let path = url;
  if (!path.startsWith('/')) {
    try {
      path = new URL(url, window.location.origin).pathname;
    } catch {
      return url;
    }
  }
  basePath ??= new URL(assetUrl('/')).pathname;
  if (basePath !== '/' && path.startsWith(basePath)) {
    path = `/${path.slice(basePath.length)}`;
  }
  return path;
}

/** The one instance the editor uses. */
export const assetProgress = new AssetProgress();

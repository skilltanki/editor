// Port of the original editor's Preview (the spinning prop pane).
//
// Differences from the original, and why:
//   - The original owned a second Scene3D + Camera3D and drew it into a
//     Sprite. Here a second PlayCanvas camera renders to a RenderTarget shown
//     in an <img>-like canvas, on its own layer so it never sees the map.
//   - getPropIcon()'s synchronous BitmapData.draw per prop is replaced by
//     renderIcon(), which reuses this same camera on demand.
import * as pc from 'playcanvas';
import { Parsed3DSObject } from '../engine/map/Parser3DS';

/** Preview: camera.rotationZ += MathUtils.DEG1 each frame. */
const DEG_PER_FRAME = 1;
const SIZE = 256;

export class Preview {
  private readonly layer: pc.Layer;
  private readonly camera: pc.Entity;
  private readonly pivot: pc.Entity;
  private readonly root: pc.Entity;
  private readonly renderTarget: pc.RenderTarget;
  private readonly colorBuffer: pc.Texture;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly pixels: Uint8Array;
  private current: pc.Entity | null = null;
  private spinning = false;

  constructor(private readonly app: pc.AppBase, host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    Object.assign(this.canvas.style, {
      width: '100%', height: '100%', display: 'block', objectFit: 'contain',
      position: 'absolute', inset: '0',
    });
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.pixels = new Uint8Array(SIZE * SIZE * 4);

    // A dedicated layer keeps the preview camera from seeing the map, and the
    // main camera from seeing the preview prop.
    const composition = app.scene.layers;
    const existing = composition.layerList.find((l) => l.name === 'preview');
    this.layer = (existing as pc.Layer | undefined) ?? new pc.Layer({ name: 'preview' });
    if (existing == null) {
      composition.push(this.layer);
    }

    this.colorBuffer = new pc.Texture(app.graphicsDevice, {
      width: SIZE, height: SIZE, format: pc.PIXELFORMAT_RGBA8,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
      mipmaps: false,
    });
    this.renderTarget = new pc.RenderTarget({ colorBuffer: this.colorBuffer, depth: true });

    this.root = new pc.Entity('previewRoot');
    app.root.addChild(this.root);

    // Same Z-up -> Y-up conversion as the editor viewport.
    this.pivot = new pc.Entity('previewPivot');
    this.pivot.setLocalEulerAngles(-90, 0, 0);
    this.pivot.setLocalScale(0.01, 0.01, 0.01);
    this.root.addChild(this.pivot);

    this.camera = new pc.Entity('previewCamera');
    this.camera.addComponent('camera', {
      clearColor: new pc.Color(1, 1, 1, 1),
      fov: 45,
      nearClip: 0.01,
      farClip: 1000,
      renderTarget: this.renderTarget,
      layers: [this.layer.id],
      priority: -1,
    });
    this.root.addChild(this.camera);

    // No light: prop materials are unlit-emissive (textures are pre-lit), so
    // a directional light would only tint them.

    app.on('update', () => this.update());
  }

  /** Preview.showProp: swap in a clone of the prop's entity and spin it. */
  show(source: pc.Entity | null, object: Parsed3DSObject | null): void {
    if (this.current != null) {
      this.current.destroy();
      this.current = null;
    }
    this.spinning = false;
    if (source == null) {
      this.clear();
      return;
    }
    const clone = source.clone();
    clone.setLocalPosition(0, 0, 0);
    clone.setLocalEulerAngles(0, 0, 0);
    clone.enabled = true;
    // Render it only on the preview layer, and clear any cursor/selection
    // tint: the source is often the green ghost cursor prop, whose emissive
    // is CURSOR_FREE_TINT rather than the texture's own white.
    for (const render of clone.findComponents('render') as pc.RenderComponent[]) {
      render.layers = [this.layer.id];
      render.enabled = true;
      for (const instance of render.meshInstances) {
        const material = instance.material as pc.StandardMaterial;
        if (material.emissiveMap != null) {
          const copy = material.clone();
          copy.emissive = new pc.Color(1, 1, 1);
          copy.update();
          instance.material = copy;
        }
      }
    }
    this.pivot.addChild(clone);
    this.current = clone;
    this.frame(object);
    this.spinning = true;
  }

  /**
   * Preview.analyzeProp: distance that fits the prop in view.
   *   h = sqrt2*d/(2*tan(fov/2)) + d/2,  camera z = maxZ/2 + h/sqrt3
   */
  private frame(object: Parsed3DSObject | null): void {
    let maxSqrDistance = 0;
    let maxZ = 0;
    if (object != null) {
      const p = object.positions;
      let minZ = Infinity;
      let topZ = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        const d = p[i] * p[i] + p[i + 1] * p[i + 1] + p[i + 2] * p[i + 2];
        if (d > maxSqrDistance) maxSqrDistance = d;
        if (p[i + 2] < minZ) minZ = p[i + 2];
        if (p[i + 2] > topZ) topZ = p[i + 2];
      }
      maxZ = Number.isFinite(minZ) ? topZ - minZ : 0;
    }
    const size = 2 * Math.sqrt(maxSqrDistance) || 500;
    const halfFov = ((this.camera.camera as pc.CameraComponent).fov * Math.PI) / 360;
    const h = (Math.SQRT2 * size) / (2 * Math.tan(halfFov)) + size / 2;

    // Sim-space pose: back off along -Y, lift to half the prop height.
    const z = maxZ / 2 + h / Math.sqrt(3);
    this.pivotTarget = { distance: h, z };
    this.applyPose(0);
  }

  private pivotTarget = { distance: 1200, z: 600 };
  private angle = 0;

  private applyPose(angleDeg: number): void {
    const a = (angleDeg * Math.PI) / 180;
    const { distance, z } = this.pivotTarget;
    // Position in sim space, then through the pivot's Z-up conversion.
    const x = Math.sin(a) * distance;
    const y = -Math.cos(a) * distance;
    const world = this.pivot.getWorldTransform().transformPoint(new pc.Vec3(x, y, z));
    this.camera.setPosition(world);
    const centre = this.pivot.getWorldTransform().transformPoint(new pc.Vec3(0, 0, this.pivotTarget.z * 0.35));
    this.camera.lookAt(centre);
  }

  private update(): void {
    if (!this.spinning || this.current == null) {
      return;
    }
    this.angle += DEG_PER_FRAME;
    this.applyPose(this.angle);
    this.blit();
  }

  private reading = false;

  /**
   * Copies the render target into the visible 2D canvas.
   * `frequent: true` tells PlayCanvas this is a per-frame readback, so it
   * trades a frame of latency for not stalling the frame it is issued in.
   */
  private blit(): void {
    if (this.ctx == null || this.reading) {
      return;
    }
    this.reading = true;
    void this.colorBuffer
      .read(0, 0, SIZE, SIZE, { renderTarget: this.renderTarget, data: this.pixels, frequent: true })
      .then((data) => {
        if (this.ctx == null) {
          return;
        }
        const bytes = data as Uint8Array;
        const image = this.ctx.createImageData(SIZE, SIZE);
        // The render target is bottom-up; flip while copying.
        for (let y = 0; y < SIZE; y++) {
          const src = (SIZE - 1 - y) * SIZE * 4;
          image.data.set(bytes.subarray(src, src + SIZE * 4), y * SIZE * 4);
        }
        this.ctx.putImageData(image, 0, 0);
      })
      .catch(() => { /* readback unsupported; the pane stays blank */ })
      .finally(() => { this.reading = false; });
  }

  /**
   * Preview.getPropIcon: render one prop to a small data URL.
   * Reuses this camera and render target, so it costs one frame per icon and
   * no extra GPU resources. The spinning preview is paused for the duration.
   */
  async renderIcon(source: pc.Entity, object: Parsed3DSObject | null, size = 48): Promise<string | null> {
    const wasSpinning = this.spinning;
    const previous = this.current;
    // frame() overwrites the shared pose; the resumed preview needs its own back.
    const savedTarget = { ...this.pivotTarget };
    this.spinning = false;
    this.current = null;

    const clone = source.clone();
    clone.setLocalPosition(0, 0, 0);
    clone.setLocalEulerAngles(0, 0, 0);
    clone.enabled = true;
    for (const render of clone.findComponents('render') as pc.RenderComponent[]) {
      render.layers = [this.layer.id];
      render.enabled = true;
      for (const instance of render.meshInstances) {
        const material = instance.material as pc.StandardMaterial;
        if (material.emissiveMap != null) {
          const copy = material.clone();
          copy.emissive = new pc.Color(1, 1, 1);
          copy.update();
          instance.material = copy;
        }
      }
    }
    if (previous != null) {
      previous.enabled = false;
    }
    this.pivot.addChild(clone);
    this.frame(object);
    // analyzeProp's distance leaves generous margin (it must fit the prop at
    // every spin angle). An icon is a fixed 3/4 view, so pull in to fill it.
    this.pivotTarget = { distance: this.pivotTarget.distance * 0.52, z: this.pivotTarget.z * 0.52 };
    this.applyPose(35);

    // Let the camera render one frame into the target before reading it back.
    await new Promise<void>((resolve) => { this.app.once('frameend', () => resolve()); });
    let url: string | null = null;
    try {
      const data = (await this.colorBuffer.read(0, 0, SIZE, SIZE, {
        renderTarget: this.renderTarget, immediate: true,
      })) as Uint8Array;
      const scratch = document.createElement('canvas');
      scratch.width = SIZE;
      scratch.height = SIZE;
      const ctx = scratch.getContext('2d');
      if (ctx != null) {
        const image = ctx.createImageData(SIZE, SIZE);
        for (let y = 0; y < SIZE; y++) {
          const src = (SIZE - 1 - y) * SIZE * 4;
          image.data.set(data.subarray(src, src + SIZE * 4), y * SIZE * 4);
        }
        ctx.putImageData(image, 0, 0);
        const small = document.createElement('canvas');
        small.width = size;
        small.height = size;
        small.getContext('2d')?.drawImage(scratch, 0, 0, size, size);
        url = small.toDataURL('image/png');
      }
    } catch {
      url = null;
    }

    clone.destroy();
    if (previous != null) {
      previous.enabled = true;
    }
    this.current = previous;
    this.pivotTarget = savedTarget;
    this.spinning = wasSpinning;
    return url;
  }

  clear(): void {
    if (this.current != null) {
      this.current.destroy();
      this.current = null;
    }
    this.spinning = false;
    if (this.ctx != null) {
      this.ctx.fillStyle = '#fff';
      this.ctx.fillRect(0, 0, SIZE, SIZE);
    }
  }
}

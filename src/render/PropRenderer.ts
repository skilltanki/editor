// Builds PlayCanvas entities for editor props and keeps the parsed 3DS around
// so the exporter can derive collision primitives from the child meshes.
//
// The loading path mirrors packages/game/src/map/MapLoader (same caches, same
// unlit-emissive materials, same "cache the promise, not the result" rule);
// the editor additions are: every library is loaded up front for the palette,
// selection tinting, and procedural gizmos for spawn/bonus/flag props, which
// have no mesh in any shipped library.
import * as pc from 'playcanvas';
import { buildMesh } from '../engine/render/buildMesh';
import { Parser3DS, Parsed3DSObject } from '../engine/map/Parser3DS';
import {
  PropLibrary, PropLibRegistry, PropDef, PropMeshDef, libraryNameToFolder,
} from '../engine/map/PropLibrary';
import { assetProgress } from '../core/AssetProgress';
import { V_BASE, H_BASE } from '../core/EditorScene';
import type { Prop, PropKind } from '../prop/Prop';

export interface LibraryEntry {
  name: string;
  folder: string;
  file: string;
}

const SELECTED_TINT = new pc.Color(1, 0.45, 0.45);
const CURSOR_FREE_TINT = new pc.Color(0.35, 1, 0.35);
const CURSOR_BLOCKED_TINT = new pc.Color(1, 0.3, 0.3);
const NO_TINT = new pc.Color(1, 1, 1);

/** Colours for the procedural spawn/bonus/flag gizmos. */
const GIZMO_COLORS: Record<string, pc.Color> = {
  red: new pc.Color(0.85, 0.2, 0.2),
  blue: new pc.Color(0.25, 0.45, 0.95),
  dm: new pc.Color(0.9, 0.8, 0.2),
  red_flag: new pc.Color(0.9, 0.15, 0.15),
  blue_flag: new pc.Color(0.2, 0.4, 1),
  bonus: new pc.Color(0.3, 0.85, 0.5),
};

export class PropRenderer {
  private registry = new PropLibRegistry();
  private libraryFolders = new Map<string, string>();
  private parsed3dsCache = new Map<string, Promise<Parser3DS>>();
  private meshCache = new Map<string, pc.Mesh>();
  private materialCache = new Map<string, pc.Material>();
  private textureCache = new Map<string, Promise<pc.Texture>>();
  /** Collision child meshes per "library|group|name". */
  private collisionCache = new Map<string, Parsed3DSObject[]>();
  /** Per-prop material instance, so tinting one prop does not tint them all. */
  private propMaterials = new WeakMap<Prop, pc.StandardMaterial>();
  private gizmoMeshes = new Map<string, pc.Mesh>();

  constructor(private readonly app: pc.AppBase, private readonly assetsBase = '') {}

  /** Loads every library listed in props.json (the editor needs all of them). */
  async loadLibraries(entries: LibraryEntry[]): Promise<void> {
    await Promise.all(entries.map(async (entry) => {
      try {
        const buffer = await assetProgress.trackedFetch(entry.file);
        const xml = new DOMParser().parseFromString(new TextDecoder().decode(buffer), 'text/xml');
        const library = PropLibrary.parse(xml, entry.folder);
        this.registry.add(library);
        this.libraryFolders.set(library.name, entry.folder);
      } catch (error) {
        console.warn(`library ${entry.name}: ${String(error)}`);
      } finally {
        // One unit per library.xml on the boot stage's bar.
        assetProgress.unitDone();
      }
    }));
  }

  getLibraryNames(): string[] {
    return [...this.libraryFolders.keys()].sort((a, b) => a.localeCompare(b));
  }

  getLibrary(name: string): PropLibrary | null {
    return this.registry.getLibrary(name);
  }

  /**
   * TanksXmlImporter's prop lookup: resolves a <prop> entry against the loaded
   * libraries. Returns the kind and (for meshes) the vertex positions used to
   * measure the occupancy extents.
   */
  resolve(library: string, group: string, name: string): { kind: PropKind; positions?: number[] | null } | null {
    const def = this.registry.getLibrary(library)?.getProp(group, name) ?? null;
    if (def == null) {
      return null;
    }
    if (def.kind === 'sprite') {
      return { kind: 'sprite' };
    }
    const cached = this.collisionCache.get(`${library}|${group}|${name}`);
    const body = cached?.[0];
    return { kind: 'tile', positions: body?.positions ?? null };
  }

  /**
   * LibraryManager's "default texture" step: a freshly picked prop gets the
   * first <texture> variant from library.xml. Without it the prop renders
   * through the 3DS material fallback and exports an empty <texture-name/>.
   *
   * The original iterated PropMesh.bitmaps, a Dictionary whose order is
   * unspecified — its own TODO asked for "the first one listed in the XML",
   * which is what document order gives here.
   */
  defaultTextureName(library: string, group: string, name: string): string {
    const def = this.registry.getLibrary(library)?.getProp(group, name) ?? null;
    if (def == null || def.kind !== 'mesh') {
      return '';
    }
    return def.textures.keys().next().value ?? '';
  }

  getDef(prop: Prop): PropDef | null {
    return this.registry.getLibrary(prop.library)?.getProp(prop.group, prop.name) ?? null;
  }

  /** The prop's visible mesh object, used by the Preview to frame it. */
  getBodyObject(prop: Prop): Parsed3DSObject | null {
    return this.collisionCache.get(`${prop.library}|${prop.group}|${prop.name}`)?.[0] ?? null;
  }

  /** Collision child meshes (everything except the body and `occ*`). */
  getCollisionObjects(prop: Prop): Parsed3DSObject[] | null {
    return this.collisionCache.get(`${prop.library}|${prop.group}|${prop.name}`)?.slice(1) ?? null;
  }

  /**
   * The loading bar's accounting, by direct order: the light map XML (already
   * parsed by the caller) names every file, and the bar advances ONE UNIT PER
   * FILE — loaded/total files, not bytes, so there is no size probing and no
   * network request beyond the downloads themselves. Units:
   *   - every unique mesh, sprite and library.xml-named texture;
   *   - plus one slot per mesh whose diffuse is named inside the .3ds (the
   *     slot settles when that texture does) — so the total is complete
   *     BEFORE the bar starts and never grows mid-flight.
   * The promises are shared with attachAll through the caches, so nothing is
   * downloaded twice; a cache hit or an error settles its unit all the same —
   * the bar reaches 100% exactly when the last file is accounted for.
   */
  trackDownloads(props: Prop[]): void {
    const meshUnits = new Set<string>();
    const textureUnits = new Set<string>();
    /** Meshes whose def names no texture — their diffuse is in the .3ds. */
    const fallbackSlots = new Map<string, string>(); // mesh url -> folder url
    for (const prop of props) {
      const def = this.getDef(prop);
      if (def == null) {
        continue; // gizmos and unresolved props download nothing
      }
      const folder = `${this.assetsBase}/props/${def.libraryFolder}`;
      if (def.kind === 'sprite') {
        textureUnits.add(`${folder}/${def.file}`);
        continue;
      }
      const meshUrl = `${folder}/${def.meshFile}`;
      meshUnits.add(meshUrl);
      const texture = def.textures.get(prop.textureName) ?? def.textures.values().next().value;
      if (texture != null) {
        textureUnits.add(`${folder}/${texture}`);
      } else {
        fallbackSlots.set(meshUrl, folder);
      }
    }
    assetProgress.addUnits(meshUnits.size + textureUnits.size + fallbackSlots.size);
    const tick = (): void => assetProgress.unitDone();
    for (const url of meshUnits) {
      this.parse3ds(url).then(tick, tick);
    }
    for (const url of textureUnits) {
      this.getTexture(url).then(tick, tick);
    }
    for (const [meshUrl, folder] of fallbackSlots) {
      this.parse3ds(meshUrl)
        .then((parser) => {
          const diffuse = parser.materials.find((m) => m.diffuseFilename != null)?.diffuseFilename;
          return diffuse != null ? this.getTexture(`${folder}/${diffuse}`) : null;
        })
        .then(tick, tick);
    }
  }

  async attachAll(props: Prop[], root: pc.Entity): Promise<void> {
    await Promise.all(props.map((prop) => this.attach(prop, root)));
    // Extents depend on the parsed mesh, which may have arrived after the Prop
    // was constructed during import; recompute now that everything is loaded.
    for (const prop of props) {
      if (prop.kind === 'tile') {
        const body = this.collisionCache.get(`${prop.library}|${prop.group}|${prop.name}`)?.[0];
        if (body != null) {
          prop.calculate(body.positions);
        }
      }
    }
  }

  async attach(prop: Prop, root: pc.Entity): Promise<void> {
    if (prop.entity != null) {
      root.addChild(prop.entity);
      this.sync(prop);
      return;
    }
    let entity: pc.Entity | null = null;
    try {
      entity = prop.kind === 'spawn' || prop.kind === 'bonus' || prop.kind === 'flag'
        ? this.buildGizmo(prop)
        : await this.buildMeshEntity(prop);
    } catch (error) {
      console.warn(`prop ${prop.library}/${prop.group}/${prop.name}: ${String(error)}`);
    }
    if (entity == null) {
      return;
    }
    prop.entity = entity;
    root.addChild(entity);
    this.sync(prop);
  }

  detach(prop: Prop): void {
    // Meshes and textures are shared across props, so never destroy() them
    // (see CLAUDE.md): just unparent and keep the entity for reuse.
    prop.entity?.remove();
  }

  /** Writes the prop transform onto its entity (sim coordinates). */
  sync(prop: Prop): void {
    if (prop.entity == null) {
      return;
    }
    prop.entity.setLocalPosition(prop.x, prop.y, prop.z);
    prop.entity.setLocalEulerAngles(0, 0, (prop.rotationZ * 180) / Math.PI);
  }

  /**
   * Tile.set textureName: swap the diffuse to another <texture> variant from
   * library.xml. The original rebuilt a BitmapData and a whole material; here
   * only the emissive map changes.
   */
  async applyTexture(prop: Prop): Promise<void> {
    const def = this.getDef(prop);
    const material = this.propMaterials.get(prop);
    if (def == null || def.kind !== 'mesh' || material == null) {
      return;
    }
    const file = def.textures.get(prop.textureName);
    if (file == null) {
      return;
    }
    const texture = await this.getTexture(
      `${this.assetsBase}/props/${def.libraryFolder}/${file}`,
    );
    material.emissiveMap = texture;
    material.update();
  }

  /** Texture variant names available for a prop, in library.xml order. */
  getTextureNames(prop: Prop): string[] {
    const def = this.getDef(prop);
    return def != null && def.kind === 'mesh' ? [...def.textures.keys()] : [];
  }

  /**
   * Tile.showCollisionBoxes / hideCollisionBoxes: hide the prop body and draw
   * its `plane*`/`box*`/`tri*` children in pink instead.
   *
   * The original painted them with CustomFillMaterial, a software-rasteriser
   * hook computing k = 0.5*(1 + normalize(lightPoint - centroid) . faceNormal)
   * per polygon against the fixed light point (-1e10, -0.7e10, 0.4e10). That
   * callback cannot be ported literally, so the same shading is produced by a
   * normal directional light: the light point is effectively a direction, and
   * PlayCanvas' lambert term gives the same 0..1 ramp.
   */
  setCollisionView(prop: Prop, enabled: boolean): void {
    if (prop.entity == null) {
      return;
    }
    let collision = prop.entity.children.find((c) => c.name === 'collision') as pc.Entity | undefined;
    if (enabled && collision == null) {
      const built = this.buildCollisionVisual(prop);
      if (built != null) {
        prop.entity.addChild(built);
        collision = built;
      }
    }
    // The prop's own mesh lives on the prop entity; hide it via its component
    // so the collision child stays visible (Tile.setMaterial(null)).
    if (prop.entity.render != null) {
      prop.entity.render.enabled = !enabled;
    }
    if (collision != null) {
      collision.enabled = enabled;
    }
  }

  /** Builds the pink collision-primitive visual once, lazily. */
  private buildCollisionVisual(prop: Prop): pc.Entity | null {
    const objects = this.getCollisionObjects(prop);
    if (objects == null || objects.length === 0) {
      return null;
    }
    const root = new pc.Entity('collision');
    for (const object of objects) {
      if (object.positions.length === 0 || object.faces.length === 0) {
        continue;
      }
      // getMesh appends `#${object.name}`, so this prefix keeps one cache
      // entry per (prop, collision child).
      const mesh = this.getMesh(`collision:${prop.library}|${prop.group}|${prop.name}`, object);
      const child = new pc.Entity(object.name);
      child.addComponent('render', {
        meshInstances: [new pc.MeshInstance(mesh, this.getCollisionMaterial())],
      });
      // Parser3DS bakes the 0x4160 matrix into the vertices; the keyframer
      // node transform is still outstanding.
      child.setLocalPosition(object.x, object.y, object.z);
      child.setLocalEulerAngles(
        (object.rotationX * 180) / Math.PI,
        (object.rotationY * 180) / Math.PI,
        (object.rotationZ * 180) / Math.PI,
      );
      root.addChild(child);
    }
    return root.children.length > 0 ? root : null;
  }

  private collisionMaterial: pc.StandardMaterial | null = null;

  private getCollisionMaterial(): pc.StandardMaterial {
    if (this.collisionMaterial == null) {
      const material = new pc.StandardMaterial();
      // CustomFillMaterial(..., 0xFF7F7F)
      material.diffuse = new pc.Color(1, 0.5, 0.5);
      material.emissive = new pc.Color(0.18, 0.06, 0.06);
      material.useLighting = true;
      material.cull = pc.CULLFACE_NONE;
      material.update();
      this.collisionMaterial = material;
    }
    return this.collisionMaterial;
  }

  /** Selection highlight — a material tint, not a texture rebuild. */
  setTint(prop: Prop, tint: 'none' | 'selected' | 'free' | 'blocked'): void {
    const material = this.propMaterials.get(prop);
    if (material == null) {
      return;
    }
    const color = tint === 'selected' ? SELECTED_TINT
      : tint === 'free' ? CURSOR_FREE_TINT
      : tint === 'blocked' ? CURSOR_BLOCKED_TINT
      : NO_TINT;
    material.emissive = color;
    material.update();
  }

  private async buildMeshEntity(prop: Prop): Promise<pc.Entity | null> {
    const def = this.getDef(prop);
    if (def == null) {
      return null;
    }
    const folder = `${this.assetsBase}/props/${def.libraryFolder}`;
    if (def.kind === 'sprite') {
      return this.buildSprite(prop, def, folder);
    }
    return this.buildMeshProp(prop, def, folder);
  }

  private async buildMeshProp(prop: Prop, def: PropMeshDef, folder: string): Promise<pc.Entity | null> {
    const meshUrl = `${folder}/${def.meshFile}`;
    const parser = await this.parse3ds(meshUrl);

    // PropMesh.processObjects: the body is the first non-`occl` object with
    // geometry; the remaining children are collision/occluder meshes.
    const geometry = parser.objects.filter((o) => o.positions.length > 0);
    const body = geometry.find((o) => !o.name.toLowerCase().startsWith('occl')) ?? geometry[0];
    if (body == null) {
      return null;
    }
    // Tile.as:40 — children named `occ*` are excluded from collisionGeometry.
    const children = geometry.filter((o) => o !== body && !o.name.toLowerCase().startsWith('occ'));
    this.collisionCache.set(`${prop.library}|${prop.group}|${prop.name}`, [body, ...children]);
    prop.calculate(body.positions);

    let textureFile = def.textures.get(prop.textureName) ?? null;
    if (textureFile == null) {
      textureFile = def.textures.values().next().value ?? null;
    }
    if (textureFile == null) {
      // prefetchMap budgets this diffuse before the bar shows a percent.
      textureFile = parser.materials.find((m) => m.diffuseFilename != null)?.diffuseFilename ?? null;
    }
    if (textureFile == null) {
      return null;
    }

    const material = await this.cloneMaterial(`${folder}/${textureFile}`, false);
    this.propMaterials.set(prop, material);
    const mesh = this.getMesh(meshUrl, body);
    const entity = new pc.Entity(prop.name);
    entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] });
    return entity;
  }

  private async buildSprite(prop: Prop, def: PropDef & { kind: 'sprite' }, folder: string): Promise<pc.Entity> {
    const url = `${folder}/${def.file}`;
    const texture = await this.getTexture(url);
    const material = await this.cloneMaterial(url, true);
    this.propMaterials.set(prop, material);
    const width = texture.width * def.scale;
    const height = texture.height * def.scale;
    const pivotZ = height * def.originY;
    const mesh = buildMesh(this.app.graphicsDevice, {
      positions: [
        -width / 2, 0, pivotZ,
        width / 2, 0, pivotZ,
        width / 2, 0, pivotZ - height,
        -width / 2, 0, pivotZ - height,
      ],
      indices: [0, 1, 2, 0, 2, 3],
      uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    });
    const entity = new pc.Entity(prop.name);
    entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] });
    return entity;
  }

  /**
   * Procedural gizmo for spawn points, bonus regions and CTF flags. The
   * original looked these up in a props library called "Functional" which does
   * not exist in this asset set, so they were dropped on import; drawing them
   * directly keeps them editable and round-trippable.
   */
  private buildGizmo(prop: Prop): pc.Entity {
    const key = prop.kind === 'bonus' ? 'bonus' : prop.name;
    const color = GIZMO_COLORS[key] ?? GIZMO_COLORS.dm;

    const halfX = prop.kind === 'bonus'
      ? Math.max(H_BASE / 2, (prop.distancesX.max - prop.distancesX.min) / 2)
      : H_BASE / 2;
    const halfY = prop.kind === 'bonus'
      ? Math.max(H_BASE / 2, (prop.distancesY.max - prop.distancesY.min) / 2)
      : H_BASE / 2;
    const height = prop.kind === 'bonus'
      ? Math.max(V_BASE / 2, (prop.distancesZ.max - prop.distancesZ.min))
      : V_BASE;

    const mesh = this.getBoxMesh(halfX, halfY, height);
    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(0, 0, 0);
    material.emissive = color;
    material.useLighting = false;
    material.opacity = 0.45;
    material.blendType = pc.BLEND_NORMAL;
    material.depthWrite = false;
    material.cull = pc.CULLFACE_NONE;
    material.update();

    const entity = new pc.Entity(`${prop.kind}:${prop.name}`);
    entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] });
    return entity;
  }

  /** Axis-aligned box sitting on z = 0, in sim units. */
  private getBoxMesh(halfX: number, halfY: number, height: number): pc.Mesh {
    const key = `${halfX}|${halfY}|${height}`;
    let mesh = this.gizmoMeshes.get(key);
    if (mesh != null) {
      return mesh;
    }
    const positions = [
      -halfX, -halfY, 0, halfX, -halfY, 0, halfX, halfY, 0, -halfX, halfY, 0,
      -halfX, -halfY, height, halfX, -halfY, height, halfX, halfY, height, -halfX, halfY, height,
    ];
    const indices = [
      0, 1, 2, 0, 2, 3, // bottom
      4, 6, 5, 4, 7, 6, // top
      0, 4, 5, 0, 5, 1,
      1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3,
      3, 7, 4, 3, 4, 0,
    ];
    mesh = buildMesh(this.app.graphicsDevice, { positions, indices });
    this.gizmoMeshes.set(key, mesh);
    return mesh;
  }

  private getMesh(meshUrl: string, object: Parsed3DSObject): pc.Mesh {
    const key = `${meshUrl}#${object.name}`;
    let mesh = this.meshCache.get(key);
    if (mesh == null) {
      mesh = buildMesh(this.app.graphicsDevice, {
        positions: object.positions,
        indices: object.faces,
        uvs: object.uvs ?? undefined,
      });
      this.meshCache.set(key, mesh);
    }
    return mesh;
  }

  /** Caches the promise (not the result) so parallel loads of one file dedupe. */
  private parse3ds(url: string): Promise<Parser3DS> {
    const cached = this.parsed3dsCache.get(url);
    if (cached != null) {
      return cached;
    }
    const promise = (async () => {
      const buffer = await assetProgress.trackedFetch(url);
      // Guard against the dev server's SPA fallback returning index.html.
      if (buffer.byteLength < 6 || new DataView(buffer).getUint16(0, true) !== 0x4d4d) {
        throw new Error(`Not a 3DS file: ${url}`);
      }
      const parser = new Parser3DS();
      parser.parse(buffer);
      return parser;
    })();
    this.parsed3dsCache.set(url, promise);
    return promise;
  }

  /**
   * Each prop gets its own material instance so selection tinting is per-prop,
   * but the underlying texture is shared through textureCache.
   */
  private async cloneMaterial(textureUrl: string, transparent: boolean): Promise<pc.StandardMaterial> {
    const texture = await this.getTexture(textureUrl);
    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(0, 0, 0);
    material.emissiveMap = texture;
    material.emissive = new pc.Color(1, 1, 1);
    material.useLighting = false;
    if (transparent) {
      material.opacityMap = texture;
      material.opacityMapChannel = 'a';
      material.alphaTest = 0.5;
      material.cull = pc.CULLFACE_NONE;
    }
    material.update();
    return material;
  }

  private getTexture(url: string): Promise<pc.Texture> {
    const cached = this.textureCache.get(url);
    if (cached != null) {
      return cached;
    }
    const promise = new Promise<pc.Texture>((resolve, reject) => {
      this.app.assets.loadFromUrl(url, 'texture', (err, asset) => {
        if (err != null || asset == null) {
          reject(new Error(String(err ?? 'texture load failed')));
        } else {
          resolve(asset.resource as pc.Texture);
        }
      });
    });
    this.textureCache.set(url, promise);
    return promise;
  }
}

// Port of the original editor's Prop (+ the Tile/Spawn/Bonus/Flag subclasses
// that only differ in constants, folded into `kind` here).
//
// Differences from the original, and why:
//   - Object3D inheritance is replaced by plain x/y/z/rotationZ fields plus an
//     optional pc.Entity; the scene graph is PlayCanvas's job.
//   - select()/deselect() cloned a BitmapData per prop and recomposited the
//     texture (Prop.as:230-248) — very expensive on multi-selects. Here
//     selection is a render-time tint, so no texture copies.
//   - getClassName()'s substr(25) class-name sniffing (PropsScene.as:144) is
//     replaced by the explicit `kind` discriminant.
import type * as pc from 'playcanvas';
import { floorTo, roundTo, H_BASE, H_BASE2, V_BASE } from '../core/EditorScene';

/** Prop.TILE/SPAWN/BONUS/FLAG, plus sprites (TileSprite3D). */
export type PropKind = 'tile' | 'sprite' | 'spawn' | 'bonus' | 'flag';

/** Distances from the centre to the extreme vertices on one axis. */
export interface Extent {
  /** Offset to the lower edge (negative or 0). */
  min: number;
  /** Offset to the upper edge. */
  max: number;
}

export interface PropInit {
  kind: PropKind;
  library: string;
  group: string;
  name: string;
  /** Mesh-local vertex positions (xyz triplets) used to measure the extents. */
  positions?: number[] | null;
}

/**
 * Spawn/Flag use fixed extents instead of measuring geometry
 * (Spawn.as:21-27, Flag.as:25-31).
 */
const FIXED_EXTENT_XY: Extent = { min: -H_BASE, max: H_BASE };
const FIXED_EXTENT_Z: Extent = { min: 0, max: V_BASE };

export class Prop {
  readonly kind: PropKind;
  readonly library: string;
  readonly group: string;
  name: string;

  x = 0;
  y = 0;
  z = 0;
  /** Radians about sim +Z, as stored in the map XML. */
  rotationZ = 0;

  /** Tile only: the chosen <texture name> variant. */
  textureName = '';
  /** Tile only: Tile.isMirror. Written to XML, never read back by the original. */
  isMirror = false;
  /** Bonus only: the <bonus-type> set. */
  types = new Set<string>();

  /** Prop.free — true means "not entered into the occupy map". */
  free = true;
  selected = false;
  /** Hidden by "hide selected props"; excluded from picking while hidden. */
  hidden = false;

  distancesX: Extent = { min: 0, max: H_BASE2 };
  distancesY: Extent = { min: 0, max: H_BASE2 };
  distancesZ: Extent = { min: 0, max: V_BASE };

  /** Prop._multi — spans more than one cell, so it snaps to lines not centres. */
  multi = false;

  entity: pc.Entity | null = null;

  constructor(init: PropInit) {
    this.kind = init.kind;
    this.library = init.library;
    this.group = init.group;
    this.name = init.name;

    if (this.kind === 'spawn' || this.kind === 'flag') {
      this.distancesX = { ...FIXED_EXTENT_XY };
      this.distancesY = { ...FIXED_EXTENT_XY };
      this.distancesZ = { ...FIXED_EXTENT_Z };
    } else if (this.kind === 'sprite') {
      // TileSprite3D.calculate zeroes every distance: sprites occupy nothing.
      this.distancesX = { min: 0, max: 0 };
      this.distancesY = { min: 0, max: 0 };
      this.distancesZ = { min: 0, max: 0 };
    } else if (init.positions != null && init.positions.length > 0) {
      this.calculate(init.positions);
    }

    if (this.kind === 'bonus') {
      this.types.add('damageup'); // Bonus.as: seeded with "damageup"
    }
  }

  /**
   * Prop.calculate: measure the grid-aligned extents on each axis.
   *
   * The original compares every vertex pair (O(n^2), Prop.as:96-145) to find
   * the most distant pair per axis. For an axis-aligned measurement that is
   * exactly min/max, which is what this computes in O(n) — same result.
   */
  calculate(positions: number[]): void {
    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;

    for (let i = 0; i < positions.length; i += 3) {
      const px = positions[i];
      const py = positions[i + 1];
      const pz = positions[i + 2];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }
    if (!Number.isFinite(minX)) {
      return;
    }

    this.distancesX = widen(calcDistance(0, minX, maxX, H_BASE), H_BASE);
    this.distancesY = widen(calcDistance(0, minY, maxY, H_BASE), H_BASE);
    this.distancesZ = widen(calcDistance(0, minZ, maxZ, V_BASE), V_BASE);

    // Prop.as:147-150
    this.multi =
      Math.abs(Math.trunc(maxX) - Math.trunc(minX)) / H_BASE2 > 1 ||
      Math.abs(Math.trunc(minY) - Math.trunc(maxY)) / H_BASE2 > 1;
  }

  /** Prop.snapCoords. */
  snapCoords(): void {
    if (this.multi) {
      this.x = floorTo(this.x, H_BASE2);
      this.y = floorTo(this.y, H_BASE2);
    } else {
      this.x = roundTo(this.x, H_BASE2);
      this.y = roundTo(this.y, H_BASE2);
    }
    this.z = floorTo(this.z, V_BASE);
  }

  /**
   * Prop.rotate: 90 degrees, swapping the X/Y extents so the occupancy
   * footprint turns with the mesh. Spawn overrides this with a 5-degree step.
   */
  rotate(plus: boolean): void {
    const step = this.kind === 'spawn' ? DEG5 : DEG90;
    if (this.kind === 'spawn') {
      this.rotationZ += plus ? -step : step;
      return;
    }
    if (plus) {
      const prev = { ...this.distancesX };
      this.distancesX = { ...this.distancesY };
      this.distancesY = { min: -prev.max, max: -prev.min };
      this.rotationZ -= step;
    } else {
      const prev = { ...this.distancesY };
      this.distancesY = { ...this.distancesX };
      this.distancesX = { min: -prev.max, max: -prev.min };
      this.rotationZ += step;
    }
  }

  clone(): Prop {
    const copy = new Prop({
      kind: this.kind,
      library: this.library,
      group: this.group,
      name: this.name,
    });
    copy.distancesX = { ...this.distancesX };
    copy.distancesY = { ...this.distancesY };
    copy.distancesZ = { ...this.distancesZ };
    copy.multi = this.multi;
    copy.textureName = this.textureName;
    copy.isMirror = this.isMirror;
    copy.types = new Set(this.types);
    copy.x = this.x;
    copy.y = this.y;
    copy.z = this.z;
    copy.rotationZ = this.rotationZ;
    return copy;
  }
}

const DEG90 = Math.PI / 2;
const DEG5 = Math.PI / 36;

/**
 * A degenerate (zero-width) extent would claim no occupancy cells at all, so
 * the prop could never conflict with anything. Some meshes really are flat on
 * an axis — Slope 1/2 span x:[-250,-250] — which the original never hit
 * because it measured vertices in GLOBAL coordinates (localToGlobal) after the
 * prop was placed, so the floor() split landed differently. Measuring in mesh
 * space is what makes the extents placement-independent and cacheable, so the
 * degenerate case is widened to one cell instead.
 */
function widen(extent: Extent, base: number): Extent {
  if (extent.max > extent.min) {
    return extent;
  }
  return { min: extent.min, max: extent.min + base };
}

/**
 * Prop.calcDistance: distance from the centre to the grid-snapped lower and
 * upper edges. Transcribed from Prop.as:159-196 including the zero cases.
 */
function calcDistance(centre: number, value1: number, value2: number, base: number): Extent {
  const v2 = floorTo(value2, base);
  const v1 = floorTo(value1, base);

  if (v2 === 0 && v1 === 0) {
    return { min: 0, max: base };
  }
  if (v2 > v1) {
    if (v1 === 0) {
      return { min: 0, max: v2 - centre };
    }
    return { min: v1 - centre, max: v2 - centre };
  }
  if (v2 === 0) {
    return { min: 0, max: v1 - centre };
  }
  return { min: v2 - centre, max: v1 - centre };
}

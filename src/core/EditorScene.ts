// Port of the original editor's EditorScene (constants + grid maths).
//
// Differences from the original, and why:
//   - Scene3D/View/Camera3D are dropped: PlayCanvas owns the scene graph and
//     the camera lives in EditorCamera.
//   - moveByArrows/move() keep the original's camera-sector switch verbatim so
//     the arrows always move a prop in screen space, not world axes.

/** EditorScene.hBase — occupancy cell size on X/Y, 2.5 m. */
export const H_BASE = 250;
/** EditorScene.hBase2 = 2*hBase — the placement lattice step, 5 m. */
export const H_BASE2 = 2 * H_BASE;
/** EditorScene.vBase — vertical step, 3 m. */
export const V_BASE = 300;

/**
 * Prop.floorTo: snap to the nearest multiple of base (lattice lines).
 *   return Math.floor((value + base/2)/base)*base;
 */
export function floorTo(value: number, base: number): number {
  return Math.floor((value + base / 2) / base) * base;
}

/**
 * Prop.roundTo: snap to the nearest half-offset multiple (cell centres).
 *   return Math.round((value + base/2)/base)*base - base/2;
 */
export function roundTo(value: number, base: number): number {
  return Math.round((value + base / 2) / base) * base - base / 2;
}

/** Arrow-key directions, matching KeyboardUtils.UP/DOWN/LEFT/RIGHT. */
export type ArrowKey = 'up' | 'down' | 'left' | 'right';

export interface MovableXY {
  x: number;
  y: number;
}

/**
 * EditorScene.move(prop, keyCode, sector): one hBase2 step in the direction
 * that looks like "screen up/down/left/right" for the current camera quadrant.
 * The sector tables are copied verbatim from the decompile.
 */
export function moveByArrows(prop: MovableXY, key: ArrowKey, sector: number): void {
  switch (key) {
    case 'up':
      switch (sector) {
        case 1: prop.x -= H_BASE2; break;
        case 4: prop.y += H_BASE2; break;
        case 3: prop.x += H_BASE2; break;
        case 2: prop.y -= H_BASE2; break;
      }
      break;
    case 'down':
      switch (sector) {
        case 1: prop.x += H_BASE2; break;
        case 4: prop.y -= H_BASE2; break;
        case 3: prop.x -= H_BASE2; break;
        case 2: prop.y += H_BASE2; break;
      }
      break;
    case 'left':
      switch (sector) {
        case 1: prop.y -= H_BASE2; break;
        case 4: prop.x -= H_BASE2; break;
        case 3: prop.y += H_BASE2; break;
        case 2: prop.x += H_BASE2; break;
      }
      break;
    case 'right':
      switch (sector) {
        case 1: prop.y += H_BASE2; break;
        case 4: prop.x += H_BASE2; break;
        case 3: prop.y -= H_BASE2; break;
        case 2: prop.x -= H_BASE2; break;
      }
      break;
  }
}

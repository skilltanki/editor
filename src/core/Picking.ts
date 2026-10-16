// Port of the picking half of the original engine's View:
//   projectViewPointToPlane(viewPoint, planeNormal, planeOffset) and
//   projectPoint(point3D), both implemented inside the original 3D engine library (no source).
//
// Differences from the original, and why:
//   - The original engine dispatched MouseEvent3D up the Object3D tree via its own
//     software hit test. PlayCanvas has no equivalent, so prop picking is an
//     explicit ray/AABB test here (pickProp).
//   - Everything works in SIM space (Z-up, 1 unit = 1 cm). The camera lives
//     under simRoot, so screen rays are built in world space and converted
//     once through the inverse simRoot transform.
import * as pc from 'playcanvas';
import { Vector3 } from '../engine/math/Vector3';
import type { Prop } from '../prop/Prop';

const worldOrigin = new pc.Vec3();
const worldFar = new pc.Vec3();
const simOrigin = new pc.Vec3();
const simFar = new pc.Vec3();
const invSim = new pc.Mat4();

export interface Ray {
  origin: Vector3;
  /** Not normalised — simply (far - origin). */
  direction: Vector3;
}

/**
 * Screen point -> ray in sim coordinates.
 * `x`/`y` are canvas-relative CSS pixels.
 */
export function screenRay(
  camera: pc.CameraComponent,
  simRoot: pc.Entity,
  x: number,
  y: number,
): Ray {
  camera.screenToWorld(x, y, camera.nearClip, worldOrigin);
  camera.screenToWorld(x, y, camera.farClip, worldFar);
  invSim.copy(simRoot.getWorldTransform()).invert();
  invSim.transformPoint(worldOrigin, simOrigin);
  invSim.transformPoint(worldFar, simFar);
  return {
    origin: new Vector3(simOrigin.x, simOrigin.y, simOrigin.z),
    direction: new Vector3(simFar.x - simOrigin.x, simFar.y - simOrigin.y, simFar.z - simOrigin.z),
  };
}

/**
 * View.projectViewPointToPlane: intersect the screen ray with the plane whose
 * normal is `normal` and whose signed offset along that normal is `offset`.
 * The editor only ever uses the three axis planes, matching EditorScene's
 * znormal/ynormal/xnormal.
 */
export function projectViewPointToPlane(
  camera: pc.CameraComponent,
  simRoot: pc.Entity,
  x: number,
  y: number,
  normal: Vector3,
  offset: number,
): Vector3 | null {
  const ray = screenRay(camera, simRoot, x, y);
  const denominator =
    normal.x * ray.direction.x + normal.y * ray.direction.y + normal.z * ray.direction.z;
  if (Math.abs(denominator) < 1e-9) {
    return null; // ray parallel to the plane
  }
  const numerator =
    offset - (normal.x * ray.origin.x + normal.y * ray.origin.y + normal.z * ray.origin.z);
  const t = numerator / denominator;
  if (t < 0) {
    return null; // plane is behind the camera
  }
  return new Vector3(
    ray.origin.x + ray.direction.x * t,
    ray.origin.y + ray.direction.y * t,
    ray.origin.z + ray.direction.z * t,
  );
}

/**
 * View.projectPoint: sim point -> screen point (canvas CSS pixels).
 * Returns null when the point is behind the camera. The original did NOT
 * clip behind the camera, which let rubber-band selection grab props from
 * behind; that is fixed here.
 */
export function projectPoint(
  camera: pc.CameraComponent,
  simRoot: pc.Entity,
  point: Vector3,
  out = new pc.Vec3(),
): pc.Vec3 | null {
  const world = simRoot.getWorldTransform().transformPoint(
    new pc.Vec3(point.x, point.y, point.z),
  );
  camera.worldToScreen(world, out);
  return out.z > 0 ? out : null;
}

/** Axis-aligned bounds of a prop in its own (unrotated) local space. */
function propHalfExtents(prop: Prop): { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number } {
  const hx = Math.max(1, (prop.distancesX.max - prop.distancesX.min) / 2);
  const hy = Math.max(1, (prop.distancesY.max - prop.distancesY.min) / 2);
  const hz = Math.max(1, (prop.distancesZ.max - prop.distancesZ.min) / 2);
  return {
    cx: (prop.distancesX.max + prop.distancesX.min) / 2,
    cy: (prop.distancesY.max + prop.distancesY.min) / 2,
    cz: (prop.distancesZ.max + prop.distancesZ.min) / 2,
    hx, hy, hz,
  };
}

/**
 * Ray/prop hit test, replacing the original engine's per-face software pick.
 * The prop's occupancy extents form an oriented box (rotation is about Z
 * only), so the ray is rotated into prop space and tested as a slab.
 * Returns the ray parameter t, or null.
 */
export function rayHitsProp(ray: Ray, prop: Prop): number | null {
  const { cx, cy, cz, hx, hy, hz } = propHalfExtents(prop);
  const cos = Math.cos(-prop.rotationZ);
  const sin = Math.sin(-prop.rotationZ);

  // Ray into prop space: translate, then un-rotate about Z.
  const ox = ray.origin.x - prop.x;
  const oy = ray.origin.y - prop.y;
  const originX = ox * cos - oy * sin - cx;
  const originY = ox * sin + oy * cos - cy;
  const originZ = ray.origin.z - prop.z - cz;

  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dirX = dx * cos - dy * sin;
  const dirY = dx * sin + dy * cos;
  const dirZ = ray.direction.z;

  let tMin = 0;
  let tMax = 1;
  const slab = (origin: number, dir: number, half: number): boolean => {
    if (Math.abs(dir) < 1e-12) {
      return Math.abs(origin) <= half;
    }
    let t1 = (-half - origin) / dir;
    let t2 = (half - origin) / dir;
    if (t1 > t2) {
      const tmp = t1; t1 = t2; t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    return tMin <= tMax;
  };

  if (!slab(originX, dirX, hx)) return null;
  if (!slab(originY, dirY, hy)) return null;
  if (!slab(originZ, dirZ, hz)) return null;
  return tMin;
}

/** Nearest prop under the screen point, skipping hidden ones. */
export function pickProp(
  camera: pc.CameraComponent,
  simRoot: pc.Entity,
  x: number,
  y: number,
  props: Iterable<Prop>,
  allow: (prop: Prop) => boolean = () => true,
): Prop | null {
  const ray = screenRay(camera, simRoot, x, y);
  let best: Prop | null = null;
  let bestT = Infinity;
  for (const prop of props) {
    if (prop.hidden || !allow(prop)) {
      continue;
    }
    const t = rayHitsProp(ray, prop);
    if (t != null && t < bestT) {
      bestT = t;
      best = prop;
    }
  }
  return best;
}

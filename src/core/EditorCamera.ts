// Port of the camera half of the original editor's EditorScene /
// CursorScene.initControllers.
//
// Differences from the original, and why:
//   - The original runs TWO scenes (CursorScene drives the camera, MainScene is
//     slaved to it every frame via synchronize()). PlayCanvas renders one scene
//     graph, so there is a single camera here and the cursor lives on its own
//     layer instead of its own scene.
//   - WalkController (inside the original 3D engine library, source unavailable) is replaced
//     by an equivalent orbit/pan/dolly rig. The published starting pose is kept
//     exactly: coords (250, -7800, 4670), rotationX = -90deg - 30deg.
import * as pc from 'playcanvas';
import { Vector3 } from '../engine/math/Vector3';

/** EditorScene.initScene: camera.coords = new Point3D(250, -7800, 4670) */
export const START_POSITION = new Vector3(250, -7800, 4670);
/** EditorScene.initScene: camera.rotationX = -MathUtils.DEG90 - MathUtils.DEG30 */
export const START_PITCH_DEG = -30;

const MIN_PITCH_DEG = -89;
const MAX_PITCH_DEG = -1;
const MIN_DISTANCE = 300;
const MAX_DISTANCE = 60000;

/**
 * Orbit camera in sim space (Z-up, 1 m = 100 units). Pose is stored as a
 * target + spherical offset; the PlayCanvas entity lives under simRoot, so it
 * is positioned in raw sim coordinates like everything else.
 */
export class EditorCamera {
  /** Point the camera orbits around, in sim coordinates. */
  readonly target = new Vector3();
  /** Degrees around sim +Z. 0 looks along +Y. */
  yawDeg = 0;
  /** Degrees below the horizon (negative looks down). */
  pitchDeg = START_PITCH_DEG;
  distance = 0;

  constructor(readonly entity: pc.Entity) {
    // Derive the orbit parameters from the original's published start pose so
    // the first frame matches the AS3 editor exactly.
    const pitch = (START_PITCH_DEG * Math.PI) / 180;
    this.distance = Math.hypot(START_POSITION.y, START_POSITION.z);
    this.target.x = START_POSITION.x;
    this.target.y = START_POSITION.y + Math.cos(pitch) * this.distance;
    this.target.z = START_POSITION.z + Math.sin(pitch) * this.distance;
    this.apply();
  }

  /** Writes the orbit parameters onto the entity transform. */
  apply(): void {
    const yaw = (this.yawDeg * Math.PI) / 180;
    const pitch = (this.pitchDeg * Math.PI) / 180;
    const horizontal = Math.cos(pitch) * this.distance;
    // Sim space: +Z is up, the camera sits "behind" the target along -Y at yaw 0.
    const x = this.target.x + Math.sin(yaw) * horizontal;
    const y = this.target.y - Math.cos(yaw) * horizontal;
    const z = this.target.z - Math.sin(pitch) * this.distance;
    this.entity.setLocalPosition(x, y, z);
    // simRoot already rotates -90deg about X to map Z-up sim onto Y-up world,
    // so a sim-space camera looking along +Y with pitch is expressed here as
    // euler (90 + pitch) about X and -yaw about Z.
    this.entity.setLocalEulerAngles(90 + this.pitchDeg, 0, -this.yawDeg);
  }

  orbit(deltaYawDeg: number, deltaPitchDeg: number): void {
    this.yawDeg += deltaYawDeg;
    this.pitchDeg = pc.math.clamp(this.pitchDeg + deltaPitchDeg, MIN_PITCH_DEG, MAX_PITCH_DEG);
    this.apply();
  }

  /** Pans the target in the camera's own screen plane, in sim units. */
  pan(dxUnits: number, dyUnits: number): void {
    const yaw = (this.yawDeg * Math.PI) / 180;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // Screen right in sim XY, and screen "up" projected onto the ground plane.
    this.target.x += cos * dxUnits + sin * dyUnits;
    this.target.y += sin * dxUnits - cos * dyUnits;
    this.apply();
  }

  /**
   * WalkController.moveForward/Back/Left/Right: slide the orbit target in the
   * camera's own horizontal frame. The original drove a WalkController with
   * speed 2000 and an acceleration model that lives inside the original 3D engine library;
   * this is the same motion at a constant rate.
   */
  move(forward: number, right: number): void {
    const yaw = (this.yawDeg * Math.PI) / 180;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // Screen "forward" is +Y rotated by yaw; "right" is that turned 90 deg.
    this.target.x += sin * forward + cos * right;
    this.target.y += cos * forward - sin * right;
    this.apply();
  }

  dolly(factor: number): void {
    this.distance = pc.math.clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
    this.apply();
  }

  /**
   * PropsScene.getCameraSector: quantises the camera yaw into 4 quadrants, so
   * the arrow keys always move a prop in screen space rather than world axes.
   * Returns 1..4, matching the original's EditorScene.move() switch.
   */
  getCameraSector(): number {
    // Original reads camera.rotationZ (radians) / DEG90 % 4; our yaw is the
    // negated Z rotation in degrees, so convert back to the same quantity.
    const sector = (-this.yawDeg / 90) % 4;
    if ((sector >= -0.5 && sector <= 0.5) || sector <= -3.5) {
      return 4;
    }
    if ((sector >= 0.5 && sector <= 1.5) || (sector >= -3.5 && sector <= -2.5)) {
      return 1;
    }
    if ((sector >= 1.5 && sector <= 2.5) || (sector >= -2.5 && sector <= -1.5)) {
      return 2;
    }
    return 3;
  }
}

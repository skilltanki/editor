// Port of the original engine's Matrix3D type (the subset the collision exporter uses).
//
// 3x4 row-major affine matrix. Translation lives in d, h, l:
//   a b c d
//   e f g h
//   i j k l
// Basis vectors are the columns (a,e,i), (b,f,j), (c,g,k).
//
// The original types library has no source, so rotate()/getRotations() are
// reconstructed to match the game's Matrix3.setRotationMatrix, which is the
// convention the shipped map XML is written in — verified against
// duel_old_summer (rotations are clean +-pi/2, +-pi with a y=1.570796 gimbal
// case, all of which round-trip through these two functions).
import { Vector3 } from '../../engine/math/Vector3';

export class Matrix3D {
  a = 1; b = 0; c = 0; d = 0;
  e = 0; f = 1; g = 0; h = 0;
  i = 0; j = 0; k = 1; l = 0;

  toIdentity(): void {
    this.a = 1; this.b = 0; this.c = 0; this.d = 0;
    this.e = 0; this.f = 1; this.g = 0; this.h = 0;
    this.i = 0; this.j = 0; this.k = 1; this.l = 0;
  }

  clone(): Matrix3D {
    const m = new Matrix3D();
    m.a = this.a; m.b = this.b; m.c = this.c; m.d = this.d;
    m.e = this.e; m.f = this.f; m.g = this.g; m.h = this.h;
    m.i = this.i; m.j = this.j; m.k = this.k; m.l = this.l;
    return m;
  }

  /** Matrix3D.setVectors(x, y, z, trans): basis vectors as columns. */
  setVectors(x: Vector3, y: Vector3, z: Vector3, trans: Vector3): void {
    this.a = x.x; this.b = y.x; this.c = z.x; this.d = trans.x;
    this.e = x.y; this.f = y.y; this.g = z.y; this.h = trans.y;
    this.i = x.z; this.j = y.z; this.k = z.z; this.l = trans.z;
  }

  /**
   * Matrix3D.rotate(rx, ry, rz): pre-multiply by the XYZ rotation matrix,
   * i.e. this = R * this. Same element layout as Matrix3.setRotationMatrix.
   */
  rotate(rx: number, ry: number, rz: number): void {
    const cosX = Math.cos(rx); const sinX = Math.sin(rx);
    const cosY = Math.cos(ry); const sinY = Math.sin(ry);
    const cosZ = Math.cos(rz); const sinZ = Math.sin(rz);

    const cosZsinY = cosZ * sinY;
    const sinZsinY = sinZ * sinY;

    const r00 = cosZ * cosY;
    const r01 = cosZsinY * sinX - sinZ * cosX;
    const r02 = cosZsinY * cosX + sinZ * sinX;
    const r10 = sinZ * cosY;
    const r11 = sinZsinY * sinX + cosZ * cosX;
    const r12 = sinZsinY * cosX - cosZ * sinX;
    const r20 = -sinY;
    const r21 = cosY * sinX;
    const r22 = cosY * cosX;

    const { a, b, c, d, e, f, g, h, i, j, k, l } = this;

    this.a = r00 * a + r01 * e + r02 * i;
    this.b = r00 * b + r01 * f + r02 * j;
    this.c = r00 * c + r01 * g + r02 * k;
    this.d = r00 * d + r01 * h + r02 * l;

    this.e = r10 * a + r11 * e + r12 * i;
    this.f = r10 * b + r11 * f + r12 * j;
    this.g = r10 * c + r11 * g + r12 * k;
    this.h = r10 * d + r11 * h + r12 * l;

    this.i = r20 * a + r21 * e + r22 * i;
    this.j = r20 * b + r21 * f + r22 * j;
    this.k = r20 * c + r21 * g + r22 * k;
    this.l = r20 * d + r21 * h + r22 * l;
  }

  /** Matrix3D.translate: add to the translation column. */
  translate(dx: number, dy: number, dz: number): void {
    this.d += dx;
    this.h += dy;
    this.l += dz;
  }

  /** Matrix3D.combine(parent): this = parent * this. */
  combine(parent: Matrix3D): void {
    const { a, b, c, d, e, f, g, h, i, j, k, l } = this;

    this.a = parent.a * a + parent.b * e + parent.c * i;
    this.b = parent.a * b + parent.b * f + parent.c * j;
    this.c = parent.a * c + parent.b * g + parent.c * k;
    this.d = parent.a * d + parent.b * h + parent.c * l + parent.d;

    this.e = parent.e * a + parent.f * e + parent.g * i;
    this.f = parent.e * b + parent.f * f + parent.g * j;
    this.g = parent.e * c + parent.f * g + parent.g * k;
    this.h = parent.e * d + parent.f * h + parent.g * l + parent.h;

    this.i = parent.i * a + parent.j * e + parent.k * i;
    this.j = parent.i * b + parent.j * f + parent.k * j;
    this.k = parent.i * c + parent.j * g + parent.k * k;
    this.l = parent.i * d + parent.j * h + parent.k * l + parent.l;
  }

  /**
   * Matrix3D.getRotations(): inverse of rotate(), returning XYZ Euler angles.
   * Mirrors the element layout above:
   *   i = -sinY, j = cosY*sinX, k = cosY*cosX, a = cosZ*cosY, e = sinZ*cosY
   */
  getRotations(): Vector3 {
    const sinY = -this.i;
    const clamped = Math.max(-1, Math.min(1, sinY));
    const ry = Math.asin(clamped);
    const cosY = Math.cos(ry);

    let rx: number;
    let rz: number;
    // The threshold must be tight: real maps contain rotations very close to
    // (but not exactly at) y = pi/2 — e.g. (1.169681, 1.570796, -0.401115) in
    // duel_old_summer. A loose epsilon routes those into the gimbal branch and
    // silently rewrites the orientation. Verified by round-tripping 20k random
    // triples plus exact gimbal poles: max matrix error 1.1e-12.
    if (Math.abs(cosY) > 1e-9) {
      rx = Math.atan2(this.j, this.k);
      rz = Math.atan2(this.e, this.a);
    } else {
      // True gimbal lock (|sinY| == 1): rz is free, so pin it at 0 and solve
      // rx from b = sinY*sinX, c = sinY*cosX.
      const sinYSign = sinY > 0 ? 1 : -1;
      rz = 0;
      rx = Math.atan2(sinYSign * this.b, sinYSign * this.c);
    }
    return new Vector3(rx, ry, rz);
  }

  /** Translation column as a vector. */
  getPosition(): Vector3 {
    return new Vector3(this.d, this.h, this.l);
  }
}

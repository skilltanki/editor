// Port of the original editor's {CollisionPrimitive, CollisionBox,
// CollisionPlane} plus a new CollisionTriangle.
//
// Differences from the original, and why:
//   - NEW: `tri*` meshes become <collision-triangle>. The AS3 exporter only
//     handled `plane*` and `box*` (TanksXmlExporter.as:160-161) while Tile
//     collected every non-`occ*` child, so `tri*` meshes were gathered and
//     then silently dropped. Every shipped map depends on triangles (duel 84,
//     highways 952, madness 1076), so a literal port would destroy ramp and
//     bridge collision on save. The game already reads <collision-triangle>
//     (CollisionGeometryParser.parseCollisionTriangles), so this is the
//     symmetric counterpart.
//   - The original engine's Mesh/Face/Vertex become the neutral Parsed3DSObject arrays.
import { Vector3 } from '../../engine/math/Vector3';
import type { Parsed3DSObject } from '../../engine/map/Parser3DS';
import { Matrix3D } from './Matrix3D';

export interface CollisionPrimitive {
  /** Emits the XML element, combined with the parent prop's transform. */
  toXml(doc: Document, parentTransform: Matrix3D): Element;
}

function appendVector(doc: Document, parent: Element, tag: string, v: Vector3): void {
  const node = doc.createElement(tag);
  appendNumber(doc, node, 'x', v.x);
  appendNumber(doc, node, 'y', v.y);
  appendNumber(doc, node, 'z', v.z);
  parent.appendChild(node);
}

function appendNumber(doc: Document, parent: Element, tag: string, value: number): void {
  const node = doc.createElement(tag);
  // Shipped maps carry 3 decimals on positions/sizes and 6 on rotations; the
  // exporter formats per call site, so just normalise -0 here.
  node.textContent = String(Object.is(value, -0) ? 0 : value);
  parent.appendChild(node);
}

function appendFixed(doc: Document, parent: Element, tag: string, value: number, digits: number): void {
  const node = doc.createElement(tag);
  const normalised = Object.is(value, -0) ? 0 : value;
  node.textContent = normalised.toFixed(digits);
  parent.appendChild(node);
}

function appendPositionRotation(doc: Document, element: Element, transform: Matrix3D): void {
  const position = transform.getPosition();
  const angles = transform.getRotations();
  const pos = doc.createElement('position');
  appendFixed(doc, pos, 'x', position.x, 3);
  appendFixed(doc, pos, 'y', position.y, 3);
  appendFixed(doc, pos, 'z', position.z, 3);
  element.appendChild(pos);
  const rot = doc.createElement('rotation');
  appendFixed(doc, rot, 'x', angles.x, 6);
  appendFixed(doc, rot, 'y', angles.y, 6);
  appendFixed(doc, rot, 'z', angles.z, 6);
  element.appendChild(rot);
}

/** Node transform of a 3DS child mesh, as parsed by Parser3DS. */
function meshTransform(object: Parsed3DSObject): Matrix3D {
  const m = new Matrix3D();
  m.toIdentity();
  m.rotate(object.rotationX, object.rotationY, object.rotationZ);
  m.translate(object.x, object.y, object.z);
  return m;
}

/**
 * CollisionBox: oriented box from the child mesh's AABB plus its node
 * transform (CollisionBox.parse / getXml).
 */
export class CollisionBox implements CollisionPrimitive {
  readonly size = new Vector3();
  readonly transform = new Matrix3D();

  constructor(object: Parsed3DSObject) {
    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    const p = object.positions;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2];
      if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    this.size.x = maxX - minX;
    this.size.y = maxY - minY;
    this.size.z = maxZ - minZ;

    const mid = new Vector3(0.5 * (maxX + minX), 0.5 * (maxY + minY), 0.5 * (maxZ + minZ));
    const m = meshTransform(object);
    // midPoint.transform(transform) then transform.d/h/l = midPoint
    const tx = m.a * mid.x + m.b * mid.y + m.c * mid.z + m.d;
    const ty = m.e * mid.x + m.f * mid.y + m.g * mid.z + m.h;
    const tz = m.i * mid.x + m.j * mid.y + m.k * mid.z + m.l;
    m.d = tx; m.h = ty; m.l = tz;

    this.transform.a = m.a; this.transform.b = m.b; this.transform.c = m.c; this.transform.d = m.d;
    this.transform.e = m.e; this.transform.f = m.f; this.transform.g = m.g; this.transform.h = m.h;
    this.transform.i = m.i; this.transform.j = m.j; this.transform.k = m.k; this.transform.l = m.l;
  }

  toXml(doc: Document, parentTransform: Matrix3D): Element {
    const global = this.transform.clone();
    global.combine(parentTransform);
    const element = doc.createElement('collision-box');
    const size = doc.createElement('size');
    appendFixed(doc, size, 'x', this.size.x, 3);
    appendFixed(doc, size, 'y', this.size.y, 3);
    appendFixed(doc, size, 'z', this.size.z, 3);
    element.appendChild(size);
    appendPositionRotation(doc, element, global);
    return element;
  }
}

/**
 * CollisionPlane: oriented rectangle derived from the mesh's first triangle,
 * assuming the mesh is a two-triangle quad (CollisionPlane.parse).
 */
export class CollisionPlane implements CollisionPrimitive {
  width = 0;
  length = 0;
  readonly transform = new Matrix3D();

  constructor(object: Parsed3DSObject) {
    const p = object.positions;
    const corner = (faceCorner: number): Vector3 => {
      const vi = object.faces[faceCorner];
      return new Vector3(p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]);
    };
    const v = [corner(0), corner(1), corner(2)];

    // Edge vectors and the hypotenuse index.
    const edges: Vector3[] = [];
    const lengths: number[] = [];
    let max = -1;
    let imax = 0;
    for (let i = 0; i < 3; i++) {
      const edge = new Vector3(
        v[(i + 1) % 3].x - v[i].x,
        v[(i + 1) % 3].y - v[i].y,
        v[(i + 1) % 3].z - v[i].z,
      );
      edges.push(edge);
      const len = Math.sqrt(edge.x * edge.x + edge.y * edge.y + edge.z * edge.z);
      lengths.push(len);
      if (len > max) {
        max = len;
        imax = i;
      }
    }

    const ix = (imax + 2) % 3;
    const iy = (imax + 1) % 3;
    const xAxis = edges[ix];
    const yAxis = edges[iy];
    yAxis.x = -yAxis.x; yAxis.y = -yAxis.y; yAxis.z = -yAxis.z; // yAxis.invert()
    this.width = lengths[ix];
    this.length = lengths[iy];

    // Local origin: the (imax+2)%3 vertex shifted by half of (xAxis + yAxis).
    const trans = new Vector3(
      v[(imax + 2) % 3].x + 0.5 * (xAxis.x + yAxis.x),
      v[(imax + 2) % 3].y + 0.5 * (xAxis.y + yAxis.y),
      v[(imax + 2) % 3].z + 0.5 * (xAxis.z + yAxis.z),
    );

    normalise(xAxis);
    normalise(yAxis);
    const zAxis = new Vector3(
      xAxis.y * yAxis.z - xAxis.z * yAxis.y,
      xAxis.z * yAxis.x - xAxis.x * yAxis.z,
      xAxis.x * yAxis.y - xAxis.y * yAxis.x,
    );

    this.transform.setVectors(xAxis, yAxis, zAxis, trans);
    this.transform.rotate(object.rotationX, object.rotationY, object.rotationZ);
    this.transform.translate(object.x, object.y, object.z);
  }

  toXml(doc: Document, parentTransform: Matrix3D): Element {
    const global = this.transform.clone();
    global.combine(parentTransform);
    const element = doc.createElement('collision-plane');
    appendFixed(doc, element, 'width', this.width, 3);
    appendFixed(doc, element, 'length', this.length, 3);
    appendPositionRotation(doc, element, global);
    return element;
  }
}

/**
 * CollisionTriangle — NEW, no AS3 counterpart (see the file header).
 *
 * The game reads v0/v1/v2 in the shape's local XY plane plus a
 * position/rotation, so the mesh's node transform becomes the orientation and
 * the vertices stay local, exactly like the shipped maps store them.
 */
export class CollisionTriangle implements CollisionPrimitive {
  readonly vertices: [Vector3, Vector3, Vector3];
  readonly transform: Matrix3D;

  constructor(object: Parsed3DSObject, faceIndex: number) {
    const p = object.positions;
    const corner = (c: number): Vector3 => {
      const vi = object.faces[faceIndex * 3 + c];
      return new Vector3(p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]);
    };
    // Parser3DS bakes the 0x4160 matrix into the positions, so these are
    // mesh-local; the keyframer node transform (0xB020/0xB021) is still
    // outstanding. Apply it here so the triangle sits where it belongs —
    // some meshes carry a real node rotation (e.g. Rise 2's tri_08 is
    // [1.5708, 0, -2.4208]), not just a translation.
    const node = meshTransform(object);
    const place = (v: Vector3): Vector3 => new Vector3(
      node.a * v.x + node.b * v.y + node.c * v.z + node.d,
      node.e * v.x + node.f * v.y + node.g * v.z + node.h,
      node.i * v.x + node.j * v.y + node.k * v.z + node.l,
    );
    const world = [place(corner(0)), place(corner(1)), place(corner(2))];

    // Same construction as CollisionPlane: build an orthonormal basis from the
    // triangle so the stored vertices lie in the local XY plane at z = 0, with
    // the placement carried by position/rotation. Verified against the shipped
    // maps, whose triangles always have v*.z == 0.
    const xAxis = sub(world[1], world[0]);
    const edge2 = sub(world[2], world[0]);
    const normal = cross(xAxis, edge2);
    normalise(xAxis);
    normalise(normal);
    // yAxis = normal x xAxis keeps the basis right-handed.
    const yAxis = cross(normal, xAxis);
    normalise(yAxis);

    const origin = world[0];
    const project = (v: Vector3): Vector3 => {
      const d = sub(v, origin);
      return new Vector3(dot(d, xAxis), dot(d, yAxis), dot(d, normal));
    };
    this.vertices = [project(world[0]), project(world[1]), project(world[2])];

    // `world` already includes the node transform, so the basis is final.
    this.transform = new Matrix3D();
    this.transform.setVectors(xAxis, yAxis, normal, origin);
  }

  toXml(doc: Document, parentTransform: Matrix3D): Element {
    const global = this.transform.clone();
    global.combine(parentTransform);
    const element = doc.createElement('collision-triangle');
    appendVector(doc, element, 'v0', round3(this.vertices[0]));
    appendVector(doc, element, 'v1', round3(this.vertices[1]));
    appendVector(doc, element, 'v2', round3(this.vertices[2]));
    appendPositionRotation(doc, element, global);
    return element;
  }
}

function round3(v: Vector3): Vector3 {
  return new Vector3(
    Number(v.x.toFixed(3)),
    Number(v.y.toFixed(3)),
    Number(v.z.toFixed(3)),
  );
}

function sub(a: Vector3, b: Vector3): Vector3 {
  return new Vector3(a.x - b.x, a.y - b.y, a.z - b.z);
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return new Vector3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalise(v: Vector3): void {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len > 0) {
    v.x /= len;
    v.y /= len;
    v.z /= len;
  }
}

/**
 * TanksXmlExporter.createPropCollisionPrimitives, extended with `tri*`.
 * Mesh-name prefixes are matched lowercase, and `occ*` children are excluded
 * upstream (Tile.as:40).
 */
export function buildPrimitives(objects: Parsed3DSObject[]): CollisionPrimitive[] {
  const primitives: CollisionPrimitive[] = [];
  for (const object of objects) {
    const name = object.name.toLowerCase();
    if (object.positions.length === 0 || object.faces.length === 0) {
      continue;
    }
    if (name.startsWith('plane')) {
      primitives.push(new CollisionPlane(object));
    } else if (name.startsWith('box')) {
      primitives.push(new CollisionBox(object));
    } else if (name.startsWith('tri')) {
      // One <collision-triangle> per face: a `tri*` mesh may hold several.
      const faceCount = object.faces.length / 3;
      for (let i = 0; i < faceCount; i++) {
        primitives.push(new CollisionTriangle(object, i));
      }
    }
  }
  return primitives;
}

// Port of the original editor's TanksXmlExporter.
//
// Differences from the original, and why:
//   - Collision primitives also cover `tri*` meshes (see CollisionPrimitives).
//   - FileStream becomes a returned string; the caller saves it with a Blob
//     download, since a browser has no AIR file dialog.
//   - E4X literals become DOM construction; element order, attribute names and
//     number formatting are kept identical to the shipped maps (positions 3
//     decimals, rotations 6).
import { Matrix3D } from './collision/Matrix3D';
import { buildPrimitives, CollisionPrimitive } from './collision/CollisionPrimitives';
import type { Parsed3DSObject } from '../engine/map/Parser3DS';
import type { Prop } from '../prop/Prop';

/**
 * Supplies the collision child meshes of a prop's .3ds. The exporter only
 * needs the non-`occ*` children; the renderer already parsed the file, so the
 * caller passes the cached objects in.
 */
export type CollisionSource = (prop: Prop) => Parsed3DSObject[] | null;

/** TanksXmlExporter.CollisionPrimitivesCache, keyed library|group|name. */
class PrimitivesCache {
  private cache = new Map<string, CollisionPrimitive[]>();

  get(prop: Prop): CollisionPrimitive[] | undefined {
    return this.cache.get(`${prop.library}|${prop.group}|${prop.name}`);
  }

  set(prop: Prop, primitives: CollisionPrimitive[]): void {
    this.cache.set(`${prop.library}|${prop.group}|${prop.name}`, primitives);
  }
}

function fixed(doc: Document, parent: Element, tag: string, value: number, digits: number): void {
  const node = doc.createElement(tag);
  const normalised = Object.is(value, -0) ? 0 : value;
  node.textContent = normalised.toFixed(digits);
  parent.appendChild(node);
}

function positionElement(doc: Document, prop: Prop): Element {
  const position = doc.createElement('position');
  fixed(doc, position, 'x', prop.x, 3);
  fixed(doc, position, 'y', prop.y, 3);
  fixed(doc, position, 'z', prop.z, 3);
  return position;
}

function rotationZElement(doc: Document, prop: Prop): Element {
  const rotation = doc.createElement('rotation');
  fixed(doc, rotation, 'z', prop.rotationZ, 6);
  return rotation;
}

/** TanksXmlExporter.getTileXml */
function tileXml(doc: Document, prop: Prop): Element {
  const element = doc.createElement('prop');
  element.setAttribute('library-name', prop.library);
  element.setAttribute('group-name', prop.group);
  element.setAttribute('name', prop.name);
  element.setAttribute('mirror', String(prop.isMirror));
  element.setAttribute('free', String(prop.free));
  element.appendChild(rotationZElement(doc, prop));
  element.appendChild(positionElement(doc, prop));
  const texture = doc.createElement('texture-name');
  texture.textContent = prop.textureName;
  element.appendChild(texture);
  return element;
}

/** TanksXmlExporter.getSpawnXml — `type` carries the prop NAME. */
function spawnXml(doc: Document, prop: Prop): Element {
  const element = doc.createElement('spawn-point');
  element.setAttribute('type', prop.name);
  element.setAttribute('free', String(prop.free));
  element.appendChild(positionElement(doc, prop));
  element.appendChild(rotationZElement(doc, prop));
  return element;
}

/** TanksXmlExporter.getBonusXml */
function bonusXml(doc: Document, prop: Prop): Element {
  const element = doc.createElement('bonus-region');
  element.setAttribute('name', prop.name);
  element.setAttribute('free', String(prop.free));
  element.appendChild(positionElement(doc, prop));
  element.appendChild(rotationZElement(doc, prop));

  const min = doc.createElement('min');
  fixed(doc, min, 'x', prop.x + prop.distancesX.min, 3);
  fixed(doc, min, 'y', prop.y + prop.distancesY.min, 3);
  fixed(doc, min, 'z', prop.z + prop.distancesZ.min, 3);
  element.appendChild(min);

  const max = doc.createElement('max');
  fixed(doc, max, 'x', prop.x + prop.distancesX.max, 3);
  fixed(doc, max, 'y', prop.y + prop.distancesY.max, 3);
  fixed(doc, max, 'z', prop.z + prop.distancesZ.max, 3);
  element.appendChild(max);

  for (const type of prop.types) {
    const node = doc.createElement('bonus-type');
    node.textContent = type;
    element.appendChild(node);
  }
  return element;
}

/** TanksXmlExporter.addCtfFlag — <ctf-flags> is created lazily. */
function addCtfFlag(doc: Document, root: Element, prop: Prop): void {
  let flags = root.getElementsByTagName('ctf-flags')[0];
  if (flags == null) {
    flags = doc.createElement('ctf-flags');
    root.appendChild(flags);
  }
  let tag: string | null = null;
  if (prop.name === 'red_flag') {
    tag = 'flag-red';
  } else if (prop.name === 'blue_flag') {
    tag = 'flag-blue';
  }
  if (tag == null) {
    return; // the original would appendChild(null) here
  }
  const element = doc.createElement(tag);
  fixed(doc, element, 'x', prop.x, 3);
  fixed(doc, element, 'y', prop.y, 3);
  fixed(doc, element, 'z', prop.z, 3);
  flags.appendChild(element);
}

/** The prop's own transform, which collision primitives are combined with. */
function propTransform(prop: Prop): Matrix3D {
  const m = new Matrix3D();
  m.toIdentity();
  m.rotate(0, 0, prop.rotationZ);
  m.translate(prop.x, prop.y, prop.z);
  return m;
}

export interface ExportOptions {
  /** Collision child meshes per prop; omit to skip <collision-geometry>. */
  collisionSource?: CollisionSource;
}

/**
 * TanksXmlExporter.exportToFileStream — builds the whole map document.
 * Section order is fixed: static-geometry, collision-geometry, spawn-points,
 * bonus-regions, then ctf-flags appended lazily.
 */
export function exportTanksXml(props: Iterable<Prop>, options: ExportOptions = {}): string {
  const doc = document.implementation.createDocument(null, 'map', null);
  const root = doc.documentElement;
  root.setAttribute('version', '1.0');

  const staticGeometry = doc.createElement('static-geometry');
  const collisionGeometry = doc.createElement('collision-geometry');
  const spawnPoints = doc.createElement('spawn-points');
  const bonusRegions = doc.createElement('bonus-regions');
  root.appendChild(staticGeometry);
  root.appendChild(collisionGeometry);
  root.appendChild(spawnPoints);
  root.appendChild(bonusRegions);

  const cache = new PrimitivesCache();

  for (const prop of props) {
    switch (prop.kind) {
      case 'bonus':
        bonusRegions.appendChild(bonusXml(doc, prop));
        break;
      case 'spawn':
        spawnPoints.appendChild(spawnXml(doc, prop));
        break;
      case 'flag':
        addCtfFlag(doc, root, prop);
        break;
      case 'tile':
      case 'sprite': {
        staticGeometry.appendChild(tileXml(doc, prop));
        if (options.collisionSource == null) {
          break;
        }
        let primitives = cache.get(prop);
        if (primitives == null) {
          const objects = options.collisionSource(prop);
          primitives = objects != null ? buildPrimitives(objects) : [];
          cache.set(prop, primitives);
        }
        const parent = propTransform(prop);
        for (const primitive of primitives) {
          collisionGeometry.appendChild(primitive.toXml(doc, parent));
        }
        break;
      }
    }
  }

  return serialise(doc);
}

/** Pretty-prints with 2-space indent, matching the shipped maps' layout. */
function serialise(doc: Document): string {
  const lines: string[] = [];

  const walk = (element: Element, depth: number): void => {
    const indent = '  '.repeat(depth);
    const attrs = Array.from(element.attributes)
      .map((a) => ` ${a.name}="${escapeXml(a.value)}"`)
      .join('');
    const children = Array.from(element.children);

    if (children.length === 0) {
      const text = element.textContent ?? '';
      if (text === '') {
        lines.push(`${indent}<${element.tagName}${attrs}/>`);
      } else {
        lines.push(`${indent}<${element.tagName}${attrs}>${escapeXml(text)}</${element.tagName}>`);
      }
      return;
    }
    lines.push(`${indent}<${element.tagName}${attrs}>`);
    for (const child of children) {
      walk(child, depth + 1);
    }
    lines.push(`${indent}</${element.tagName}>`);
  };

  walk(doc.documentElement, 0);
  return `${lines.join('\n')}\n`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

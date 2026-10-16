// Port of the original editor's TanksXmlImporter.
//
// Differences from the original, and why:
//   - Spawns/bonuses/flags no longer need a props library called "Functional"
//     (the original keyed them "Functional"+"Spawn Points"/..., and no such
//     library exists in assets/Props — so they were silently dropped on load
//     and lost on save). They become first-class procedural props here.
//   - `free` is parsed properly: the original wrote
//     `var free:Boolean = bonusXML.attribute("free")`, coercing a non-empty
//     XMLList to true, so bonuses/spawns never entered the occupy map
//     (TanksXmlImporter.as:139,168). Tiles used the correct string compare.
//   - `mirror` is read back (the original wrote it but never read it, so
//     mirroring was lost on round-trip).
//   - No per-prop scene.calculate(): the original rebuilt the BSP once per
//     imported prop, which is quadratic.
import { childElements, firstChild, childNumber } from '../engine/map/xmlUtils';
import { Prop, PropKind } from '../prop/Prop';

export interface ImportedMap {
  props: Prop[];
  /** Props whose <prop> entry could not be resolved against a library. */
  skipped: number;
}

function readPosition(node: Element, prop: Prop): void {
  const position = firstChild(node, 'position');
  if (position != null) {
    prop.x = childNumber(position, 'x');
    prop.y = childNumber(position, 'y');
    prop.z = childNumber(position, 'z');
  }
}

function readRotationZ(node: Element, prop: Prop): void {
  const rotation = firstChild(node, 'rotation');
  if (rotation != null) {
    prop.rotationZ = childNumber(rotation, 'z');
  }
}

function readFree(node: Element): boolean {
  return node.getAttribute('free') === 'true';
}

export interface ImportCallbacks {
  /**
   * Resolves a <prop> entry to its kind and measured extents. Returning null
   * means the library is not loaded, and the prop is counted as skipped.
   */
  resolveTile(libraryName: string, groupName: string, propName: string): {
    kind: PropKind;
    positions?: number[] | null;
  } | null;
}

/** TanksXmlImporter.importFromFileStream */
export function importTanksXml(mapXml: Document, callbacks: ImportCallbacks): ImportedMap {
  const root = mapXml.documentElement;
  const props: Prop[] = [];
  let skipped = 0;

  // --- <static-geometry> ---
  const staticGeometry = firstChild(root, 'static-geometry');
  if (staticGeometry != null) {
    for (const node of childElements(staticGeometry, 'prop')) {
      const libraryName = node.getAttribute('library-name') ?? '';
      const groupName = node.getAttribute('group-name') ?? '';
      const propName = node.getAttribute('name') ?? '';
      const resolved = callbacks.resolveTile(libraryName, groupName, propName);
      if (resolved == null) {
        skipped++;
        continue;
      }
      const prop = new Prop({
        kind: resolved.kind,
        library: libraryName,
        group: groupName,
        name: propName,
        positions: resolved.positions,
      });
      readRotationZ(node, prop);
      readPosition(node, prop);
      prop.textureName = firstChild(node, 'texture-name')?.textContent?.trim() ?? '';
      prop.isMirror = node.getAttribute('mirror') === 'true';
      prop.free = readFree(node);
      props.push(prop);
    }
  }

  // --- <spawn-points> ---
  const spawnPoints = firstChild(root, 'spawn-points');
  if (spawnPoints != null) {
    for (const node of childElements(spawnPoints, 'spawn-point')) {
      const prop = new Prop({
        kind: 'spawn',
        library: 'Functional',
        group: 'Spawn Points',
        name: node.getAttribute('type') ?? 'dm',
      });
      readPosition(node, prop);
      readRotationZ(node, prop);
      prop.free = readFree(node);
      props.push(prop);
    }
  }

  // --- <bonus-regions> ---
  const bonusRegions = firstChild(root, 'bonus-regions');
  if (bonusRegions != null) {
    for (const node of childElements(bonusRegions, 'bonus-region')) {
      const prop = new Prop({
        kind: 'bonus',
        library: 'Functional',
        group: 'Bonus Regions',
        name: node.getAttribute('name') ?? '',
      });
      readPosition(node, prop);
      readRotationZ(node, prop);
      prop.free = readFree(node);

      // min/max are stored absolute; keep them as extents so the exporter
      // reproduces the same numbers.
      const min = firstChild(node, 'min');
      const max = firstChild(node, 'max');
      if (min != null && max != null) {
        prop.distancesX = { min: childNumber(min, 'x') - prop.x, max: childNumber(max, 'x') - prop.x };
        prop.distancesY = { min: childNumber(min, 'y') - prop.y, max: childNumber(max, 'y') - prop.y };
        prop.distancesZ = { min: childNumber(min, 'z') - prop.z, max: childNumber(max, 'z') - prop.z };
      }

      prop.types.clear();
      for (const type of childElements(node, 'bonus-type')) {
        const value = type.textContent?.trim();
        if (value != null && value !== '') {
          prop.types.add(value);
        }
      }
      props.push(prop);
    }
  }

  // --- <ctf-flags> ---
  const flags = firstChild(root, 'ctf-flags');
  if (flags != null) {
    for (const [tag, name] of [['flag-red', 'red_flag'], ['flag-blue', 'blue_flag']] as const) {
      for (const node of childElements(flags, tag)) {
        const prop = new Prop({
          kind: 'flag',
          library: 'Functional',
          group: 'Flags',
          name,
        });
        prop.x = childNumber(node, 'x');
        prop.y = childNumber(node, 'y');
        prop.z = childNumber(node, 'z');
        props.push(prop);
      }
    }
  }

  return { props, skipped };
}

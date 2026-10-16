// Port of the original editor's OccupyMap.
//
// Sparse 3-level grid x -> y -> z -> Prop[], cell size hBase x hBase x vBase
// (250 x 250 x 300). The original's Map type becomes a plain Map; iteration
// order is irrelevant here because every lookup is by key.
import { H_BASE, V_BASE } from './EditorScene';
import type { Prop } from '../prop/Prop';

type ZMap = Map<number, Prop[]>;
type YMap = Map<number, ZMap>;

export class OccupyMap {
  private map: Map<number, YMap> = new Map();

  /** OccupyMap.occupy — fills every cell the prop covers and clears `free`. */
  occupy(prop: Prop): void {
    if (!prop.free) {
      return;
    }
    const x1 = prop.distancesX.min + prop.x;
    const x2 = prop.distancesX.max + prop.x;
    const y1 = prop.distancesY.min + prop.y;
    const y2 = prop.distancesY.max + prop.y;
    const z1 = prop.distancesZ.min + prop.z;
    const z2 = prop.distancesZ.max + prop.z;

    for (let x = x1; x < x2; x += H_BASE) {
      for (let y = y1; y < y2; y += H_BASE) {
        for (let z = z1; z < z2; z += V_BASE) {
          this.addElement(x, y, z, prop);
        }
      }
    }
    prop.free = false;
  }

  addElement(x: number, y: number, z: number, prop: Prop): void {
    let yMap = this.map.get(x);
    if (yMap == null) {
      yMap = new Map();
      this.map.set(x, yMap);
    }
    let zMap = yMap.get(y);
    if (zMap == null) {
      zMap = new Map();
      yMap.set(y, zMap);
    }
    const props = zMap.get(z);
    if (props == null) {
      zMap.set(z, [prop]);
    } else {
      props.push(prop);
    }
  }

  /** OccupyMap.free — removes the prop from every cell and sets `free`. */
  free(prop: Prop): void {
    if (prop.free) {
      return;
    }
    const x1 = prop.distancesX.min + prop.x;
    const x2 = prop.distancesX.max + prop.x;
    const y1 = prop.distancesY.min + prop.y;
    const y2 = prop.distancesY.max + prop.y;
    const z1 = prop.distancesZ.min + prop.z;
    const z2 = prop.distancesZ.max + prop.z;

    for (let x = x1; x < x2; x += H_BASE) {
      const yMap = this.map.get(x);
      if (yMap == null) {
        continue;
      }
      for (let y = y1; y < y2; y += H_BASE) {
        const zMap = yMap.get(y);
        if (zMap == null) {
          continue;
        }
        for (let z = z1; z < z2; z += V_BASE) {
          const props = zMap.get(z);
          if (props == null) {
            continue;
          }
          const index = props.indexOf(prop);
          if (index > -1) {
            props.splice(index, 1);
            if (props.length === 0) {
              zMap.delete(z);
            }
          }
        }
        if (zMap.size === 0) {
          yMap.delete(y);
        }
      }
      if (yMap.size === 0) {
        this.map.delete(x);
      }
    }
    prop.free = true;
  }

  isOccupy(x: number, y: number, z: number): Prop[] | null {
    return this.map.get(x)?.get(y)?.get(z) ?? null;
  }

  clear(): void {
    this.map.clear();
  }

  /** OccupyMap.isConflict — any other prop sharing a cell. */
  isConflict(prop: Prop): boolean {
    return this.scan(prop, (props) => props.indexOf(prop) === -1 || props.length > 1);
  }

  /** OccupyMap.isConflictGroup — only props of the SAME group collide. */
  isConflictGroup(prop: Prop): boolean {
    return this.scan(prop, (props) =>
      props.some((other) => other !== prop && other.group === prop.group));
  }

  private scan(prop: Prop, hit: (props: Prop[]) => boolean): boolean {
    const x1 = prop.distancesX.min + prop.x;
    const x2 = prop.distancesX.max + prop.x;
    const y1 = prop.distancesY.min + prop.y;
    const y2 = prop.distancesY.max + prop.y;
    const z1 = prop.distancesZ.min + prop.z;
    const z2 = prop.distancesZ.max + prop.z;

    for (let x = x1; x < x2; x += H_BASE) {
      for (let y = y1; y < y2; y += H_BASE) {
        for (let z = z1; z < z2; z += V_BASE) {
          const props = this.isOccupy(x, y, z);
          if (props != null && hit(props)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** OccupyMap.getConflictProps — every prop sharing a cell with another. */
  getConflictProps(): Set<Prop> {
    const result = new Set<Prop>();
    for (const yMap of this.map.values()) {
      for (const zMap of yMap.values()) {
        for (const props of zMap.values()) {
          if (props.length > 1) {
            for (const prop of props) {
              result.add(prop);
            }
          }
        }
      }
    }
    return result;
  }
}

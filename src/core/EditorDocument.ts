// The editable level: props + occupancy + undo, and the bridge to the
// PlayCanvas scene. Corresponds to the original editor's PropsScene /
// MainScene minus the picking and input, which live in the viewport layer.
import type * as pc from 'playcanvas';
import { OccupyMap } from './OccupyMap';
import { EventJournal, MoveDelta, TextureChange } from './EventJournal';
import { Prop } from '../prop/Prop';
import { PropRenderer } from '../render/PropRenderer';
import { exportTanksXml } from '../io/TanksXmlExporter';
import { importTanksXml } from '../io/TanksXmlImporter';
import { exportLvl, importLvl } from '../io/LvlFormat';
import { groupCentre } from './Viewport';

export class EditorDocument {
  readonly props: Prop[] = [];
  readonly occupyMap = new OccupyMap();
  readonly journal = new EventJournal();
  readonly selection = new Set<Prop>();

  /** PropsScene.changed — set by every mutation, cleared on load/save. */
  changed = false;
  /** PropsScene.snapMode, default true. */
  snapMode = true;
  /**
   * SceneContainer.multiplePropMode: 0 unlock, 1 lock group, 2 lock.
   * Default 1 (Lock group), as in the original.
   */
  multiplePropMode = 0 | 1;

  constructor(private readonly renderer: PropRenderer, private readonly root: pc.Entity) {}

  /** PropsScene.addProp */
  async addProp(prop: Prop, addToMap = true): Promise<void> {
    this.props.push(prop);
    await this.renderer.attach(prop, this.root);
    if (this.snapMode && addToMap) {
      this.occupyMap.occupy(prop);
    }
    this.changed = true;
  }

  /** PropsScene.deleteProps */
  deleteProps(props: Iterable<Prop> = this.selection): Set<Prop> {
    const removed = new Set<Prop>();
    for (const prop of props) {
      const index = this.props.indexOf(prop);
      if (index === -1) {
        continue;
      }
      this.props.splice(index, 1);
      this.occupyMap.free(prop);
      this.renderer.detach(prop);
      this.selection.delete(prop);
      removed.add(prop);
    }
    if (removed.size > 0) {
      this.changed = true;
    }
    return removed;
  }

  /** PropsScene.clear */
  clear(): void {
    for (const prop of this.props) {
      this.renderer.detach(prop);
    }
    this.props.length = 0;
    this.selection.clear();
    this.occupyMap.clear();
    this.journal.clear();
    this.changed = false;
  }

  /** Re-seats a prop in the occupancy grid after its coordinates changed. */
  reoccupy(prop: Prop): void {
    this.occupyMap.free(prop);
    this.occupyMap.occupy(prop);
  }

  /** SceneContainer.checkConflict, honouring multiplePropMode. */
  isConflict(prop: Prop): boolean {
    if (this.multiplePropMode === 0) {
      return false;
    }
    return this.multiplePropMode === 1
      ? this.occupyMap.isConflictGroup(prop)
      : this.occupyMap.isConflict(prop);
  }

  /** Pushes a prop's transform to its entity. */
  sync(prop: Prop): void {
    this.renderer.sync(prop);
  }

  syncAll(): void {
    for (const prop of this.props) {
      this.renderer.sync(prop);
    }
  }

  /**
   * MainScene.undo: reverses one journal entry.
   * Unlike the original, ADD/COPY redo operates on the whole set rather than
   * props.peek() (MainScene.as:135), so multi-prop operations round-trip.
   */
  async undo(): Promise<boolean> {
    const item = this.journal.undo();
    if (item == null) {
      return false;
    }
    switch (item.operation) {
      case 'add':
      case 'copy':
        this.deleteProps(item.props);
        break;
      case 'delete':
        for (const prop of item.props) {
          prop.free = true;
          await this.addProp(prop);
        }
        break;
      case 'move':
        this.shift(item.props, item.oldState as MoveDelta, -1);
        break;
      case 'rotate':
        this.spin(item.props, !(item.oldState as boolean));
        break;
      case 'changeTexture':
        this.restoreTextures(item.oldState as TextureChange);
        break;
    }
    this.changed = true;
    return true;
  }

  /** MainScene.redo. */
  async redo(): Promise<boolean> {
    const item = this.journal.redo();
    if (item == null) {
      return false;
    }
    switch (item.operation) {
      case 'add':
      case 'copy':
        for (const prop of item.props) {
          prop.free = true;
          await this.addProp(prop);
        }
        break;
      case 'delete':
        this.deleteProps(item.props);
        break;
      case 'move':
        this.shift(item.props, item.oldState as MoveDelta, 1);
        break;
      case 'rotate':
        this.spin(item.props, item.oldState as boolean);
        break;
      case 'changeTexture':
        this.restoreTextures(item.oldState as TextureChange);
        break;
    }
    this.changed = true;
    return true;
  }

  private shift(props: Set<Prop>, delta: MoveDelta, sign: number): void {
    for (const prop of props) {
      prop.x += delta.x * sign;
      prop.y += delta.y * sign;
      prop.z += delta.z * sign;
      this.reoccupy(prop);
      this.sync(prop);
    }
  }

  private spin(props: Set<Prop>, plus: boolean): void {
    const centre = groupCentre(props);
    for (const prop of props) {
      const x = prop.x;
      const y = prop.y;
      if (plus) {
        prop.x = y + centre.x - centre.y;
        prop.y = -x + centre.y + centre.x;
      } else {
        prop.x = -y + centre.x + centre.y;
        prop.y = x + centre.y - centre.x;
      }
      prop.rotate(plus);
      this.reoccupy(prop);
      this.sync(prop);
    }
  }

  /** Swaps stored and current texture names, so it works for undo and redo. */
  private restoreTextures(change: TextureChange): void {
    for (const [prop, name] of change.previous) {
      const current = prop.textureName;
      prop.textureName = name;
      change.previous.set(prop, current);
      void this.renderer.applyTexture(prop);
    }
  }

  /** File -> Export to Tanks. */
  toXml(): string {
    return exportTanksXml(this.props, {
      collisionSource: (prop) => this.renderer.getCollisionObjects(prop),
    });
  }

  /** File -> Save / Save as...: the editor's native binary format. */
  toLvl(): Uint8Array<ArrayBuffer> {
    return exportLvl(this.props);
  }

  /** File -> Open...: the editor's native binary format. */
  async loadLvl(
    buffer: ArrayBuffer,
    onParsed?: (props: Prop[]) => void,
  ): Promise<{ loaded: number; skipped: number; truncated: boolean }> {
    this.clear();
    const imported = importLvl(buffer, (library, group, name) =>
      this.renderer.resolve(library, group, name));
    for (const prop of imported.props) {
      this.props.push(prop);
    }
    // The prop list is known but nothing is fetched yet — the loading bar
    // takes its byte estimate here, before attachAll starts downloading.
    onParsed?.(imported.props);
    await this.renderer.attachAll(imported.props, this.root);
    for (const prop of imported.props) {
      if (!prop.free) {
        prop.free = true;
        this.occupyMap.occupy(prop);
      }
    }
    this.changed = false;
    return {
      loaded: imported.props.length,
      skipped: imported.skipped,
      truncated: imported.truncated,
    };
  }

  /** File -> Import from Tanks. */
  async loadXml(
    mapXml: Document,
    onParsed?: (props: Prop[]) => void,
  ): Promise<{ loaded: number; skipped: number }> {
    this.clear();
    const imported = importTanksXml(mapXml, {
      resolveTile: (library, group, name) => this.renderer.resolve(library, group, name),
    });
    for (const prop of imported.props) {
      this.props.push(prop);
    }
    onParsed?.(imported.props);
    await this.renderer.attachAll(imported.props, this.root);
    // Fill the occupancy grid once, after everything is in place.
    for (const prop of imported.props) {
      if (!prop.free) {
        prop.free = true;
        this.occupyMap.occupy(prop);
      }
    }
    this.changed = false;
    return { loaded: imported.props.length, skipped: imported.skipped };
  }
}

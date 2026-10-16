// Port of the original editor's EventJournal + EventJournalItem.
//
// Differences from the original, and why:
//   - CHANGE_TEXTURE was declared but never recorded, and MainScene's
//     undo/redo cases for it were empty (MainScene.as:120-121, 155-156), so
//     texture changes were not undoable. Here it is recorded and handled.
//   - ADD's redo used props.peek() (one arbitrary element) while COPY looped,
//     so redoing a multi-prop add was wrong (MainScene.as:135). This port
//     always works on the whole set.
import type { Prop } from '../prop/Prop';

export type JournalOperation =
  | 'add' | 'delete' | 'rotate' | 'move' | 'copy' | 'changeTexture';

export interface MoveDelta {
  x: number;
  y: number;
  z: number;
}

export interface TextureChange {
  /** Previous texture name per prop, keyed by the prop itself. */
  previous: Map<Prop, string>;
}

export interface JournalItem {
  operation: JournalOperation;
  props: Set<Prop>;
  /** MOVE: the delta applied. ROTATE: the direction flag. CHANGE_TEXTURE: old names. */
  oldState?: MoveDelta | boolean | TextureChange;
}

export class EventJournal {
  private events: JournalItem[] = [];
  private cancelEvents: JournalItem[] = [];

  /** EventJournal.addEvent — recording a new event clears the redo stack. */
  addEvent(operation: JournalOperation, props: Set<Prop>, oldState?: JournalItem['oldState']): void {
    this.events.push({ operation, props, oldState });
    this.cancelEvents.length = 0;
  }

  /**
   * EventJournal.undo. `deleteEvent` drops the item instead of pushing it to
   * the redo stack — used by the "location occupied -> No" rollback.
   */
  undo(deleteEvent = false): JournalItem | null {
    const item = this.events.pop();
    if (item == null) {
      return null;
    }
    if (!deleteEvent) {
      this.cancelEvents.push(item);
    }
    return item;
  }

  redo(): JournalItem | null {
    const item = this.cancelEvents.pop();
    if (item == null) {
      return null;
    }
    this.events.push(item);
    return item;
  }

  get canUndo(): boolean {
    return this.events.length > 0;
  }

  get canRedo(): boolean {
    return this.cancelEvents.length > 0;
  }

  clear(): void {
    this.events.length = 0;
    this.cancelEvents.length = 0;
  }
}

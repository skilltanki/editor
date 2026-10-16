// Port of the original editor's SceneContainer (mouse + keyboard handling) and
// the movement half of PropsScene.
//
// Differences from the original, and why:
//   - Two WalkControllers driving two scenes collapse into one EditorCamera.
//   - MouseEvent3D hit-testing becomes explicit raycasts (core/Picking).
//   - F and Q are bound from the same table as every other letter. The
//     original read them off flash.ui.Keyboard while all other letters came
//     from KeyboardUtils, so on AIR 1.5 they silently never fired.
//   - deleteProps returns the removed set even when nothing was selected
//     (PropsScene.as:468-494 returned undefined through an out-of-scope var).
import * as pc from 'playcanvas';
import { Vector3 } from '../engine/math/Vector3';
import { EditorCamera } from './EditorCamera';
import { EditorDocument } from './EditorDocument';
import { moveByArrows, ArrowKey, V_BASE } from './EditorScene';
import { pickProp, projectPoint, projectViewPointToPlane } from './Picking';
import {
  createCameraKeyMapper, KEY_YAW_LEFT, KEY_YAW_RIGHT, KEY_MOVE_LEFT, KEY_MOVE_RIGHT,
  KEY_MOVE_FORWARD, KEY_MOVE_BACK, KEY_PITCH_DOWN, KEY_PITCH_UP,
} from './KeyMapper';
import type { Prop, PropKind } from '../prop/Prop';
import type { PropRenderer } from '../render/PropRenderer';

/** EditorScene's plane normals. */
const Z_NORMAL = new Vector3(0, 0, 1);
const Y_NORMAL = new Vector3(0, 1, 0);
const X_NORMAL = new Vector3(1, 0, 0);

/** SceneContainer: a drag under 3px counts as a click. */
const CLICK_THRESHOLD = 3;

/** SceneContainer.onEnterFrame: containerController.speed = 2000 (units/s). */
const CAMERA_MOVE_SPEED = 2000;
/** Degrees per second for N/M yaw and Numpad 9/3 pitch. */
const CAMERA_TURN_SPEED = 90;

/** The original editor's onTypeSelectingChange options -> allowed prop kinds. */
const SELECTING: Record<string, PropKind[]> = {
  // The original never re-added Flag here, which made flags permanently
  // unselectable once the combo was touched; included deliberately.
  'All': ['tile', 'sprite', 'spawn', 'bonus', 'flag'],
  'Tile': ['tile'],
  'Sprite': ['sprite'],
  'Bonus + Spawn': ['spawn', 'bonus'],
};

export interface ViewportHost {
  canvas: HTMLCanvasElement;
  camera: pc.CameraComponent;
  simRoot: pc.Entity;
  editorCamera: EditorCamera;
  doc: EditorDocument;
  renderer: PropRenderer;
  cursorRoot: pc.Entity;
  onChange(): void;
  onStatus(text: string): void;
}

export class Viewport {
  private allowedKinds = new Set<PropKind>(SELECTING['All']);
  /** The ghost prop that follows the grid (CursorScene._object). */
  cursorProp: Prop | null = null;
  cursorVisible = true;

  private dragging = false;
  private draggingProps = false;
  private copied = false;
  private verticalMoving = false;
  private panning = false;
  private orbiting = false;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  /** Anchor prop for a multi-prop drag (PropsScene.selectedProp). */
  private anchor: Prop | null = null;
  private dragStart = new Vector3();
  private marquee: HTMLElement | null = null;
  /** SceneContainer's held-key bitmask for the per-frame camera loop. */
  private readonly keyMapper = createCameraKeyMapper();

  constructor(private readonly host: ViewportHost) {
    this.attach();
    this.keyMapper.startListening();
  }

  /**
   * SceneContainer.onEnterFrame: feed the held keys to the camera every frame.
   * Call once per update with the frame delta in seconds.
   */
  update(dt: number): void {
    if (!this.keyMapper.anyPressed) {
      return;
    }
    const camera = this.host.editorCamera;
    const turn = CAMERA_TURN_SPEED * dt;
    let yaw = 0;
    let pitch = 0;
    if (this.keyMapper.keyPressed(KEY_YAW_LEFT)) yaw -= turn;
    if (this.keyMapper.keyPressed(KEY_YAW_RIGHT)) yaw += turn;
    if (this.keyMapper.keyPressed(KEY_PITCH_DOWN)) pitch -= turn;
    if (this.keyMapper.keyPressed(KEY_PITCH_UP)) pitch += turn;
    if (yaw !== 0 || pitch !== 0) {
      camera.orbit(yaw, pitch);
    }

    const step = CAMERA_MOVE_SPEED * dt;
    let forward = 0;
    let right = 0;
    if (this.keyMapper.keyPressed(KEY_MOVE_FORWARD)) forward += step;
    if (this.keyMapper.keyPressed(KEY_MOVE_BACK)) forward -= step;
    if (this.keyMapper.keyPressed(KEY_MOVE_RIGHT)) right += step;
    if (this.keyMapper.keyPressed(KEY_MOVE_LEFT)) right -= step;
    if (forward !== 0 || right !== 0) {
      camera.move(forward, right);
    }
  }

  setSelectingFilter(label: string): void {
    this.allowedKinds = new Set(SELECTING[label] ?? SELECTING['All']);
    // Drop anything no longer selectable.
    for (const prop of [...this.host.doc.selection]) {
      if (!this.allowedKinds.has(prop.kind)) {
        this.deselect(prop);
      }
    }
  }

  private allow = (prop: Prop): boolean => this.allowedKinds.has(prop.kind);

  // ---- selection ----

  select(prop: Prop): void {
    if (prop.selected) {
      return;
    }
    prop.selected = true;
    this.host.doc.selection.add(prop);
    this.host.renderer.setTint(prop, 'selected');
  }

  deselect(prop: Prop): void {
    if (!prop.selected) {
      return;
    }
    prop.selected = false;
    this.host.doc.selection.delete(prop);
    this.host.renderer.setTint(prop, 'none');
  }

  deselectAll(): void {
    for (const prop of [...this.host.doc.selection]) {
      this.deselect(prop);
    }
  }

  /** PropsScene.selectConflictProps (Q). */
  selectConflictProps(): void {
    this.deselectAll();
    for (const prop of this.host.doc.occupyMap.getConflictProps()) {
      this.select(prop);
    }
    this.host.onStatus(`${this.host.doc.selection.size} conflicting props`);
  }

  // ---- cursor prop ----

  async setCursorProp(prop: Prop | null): Promise<void> {
    if (this.cursorProp?.entity != null) {
      this.cursorProp.entity.remove();
    }
    this.cursorProp = prop;
    if (prop == null) {
      return;
    }
    await this.host.renderer.attach(prop, this.host.cursorRoot);
    if (this.host.doc.snapMode) {
      prop.snapCoords();
    }
    this.updateCursorMaterial();
    this.host.renderer.sync(prop);
  }

  /** Drops the ghost prop (Esc with no selection). */
  async clearCursorProp(): Promise<void> {
    if (this.cursorProp == null) {
      return;
    }
    await this.setCursorProp(null);
    this.hideCursor();
    this.host.onStatus('Cursor cleared — pick a prop to place');
  }

  /** CursorScene.updateMaterial: green when the cell is free, red when taken. */
  updateCursorMaterial(): void {
    const prop = this.cursorProp;
    if (prop == null) {
      return;
    }
    if (!this.host.doc.snapMode) {
      this.host.renderer.setTint(prop, 'none');
      return;
    }
    this.host.renderer.setTint(prop, this.host.doc.isConflict(prop) ? 'blocked' : 'free');
  }

  /** CursorScene.moveCursorByMouse. */
  private moveCursorTo(x: number, y: number): void {
    const prop = this.cursorProp;
    if (prop == null) {
      return;
    }
    const point = projectViewPointToPlane(
      this.host.camera, this.host.simRoot, x, y, Z_NORMAL, prop.z,
    );
    if (point == null) {
      return;
    }
    prop.x = point.x;
    prop.y = point.y;
    if (this.host.doc.snapMode) {
      prop.snapCoords();
    }
    this.host.renderer.sync(prop);
    this.updateCursorMaterial();
  }

  /** SceneContainer.addProp (SPACE). */
  async pasteCursorProp(): Promise<void> {
    const cursor = this.cursorProp;
    if (cursor == null) {
      this.host.onStatus('Select prop for pasting!');
      return;
    }
    const copy = cursor.clone();
    copy.free = true;
    await this.host.doc.addProp(copy);
    // The clone inherits the cursor's green/red tint; a placed prop renders
    // normally until it is selected.
    this.host.renderer.setTint(copy, 'none');
    this.host.doc.journal.addEvent('add', new Set([copy]));
    this.updateCursorMaterial();
    this.host.onChange();
  }

  // ---- input wiring ----

  private attach(): void {
    const canvas = this.host.canvas;
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    canvas.tabIndex = 0;
  }

  private local(event: MouseEvent): { x: number; y: number } {
    const rect = this.host.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onMouseDown = (event: MouseEvent): void => {
    const { x, y } = this.local(event);
    this.downX = x; this.downY = y;
    this.lastX = event.clientX; this.lastY = event.clientY;
    this.host.canvas.focus();

    if (event.button === 1) {
      // Middle = pan, Alt+middle = orbit (SceneContainer.onMiddleMouseDown).
      event.preventDefault();
      if (event.altKey) {
        this.orbiting = true;
      } else {
        this.panning = true;
      }
      return;
    }
    if (event.button !== 0) {
      return;
    }

    // Ctrl suppresses hit testing entirely (PropsScene.onPropMouseDown).
    const hit = event.ctrlKey
      ? null
      : pickProp(this.host.camera, this.host.simRoot, x, y, this.host.doc.props, this.allow);

    this.dragging = true;
    if (hit != null) {
      if (event.shiftKey && event.altKey) {
        this.deselect(hit);
      } else if (event.shiftKey) {
        this.select(hit);
      } else if (!hit.selected) {
        this.deselectAll();
        this.select(hit);
      }
      if (hit.selected) {
        this.anchor = hit;
        this.draggingProps = true;
        this.copied = false;
        this.dragStart.x = hit.x; this.dragStart.y = hit.y; this.dragStart.z = hit.z;
      }
      // SceneContainer.as:126 — the ghost gets out of the way while a real
      // prop is selected.
      this.hideCursor();
    }
  };

  private onMouseMove = (event: MouseEvent): void => {
    const dxScreen = event.clientX - this.lastX;
    const dyScreen = event.clientY - this.lastY;

    if (this.panning) {
      // SceneContainer: translate along the camera's own screen axes.
      const scale = this.host.editorCamera.distance / 600;
      this.host.editorCamera.pan(-dxScreen * scale, dyScreen * scale);
      this.lastX = event.clientX; this.lastY = event.clientY;
      return;
    }
    if (this.orbiting) {
      this.host.editorCamera.orbit(dxScreen * 0.4, -dyScreen * 0.4);
      this.lastX = event.clientX; this.lastY = event.clientY;
      return;
    }
    this.lastX = event.clientX; this.lastY = event.clientY;

    const { x, y } = this.local(event);

    if (this.draggingProps) {
      if (event.shiftKey && !this.copied) {
        void this.copySelection();
      }
      this.moveSelectedProps(x, y);
      return;
    }
    if (this.dragging) {
      if (Math.abs(x - this.downX) > CLICK_THRESHOLD && Math.abs(y - this.downY) > CLICK_THRESHOLD) {
        this.updateMarquee(x, y, event.shiftKey, event.altKey);
      }
      return;
    }
    if (this.cursorVisible && this.cursorProp != null) {
      this.moveCursorTo(x, y);
    }
  };

  private onMouseUp = (event: MouseEvent): void => {
    if (this.panning || this.orbiting) {
      this.panning = false;
      this.orbiting = false;
      return;
    }
    const { x, y } = this.local(event);
    const isClick =
      Math.abs(x - this.downX) < CLICK_THRESHOLD && Math.abs(y - this.downY) < CLICK_THRESHOLD;

    if (this.draggingProps && this.anchor != null) {
      const delta = {
        x: this.anchor.x - this.dragStart.x,
        y: this.anchor.y - this.dragStart.y,
        z: this.anchor.z - this.dragStart.z,
      };
      if (delta.x !== 0 || delta.y !== 0 || delta.z !== 0) {
        this.host.doc.journal.addEvent(
          this.copied ? 'copy' : 'move', new Set(this.host.doc.selection), delta,
        );
        this.host.onChange();
      }
      this.checkConflict();
    } else if (isClick) {
      const hit = event.ctrlKey
        ? null
        : pickProp(this.host.camera, this.host.simRoot, x, y, this.host.doc.props, this.allow);
      if (hit == null) {
        // Click on empty space: drop the selection and move the paste cursor.
        this.deselectAll();
        this.showCursor();
        this.moveCursorTo(x, y);
      } else if (this.cursorProp != null) {
        this.cursorProp.z = hit.z;
      }
    }

    this.removeMarquee();
    this.dragging = false;
    this.draggingProps = false;
    this.anchor = null;
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.host.editorCamera.dolly(event.deltaY > 0 ? 1.1 : 1 / 1.1);
  };

  // ---- dragging props ----

  /** PropsScene.moveSelectedProps. */
  private moveSelectedProps(screenX: number, screenY: number): void {
    const anchor = this.anchor;
    if (anchor == null) {
      return;
    }
    let point: Vector3 | null;
    let deltaX = 0; let deltaY = 0; let deltaZ = 0;

    if (this.verticalMoving) {
      const sector = this.host.editorCamera.getCameraSector();
      if (sector === 2 || sector === 4) {
        point = projectViewPointToPlane(
          this.host.camera, this.host.simRoot, screenX, screenY, Y_NORMAL, anchor.y,
        );
        if (point == null) return;
        deltaX = point.x - anchor.x;
        anchor.x = point.x;
      } else {
        point = projectViewPointToPlane(
          this.host.camera, this.host.simRoot, screenX, screenY, X_NORMAL, anchor.x,
        );
        if (point == null) return;
        deltaY = point.y - anchor.y;
        anchor.y = point.y;
      }
      deltaZ = point.z - anchor.z;
      anchor.z = point.z;
    } else {
      point = projectViewPointToPlane(
        this.host.camera, this.host.simRoot, screenX, screenY, Z_NORMAL, anchor.z,
      );
      if (point == null) return;
      deltaX = point.x - anchor.x;
      deltaY = point.y - anchor.y;
      anchor.x = point.x;
      anchor.y = point.y;
    }

    const doc = this.host.doc;
    for (const prop of doc.selection) {
      if (prop !== anchor) {
        prop.x += deltaX;
        prop.y += deltaY;
        prop.z += deltaZ;
      }
      // Non-sprite tiles always snap, regardless of snap mode.
      if (doc.snapMode || prop.kind === 'tile') {
        prop.snapCoords();
      }
      doc.reoccupy(prop);
      doc.sync(prop);
    }
    doc.changed = true;
  }

  /** Shift+drag duplicates the selection before moving it. */
  private async copySelection(): Promise<void> {
    const doc = this.host.doc;
    const originals = [...doc.selection];
    this.copied = true;
    this.deselectAll();
    const copies: Prop[] = [];
    for (const original of originals) {
      const copy = original.clone();
      copy.free = true;
      await doc.addProp(copy);
      copies.push(copy);
    }
    for (const copy of copies) {
      this.select(copy);
    }
    if (this.anchor != null) {
      const index = originals.indexOf(this.anchor);
      this.anchor = copies[index >= 0 ? index : 0] ?? null;
      if (this.anchor != null) {
        this.dragStart.x = this.anchor.x;
        this.dragStart.y = this.anchor.y;
        this.dragStart.z = this.anchor.z;
      }
    }
  }

  /** SceneContainer.checkConflict. */
  private checkConflict(): void {
    if (!this.host.doc.snapMode) {
      return;
    }
    for (const prop of this.host.doc.selection) {
      if (this.host.doc.isConflict(prop)) {
        this.host.onStatus('This location is occupied.');
        return;
      }
    }
  }

  // ---- rubber band ----

  private updateMarquee(x: number, y: number, add: boolean, subtract: boolean): void {
    if (this.marquee == null) {
      this.marquee = document.createElement('div');
      Object.assign(this.marquee.style, {
        position: 'absolute', border: '1px solid #000', pointerEvents: 'none',
        background: 'rgba(255,255,255,0.12)', zIndex: '5',
      });
      this.host.canvas.parentElement?.appendChild(this.marquee);
    }
    const left = Math.min(this.downX, x);
    const top = Math.min(this.downY, y);
    const width = Math.abs(x - this.downX);
    const height = Math.abs(y - this.downY);
    Object.assign(this.marquee.style, {
      left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
    });

    // PropsScene.getPropsUnderRect: centre-point test in screen space.
    if (!add && !subtract) {
      this.deselectAll();
    }
    const centre = new Vector3();
    for (const prop of this.host.doc.props) {
      if (prop.hidden || !this.allow(prop)) {
        continue;
      }
      centre.x = prop.x; centre.y = prop.y; centre.z = prop.z;
      const screen = projectPoint(this.host.camera, this.host.simRoot, centre);
      if (screen == null) {
        continue;
      }
      const inside =
        screen.x >= left && screen.x <= left + width &&
        screen.y >= top && screen.y <= top + height;
      if (!inside) {
        continue;
      }
      if (subtract) {
        this.deselect(prop);
      } else {
        this.select(prop);
      }
    }
  }

  private removeMarquee(): void {
    this.marquee?.remove();
    this.marquee = null;
  }

  // ---- keyboard ----

  private showCursor(): void {
    this.cursorVisible = true;
    this.host.cursorRoot.enabled = this.cursorProp != null;
  }

  private hideCursor(): void {
    this.cursorVisible = false;
    this.host.cursorRoot.enabled = false;
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'KeyV') {
      this.verticalMoving = false;
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
      return;
    }
    const doc = this.host.doc;
    const selection = doc.selection;
    const sector = this.host.editorCamera.getCameraSector();
    let handled = true;

    switch (event.code) {
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
        const key = (
          { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const
        )[event.code] as ArrowKey;
        if (this.cursorVisible && this.cursorProp != null) {
          moveByArrows(this.cursorProp, key, sector);
          this.host.renderer.sync(this.cursorProp);
          this.updateCursorMaterial();
        } else if (selection.size > 0) {
          const before = this.anchorOf(selection);
          for (const prop of selection) {
            moveByArrows(prop, key, sector);
            doc.reoccupy(prop);
            doc.sync(prop);
          }
          const after = this.anchorOf(selection);
          doc.journal.addEvent('move', new Set(selection), {
            x: after.x - before.x, y: after.y - before.y, z: 0,
          });
          doc.changed = true;
          this.host.onChange();
        }
        break;
      }
      case 'KeyV':
        this.verticalMoving = true;
        break;
      case 'KeyW':
      case 'KeyS': {
        if (event.ctrlKey || event.metaKey) { handled = false; break; }
        const step = event.code === 'KeyW' ? V_BASE : -V_BASE;
        if (this.cursorVisible && this.cursorProp != null) {
          this.cursorProp.z += step;
          this.host.renderer.sync(this.cursorProp);
          this.updateCursorMaterial();
        } else if (selection.size > 0) {
          for (const prop of selection) {
            prop.z += step;
            doc.reoccupy(prop);
            doc.sync(prop);
          }
          doc.journal.addEvent('move', new Set(selection), { x: 0, y: 0, z: step });
          doc.changed = true;
          this.host.onChange();
        }
        break;
      }
      case 'Delete':
      case 'KeyC': {
        if (event.ctrlKey || event.metaKey) { handled = false; break; }
        if (selection.size === 0) { break; }
        const first = selection.values().next().value as Prop;
        if (this.cursorProp != null) {
          this.cursorProp.x = first.x;
          this.cursorProp.y = first.y;
          this.cursorProp.z = first.z;
          if (doc.snapMode) {
            this.cursorProp.snapCoords();
          }
          this.host.renderer.sync(this.cursorProp);
        }
        const removed = doc.deleteProps();
        doc.journal.addEvent('delete', removed);
        this.showCursor();
        this.updateCursorMaterial();
        this.host.onChange();
        break;
      }
      case 'KeyZ': {
        if (event.ctrlKey || event.metaKey) { handled = false; break; }
        this.rotate(true);
        break;
      }
      case 'KeyX': {
        if (event.ctrlKey || event.metaKey) { handled = false; break; }
        this.rotate(false);
        break;
      }
      case 'Escape':
        if (selection.size > 0) {
          // With a selection, Esc drops it and parks the ghost on the first
          // selected prop, as the original did.
          const first = selection.values().next().value as Prop;
          if (this.cursorProp != null) {
            this.cursorProp.x = first.x;
            this.cursorProp.y = first.y;
            this.cursorProp.z = first.z;
            if (doc.snapMode) {
              this.cursorProp.snapCoords();
            }
            this.host.renderer.sync(this.cursorProp);
          }
          this.deselectAll();
          this.showCursor();
          this.updateCursorMaterial();
        } else {
          // Nothing selected: put the ghost down. The original had no way to
          // do this at all — the prop stayed stuck to the pointer until another
          // one was picked — which leaves the editor feeling jammed.
          void this.clearCursorProp();
        }
        break;
      case 'Space':
        void this.pasteCursorProp();
        break;
      case 'KeyQ':
        this.selectConflictProps();
        break;
      case 'KeyF':
        this.mirrorTextures();
        break;
      case 'NumpadAdd':
        this.host.editorCamera.dolly(1 / 1.2);
        break;
      case 'NumpadSubtract':
        this.host.editorCamera.dolly(1.2);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
  };

  /** Group centre, used to measure arrow-key deltas for the journal. */
  private anchorOf(props: Set<Prop>): { x: number; y: number } {
    for (const prop of props) {
      return { x: prop.x, y: prop.y };
    }
    return { x: 0, y: 0 };
  }

  /** PropsScene.rotateProps: rotate the group about its computed centre. */
  private rotate(plus: boolean): void {
    const doc = this.host.doc;
    if (this.cursorVisible && this.cursorProp != null) {
      this.cursorProp.rotate(plus);
      this.host.renderer.sync(this.cursorProp);
      this.updateCursorMaterial();
      return;
    }
    if (doc.selection.size === 0) {
      return;
    }
    const centre = groupCentre(doc.selection);
    for (const prop of doc.selection) {
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
      doc.reoccupy(prop);
      doc.sync(prop);
    }
    doc.journal.addEvent('rotate', new Set(doc.selection), plus);
    doc.changed = true;
    this.host.onChange();
  }

  /** PropsScene.mirrorTextures (F). */
  private mirrorTextures(): void {
    let count = 0;
    for (const prop of this.host.doc.selection) {
      if (prop.kind === 'tile') {
        prop.isMirror = !prop.isMirror;
        count++;
      }
    }
    if (count > 0) {
      this.host.doc.changed = true;
      this.host.onStatus(`Mirrored ${count} prop(s)`);
      this.host.onChange();
    }
  }
}

/** EditorScene.getCentrePropsGroup. */
export function groupCentre(props: Set<Prop>): { x: number; y: number } {
  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let averageX = 0; let averageY = 0;
  const H_BASE2 = 500;

  for (const prop of props) {
    const left = prop.distancesX.min + prop.x;
    const right = prop.distancesX.max + prop.x;
    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    const bottom = prop.distancesY.min + prop.y;
    const top = prop.distancesY.max + prop.y;
    if (bottom < minY) minY = bottom;
    if (top > maxY) maxY = top;
    averageX += prop.x;
    averageY += prop.y;
  }

  const modX = ((maxX - minX) / H_BASE2) % 2;
  if (modX !== ((maxY - minY) / H_BASE2) % 2) {
    if (modX !== 0) {
      averageX /= props.size;
      if (Math.abs(averageX - maxX) < Math.abs(averageX - minX)) {
        maxX += H_BASE2;
      } else {
        minX -= H_BASE2;
      }
    } else {
      averageY /= props.size;
      if (Math.abs(averageY - maxY) < Math.abs(averageY - minY)) {
        maxY += H_BASE2;
      } else {
        minY -= H_BASE2;
      }
    }
  }
  return { x: (maxX + minX) / 2, y: (maxY + minY) / 2 };
}

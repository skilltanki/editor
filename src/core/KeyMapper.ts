// Port of the original editor's KeyMapper.
//
// A bitmask of held keys, so the per-frame camera loop can ask "is N down?"
// instead of tracking keydown/keyup itself. Max 31 keys, one bit each.
//
// Differences from the original, and why:
//   - AS3 keyCodes become KeyboardEvent.code strings; `code` is layout
//     independent, so N/M keep working on a non-QWERTY layout.
//   - startListening/stopListening take no dispatcher: the browser has one
//     global key stream.

const MAX_KEYS = 31;

export class KeyMapper {
  private keys = 0;
  private map: (string | null)[] = new Array(MAX_KEYS).fill(null);
  private listening = false;

  private checkKey(keyNum: number): void {
    if (keyNum < 0 || keyNum > MAX_KEYS - 1) {
      throw new RangeError('keyNum is out of range');
    }
  }

  /** KeyMapper.mapKey(keyNum, keyCode). */
  mapKey(keyNum: number, code: string): void {
    this.checkKey(keyNum);
    this.map[keyNum] = code;
  }

  /** KeyMapper.unmapKey. */
  unmapKey(keyNum: number): void {
    this.checkKey(keyNum);
    this.map[keyNum] = null;
    this.keys &= ~(1 << keyNum);
  }

  /** KeyMapper.checkEvent: set the bit on keydown, clear it on keyup. */
  checkEvent(event: KeyboardEvent, down: boolean): boolean {
    const index = this.map.indexOf(event.code);
    if (index < 0) {
      return false;
    }
    if (down) {
      this.keys |= 1 << index;
    } else {
      this.keys &= ~(1 << index);
    }
    return true;
  }

  /** KeyMapper.getKeyState. */
  getKeyState(keyNum: number): number {
    return (this.keys >> keyNum) & 1;
  }

  /** KeyMapper.keyPressed. */
  keyPressed(keyNum: number): boolean {
    return this.getKeyState(keyNum) === 1;
  }

  get anyPressed(): boolean {
    return this.keys !== 0;
  }

  startListening(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // A browser tab can lose focus mid-press and never deliver the keyup.
    window.addEventListener('blur', this.onBlur);
  }

  stopListening(): void {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.keys = 0;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
      return;
    }
    // A modified press belongs to a menu accelerator (Ctrl+N is "New", not
    // "yaw left"). Ignoring it on the way down also avoids a stuck bit: the
    // matching keyup may never arrive once the menu action runs.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (this.checkEvent(event, true)) {
      event.preventDefault();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.checkEvent(event, false);
  };

  private onBlur = (): void => {
    this.keys = 0;
  };
}

/**
 * SceneContainer.onAddedToStage key slots, in the original's numbering.
 * Slots 0..7 drive the per-frame camera loop in Viewport.
 */
export const KEY_YAW_LEFT = 0;      // KeyboardUtils.N
export const KEY_YAW_RIGHT = 1;     // KeyboardUtils.M
export const KEY_MOVE_LEFT = 2;     // Keyboard.NUMPAD_4
export const KEY_MOVE_RIGHT = 3;    // Keyboard.NUMPAD_6
export const KEY_MOVE_FORWARD = 4;  // Keyboard.NUMPAD_8
export const KEY_MOVE_BACK = 5;     // Keyboard.NUMPAD_2
export const KEY_PITCH_DOWN = 6;    // Keyboard.NUMPAD_9
export const KEY_PITCH_UP = 7;      // Keyboard.NUMPAD_3

/** The mapping SceneContainer installs (SceneContainer.as:62-69). */
export function createCameraKeyMapper(): KeyMapper {
  const mapper = new KeyMapper();
  mapper.mapKey(KEY_YAW_LEFT, 'KeyN');
  mapper.mapKey(KEY_YAW_RIGHT, 'KeyM');
  mapper.mapKey(KEY_MOVE_LEFT, 'Numpad4');
  mapper.mapKey(KEY_MOVE_RIGHT, 'Numpad6');
  mapper.mapKey(KEY_MOVE_FORWARD, 'Numpad8');
  mapper.mapKey(KEY_MOVE_BACK, 'Numpad2');
  mapper.mapKey(KEY_PITCH_DOWN, 'Numpad9');
  mapper.mapKey(KEY_PITCH_UP, 'Numpad3');
  return mapper;
}

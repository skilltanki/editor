// Menu / toolbar model, transcribed from the original editor's main window (mxml).
// Labels are kept verbatim because the original dispatches on the label string
// (menuHandler), and the port keeps that contract.

export interface MenuItem {
  label: string;
  shortcut?: string;
  separator?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

/** The original editor's <mx:XML id="menuData">. */
export const MENU: Menu[] = [
  {
    label: 'File',
    items: [
      { label: 'New', shortcut: 'Ctrl+N' },
      { label: 'Open...', shortcut: 'Ctrl+O' },
      { label: 'Save', shortcut: 'Ctrl+S' },
      { label: 'Save as...', shortcut: 'Ctrl+Alt+S' },
      { label: '', separator: true },
      { label: 'Export to Tanks', shortcut: 'Ctrl+T' },
      { label: 'Import from Tanks', shortcut: 'Ctrl+I' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', shortcut: 'Ctrl+Z' },
      { label: 'Redo', shortcut: 'Ctrl+Y' },
      { label: 'Clear', shortcut: 'Ctrl+Alt+C' },
    ],
  },
  {
    label: 'Library',
    items: [
      { label: 'Clear and load...', shortcut: 'Ctrl+Alt+L' },
      { label: 'Load...', shortcut: 'Ctrl+L' },
    ],
  },
  {
    label: 'Option',
    items: [
      { label: 'Unlock' },
      { label: 'Lock group' },
      { label: 'Lock' },
      { label: '', separator: true },
      { label: 'Normal' },
      { label: 'Collision boxes' },
      { label: '', separator: true },
      { label: 'Snap' },
      { label: 'Show grid' },
    ],
  },
  { label: 'Help', items: [{ label: 'Help' }] },
];

export type ToolbarId =
  | 'snap' | 'view' | 'grid' | 'textures' | 'hideSelected' | 'showAll';

export interface ToolbarEntry {
  id: ToolbarId;
  tooltip: string;
  glyph: string;
  toggle: boolean;
  initial?: boolean;
}

/**
 * The six 24x24 buttons from the mx:ControlBar, in the original order.
 * Icons were embedded PNGs (editor_snap_icon.png etc.); glyphs stand in for
 * them so the toolbar needs no binary assets.
 */
export const TOOLBAR: ToolbarEntry[] = [
  { id: 'snap', tooltip: 'snap mode', glyph: '⊓', toggle: true, initial: true },
  { id: 'view', tooltip: 'view mode', glyph: '◳', toggle: true, initial: false },
  { id: 'grid', tooltip: 'hide grid', glyph: '▦', toggle: true, initial: true },
  { id: 'textures', tooltip: 'show property panel', glyph: '◉', toggle: true, initial: false },
  { id: 'hideSelected', tooltip: 'hide selected props', glyph: '◌', toggle: false },
  { id: 'showAll', tooltip: 'show all', glyph: '👁', toggle: false },
];

/** The original editor's onTypeSelectingChange combo items. */
export const SELECTING_PROP_OPTIONS = ['All', 'Tile', 'Sprite', 'Bonus + Spawn'] as const;

/** The in-app shortcut list shown by Help (the original editor's main window, lines 651-661). */
export const HELP_TEXT = [
  'Esc - deselect prop, or drop the prop stuck to the cursor',
  'Delete, C - delete selected prop',
  'X, Z - rotate selected prop or cursor',
  'drag, arrows - moving selected prop or cursor',
  'Shift + drag - copy and moving selected prop',
  'V + drag, W, S - vertical moving',
  'Space - paste prop',
  'Middle - panning',
  'F - mirror texture',
  'Q - select conflict props',
  'Alt + middle - rotate camera',
  // Not in the original's Help list, but SceneContainer bound them
  // (KeyMapper slots 0..7) and the port drives them the same way.
  'N, M - rotate camera',
  'Numpad 8/2/4/6 - move camera',
  'Numpad 9/3 - tilt camera',
  'Numpad +/- - zoom',
].join('\n');

/**
 * Matches a keydown against a menu item's declared shortcut, so the
 * accelerators and the labels can never drift apart. Shortcut strings use the
 * original's spelling ("Ctrl+Alt+S"); Meta stands in for Ctrl on macOS.
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split('+').map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const wantCtrl = parts.includes('ctrl');
  const wantAlt = parts.includes('alt');
  const wantShift = parts.includes('shift');
  if (wantCtrl !== (event.ctrlKey || event.metaKey)) return false;
  if (wantAlt !== event.altKey) return false;
  if (wantShift !== event.shiftKey) return false;
  // Compare on `code` so the binding survives a non-Latin keyboard layout.
  return event.code === `Key${key.toUpperCase()}`;
}

/** Every (label, shortcut) pair in the menu, flattened. */
export function menuShortcuts(): { label: string; shortcut: string }[] {
  const out: { label: string; shortcut: string }[] = [];
  for (const menu of MENU) {
    for (const item of menu.items) {
      if (item.shortcut != null && item.separator !== true) {
        out.push({ label: item.label, shortcut: item.shortcut });
      }
    }
  }
  return out;
}

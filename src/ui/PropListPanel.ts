// Port of PropListPanel.mxml (the Props accordion) and TexturePanel.as.
//
// Differences from the original, and why:
//   - mx:Accordion + TileList + ImageItemRenderer become DOM: a collapsible
//     section per prop-group, each holding a grid of name cells.
//   - The original rendered a 50x50 3D icon per prop up front
//     (Preview.getPropIcon, a synchronous BitmapData.draw per prop). That
//     cost is skipped: cells are labelled, and the Preview pane shows the
//     selected prop instead.
//   - TexturePanel's `private static var dp:Array` was static and therefore
//     shared across instances; here each panel owns its items.
import type { PropLibrary } from '../engine/map/PropLibrary';

export interface PropPick {
  group: string;
  name: string;
}

const CELL_BG = '#e8e6e0';
const CELL_SELECTED = '#b6cce8';

function sectionHeader(text: string): HTMLElement {
  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '3px 6px', background: 'linear-gradient(#e8e6e0, #cfcbc2)',
    borderTop: '1px solid #8a8a8a', borderBottom: '1px solid #8a8a8a',
    font: 'bold 11px "Segoe UI", Tahoma, sans-serif', cursor: 'pointer',
  });
  header.textContent = text;
  return header;
}

/**
 * Fills `host` with one collapsible section per prop-group.
 * `onPick` fires on click (PropListEvent.SELECT -> cursorScene.object).
 */
export function buildPropList(
  host: HTMLElement,
  library: PropLibrary | null,
  onPick: (pick: PropPick) => void,
  loadIcon?: (pick: PropPick) => Promise<string | null>,
): void {
  host.textContent = '';
  if (library == null) {
    return;
  }

  // Document order, so the accordion matches library.xml.
  const groups = new Map<string, string[]>();
  for (const { group, name } of library.entries()) {
    const list = groups.get(group);
    if (list == null) {
      groups.set(group, [name]);
    } else {
      list.push(name);
    }
  }

  let selectedCell: HTMLElement | null = null;
  let first = true;
  const pending: { icon: HTMLElement; pick: PropPick }[] = [];

  for (const [group, names] of groups) {
    const header = sectionHeader(group);
    const body = document.createElement('div');
    Object.assign(body.style, {
      display: first ? 'flex' : 'none', flexWrap: 'wrap', gap: '2px', padding: '3px',
    });
    first = false;
    header.addEventListener('click', () => {
      body.style.display = body.style.display === 'none' ? 'flex' : 'none';
    });

    for (const name of names) {
      const cell = document.createElement('div');
      Object.assign(cell.style, {
        width: '86px', padding: '3px 4px', background: CELL_BG,
        border: '1px solid #b5b1a8', cursor: 'pointer', fontSize: '10px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
      });
      // ImageItemRenderer: a 50x50 icon above the label.
      const icon = document.createElement('div');
      Object.assign(icon.style, {
        width: '48px', height: '48px', flex: '0 0 48px',
        background: '#fff center/contain no-repeat', border: '1px solid #d8d4cc',
      });
      cell.appendChild(icon);
      const label = document.createElement('div');
      Object.assign(label.style, {
        width: '100%', textAlign: 'center', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      label.textContent = name;
      cell.appendChild(label);
      cell.title = `${group} / ${name}`;
      if (loadIcon != null) {
        pending.push({ icon, pick: { group, name } });
      }
      cell.addEventListener('click', () => {
        if (selectedCell != null) {
          selectedCell.style.background = CELL_BG;
        }
        selectedCell = cell;
        cell.style.background = CELL_SELECTED;
        onPick({ group, name });
      });
      body.appendChild(cell);
    }

    host.appendChild(header);
    host.appendChild(body);
  }

  // Icons render one at a time, only while this listing is still on screen —
  // the original built every icon up front, which stalled library loading.
  if (loadIcon != null && pending.length > 0) {
    void (async () => {
      for (const { icon, pick } of pending) {
        if (!host.isConnected) {
          return;
        }
        const url = await loadIcon(pick);
        if (url != null) {
          icon.style.backgroundImage = `url("${url}")`;
        }
      }
    })();
  }
}

/** TexturePanel: the <texture> variants of the selected tile. */
export function buildTexturePanel(
  host: HTMLElement,
  names: string[],
  current: string,
  onPick: (name: string) => void,
): void {
  host.textContent = '';
  if (names.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = '#666';
    empty.textContent = 'No texture variants for this prop.';
    host.appendChild(empty);
    return;
  }
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '3px' });
  for (const name of names) {
    const cell = document.createElement('div');
    Object.assign(cell.style, {
      padding: '4px 8px', border: '1px solid #b5b1a8', cursor: 'pointer',
      background: name === current ? CELL_SELECTED : CELL_BG, fontSize: '10px',
    });
    cell.textContent = name;
    cell.addEventListener('click', () => onPick(name));
    row.appendChild(cell);
  }
  host.appendChild(row);
}

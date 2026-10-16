// Port of the original editor's main window layout (the mxml application).
//
// Differences from the original, and why:
//   - Flex (mx:WindowedApplication / Panel / HDividedBox / Accordion) is
//     replaced by plain DOM + flexbox, matching how packages/game builds its
//     Hud/Menu. The structure, titles, tooltips and control order are kept.
//   - The AIR FlexNativeMenu becomes an in-page menubar: a browser tab has no
//     native menu. Shortcuts keep their original key equivalents.
import { MENU, ToolbarId, TOOLBAR, SELECTING_PROP_OPTIONS } from './menuModel';

export interface Chrome {
  canvas: HTMLCanvasElement;
  /** Right-hand column: Preview pane. */
  preview: HTMLElement;
  /** Right-hand column: terrain/library chooser. */
  libraryCombo: HTMLSelectElement;
  /** Right-hand column: the Props accordion host. */
  propList: HTMLElement;
  /** Optional panel below the viewport (textures / bonus types). */
  propertyPanel: HTMLElement;
  setStatus(text: string): void;
  setMenuHandler(handler: (label: string) => void): void;
  setToolbarHandler(handler: (id: ToolbarId, active: boolean) => void): void;
  setSelectingPropHandler(handler: (value: string) => void): void;
  setToggle(id: ToolbarId, active: boolean): void;
  showPropertyPanel(visible: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

const PANEL_BG = '#d4d0c8';
const PANEL_BORDER = '1px solid #8a8a8a';
const TITLE_BG = 'linear-gradient(#e8e6e0, #cfcbc2)';

function panelTitle(text: string): HTMLElement {
  return el('div', {
    padding: '3px 6px',
    font: 'bold 11px "Segoe UI", Tahoma, sans-serif',
    background: TITLE_BG,
    borderBottom: PANEL_BORDER,
    flex: '0 0 auto',
  }, text);
}

export function buildChrome(host: HTMLElement): Chrome {
  let menuHandler: (label: string) => void = () => {};
  let toolbarHandler: (id: ToolbarId, active: boolean) => void = () => {};
  let selectingPropHandler: (value: string) => void = () => {};

  Object.assign(host.style, {
    display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
    background: PANEL_BG,
  });

  // ---- menubar (the original editor's menuData) ----
  const menubar = el('div', {
    display: 'flex', flex: '0 0 auto', background: PANEL_BG,
    borderBottom: PANEL_BORDER, position: 'relative', zIndex: '20',
  });

  let openMenu: HTMLElement | null = null;
  const closeMenu = (): void => {
    if (openMenu != null) {
      openMenu.style.display = 'none';
      openMenu = null;
    }
  };
  document.addEventListener('click', closeMenu);

  for (const menu of MENU) {
    const wrapper = el('div', { position: 'relative' });
    const button = el('div', {
      padding: '3px 9px', cursor: 'default', font: '11px "Segoe UI", Tahoma, sans-serif',
    }, menu.label);
    const dropdown = el('div', {
      display: 'none', position: 'absolute', top: '100%', left: '0',
      minWidth: '190px', background: PANEL_BG, border: PANEL_BORDER,
      boxShadow: '2px 2px 5px rgba(0,0,0,0.35)', zIndex: '30',
    });

    for (const item of menu.items) {
      if (item.separator === true) {
        dropdown.appendChild(el('div', {
          height: '0', margin: '3px 2px', borderTop: '1px solid #9a9a9a',
        }));
        continue;
      }
      const row = el('div', {
        display: 'flex', justifyContent: 'space-between', gap: '24px',
        padding: '3px 10px', cursor: 'default',
      });
      row.appendChild(el('span', {}, item.label));
      if (item.shortcut != null) {
        row.appendChild(el('span', { color: '#555' }, item.shortcut));
      }
      row.addEventListener('mouseenter', () => { row.style.background = '#b6cce8'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMenu();
        menuHandler(item.label);
      });
      dropdown.appendChild(row);
    }

    button.addEventListener('mouseenter', () => { button.style.background = '#b6cce8'; });
    button.addEventListener('mouseleave', () => { button.style.background = ''; });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = openMenu === dropdown;
      closeMenu();
      if (!wasOpen) {
        dropdown.style.display = 'block';
        openMenu = dropdown;
      }
    });

    wrapper.appendChild(button);
    wrapper.appendChild(dropdown);
    menubar.appendChild(wrapper);
  }
  host.appendChild(menubar);

  // ---- toolbar (mx:ControlBar, height 26) ----
  const toolbar = el('div', {
    display: 'flex', alignItems: 'center', gap: '3px', height: '26px',
    flex: '0 0 auto', padding: '0 4px', background: PANEL_BG,
    borderBottom: PANEL_BORDER,
  });

  const toggles = new Map<ToolbarId, HTMLElement>();
  const paintToggle = (button: HTMLElement, active: boolean): void => {
    button.style.background = active ? '#f0c060' : '#e4e0d8';
    button.style.borderStyle = active ? 'inset' : 'outset';
  };

  for (const entry of TOOLBAR) {
    const button = el('div', {
      width: '24px', height: '24px', display: 'flex', alignItems: 'center',
      justifyContent: 'center', border: '2px outset #e4e0d8',
      background: '#e4e0d8', cursor: 'pointer', fontSize: '13px',
    }, entry.glyph);
    button.title = entry.tooltip;
    if (entry.toggle) {
      toggles.set(entry.id, button);
      paintToggle(button, entry.initial === true);
      button.dataset.active = String(entry.initial === true);
    }
    button.addEventListener('click', () => {
      let active = true;
      if (entry.toggle) {
        active = button.dataset.active !== 'true';
        button.dataset.active = String(active);
        paintToggle(button, active);
      }
      toolbarHandler(entry.id, active);
    });
    toolbar.appendChild(button);
  }

  toolbar.appendChild(el('div', { width: '8px' }));
  toolbar.appendChild(el('span', { font: '11px "Segoe UI", Tahoma, sans-serif' }, 'Selecting prop:'));
  const selecting = el('select', { width: '130px', font: '11px "Segoe UI", Tahoma, sans-serif' });
  for (const option of SELECTING_PROP_OPTIONS) {
    const node = document.createElement('option');
    node.value = option;
    node.textContent = option;
    selecting.appendChild(node);
  }
  selecting.addEventListener('change', () => selectingPropHandler(selecting.value));
  toolbar.appendChild(selecting);
  host.appendChild(toolbar);

  // ---- body: workspace | right column ----
  const body = el('div', { display: 'flex', flex: '1 1 auto', minHeight: '0' });

  const left = el('div', { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: '0' });
  const workspace = el('div', {
    display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0',
    margin: '4px', border: PANEL_BORDER, background: PANEL_BG,
  });
  workspace.appendChild(panelTitle('Workspace'));
  const viewportHost = el('div', { position: 'relative', flex: '1 1 auto', minHeight: '0' });
  const canvas = document.createElement('canvas');
  canvas.id = 'viewport';
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' });
  viewportHost.appendChild(canvas);
  workspace.appendChild(viewportHost);
  left.appendChild(workspace);

  // Property panel (Textures / bonus types) — toggled by the toolbar button.
  const propertyPanel = el('div', {
    display: 'none', flexDirection: 'column', height: '150px', flex: '0 0 auto',
    margin: '0 4px 4px', border: PANEL_BORDER, background: PANEL_BG,
  });
  propertyPanel.appendChild(panelTitle('Properties'));
  const propertyBody = el('div', { flex: '1 1 auto', overflow: 'auto', padding: '4px' });
  propertyPanel.appendChild(propertyBody);
  left.appendChild(propertyPanel);
  body.appendChild(left);

  const right = el('div', {
    display: 'flex', flexDirection: 'column', width: '300px', flex: '0 0 300px',
    margin: '4px 4px 4px 0', gap: '4px', minHeight: '0',
  });

  const previewPanel = el('div', {
    display: 'flex', flexDirection: 'column', height: '300px', flex: '0 0 300px',
    border: PANEL_BORDER, background: PANEL_BG,
  });
  previewPanel.appendChild(panelTitle('Preview'));
  const preview = el('div', { flex: '1 1 auto', position: 'relative', background: '#fff' });
  previewPanel.appendChild(preview);
  right.appendChild(previewPanel);

  const libraryCombo = el('select', {
    width: '100%', flex: '0 0 auto', font: '11px "Segoe UI", Tahoma, sans-serif',
  });
  right.appendChild(libraryCombo);

  const propsPanel = el('div', {
    display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0',
    border: PANEL_BORDER, background: PANEL_BG,
  });
  propsPanel.appendChild(panelTitle('Props'));
  const propList = el('div', { flex: '1 1 auto', overflow: 'auto' });
  propsPanel.appendChild(propList);
  right.appendChild(propsPanel);

  body.appendChild(right);
  host.appendChild(body);

  // ---- status bar (the original's progress-bar strip) ----
  const status = el('div', {
    flex: '0 0 auto', height: '20px', display: 'flex', alignItems: 'center',
    padding: '0 6px', borderTop: PANEL_BORDER, background: PANEL_BG,
    font: '11px "Segoe UI", Tahoma, sans-serif', color: '#333',
  }, 'Ready');
  host.appendChild(status);

  return {
    canvas,
    preview,
    libraryCombo,
    propList,
    propertyPanel: propertyBody,
    setStatus(text) { status.textContent = text; },
    setMenuHandler(handler) { menuHandler = handler; },
    setToolbarHandler(handler) { toolbarHandler = handler; },
    setSelectingPropHandler(handler) { selectingPropHandler = handler; },
    setToggle(id, active) {
      const button = toggles.get(id);
      if (button != null) {
        button.dataset.active = String(active);
        paintToggle(button, active);
      }
    },
    showPropertyPanel(visible) {
      propertyPanel.style.display = visible ? 'flex' : 'none';
    },
  };
}

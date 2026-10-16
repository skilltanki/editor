// Editor bootstrap. Mirrors packages/game/src/main.ts: one PlayCanvas app, a
// simRoot that converts Z-up sim units (1 m = 100) into PlayCanvas Y-up metres,
// and everything else parented under it in raw sim coordinates.
import * as pc from 'playcanvas';
import { EditorCamera } from './core/EditorCamera';
import { createGrid } from './core/Grid';
import { buildChrome } from './ui/Chrome';
import { EditorDocument } from './core/EditorDocument';
import { PropRenderer, LibraryEntry } from './render/PropRenderer';
import { Viewport } from './core/Viewport';
import { Prop } from './prop/Prop';
import { buildPropList, buildTexturePanel, PropPick } from './ui/PropListPanel';
import { HELP_TEXT, matchesShortcut, menuShortcuts } from './ui/menuModel';
import { Preview } from './ui/Preview';
import { assetUrl } from './core/assetUrl';
import { assetProgress } from './core/AssetProgress';
import { LoadingScreen } from './ui/LoadingScreen';

/** simRoot scale: 1 sim unit = 0.01 world metres (same as the game). */
const UNITS_TO_METERS = 0.01;

/** The boot loading screen, reachable from main()'s catch below. */
let bootScreen: LoadingScreen | null = null;

interface MapRegistryEntry {
  id: string;
  name: string;
  theme: string;
  file: string;
  thumbnail?: string;
}

interface MapRegistry {
  defaultMap: string;
  maps: MapRegistryEntry[];
}

async function loadMapRegistry(): Promise<MapRegistry> {
  const response = await fetch(assetUrl('/editor-maps.json'));
  if (!response.ok) {
    throw new Error(`maps.json: HTTP ${response.status}`);
  }
  const registry = (await response.json()) as MapRegistry;
  for (const entry of registry.maps) {
    entry.file = assetUrl(entry.file);
    if (entry.thumbnail != null) {
      entry.thumbnail = assetUrl(entry.thumbnail);
    }
  }
  return registry;
}

async function loadLibraryList(): Promise<LibraryEntry[]> {
  const response = await fetch(assetUrl('/editor-props.json'));
  if (!response.ok) {
    throw new Error(`props.json: HTTP ${response.status}`);
  }
  const data = (await response.json()) as { libraries: LibraryEntry[] };
  return data.libraries.map((entry) => ({ ...entry, file: assetUrl(entry.file) }));
}

function createApp(canvas: HTMLCanvasElement): pc.AppBase {
  const app = new pc.Application(canvas, {
    mouse: new pc.Mouse(canvas),
    keyboard: new pc.Keyboard(window),
    graphicsDeviceOptions: { antialias: true, alpha: false },
  });
  app.setCanvasFillMode(pc.FILLMODE_NONE);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);

  const resize = (): void => {
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (rect != null && rect.width > 0 && rect.height > 0) {
      app.resizeCanvas(rect.width, rect.height);
    }
  };
  window.addEventListener('resize', resize);
  // The viewport is a flex child, so observe it rather than the window alone.
  if (canvas.parentElement != null) {
    new ResizeObserver(resize).observe(canvas.parentElement);
  }
  resize();
  return app;
}

async function main(): Promise<void> {
  const chrome = buildChrome(document.getElementById('editor') as HTMLElement);
  const app = createApp(chrome.canvas);

  // Loading bar, counting FILES: the light XML downloads first and names
  // every file, then the bar advances one unit per finished file — no size
  // manifest, no HEAD probes, no network requests beyond the downloads
  // themselves. The megabytes shown are bytes received, information only.
  const loadingScreen = new LoadingScreen();
  bootScreen = loadingScreen;
  loadingScreen.show('Loading', '');
  assetProgress.onProgress((bytes, loaded, total) => loadingScreen.setProgress(bytes, loaded, total));
  assetProgress.attachTo(app);

  // Camera + light, same conventions as the game.
  const camera = new pc.Entity('camera');
  camera.addComponent('camera', {
    clearColor: new pc.Color(0.42, 0.45, 0.5),
    farClip: 2000,
    nearClip: 0.1,
    fov: 45,
  });

  const light = new pc.Entity('light');
  light.addComponent('light', {
    type: 'directional',
    intensity: 1.2,
    castShadows: false,
  });
  light.setLocalEulerAngles(50, 30, 0);
  app.root.addChild(light);

  // Z-up sim space -> PlayCanvas Y-up world: rotate -90deg about X, scale to metres.
  const simRoot = new pc.Entity('simRoot');
  simRoot.setLocalEulerAngles(-90, 0, 0);
  simRoot.setLocalScale(UNITS_TO_METERS, UNITS_TO_METERS, UNITS_TO_METERS);
  app.root.addChild(simRoot);
  simRoot.addChild(camera);

  const editorCamera = new EditorCamera(camera);
  const grid = createGrid(app);
  simRoot.addChild(grid);

  // Map selection: ?map=<id>, falling back to the registry default.
  const registry = await loadMapRegistry();
  const params = new URLSearchParams(window.location.search);
  const mapId = params.get('map') ?? registry.defaultMap;
  const mapEntry = registry.maps.find((m) => m.id === mapId);

  const mapRoot = new pc.Entity('mapRoot');
  simRoot.addChild(mapRoot);

  // Every prop library, so the palette can offer all of them.
  chrome.setStatus('Loading libraries...');
  // Prop meshes/textures are fetched as `${base}/props/...` — the base is the
  // data root (public/, served at the vite base), or every .3ds 404s.
  const renderer = new PropRenderer(app, assetUrl('/').replace(/\/$/, ''));
  const libraries = await loadLibraryList();
  loadingScreen.setPhase('Libraries');
  // Boot stage one: the library list is known, one unit per library.xml
  // (loadLibraries ticks them). The map is its own stage inside openMap.
  assetProgress.begin(libraries.length);
  await renderer.loadLibraries(libraries);
  for (const name of renderer.getLibraryNames()) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    chrome.libraryCombo.appendChild(option);
  }

  const doc = new EditorDocument(renderer, mapRoot);

  // The ghost cursor prop lives on its own node so it can be hidden wholesale
  // (the original kept a whole second scene for this).
  const cursorRoot = new pc.Entity('cursorRoot');
  simRoot.addChild(cursorRoot);

  const preview = new Preview(app, chrome.preview);

  let currentMapName = 'untitled';

  const viewport = new Viewport({
    canvas: chrome.canvas,
    camera: camera.camera as pc.CameraComponent,
    simRoot, editorCamera, doc, renderer, cursorRoot,
    onChange: () => {
      refreshPropertyPanel();
      const first = doc.selection.values().next().value;
      if (first != null) {
        preview.show(first.entity, renderer.getBodyObject(first));
      }
    },
    onStatus: (text) => chrome.setStatus(text),
  });

  // Debug access for tests/tooling (the game exposes __game the same way).
  (window as unknown as Record<string, unknown>).__editor = { app, doc, editorCamera, renderer, simRoot };

  const openMap = async (entry: MapRegistryEntry): Promise<void> => {
    chrome.setStatus(`Loading ${entry.name}...`);
    // The map stage, as ordered: the LIGHT XML downloads first (megabytes
    // tick, no percent yet — the list is not known), then the parsed prop
    // list sets the file total in one shot and the bar runs 0 -> 100% by
    // finished files, with nowhere to run backwards.
    loadingScreen.show('Loading map', entry.name);
    assetProgress.begin();
    try {
      const buffer = await assetProgress.trackedFetch(entry.file);
      const xml = new DOMParser().parseFromString(new TextDecoder().decode(buffer), 'text/xml');
      const result = await doc.loadXml(xml, (props) => renderer.trackDownloads(props));
      currentMapName = entry.id;
      // Frame the camera on the loaded map: maps carry absolute sim
      // coordinates (Island sits ~8 500 units below the start pose), so
      // without this the viewport showed an empty grid while the status bar
      // claimed the map was loaded.
      if (doc.props.length > 0) {
        const min = { x: Infinity, y: Infinity, z: Infinity };
        const max = { x: -Infinity, y: -Infinity, z: -Infinity };
        for (const prop of doc.props) {
          min.x = Math.min(min.x, prop.x); max.x = Math.max(max.x, prop.x);
          min.y = Math.min(min.y, prop.y); max.y = Math.max(max.y, prop.y);
          min.z = Math.min(min.z, prop.z); max.z = Math.max(max.z, prop.z);
        }
        editorCamera.target.x = (min.x + max.x) / 2;
        editorCamera.target.y = (min.y + max.y) / 2;
        editorCamera.target.z = (min.z + max.z) / 2;
        editorCamera.distance = Math.max(
          3000,
          Math.hypot(max.x - min.x, max.y - min.y) * 0.9,
        );
        editorCamera.apply();
      }
      if (collisionView) setCollisionView(true);
      chrome.setStatus(
        `${entry.name}: ${result.loaded} props` +
        (result.skipped > 0 ? `, ${result.skipped} skipped` : ''),
      );
    } catch (error) {
      console.error(error);
      chrome.setStatus(`Failed to load ${entry.name}`);
    } finally {
      loadingScreen.hide();
    }
  };

  // ---- prop palette ----
  // Icons are rendered on demand through the Preview camera. Each prop is
  // built once into a detached node, drawn, then left for reuse.
  const iconCache = new Map<string, string | null>();
  const iconRoot = new pc.Entity('iconRoot');
  iconRoot.enabled = false;
  app.root.addChild(iconRoot);

  const loadIcon = async (library: string, pick: PropPick): Promise<string | null> => {
    const key = `${library}|${pick.group}|${pick.name}`;
    const cached = iconCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let url: string | null = null;
    try {
      const def = renderer.getLibrary(library)?.getProp(pick.group, pick.name) ?? null;
      const prop = new Prop({
        kind: def?.kind === 'sprite' ? 'sprite' : 'tile',
        library, group: pick.group, name: pick.name,
      });
      prop.textureName = renderer.defaultTextureName(library, pick.group, pick.name);
      await renderer.attach(prop, iconRoot);
      if (prop.entity != null) {
        url = await preview.renderIcon(prop.entity, renderer.getBodyObject(prop));
        prop.entity.remove();
      }
    } catch {
      url = null;
    }
    iconCache.set(key, url);
    return url;
  };

  const showLibrary = (name: string): void => {
    buildPropList(chrome.propList, renderer.getLibrary(name), async (pick) => {
      const def = renderer.getLibrary(name)?.getProp(pick.group, pick.name) ?? null;
      const prop = new Prop({
        kind: def?.kind === 'sprite' ? 'sprite' : 'tile',
        library: name,
        group: pick.group,
        name: pick.name,
      });
      // LibraryManager set the first <texture> variant on a freshly built prop.
      prop.textureName = renderer.defaultTextureName(name, pick.group, pick.name);
      await viewport.setCursorProp(prop);
      cursorRoot.enabled = true;
      preview.show(prop.entity, renderer.getBodyObject(prop));
      chrome.setStatus(`Cursor: ${pick.group} / ${pick.name} — Space to place, Esc to drop`);
    }, (pick) => loadIcon(name, pick));
  };
  chrome.libraryCombo.addEventListener('change', () => showLibrary(chrome.libraryCombo.value));
  if (chrome.libraryCombo.options.length > 0) {
    showLibrary(chrome.libraryCombo.value);
  }

  // ---- property panel (texture variants of the selection) ----
  function refreshPropertyPanel(): void {
    const selected = [...doc.selection];
    const tile = selected.find((p) => p.kind === 'tile');
    if (tile == null) {
      buildTexturePanel(chrome.propertyPanel, [], '', () => {});
      return;
    }
    buildTexturePanel(
      chrome.propertyPanel,
      renderer.getTextureNames(tile),
      tile.textureName,
      (textureName) => {
        const previous = new Map<Prop, string>();
        for (const prop of doc.selection) {
          if (prop.kind !== 'tile') continue;
          previous.set(prop, prop.textureName);
          prop.textureName = textureName;
          void renderer.applyTexture(prop);
        }
        if (previous.size > 0) {
          doc.journal.addEvent('changeTexture', new Set(previous.keys()), { previous });
          doc.changed = true;
        }
        refreshPropertyPanel();
      },
    );
  }

  // ---- menu + toolbar ----
  /**
   * Builds `<base>.<ext>`, stripping any extension the base already carries so
   * the file never lands as "map.xml.lvl" or, worse, extensionless.
   */
  const withExtension = (base: string, ext: string): string => {
    const cleaned = (base.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'untitled')
      .replace(/[\\/:*?"<>|]/g, '_');
    return `${cleaned}.${ext}`;
  };

  const download = (data: BlobPart, filename: string, type: string): void => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    // Safari ignores `download` on links that are not in the document.
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const saveXml = (): void => {
    const filename = withExtension(currentMapName, 'xml');
    download(doc.toXml(), filename, 'application/xml');
    doc.changed = false;
    chrome.setStatus(`Exported ${filename}`);
  };

  /** File -> Save / Save as...: the editor's own binary format. */
  const saveLvl = (): void => {
    const bytes = doc.toLvl();
    const filename = withExtension(currentMapName, 'lvl');
    download(bytes, filename, 'application/octet-stream');
    doc.changed = false;
    chrome.setStatus(`Saved ${filename} (${bytes.length} bytes)`);
  };

  /** File -> Open...: the editor's own binary format. */
  const openLvl = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.lvl';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file == null) return;
      try {
        // The .lvl itself is local; what downloads is its meshes/textures,
        // counted as files once the records are parsed.
        loadingScreen.show('Loading', file.name);
        assetProgress.begin();
        const result = await doc.loadLvl(await file.arrayBuffer(), (props) =>
          renderer.trackDownloads(props));
        currentMapName = file.name.replace(/\.lvl$/i, '');
        if (collisionView) setCollisionView(true);
        chrome.setStatus(
          `${file.name}: ${result.loaded} props` +
          (result.skipped > 0 ? `, ${result.skipped} skipped` : '') +
          (result.truncated ? ' — file ends mid-record' : ''),
        );
      } catch (error) {
        console.error(error);
        chrome.setStatus(`Failed to read ${file.name}`);
      } finally {
        loadingScreen.hide();
      }
      refreshPropertyPanel();
    });
    input.click();
  };

  const openXmlFile = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file == null) return;
      try {
        loadingScreen.show('Loading', file.name);
        assetProgress.begin();
        const xml = new DOMParser().parseFromString(await file.text(), 'text/xml');
        const result = await doc.loadXml(xml, (props) => renderer.trackDownloads(props));
        currentMapName = file.name.replace(/\.xml$/i, '');
        chrome.setStatus(
          `${file.name}: ${result.loaded} props` +
          (result.skipped > 0 ? `, ${result.skipped} skipped` : ''),
        );
      } finally {
        loadingScreen.hide();
      }
      refreshPropertyPanel();
    });
    input.click();
  };

  // MainScene.showCollisionBoxes / hideCollisionBoxes
  let collisionView = false;
  const setCollisionView = (enabled: boolean): void => {
    collisionView = enabled;
    let shown = 0;
    for (const prop of doc.props) {
      if (prop.kind !== 'tile') continue;
      renderer.setCollisionView(prop, enabled);
      shown++;
    }
    chrome.setStatus(enabled ? `Collision boxes: ${shown} prop(s)` : 'Normal view');
  };

  const menuHandler = (label: string): void => {
    switch (label) {
      case 'New':
        doc.clear();
        currentMapName = 'untitled';
        chrome.setStatus('New level');
        break;
      case 'Open...':
        openLvl();
        break;
      case 'Import from Tanks':
        openXmlFile();
        break;
      case 'Save':
      case 'Save as...':
        saveLvl();
        break;
      case 'Export to Tanks':
        saveXml();
        break;
      case 'Undo':
        void doc.undo().then((ok) => chrome.setStatus(ok ? 'Undo' : 'Nothing to undo'));
        break;
      case 'Redo':
        void doc.redo().then((ok) => chrome.setStatus(ok ? 'Redo' : 'Nothing to redo'));
        break;
      case 'Clear':
        doc.clear();
        chrome.setStatus('Cleared');
        break;
      case 'Normal':
        setCollisionView(false);
        chrome.setToggle('view', false);
        break;
      case 'Collision boxes':
        setCollisionView(true);
        chrome.setToggle('view', true);
        break;
      case 'Unlock': doc.multiplePropMode = 0; chrome.setStatus('Multiple prop: unlock'); break;
      case 'Lock group': doc.multiplePropMode = 1; chrome.setStatus('Multiple prop: lock group'); break;
      case 'Lock': doc.multiplePropMode = 2; chrome.setStatus('Multiple prop: lock'); break;
      case 'Snap':
        doc.snapMode = !doc.snapMode;
        chrome.setToggle('snap', doc.snapMode);
        chrome.setStatus(`Snap ${doc.snapMode ? 'on' : 'off'}`);
        break;
      case 'Show grid':
        grid.enabled = !grid.enabled;
        chrome.setToggle('grid', grid.enabled);
        break;
      case 'Help':
        window.alert(HELP_TEXT);
        break;
      default:
        break;
    }
  };
  chrome.setMenuHandler(menuHandler);

  chrome.setToolbarHandler((id, active) => {
    switch (id) {
      case 'snap':
        doc.snapMode = active;
        viewport.updateCursorMaterial();
        chrome.setStatus(`Snap ${active ? 'on' : 'off'}`);
        break;
      case 'grid':
        grid.enabled = active;
        break;
      case 'textures':
        chrome.showPropertyPanel(active);
        refreshPropertyPanel();
        break;
      case 'view':
        setCollisionView(active);
        break;
      case 'hideSelected':
        for (const prop of doc.selection) {
          prop.hidden = true;
          if (prop.entity != null) prop.entity.enabled = false;
        }
        chrome.setStatus(`Hid ${doc.selection.size} prop(s)`);
        break;
      case 'showAll':
        for (const prop of doc.props) {
          prop.hidden = false;
          if (prop.entity != null) prop.entity.enabled = true;
        }
        chrome.setStatus('All props shown');
        break;
    }
  });

  chrome.setSelectingPropHandler((value) => viewport.setSelectingFilter(value));

  // Menu accelerators (Ctrl+N/O/S, Ctrl+Alt+S, Ctrl+T/I, Ctrl+Z/Y, ...).
  // They route through the same handler the menu clicks use, and are bound
  // from the menu model so the labels and the bindings cannot drift apart.
  const shortcuts = menuShortcuts();
  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
      return;
    }
    for (const { label, shortcut } of shortcuts) {
      if (matchesShortcut(event, shortcut)) {
        event.preventDefault();
        menuHandler(label);
        return;
      }
    }
  });

  if (mapEntry != null) {
    await openMap(mapEntry);
  } else {
    chrome.setStatus(`Unknown map "${mapId}"`);
    loadingScreen.hide();
  }

  // SceneContainer.onEnterFrame: held-key camera navigation (N/M, numpad).
  app.on('update', (dt: number) => viewport.update(dt));

  app.start();

  // Debug access for tests/tooling (same contract as the game's window.__game).
  (window as unknown as Record<string, unknown>).__editor = {
    app, simRoot, mapRoot, cursorRoot, camera, editorCamera, grid, registry,
    renderer, doc, viewport, openMap, chrome, saveXml, saveLvl, openLvl,
    assetProgress, loadingScreen,
  };
}

main().catch((error) => {
  console.error(error);
  // A boot failure must not strand a full-screen progress overlay.
  bootScreen?.fail('Editor failed to load — see the console');
});

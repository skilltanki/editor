// Editor asset sync — the editor's OWN dev pipeline (no game build involved):
// fills packages/editor/public with the prop libraries and maps the GAME
// ships, plus the editor-maps.json/editor-props.json registries.
//
// The layout and the registry names are IDENTICAL to what the game's
// sync-assets emits into packages/game/public (its "EDITOR data" section):
// that tree is the ONE store uploaded to R2 (/assets/*), which the production
// editor reads via VITE_ASSET_BASE=/assets/. This script only exists so that
// editor development is self-contained; keep the two in step.
//
// No size manifest is written here: the loading bar inventories byte totals
// AT RUNTIME (HEAD/Range probes in src/core/AssetProgress.ts), because the
// production store is not re-uploaded for editor features and must keep
// serving exactly the files it already holds.
//
// SCOPE — the game decides, the editor follows. Both read the same filter:
// the `bundled` list in the repo-root maps.json (53 of the 91 maps). The
// editor must not offer props the game cannot render: everything here is
// uploaded to the one shared R2 bucket, and a library that no bundled map
// references would ship megabytes nothing can load. So the libraries are
// DERIVED, exactly as the game derives them — by reading each bundled map's
// XML and keeping the libraries it actually references — rather than listed
// by hand or taken from whatever happens to sit in assets/Props.
// Usage: node scripts/sync-assets.mjs   (also runs as predev/prebuild/prepreview)
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(projectRoot, '../..');
const assetsRoot = join(repoRoot, 'assets');
const publicRoot = join(projectRoot, 'public');

let copied = 0;
let totalBytes = 0;

/**
 * Flat lowercase layout, same rule as the game's sync-assets: directories are
 * lowercased so the client never guesses letter case, file names keep their
 * on-disk spelling.
 */
function flatten(relSrc) {
  const parts = relSrc.split(/[\\/]/).filter((p) => p !== 'Resources');
  const file = parts.pop();
  return join(...parts.map((p) => p.toLowerCase()), file);
}

function copyFile(relSrc, relDst = flatten(relSrc)) {
  const src = join(assetsRoot, relSrc);
  const dst = join(publicRoot, relDst);
  if (!existsSync(src)) {
    console.warn(`sync-assets: MISSING ${relSrc}`);
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied++;
  totalBytes += statSync(src).size;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// --- wipe and rebuild ---
if (existsSync(publicRoot)) {
  rmSync(publicRoot, { recursive: true, force: true });
}
mkdirSync(publicRoot, { recursive: true });

// --- favicon ---
// The project logo lives in the REPO ROOT, like the game's sync-assets reads
// it. index.html asks for "./logo.png", i.e. /logo.png in dev; the deploy
// build rewrites that to the shared static root instead.
const logoSrc = join(repoRoot, 'logo.png');
if (existsSync(logoSrc)) {
  copyFileSync(logoSrc, join(publicRoot, 'logo.png'));
  copied++;
  totalBytes += statSync(logoSrc).size;
} else {
  console.warn('sync-assets: MISSING logo.png in the repo root');
}

// --- loading-bar art ---
// The LoadingScreen fills its bar with these strips. They are already in the
// production store byte-identically (the game's tree ships /embedded/ui/), so
// this is dev-only serving, not a new upload.
for (const name of ['life_left.png', 'life_center.png', 'life_right.png']) {
  copyFile(join('Embedded', 'UI', name));
}

// --- maps: the GAME's bundled list, which also decides the prop scope ---
// Same filter the game applies (registry.bundled, 53 of 91): the editor edits
// maps the game can actually run, and nothing here reaches R2 that the game
// would not also ship.
const registry = JSON.parse(readFileSync(join(repoRoot, 'maps.json'), 'utf8'));
const MAP_IDS = registry.bundled ?? registry.maps.map((m) => m.id);
const bundledMaps = registry.maps.filter((m) => MAP_IDS.includes(m.id));
const missingIds = MAP_IDS.filter((id) => !bundledMaps.some((m) => m.id === id));
if (missingIds.length > 0) {
  console.warn(`sync-assets: map ids not in maps.json: ${missingIds.join(', ')}`);
}

// Which prop libraries those maps reference, by folder name. A map names its
// library by display name ("Buildings v1"); the folder is that lowercased with
// spaces as underscores — the same mapping the game's loadLibrary() uses.
const libraryNameToFolder = (name) => name.toLowerCase().replace(/ /g, '_');
const usedFolders = new Set();
for (const map of bundledMaps) {
  const rel = map.file.replace(/^assets\//, '');
  const mapPath = join(assetsRoot, rel);
  if (!existsSync(mapPath)) continue;
  const xml = readFileSync(mapPath, 'utf8');
  for (const propMatch of xml.matchAll(/<prop ([^>]*)>/g)) {
    const libraryName = decodeEntities(propMatch[1].match(/library-name="([^"]*)"/)?.[1] ?? '');
    if (libraryName !== '') usedFolders.add(libraryNameToFolder(libraryName));
  }
}

// --- the prop libraries those maps use ---
// library.xml references meshes/textures in mixed case while the files on disk
// are lowercase. Normalise the references HERE so the client uses them verbatim
// instead of calling toLowerCase() on every asset URL.
const propsSrc = join(assetsRoot, 'Props');
const libraries = [];

for (const entry of readdirSync(propsSrc, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const folder = entry.name;
  // Not referenced by any bundled map — the game would never load it.
  if (!usedFolders.has(folder.toLowerCase())) continue;
  const libraryPath = join(propsSrc, folder, 'library.xml');
  if (!existsSync(libraryPath)) {
    console.warn(`sync-assets: ${folder} has no library.xml, skipped`);
    continue;
  }

  const raw = readFileSync(libraryPath, 'utf8');
  const libraryXml = raw
    .replace(/(<mesh\s+file=")([^"]+)(")/g, (_, a, file, b) => a + file.toLowerCase() + b)
    .replace(/(<sprite\s+file=")([^"]+)(")/g, (_, a, file, b) => a + file.toLowerCase() + b)
    .replace(/(diffuse-map=")([^"]+)(")/g, (_, a, file, b) => a + file.toLowerCase() + b)
    .replace(/(opacity-map=")([^"]+)(")/g, (_, a, file, b) => a + file.toLowerCase() + b);

  const dstDir = join(publicRoot, 'props', folder.toLowerCase());
  mkdirSync(dstDir, { recursive: true });
  writeFileSync(join(dstDir, 'library.xml'), libraryXml);
  copied++;

  // Every asset beside library.xml, lowercased (meshes, textures, sprites).
  for (const file of readdirSync(join(propsSrc, folder), { withFileTypes: true })) {
    if (!file.isFile()) continue;
    if (file.name === 'library.xml') continue;
    if (file.name === 'Thumbs.db' || file.name === '.DS_Store') continue;
    copyFile(join('Props', folder, file.name), join('props', folder.toLowerCase(), file.name.toLowerCase()));
  }

  libraries.push({
    name: decodeEntities(raw.match(/<library\s+name="([^"]*)"/)?.[1] ?? folder),
    folder: folder.toLowerCase(),
    file: `/props/${folder.toLowerCase()}/library.xml`,
  });
}

libraries.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(publicRoot, 'editor-props.json'), JSON.stringify({ libraries }, null, 2));

// --- the bundled maps themselves (selected above, with the prop scope) ---
const maps = [];
for (const map of bundledMaps) {
  const rel = map.file.replace(/^assets\//, '');
  if (!existsSync(join(assetsRoot, rel))) {
    console.warn(`sync-assets: missing map file ${map.file}`);
    continue;
  }
  copyFile(rel);
  maps.push({ ...map, file: `/${flatten(rel).split(/[\\/]/).join('/')}` });
}
// Fall back to a bundled map when the registry's default is not among them,
// so the editor never opens on a map it did not publish.
const defaultMap = MAP_IDS.includes(registry.defaultMap) ? registry.defaultMap : MAP_IDS[0];
writeFileSync(
  join(publicRoot, 'editor-maps.json'),
  JSON.stringify({ defaultMap, maps }, null, 2),
);

console.log(
  `sync-assets: ${copied} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB, ` +
  `${libraries.length} libraries, ${maps.length} maps`,
);

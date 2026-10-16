// Where the editor DATA (maps, prop libraries, registries) lives. Dev serves
// it from the editor's own public/ (vite publicDir) at the vite base (/); a
// production build sets VITE_ASSET_BASE=/assets/ and the worker streams the
// SAME store from R2 — one tree for game and editor, uploaded once. The
// editor's own JS/CSS always stays at the root.
const DATA_BASE: string = import.meta.env.VITE_ASSET_BASE ?? import.meta.env.BASE_URL;

export function assetUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return path; // already absolute
  }
  return new URL(path.replace(/^\//, ''), new URL(DATA_BASE, window.location.origin)).href;
}

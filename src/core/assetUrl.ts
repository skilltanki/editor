// Where the editor DATA (maps, prop libraries, registries) lives: the editor's
// own public/ (vite publicDir), served at the site root — `/editor-maps.json`,
// `/editor-props.json`, `/maps/**`, `/props/**`, `/embedded/**`. Dev serves the
// folder as is; a build copies it into dist/ next to the bundle, so the same
// paths hold in production with no separate asset store.
const DATA_BASE: string = import.meta.env.BASE_URL;

export function assetUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return path; // already absolute
  }
  return new URL(path.replace(/^\//, ''), new URL(DATA_BASE, window.location.origin)).href;
}

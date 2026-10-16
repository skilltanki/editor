import { defineConfig, type Plugin } from 'vite';
// CommonJS package: Vite bundles this config as ESM, where only the default
// import resolves (a named `obfuscate` import fails at config load).
import JavaScriptObfuscator from 'javascript-obfuscator';

// Obfuscation of the production bundle, applied to each emitted chunk AFTER
// terser. Same settings as the game's vite.config.ts (deliberately a copy —
// obfuscation is each package's own build concern, not shared infrastructure):
// the upstream "low" preset, with controlFlowFlattening, deadCodeInjection and
// splitStrings OFF because they cost frames, stringArrayEncoding empty so no
// literal is decoded at runtime, and debugProtection off because it freezes a
// browser with DevTools open. The editor renders the same PlayCanvas scene as
// the game, so it gets the same budget.
function obfuscator(): Plugin {
  return {
    name: 'obfuscator',
    apply: 'build',
    enforce: 'post',
    renderChunk(code) {
      const result = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        simplify: true,
        stringArray: true,
        stringArrayThreshold: 0.75,
        selfDefending: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        splitStrings: false,
        stringArrayEncoding: [],
        debugProtection: false,
        identifierNamesGenerator: 'mangled',
        renameGlobals: false,
      });
      return { code: result.getObfuscatedCode(), map: null };
    },
  };
}

export default defineConfig({
  // The editor is its own origin: it starts at / (dev and build alike).
  base: '/',
  plugins: [obfuscator()],
  build: {
    // playcanvas is a single large engine chunk; the default 500kB warning is noise
    chunkSizeWarningLimit: 2500,
    // terser over the default esbuild minifier: slower build, smaller and
    // better-mangled output (the obfuscation plugin above runs on top).
    minify: 'terser',
    rollupOptions: {
      output: {
        // Hash-only names: the default `[name]-[hash]` would leak the module
        // map through the URLs alone, undoing the obfuscation above.
        entryFileNames: 'assets/[hash].js',
        chunkFileNames: 'assets/[hash].js',
        assetFileNames: 'assets/[hash].[ext]',
      },
    },
    // public/ is the editor's DEV data (own scripts/sync-assets.mjs); in
    // production the same layout is read from R2 at /assets/ (uploaded once,
    // from the game's tree which carries the editor supersets too).
    copyPublicDir: false,
  },
});

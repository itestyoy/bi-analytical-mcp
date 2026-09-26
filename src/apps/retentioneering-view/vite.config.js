// Builds the path-analysis view into ONE self-contained HTML file, like the result view
// (vite + vite-plugin-singlefile; npm run build:app). The output is checked in
// (dist/retentioneering-view.html) and test/unit/retentioneering-view.test.js holds it to these sources.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  logLevel: 'warn',
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssMinify: true,
    minify: true,
    modulePreload: { polyfill: false },
    rollupOptions: { input: join(root, 'retentioneering-view.html') },
  },
});

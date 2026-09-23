// Builds the view into ONE self-contained HTML file (scripts, styles and Chart.js inlined) — the
// shape of a `ui://` resource, and the build the official MCP Apps examples use
// (vite + vite-plugin-singlefile). Run: npm run build:app. The output is checked in
// (dist/mcp-app.html) and test/unit/mcp-apps.test.js holds it to these sources.
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
    rollupOptions: { input: join(root, 'mcp-app.html') },
  },
});

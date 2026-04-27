import { defineConfig } from 'vite';

export default defineConfig({
  // Static assets (css/, data/) are copied verbatim to dist/
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

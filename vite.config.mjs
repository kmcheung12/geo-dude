import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: resolve(__dirname, 'public/js/src/app.js'),
      name: 'GeoApp',
      formats: ['iife'],
      fileName: () => 'bundle.js',
    },
    outDir: 'public/js',
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2020',
  },
});

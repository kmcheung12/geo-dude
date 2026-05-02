// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,        // per-test timeout (globe load can be slow)
  use: {
    baseURL: 'http://192.168.1.163:3000',
    actionTimeout: 15000,
  },
});

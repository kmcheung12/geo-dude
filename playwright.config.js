// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,        // per-test timeout (globe load can be slow)
  use: {
    baseURL: 'http://192.168.1.163:3000',
    actionTimeout: 15000,
  },
});

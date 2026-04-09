const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    headless: true,
  },
  projects: [
    { name: 'chromium', use: {
      browserName: 'chromium',
      permissions: ['clipboard-read', 'clipboard-write'],
    } },
  ],
});

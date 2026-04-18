const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 120000,  // safety bail-out for genuine hangs (WebSocket stuck, etc.)
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

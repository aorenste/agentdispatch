const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 60000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:8916',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: {
      browserName: 'chromium',
      permissions: ['clipboard-read', 'clipboard-write'],
    } },
  ],
  webServer: {
    command: 'cargo build && exec ./target/debug/agentdispatch --db /tmp/agentdispatch-e2e.db --port 8916',
    port: 8916,
    timeout: 120000,
    reuseExistingServer: false,
  },
});

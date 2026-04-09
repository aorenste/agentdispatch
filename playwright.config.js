const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 10000,
  retries: 0,
  workers: 4,
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
    command: 'CARGO_TARGET_DIR=target/test cargo build && exec env AGENTDISPATCH_TMUX_SOCKET=agentdispatch-test ./target/test/debug/agentdispatch --db /tmp/agentdispatch-e2e.db --port 8916',
    port: 8916,
    timeout: 120000,
    reuseExistingServer: false,
  },
});

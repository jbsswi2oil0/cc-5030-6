const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8080',
    actionTimeout: 15000,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
    }
  },
  webServer: {
    command: 'node ../server/index.js',
    cwd: __dirname,
    url: 'http://localhost:8080/api/media',
    timeout: 30000,
    reuseExistingServer: !process.env.CI,
    env: {
      LD_LIBRARY_PATH: '/tmp/local-lib/usr/lib/aarch64-linux-gnu:/tmp/local-lib/lib/aarch64-linux-gnu',
      PORT: '8080',
      ALLOW_TEST_RESET: '1'
    }
  }
});

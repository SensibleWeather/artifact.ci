import {defineConfig} from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  use: {
    colorScheme: 'dark',
  },
})

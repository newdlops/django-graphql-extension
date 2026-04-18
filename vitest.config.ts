import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/__tests__/__mocks__/vscode.ts'),
    },
  },
});

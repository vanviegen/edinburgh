import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{js,ts}'], // Point to source .ts files
    exclude: ['build/**/*'] // Explicitly exclude build directory
  }
});

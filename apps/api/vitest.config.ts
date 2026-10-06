import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Integration files share one development PostgreSQL database and start API
  // processes. Keep fixtures serial; concurrency is exercised inside the tests.
  test: { fileParallelism: false },
});

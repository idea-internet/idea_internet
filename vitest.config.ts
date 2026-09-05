import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // NOTE: @cloudflare/vitest-pool-workers is installed but workerd crashes on
    // some machines (0xc0000005 at startup). We run on the default Node pool
    // with in-memory KV/R2 mocks (src/test/mocks.ts) instead, so the full
    // request pipeline is still exercised without the Workers runtime.
  },
});

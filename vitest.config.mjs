import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "open-sse": fileURLToPath(new URL("./open-sse", import.meta.url)),
    },
  },
  test: {
    globals: false,
  },
});

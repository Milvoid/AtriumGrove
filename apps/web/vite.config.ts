import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 4311,
    proxy: { "/v1": "http://127.0.0.1:4310" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});

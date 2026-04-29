import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["tests/setup.ts"]
  },
  resolve: {
    alias: {
      "@client": "/src/client",
      "@server": "/src/server",
      "@shared": "/src/shared"
    }
  }
});

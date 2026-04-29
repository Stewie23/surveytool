import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function brotliTopoJsonFallback(): Plugin {
  const publicDir = path.resolve("public");

  return {
    name: "brotli-topojson-fallback",
    configureServer(server) {
      server.middlewares.use("/data/germany-plz.topojson", (_, response, next) => {
        const plainPath = path.join(publicDir, "data", "germany-plz.topojson");
        const brotliPath = `${plainPath}.br`;

        if (fs.existsSync(plainPath) || !fs.existsSync(brotliPath)) {
          next();
          return;
        }

        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Content-Encoding", "br");
        response.setHeader("Vary", "Accept-Encoding");
        fs.createReadStream(brotliPath).pipe(response);
      });
    }
  };
}

export default defineConfig({
  plugins: [brotliTopoJsonFallback(), react()],
  root: "src/client",
  publicDir: "../../public",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000"
    }
  }
});

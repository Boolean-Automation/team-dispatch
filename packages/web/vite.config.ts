import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_API_PROXY_TARGET lets multi-project laptops point the dev proxy at a
// non-default API port without editing this file. Default: localhost:3000.
const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // foliate-js loads its formats with dynamic imports; leave it as plain ES modules
  optimizeDeps: { exclude: ["foliate-js"] },
  build: { target: "chrome120", sourcemap: false, chunkSizeWarningLimit: 4000 },
});

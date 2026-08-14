import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
const env = runtime.process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(env.TAURI_ENV_DEBUG),
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.indexOf("/lucide-react/") >= 0) return "icons";
          if (id.indexOf("/@tauri-apps/") >= 0) return "tauri";
          if (["/react/", "/react-dom/", "/scheduler/", "/i18next/", "/react-i18next/"].some((dependency) => id.indexOf(dependency) >= 0)) return "framework";
          return undefined;
        },
      },
    },
  },
});

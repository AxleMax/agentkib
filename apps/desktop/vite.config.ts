import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
const env = runtime.process?.env ?? {};

const config = {
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  test: { setupFiles: ["./src/test/test-setup.ts"] },
  build: {
    target: env.TAURI_ENV_PLATFORM === "windows" ? "chrome111" : "safari16.4",
    minify: env.TAURI_ENV_DEBUG ? false : "esbuild" as const,
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
};

export default defineConfig(config);

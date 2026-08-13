import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
const env = runtime.process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13", minify: env.TAURI_ENV_DEBUG ? false : "esbuild", sourcemap: Boolean(env.TAURI_ENV_DEBUG) },
});

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./api";
import { initializeI18n, normalizeLocale } from "./i18n";
import "./styles.css";

async function bootstrap() {
  let locale = normalizeLocale(navigator.language);
  try {
    locale = (await api.runtime()).effective_locale;
  } catch {
    // The web preview has no Tauri runtime; the system browser locale remains useful.
  }
  await initializeI18n(locale);
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
}

void bootstrap();

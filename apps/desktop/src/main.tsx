import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppDialogProvider } from "./components/AppDialogProvider";
import { QuotaPopover } from "./components/QuotaPopover";
import { api } from "./api";
import { initializeI18n, normalizeLocale } from "./i18n";
import { applyPlatformAttribute } from "./platform";
import { applyTheme, systemTheme } from "./theme";
import "./shadcn.css";
import "./styles.css";

applyPlatformAttribute(import.meta.env.TAURI_ENV_PLATFORM);

async function bootstrap() {
  let locale = normalizeLocale(navigator.language);
  let theme = systemTheme();
  try {
    const runtime = await api.runtime();
    locale = runtime.effective_locale;
    theme = runtime.effective_theme;
  } catch {
    // The web preview has no Tauri runtime; the system browser locale remains useful.
  }
  applyTheme(theme);
  await initializeI18n(locale);
  const surface = new URLSearchParams(window.location.search).get("surface");
  createRoot(document.getElementById("root")!).render(
    <StrictMode><AppDialogProvider>{surface === "quota-popover" ? <QuotaPopover /> : <App />}</AppDialogProvider></StrictMode>,
  );
}

void bootstrap();

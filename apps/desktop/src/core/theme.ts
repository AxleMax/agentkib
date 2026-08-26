import type { EffectiveTheme } from "./types";

export type AccentTheme = "black" | "sky" | "blue";

const ACCENT_THEME_STORAGE_KEY = "agentkib.accent-theme";

export function systemTheme(): EffectiveTheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: EffectiveTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function accentThemePreference(): AccentTheme {
  if (typeof localStorage === "undefined") return "black";
  const stored = localStorage.getItem(ACCENT_THEME_STORAGE_KEY);
  return stored === "sky" || stored === "blue" ? stored : "black";
}

export function applyAccentTheme(theme: AccentTheme) {
  document.documentElement.dataset.accentTheme = theme;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(ACCENT_THEME_STORAGE_KEY, theme);
  }
}

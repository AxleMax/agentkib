export type AppPlatform = "macos" | "windows" | "linux" | "web";

export function normalizePlatform(platform?: string): AppPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "windows" || platform === "linux") return platform;
  return "web";
}

export function applyPlatformAttribute(platform?: string): void {
  document.documentElement.dataset.platform = normalizePlatform(platform);
}

export function primaryShortcutModifier(platform?: string): "Command" | "Ctrl" {
  return normalizePlatform(platform) === "macos" ? "Command" : "Ctrl";
}

export function usesSystemTrayWording(platform?: string): boolean {
  return normalizePlatform(platform) === "linux";
}

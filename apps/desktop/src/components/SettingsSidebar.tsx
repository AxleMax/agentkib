import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import { ArrowLeft, Database, FolderSearch, PlugZap, Settings2, Stethoscope } from "lucide-react";
import { tr } from "../core/i18n";
import { cn } from "@/lib/utils";
import type { AppPlatform } from "../core/platform";
import { SidebarBrand } from "./SidebarBrand";

export type SettingsSection = "general" | "discovery" | "integrations" | "privacy" | "diagnostics";

const sections: Array<{ id: SettingsSection; label: string; icon: ComponentType<{ size?: number }> }> = [
  { id: "general", label: "settings.section.general", icon: Settings2 },
  { id: "discovery", label: "settings.section.discovery", icon: FolderSearch },
  { id: "integrations", label: "settings.section.integrations", icon: PlugZap },
  { id: "privacy", label: "settings.section.privacy", icon: Database },
  { id: "diagnostics", label: "settings.section.diagnostics", icon: Stethoscope },
];

export function SettingsSidebar({
  active,
  onSelect,
  onBack,
  collapsed,
  platform = "web",
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onBack: () => void;
  collapsed: boolean;
  platform?: AppPlatform;
}) {
  return (
    <aside className={cn("relative z-20 col-start-1 row-start-1 flex h-full min-h-0 w-[var(--sidebar-width)] flex-col border-r border-sidebar-border bg-sidebar px-3.5 pb-3.5 transition-transform duration-150 group-[.sidebar-collapsed]:pointer-events-none group-[.sidebar-collapsed]:-translate-x-full", platform === "macos" || platform === "web" ? "pt-[68px]" : "pt-3")} aria-hidden={collapsed} inert={collapsed ? true : undefined}>
      <SidebarBrand />
      <div className="mt-5 border-t border-sidebar-border/70 pt-4">
        <Button variant="bare" size="content" className="flex h-10 min-w-0 w-full items-center justify-start gap-2.5 rounded-xl px-3 text-left text-sm font-medium text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.99]" type="button" onClick={onBack}>
          <ArrowLeft size={17} />{tr("settings.backToApp")}
        </Button>
      </div>
      <nav className="mt-5 flex flex-col gap-1" aria-label={tr("settings.navigation")}>
        {sections.map(({ id, label, icon: Icon }) => (
          <Button key={id} variant="bare" size="content" className={cn("flex min-h-11 w-full items-center justify-start gap-3 rounded-xl px-3 text-sm font-medium tracking-[0.01em] text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.99]", active === id && "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm")} aria-current={active === id ? "page" : undefined} onClick={() => onSelect(id)}>
            <Icon size={18} />{tr(label)}
          </Button>
        ))}
      </nav>
    </aside>
  );
}

export function settingsSectionLabel(section: SettingsSection) {
  return tr(`settings.section.${section}`);
}

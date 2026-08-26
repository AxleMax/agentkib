import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import {
  ArrowLeft,
  Database,
  FolderSearch,
  PlugZap,
  Settings,
  Settings2,
  Stethoscope,
} from "lucide-react";
import { tr } from "@/core/i18n";
import { cn } from "@/lib/utils";

export type SettingsSection = "general" | "discovery" | "integrations" | "privacy" | "diagnostics";

const sections: Array<{
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ size?: number }>;
}> = [
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
  onSettings,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onBack: () => void;
  onSettings: () => void;
}) {
  return (
    <header className="top-navbar col-start-1 row-start-2 flex min-w-0 items-center border-b border-border-subtle/70 bg-background px-4 sm:px-6">
      <div className="top-navbar-inner">
        <div className="top-navbar-group shrink-0">
          <Button
            variant="bare"
            size="content"
            className="flex size-9 items-center justify-center rounded-xl px-0 text-left text-sm font-medium text-sidebar-foreground/70 transition-colors duration-200 active:scale-[0.99]"
            type="button"
            onClick={onBack}
          >
            <ArrowLeft size={17} />
            <span className="sr-only">{tr("settings.backToApp")}</span>
          </Button>
        </div>
        <nav className="min-w-0 flex-1 overflow-x-auto" aria-label={tr("settings.navigation")}>
          <div className="top-navbar-group mx-auto w-fit min-w-max">
            {sections.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant="bare"
                size="content"
                className={cn(
                  "flex h-9 items-center justify-center gap-2 rounded-[11px] px-3 text-sm font-medium tracking-[0.01em] text-sidebar-foreground/70 transition-colors duration-200 active:scale-[0.99]",
                  active === id && "shadow-sm",
                )}
                aria-current={active === id ? "page" : undefined}
                onClick={() => onSelect(id)}
              >
                <Icon size={17} />
                <span>{tr(label)}</span>
              </Button>
            ))}
          </div>
        </nav>
        <div className="shrink-0">
          <Button
            variant="bare"
            size="content"
            className="flex size-9 items-center justify-center rounded-xl px-0 text-left text-sm font-medium text-sidebar-foreground/70 transition-colors duration-200 active:scale-[0.99]"
            type="button"
            aria-current="page"
            onClick={onSettings}
          >
            <Settings size={18} />
            <span className="sr-only">{tr("nav.settings")}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function settingsSectionLabel(section: SettingsSection) {
  return tr(`settings.section.${section}`);
}

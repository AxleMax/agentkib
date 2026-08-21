import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import { ArrowLeft, Database, FolderSearch, PlugZap, Settings2, Stethoscope } from "lucide-react";
import { tr } from "../i18n";
import { cn } from "@/lib/utils";

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
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onBack: () => void;
  collapsed: boolean;
}) {
  return (
    <aside className="sidebar settings-sidebar relative z-20 col-start-1 row-start-1 flex h-full min-h-0 w-[var(--sidebar-width)] flex-col border-r border-[var(--border)] bg-[var(--sidebar)] p-3 transition-transform duration-150 group-[.sidebar-collapsed]:pointer-events-none group-[.sidebar-collapsed]:-translate-x-full" aria-hidden={collapsed} inert={collapsed ? true : undefined}>
      <div className="settings-sidebar-head flex h-[38px] items-center gap-2">
        <Button variant="bare" size="content" className="back-to-app flex h-[34px] min-w-0 flex-1 items-center justify-start gap-2 rounded-[7px] px-2 text-left text-[13px] text-[#a5adbb] hover:bg-[#171c25] hover:text-white" type="button" onClick={onBack}>
          <ArrowLeft size={16} />{tr("settings.backToApp")}
        </Button>
      </div>
      <nav className="mt-[22px] flex flex-col gap-[3px]" aria-label={tr("settings.navigation")}>
        {sections.map(({ id, label, icon: Icon }) => (
          <Button key={id} variant="bare" size="content" className={cn("flex min-h-[38px] w-full items-center justify-start gap-[11px] rounded-lg px-2.5 text-[13px] font-medium text-[#7f899d] hover:bg-[#121721] hover:text-[#bec5d3]", active === id && "active bg-[rgba(172,172,172,0.13)] text-[#eeeaff]")} aria-current={active === id ? "page" : undefined} onClick={() => onSelect(id)}>
            <Icon size={17} />{tr(label)}
          </Button>
        ))}
      </nav>
    </aside>
  );
}

export function settingsSectionLabel(section: SettingsSection) {
  return tr(`settings.section.${section}`);
}

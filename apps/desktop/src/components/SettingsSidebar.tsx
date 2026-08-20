import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import { ArrowLeft, Database, FolderSearch, PlugZap, Settings2, Stethoscope } from "lucide-react";
import { tr } from "../i18n";

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
    <aside className="sidebar settings-sidebar" aria-hidden={collapsed} inert={collapsed ? true : undefined}>
      <div className="settings-sidebar-head">
        <Button variant="bare" size="content" className="back-to-app" type="button" onClick={onBack}>
          <ArrowLeft size={16} />{tr("settings.backToApp")}
        </Button>
      </div>
      <nav aria-label={tr("settings.navigation")}>
        {sections.map(({ id, label, icon: Icon }) => (
          <Button key={id} variant="bare" size="content" className={active === id ? "active" : ""} aria-current={active === id ? "page" : undefined} onClick={() => onSelect(id)}>
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

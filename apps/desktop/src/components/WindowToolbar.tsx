import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { tr } from "../i18n";

export function WindowToolbar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = tr(collapsed ? "common.expandSidebar" : "common.collapseSidebar");
  return (
    <div className="window-toolbar" data-tauri-drag-region>
      <button className="window-sidebar-toggle" type="button" onClick={onToggle} aria-label={label} title={label}>
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button>
    </div>
  );
}

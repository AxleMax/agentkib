import { Button } from "@/components/ui/button";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { tr } from "../i18n";

export function WindowToolbar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = tr(collapsed ? "common.expandSidebar" : "common.collapseSidebar");
  return (
    <div className="pointer-events-auto fixed inset-x-auto left-0 top-0 z-[45] h-[var(--page-header-height)] w-[var(--sidebar-width)] bg-transparent" data-tauri-drag-region>
      <Button className="absolute left-[calc(var(--sidebar-width)-43px)] top-2.5 z-[1] grid size-8 place-items-center rounded-[7px] bg-transparent text-muted-foreground transition-[left] duration-150 hover:bg-muted hover:text-foreground group-[.sidebar-collapsed]:left-[88px]" type="button" onClick={onToggle} aria-label={label} title={label}>
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </Button>
    </div>
  );
}

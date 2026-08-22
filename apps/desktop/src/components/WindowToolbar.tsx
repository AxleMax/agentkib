import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { tr } from "../i18n";
import type { AppPlatform } from "../platform";

export function WindowToolbar({ collapsed, onToggle, platform = "web", fullscreen = false }: { collapsed: boolean; onToggle: () => void; platform?: AppPlatform; fullscreen?: boolean }) {
  const label = tr(collapsed ? "common.expandSidebar" : "common.collapseSidebar");
  const usesMacWindowChrome = platform === "macos" || platform === "web";
  const toolbarPosition = usesMacWindowChrome
    ? fullscreen ? "left-4" : "left-[88px]"
    : "left-[calc(var(--sidebar-width)-43px)] transition-[left] duration-150 group-[.sidebar-collapsed]:left-[88px]";

  return (
    <div className="pointer-events-auto fixed inset-x-auto left-0 top-0 z-[45] h-[var(--page-header-height)] w-[var(--sidebar-width)] bg-transparent" data-tauri-drag-region>
      <Button size="icon" className={cn("absolute top-[9px] z-[1] grid place-items-center rounded-[7px] bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground", toolbarPosition)} type="button" onClick={onToggle} aria-label={label} title={label}>
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </Button>
    </div>
  );
}

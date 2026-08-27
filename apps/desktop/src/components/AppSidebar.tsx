import { Button } from "@/components/ui/button";
import { useEffect, useId, useState, type ComponentType } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { tr } from "../core/i18n";
import { cn } from "@/lib/utils";
import { SidebarBrand } from "./SidebarBrand";

export interface SidebarEntry<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number }>;
  badge?: number;
}

export function AppSidebar<T extends string>({
  active,
  entries,
  onNavigate,
  onSettings,
  onBrandClick,
  onCollapsedChange,
}: {
  active: T;
  entries: SidebarEntry<T>[];
  onNavigate: (page: T) => void;
  onSettings: () => void;
  onBrandClick: () => void;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const sidebarId = useId();

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const navigate = (page: T) => {
    setMobileOpen(false);
    onNavigate(page);
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    onCollapsedChange(next);
  };

  return (
    <>
      <Button
        variant="bare"
        size="content"
        className={cn("sidebar-mobile-trigger", mobileOpen && "invisible")}
        type="button"
        aria-expanded={mobileOpen}
        aria-controls={sidebarId}
        aria-label={tr("common.primaryNavigation")}
        onClick={() => setMobileOpen(true)}
      >
        <Menu size={19} />
      </Button>
      {mobileOpen && (
        <button
          className="sidebar-mobile-backdrop"
          type="button"
          aria-label={tr("common.close")}
          onClick={() => setMobileOpen(false)}
        />
      )}
      <Button
        variant="bare"
        size="content"
        className="app-sidebar-collapse-button"
        type="button"
        aria-label={tr(collapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        aria-expanded={!collapsed}
        title={tr(collapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        onClick={toggleCollapsed}
      >
        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </Button>
      <aside
        id={sidebarId}
        className={cn(
          "app-sidebar",
          collapsed && "app-sidebar-collapsed",
          mobileOpen && "app-sidebar-open",
        )}
      >
        <div className="app-sidebar-content">
          <div className="app-sidebar-header">
            <SidebarBrand
              onClick={() => {
                setMobileOpen(false);
                onBrandClick();
              }}
            />
          </div>
          <nav className="app-sidebar-nav" aria-label={tr("common.primaryNavigation")}>
            {entries.map(({ id, label, icon: Icon, badge }) => (
              <Button
                key={id}
                variant="bare"
                size="content"
                className={cn("app-sidebar-item", active === id && "app-sidebar-item-active")}
                aria-current={active === id ? "page" : undefined}
                title={tr(label)}
                onClick={() => navigate(id)}
              >
                <span className="app-sidebar-item-icon">
                  <Icon size={18} />
                </span>
                <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                  {tr(label)}
                </span>
                {badge ? <em className="app-sidebar-item-badge">{badge}</em> : null}
              </Button>
            ))}
          </nav>
          <div className="app-sidebar-footer">
            <Button
              variant="bare"
              size="content"
              className="app-sidebar-item"
              type="button"
              title={tr("nav.settings")}
              onClick={() => {
                setMobileOpen(false);
                onSettings();
              }}
            >
              <span className="app-sidebar-item-icon">
                <Settings size={18} />
              </span>
              <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                {tr("nav.settings")}
              </span>
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

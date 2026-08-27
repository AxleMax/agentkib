import { Button } from "@/components/ui/button";
import logoUrl from "../assets/logo.svg";
import { useAppStore } from "@/stores/app-store";

export function SidebarBrand({ onClick }: { onClick: () => void }) {
  const appName = useAppStore((state) => state.runtime?.app_name ?? "AgentKib");
  return (
    <Button
      variant="bare"
      size="content"
      className="sidebar-brand"
      aria-label={appName}
      onClick={onClick}
    >
      <img className="sidebar-brand-mark" src={logoUrl} alt="" aria-hidden="true" />
      <span className="sidebar-brand-label">{appName}</span>
    </Button>
  );
}

import { Button } from "@/components/ui/button";
import logoUrl from "../assets/logo.svg";

export function SidebarBrand({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="bare"
      size="content"
      className="sidebar-brand"
      aria-label="AgentKib"
      onClick={onClick}
    >
      <img className="sidebar-brand-mark" src={logoUrl} alt="" aria-hidden="true" />
      <span className="sidebar-brand-label">AgentKib</span>
    </Button>
  );
}

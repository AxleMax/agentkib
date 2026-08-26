import { Button } from "@/components/ui/button";

export function SidebarBrand({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="bare"
      size="content"
      className="shrink-0 rounded-lg border-0 bg-transparent px-2 py-1 text-left text-[15px] font-semibold tracking-[-0.02em] text-primary transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label="AgentKib"
      onClick={onClick}
    >
      AgentKib
    </Button>
  );
}

import logoUrl from "../assets/logo.svg";

export function SidebarBrand() {
  return (
    <div className="flex h-11 items-center gap-3 px-2" aria-label="AgentKib">
      <span className="grid size-8 shrink-0 place-items-center">
        <img src={logoUrl} alt="" className="size-full object-contain" aria-hidden="true" />
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-sidebar-foreground">
        AgentKib
      </span>
    </div>
  );
}

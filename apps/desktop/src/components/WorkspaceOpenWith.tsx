import { useEffect, useRef, useState } from "react";
import { ChevronDown, Code2, FolderOpen, SquareTerminal } from "lucide-react";
import { api } from "../api";
import { localizeMessage, tr } from "../i18n";
import type { WorkspaceOpener, WorkspaceSummary } from "../types";

export function WorkspaceOpenWith({ workspace, onError }: { workspace: WorkspaceSummary; onError: (message: string) => void }) {
  const [openers, setOpeners] = useState<WorkspaceOpener[]>([]);
  const [opening, setOpening] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);

  const load = () => api.workspaceOpeners(workspace.id).then(setOpeners).catch((reason) => onError(localizeMessage(reason)));
  useEffect(() => { void load(); }, [workspace.id]);
  const preferred = openers.find((opener) => opener.preferred) ?? openers[0];

  const openWorkspace = async (openerId?: string) => {
    if (!preferred && !openerId) return;
    setOpening(true);
    onError("");
    try {
      await api.openWorkspaceWithApp(workspace.id, openerId);
      menu.current?.removeAttribute("open");
      if (openerId) await load();
    } catch (reason) {
      onError(localizeMessage(reason));
    } finally {
      setOpening(false);
    }
  };

  if (!preferred) return null;
  return <div className="workspace-open-with">
    <button className="ghost opener-main" disabled={opening} onClick={() => void openWorkspace()} title={tr("workspaceOpener.openWith", { app: preferred.name })}><OpenerIcon category={preferred.category} />{preferred.name}</button>
    <details ref={menu} className="opener-dropdown"><summary className="ghost" aria-label={tr("workspaceOpener.choose")} title={tr("workspaceOpener.choose")}><ChevronDown size={14} /></summary><div>{(["editor", "terminal", "file-manager"] as const).map((category) => {
      const values = openers.filter((opener) => opener.category === category);
      return values.length ? <section key={category}><span>{tr(`workspaceOpener.category.${category}`)}</span>{values.map((opener) => <button key={opener.id} onClick={() => void openWorkspace(opener.id)}><OpenerIcon category={opener.category} /><strong>{opener.name}</strong>{opener.preferred && <em>{tr("workspaceOpener.default")}</em>}</button>)}</section> : null;
    })}</div></details>
  </div>;
}

function OpenerIcon({ category }: { category: WorkspaceOpener["category"] }) {
  if (category === "terminal") return <SquareTerminal size={15} />;
  if (category === "file-manager") return <FolderOpen size={15} />;
  return <Code2 size={15} />;
}

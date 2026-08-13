import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ExternalLink, FolderOpen, Link2, Unlink } from "lucide-react";
import { api } from "../api";
import { localizeMessage, tr } from "../i18n";
import type { ObsidianIntegration } from "../types";

function InstallationStatus({ integration }: { integration: ObsidianIntegration }) {
  const { installation } = integration;
  return (
    <div className="obsidian-status">
      <span className={installation.installed ? "ready" : "status neutral"}>
        {tr(installation.installed ? "obsidian.installed" : "obsidian.notInstalled")}
      </span>
      {installation.version && <small>{tr("obsidian.version", { version: installation.version })}</small>}
      <small>{tr(installation.cli_available ? "obsidian.cliAvailable" : "obsidian.cliUnavailable")}</small>
    </div>
  );
}

export function ObsidianSettingsCard() {
  const [integration, setIntegration] = useState<ObsidianIntegration>();
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setError("");
      setIntegration(await api.obsidianIntegration());
    } catch (cause) {
      setError(localizeMessage(cause));
    }
  };

  useEffect(() => { void load(); }, []);

  const openApp = async () => {
    try {
      setError("");
      await api.openObsidian();
    } catch (cause) {
      setError(localizeMessage(cause));
    }
  };

  const addVault = async () => {
    const selected = await open({ directory: true, multiple: false, title: tr("obsidian.addVaultDialog") });
    if (typeof selected !== "string") return;
    try {
      setError("");
      setIntegration(await api.addObsidianVault(selected));
    } catch (cause) {
      setError(localizeMessage(cause));
    }
  };

  return (
    <div className="panel obsidian-card">
      <div className="panel-head">
        <div className="obsidian-heading">
          <div className="setting-icon"><Link2 /></div>
          <div><h2>{tr("obsidian.title")}</h2><p>{tr("obsidian.description")}</p></div>
        </div>
        <div className="header-actions">
          {integration?.installation.installed && <button className="ghost" onClick={() => void openApp()}><ExternalLink size={15} />{tr("obsidian.open")}</button>}
          <button className="primary" onClick={() => void addVault()}><FolderOpen size={15} />{tr("obsidian.addVault")}</button>
        </div>
      </div>
      {integration ? <InstallationStatus integration={integration} /> : <p>{tr("common.loading")}</p>}
      {integration?.installation.app_path && <code>{integration.installation.app_path}</code>}
      {error && <div className="alert">{error}</div>}
      <div className="obsidian-vaults">
        <h3>{tr("obsidian.vaults")}</h3>
        {integration?.vaults.map((vault) => (
          <div className="obsidian-vault-row" key={vault.path}>
            <FolderOpen size={16} />
            <span><strong>{vault.name}</strong><small>{vault.path}</small></span>
            <span className="status neutral">{tr(`obsidian.source.${vault.source}`)}</span>
          </div>
        ))}
        {integration && !integration.vaults.length && <p className="muted">{tr("obsidian.noVaults")}</p>}
      </div>
    </div>
  );
}

export function WorkspaceObsidianCard({ workspaceId }: { workspaceId: string }) {
  const [integration, setIntegration] = useState<ObsidianIntegration>();
  const [vaultPath, setVaultPath] = useState("");
  const [relativeTarget, setRelativeTarget] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setError("");
      const next = await api.obsidianIntegration();
      setIntegration(next);
      setVaultPath((current) => current || next.vaults[0]?.path || "");
    } catch (cause) {
      setError(localizeMessage(cause));
    }
  };

  useEffect(() => { void load(); }, [workspaceId]);
  const link = integration?.workspace_links.find((item) => item.workspace_id === workspaceId);

  const linkWorkspace = async () => {
    if (!vaultPath) return;
    try {
      setError("");
      await api.linkWorkspaceToObsidian(workspaceId, vaultPath, relativeTarget);
      await load();
    } catch (cause) {
      setError(localizeMessage(cause));
    }
  };

  const unlinkWorkspace = async () => {
    try {
      setError("");
      await api.unlinkWorkspaceFromObsidian(workspaceId);
      await load();
    } catch (cause) {
      setError(localizeMessage(cause));
    }
  };

  const openLinkedTarget = async () => {
    try {
      setError("");
      await api.openWorkspaceInObsidian(workspaceId);
    } catch (cause) {
      setError(localizeMessage(cause));
    }
  };

  return (
    <div className="panel obsidian-card workspace-obsidian-card">
      <div className="panel-head">
        <div><h2>{tr("obsidian.workspaceTitle")}</h2><p>{tr("obsidian.workspaceDescription")}</p></div>
        {link && <button className="ghost" onClick={() => void openLinkedTarget()}><ExternalLink size={15} />{tr("obsidian.open")}</button>}
      </div>
      {error && <div className="alert">{error}</div>}
      {!integration && <p>{tr("common.loading")}</p>}
      {integration && !integration.installation.installed && <p className="muted">{tr("obsidian.notInstalledWorkspace")}</p>}
      {integration?.installation.installed && link && (
        <div className="obsidian-linked-row">
          <Link2 size={17} />
          <span><strong>{tr("obsidian.linked")}</strong><small>{link.target_path}</small></span>
          <button className="ghost" onClick={() => void unlinkWorkspace()}><Unlink size={15} />{tr("obsidian.unlink")}</button>
        </div>
      )}
      {integration?.installation.installed && !link && integration.vaults.length > 0 && (
        <div className="obsidian-link-form">
          <label>{tr("obsidian.chooseVault")}<select value={vaultPath} onChange={(event) => setVaultPath(event.target.value)}>{integration.vaults.map((vault) => <option key={vault.path} value={vault.path}>{vault.name}</option>)}</select></label>
          <label>{tr("obsidian.relativeTarget")}<input value={relativeTarget} onChange={(event) => setRelativeTarget(event.target.value)} placeholder={tr("obsidian.relativeTargetHint")} /></label>
          <button className="primary" disabled={!vaultPath} onClick={() => void linkWorkspace()}><Link2 size={15} />{tr("obsidian.link")}</button>
        </div>
      )}
      {integration?.installation.installed && !link && !integration.vaults.length && <p className="muted">{tr("obsidian.addVaultFirst")}</p>}
    </div>
  );
}

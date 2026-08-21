import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useAppDialogs } from "./AppDialogProvider";
import { useState } from "react";
import { Pencil, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { api } from "../api";
import { formatDateTime, localizeMessage, tr } from "../i18n";
import type { RemoteGatewayAuthKind, RemoteGatewayInput, RemoteGatewayKind, RemoteGatewaySummary } from "../types";

const emptyGateway = (): RemoteGatewayInput => ({
  kind: "open-claw",
  name: "OpenClaw",
  url: "",
  auth_kind: "token",
});

function authKinds(kind: RemoteGatewayKind): RemoteGatewayAuthKind[] {
  return kind === "open-claw" ? ["token", "password", "none"] : ["session-token", "basic", "none"];
}

export function RemoteGatewaysSettings({ gateways, onChanged }: { gateways: RemoteGatewaySummary[]; onChanged: () => Promise<void> }) {
  const dialogs = useAppDialogs();
  const [draft, setDraft] = useState<RemoteGatewayInput>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState("");

  const edit = (gateway?: RemoteGatewaySummary) => {
    setError("");
    setDraft(gateway ? {
      id: gateway.id,
      kind: gateway.kind,
      name: gateway.name,
      url: gateway.url,
      auth_kind: gateway.auth_kind,
      username: gateway.username,
    } : emptyGateway());
  };

  const save = async () => {
    if (!draft) return;
    setBusyId(draft.id ?? "new");
    setError("");
    try {
      const saved = await api.saveRemoteGateway(draft);
      await api.refreshRemoteGateway(saved.id);
      setDraft(undefined);
      await onChanged();
    } catch (cause) {
      setError(localizeMessage(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  const refresh = async (id: string) => {
    setBusyId(id);
    setError("");
    try {
      await api.refreshRemoteGateway(id);
      await onChanged();
    } catch (cause) {
      setError(localizeMessage(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  const remove = async (id: string) => {
    if (!await dialogs.confirm({ description: tr("gateway.removeConfirm"), tone: "destructive" })) return;
    setBusyId(id);
    setError("");
    try {
      await api.removeRemoteGateway(id);
      await onChanged();
    } catch (cause) {
      setError(localizeMessage(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <Card className="panel settings-section remote-gateways">
      <div className="panel-head">
        <h2>{tr("gateway.title")}</h2>
        <Button className="primary" onClick={() => edit()}><Plus size={14} />{tr("gateway.add")}</Button>
      </div>
      {error && <div className="alert">{error}</div>}
      {draft && (
        <form className="remote-gateway-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Label><span>{tr("gateway.kind")}</span><SelectControl aria-label={tr("gateway.kind")} value={draft.kind} onChange={(event) => { const kind = event.target.value as RemoteGatewayKind; setDraft({ ...draft, kind, auth_kind: authKinds(kind)[0], name: draft.id ? draft.name : kind === "open-claw" ? "OpenClaw" : "Hermes" }); }}><option value="open-claw">OpenClaw</option><option value="hermes">Hermes</option></SelectControl></Label>
          <Label><span>{tr("gateway.name")}</span><Input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Label>
          <Label className="remote-gateway-url"><span>{tr("gateway.url")}</span><Input required type="url" value={draft.url} placeholder={draft.kind === "open-claw" ? "wss://gateway.example.com" : "https://hermes.example.com"} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></Label>
          <Label><span>{tr("gateway.auth")}</span><SelectControl aria-label={tr("gateway.auth")} value={draft.auth_kind} onChange={(event) => setDraft({ ...draft, auth_kind: event.target.value as RemoteGatewayAuthKind })}>{authKinds(draft.kind).map((kind) => <option value={kind} key={kind}>{tr(`gateway.auth.${kind}`)}</option>)}</SelectControl></Label>
          {draft.auth_kind === "basic" && <Label><span>{tr("gateway.username")}</span><Input required value={draft.username ?? ""} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></Label>}
          {draft.auth_kind !== "none" && <Label><span>{tr("gateway.secret")}</span><Input type="password" required={!draft.id || gateways.find((gateway) => gateway.id === draft.id)?.auth_kind !== draft.auth_kind} value={draft.secret ?? ""} placeholder={draft.id ? tr("gateway.secretKeep") : ""} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} /></Label>}
          <div className="remote-gateway-form-actions"><Button type="button" className="ghost" onClick={() => setDraft(undefined)}><X size={14} />{tr("common.cancel")}</Button><Button className="primary" disabled={Boolean(busyId)}>{tr("common.save")}</Button></div>
        </form>
      )}
      <div className="remote-gateway-list">
        {gateways.map((gateway) => (
          <article key={gateway.id}>
            <Server size={17} />
            <div className="remote-gateway-main">
              <div><strong>{gateway.name}</strong><Badge variant={gateway.state === "connected" ? "secondary" : "outline"}>{tr(`gateway.state.${gateway.state}`)}</Badge></div>
              <code>{gateway.url}</code>
              <small>{tr("gateway.workspaceCount", { count: gateway.workspaces.length })} · {tr("gateway.sessionCount", { count: gateway.session_count })} · {tr("gateway.assetCount", { count: gateway.assets.length })}{gateway.last_connected_at ? ` · ${formatDateTime(gateway.last_connected_at)}` : ""}</small>
              {gateway.kind === "hermes" && gateway.state === "connected" && <small className="gateway-partial">{tr("gateway.hermesPartial")}</small>}
              {gateway.pairing_request_id && <div className="gateway-pairing"><strong>{tr("gateway.pairingRequired")}</strong><code>openclaw devices approve {gateway.pairing_request_id}</code></div>}
              {gateway.last_error && <small className="gateway-error">{gateway.last_error}</small>}
            </div>
            <div className="remote-gateway-actions">
              <Button className="icon-button" title={tr("gateway.refresh")} disabled={Boolean(busyId)} onClick={() => void refresh(gateway.id)}><RefreshCw size={14} className={busyId === gateway.id ? "spin" : ""} /></Button>
              <Button className="icon-button" title={tr("gateway.edit")} disabled={Boolean(busyId)} onClick={() => edit(gateway)}><Pencil size={14} /></Button>
              <Button className="icon-danger" title={tr("gateway.remove")} disabled={Boolean(busyId)} onClick={() => void remove(gateway.id)}><Trash2 size={14} /></Button>
            </div>
          </article>
        ))}
        {!gateways.length && !draft && <div className="setting-empty">{tr("gateway.empty")}</div>}
      </div>
    </Card>
  );
}

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Copy, FileOutput, ShieldCheck, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { localizeMessage, tr } from "../i18n";
import type { AgentKind, ConversationSessionSummary, HandoffFormat, PlannedSessionHandoff, SessionHandoffDraft, SessionHandoffPreparation, SessionHandoffRequest, WorkspaceSummary } from "../types";

const targets: Array<[AgentKind, string]> = [
  ["codex", "Codex"], ["claude-code", "Claude Code"], ["cursor", "Cursor"],
  ["open-claw", "OpenClaw"], ["hermes", "Hermes"], ["deepseek-harness", "DeepSeek Harness"],
];

export function SessionHandoffDialog({
  workspace,
  session,
  targetAgents,
  onClose,
  onPlanned,
}: {
  workspace: WorkspaceSummary;
  session: ConversationSessionSummary;
  targetAgents: AgentKind[];
  onClose: () => void;
  onPlanned: (handoff: PlannedSessionHandoff) => void;
}) {
  const availableTargets = useMemo(
    () => targets.filter(([agent]) => agent === session.agent || targetAgents.includes(agent)),
    [session.agent, targetAgents],
  );
  const defaultTarget = availableTargets.find(([agent]) => agent !== session.agent)?.[0]
    ?? availableTargets[0]?.[0]
    ?? session.agent;
  const [targetAgent, setTargetAgent] = useState<AgentKind>(defaultTarget);
  const [format, setFormat] = useState<HandoffFormat>("markdown");
  const [draft, setDraft] = useState<SessionHandoffDraft>();
  const [summaryRequired, setSummaryRequired] = useState<Extract<SessionHandoffPreparation, { status: "summary-required" }>>();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const activeRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const identityRef = useRef({ workspaceId: workspace.id, sessionId: session.id });
  identityRef.current = { workspaceId: workspace.id, sessionId: session.id };

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  const captureIdentity = () => ({
    workspaceId: workspace.id,
    sessionId: session.id,
    generation: ++requestGenerationRef.current,
  });
  const isLatest = (identity: { generation: number }) => (
    activeRef.current && requestGenerationRef.current === identity.generation
  );
  const isCurrent = (identity: { workspaceId: string; sessionId: string; generation: number }) => (
    isLatest(identity)
    && identityRef.current.workspaceId === identity.workspaceId
    && identityRef.current.sessionId === identity.sessionId
  );

  const request = (): SessionHandoffRequest => ({
    session_id: session.id,
    target_agent: targetAgent,
    format,
  });

  const showDraft = (nextDraft: SessionHandoffDraft) => {
    setSummaryRequired(undefined);
    setDraft(nextDraft);
    setContent(nextDraft.content);
  };

  const prepare = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const preparation = await api.prepareSessionHandoff(request());
      if (!isCurrent(identity)) return;
      if (preparation.status === "ready") showDraft(preparation.draft);
      else setSummaryRequired(preparation);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const summarize = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setSummarizing(true);
    setError("");
    try {
      const nextDraft = await api.summarizeSessionHandoff(request());
      if (isCurrent(identity)) showDraft(nextDraft);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) {
        setBusy(false);
        setSummarizing(false);
      }
    }
  };

  const plan = async () => {
    if (!draft) return;
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const planned = await api.planSessionHandoff(workspace.id, draft.filename, draft.format, content, targetAgent);
      if (isCurrent(identity)) onPlanned(planned);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const copy = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const sanitized = await api.sanitizeSessionHandoff(format, content);
      if (!isCurrent(identity)) return;
      await navigator.clipboard?.writeText(sanitized);
      if (!isCurrent(identity)) return;
      setCopied(true);
      window.setTimeout(() => { if (activeRef.current) setCopied(false); }, 1200);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const reset = () => {
    requestGenerationRef.current += 1;
    setDraft(undefined);
    setSummaryRequired(undefined);
    setError("");
  };

  const sourceAgentName = agentName(summaryRequired?.source_agent ?? session.agent);
  const close = () => {
    activeRef.current = false;
    requestGenerationRef.current += 1;
    onClose();
  };

  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="panel handoff-dialog" showCloseButton={false}>
      <header><div><span className="eyebrow">Session Handoff</span><DialogTitle>{tr("handoff.title")}</DialogTitle><p>{tr("handoff.description")}</p></div><Button className="icon-button" onClick={close} aria-label={tr("common.close")}><X size={17} /></Button></header>
      {error && <div className="alert"><CircleAlert size={15} />{error}</div>}
      {draft ? <div className="handoff-preview">
        <div className="handoff-safety"><ShieldCheck size={16} /><span>{tr("handoff.redacted", { count: draft.redaction_count })}</span><code>{draft.filename}</code></div>
        <div className="handoff-context-summary">{tr(`handoff.context.${draft.context_source}`, { count: draft.included_message_count, tools: draft.omitted_tool_count })}</div>
        {draft.warnings.map((warning) => <div className="warning" key={warning}><CircleAlert size={14} />{tr(`handoff.warning.${warning}`)}</div>)}
        <Textarea aria-label={tr("handoff.preview")} value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
      </div> : summaryRequired ? <div className="handoff-summary-confirm">
        <div className="handoff-summary-icon"><Sparkles size={22} /></div>
        <div><h3>{tr("handoff.summaryRequired")}</h3><p>{tr("handoff.summaryReason", { count: summaryRequired.message_count, size: formatBytes(summaryRequired.estimated_bytes) })}</p></div>
        <div className="warning"><CircleAlert size={14} />{tr("handoff.summaryConsent", { agent: sourceAgentName })}</div>
      </div> : <div className="handoff-compose handoff-compose-simple">
        <div className="handoff-fields">
          <Label className="wide">{tr("handoff.target")}<SelectControl aria-label={tr("handoff.target")} value={targetAgent} disabled={busy} onChange={(event) => setTargetAgent(event.target.value as AgentKind)}>{availableTargets.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</SelectControl></Label>
          <div className="handoff-auto-context"><ShieldCheck size={16} /><div><strong>{tr("handoff.autoContext")}</strong><span>{tr("handoff.autoContextDetail")}</span></div></div>
          <Collapsible className="handoff-advanced"><CollapsibleTrigger>{tr("handoff.advanced")}</CollapsibleTrigger><CollapsibleContent><Label>{tr("handoff.format")}<SelectControl aria-label={tr("handoff.format")} value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as HandoffFormat)}><option value="markdown">Markdown</option><option value="json">JSON</option></SelectControl></Label></CollapsibleContent></Collapsible>
        </div>
      </div>}
      <footer>{draft ? <><Button className="ghost" disabled={busy} onClick={reset}>{tr("common.back")}</Button><Button className="ghost" disabled={busy} onClick={() => void copy()}><Copy size={14} />{tr(copied ? "handoff.copied" : "handoff.copy")}</Button><Button className="primary" disabled={busy} onClick={() => void plan()}><FileOutput size={14} />{tr("handoff.reviewSave")}</Button></> : summaryRequired ? <><Button className="ghost" disabled={busy} onClick={() => setSummaryRequired(undefined)}>{tr("common.cancel")}</Button><Button className="primary" disabled={busy} onClick={() => void summarize()}><Sparkles size={14} />{tr(summarizing ? "handoff.summarizing" : "handoff.summarizeWith", { agent: sourceAgentName })}</Button></> : <Button className="primary" disabled={busy} onClick={() => void prepare()}><FileOutput size={14} />{tr(busy ? "common.loading" : "handoff.prepare")}</Button>}</footer>
    </DialogContent>
  </Dialog>;
}

function agentName(agent: AgentKind) {
  return targets.find(([value]) => value === agent)?.[1] ?? agent;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

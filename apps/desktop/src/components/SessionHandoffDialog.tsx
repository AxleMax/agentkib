import { useMemo, useState } from "react";
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
    setBusy(true);
    setError("");
    try {
      const preparation = await api.prepareSessionHandoff(request());
      if (preparation.status === "ready") showDraft(preparation.draft);
      else setSummaryRequired(preparation);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const summarize = async () => {
    setBusy(true);
    setSummarizing(true);
    setError("");
    try {
      showDraft(await api.summarizeSessionHandoff(request()));
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
      setSummarizing(false);
    }
  };

  const plan = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      onPlanned(await api.planSessionHandoff(workspace.id, draft.filename, draft.format, content, targetAgent));
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    setBusy(true);
    setError("");
    try {
      const sanitized = await api.sanitizeSessionHandoff(format, content);
      await navigator.clipboard?.writeText(sanitized);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setDraft(undefined);
    setSummaryRequired(undefined);
    setError("");
  };

  const sourceAgentName = agentName(summaryRequired?.source_agent ?? session.agent);

  return <div className="modal-backdrop handoff-backdrop" role="presentation">
    <section className="panel handoff-dialog" role="dialog" aria-modal="true" aria-label={tr("handoff.title")}>
      <header><div><span className="eyebrow">Session Handoff</span><h2>{tr("handoff.title")}</h2><p>{tr("handoff.description")}</p></div><button className="icon-button" onClick={onClose} aria-label={tr("common.close")}><X size={17} /></button></header>
      {error && <div className="alert"><CircleAlert size={15} />{error}</div>}
      {draft ? <div className="handoff-preview">
        <div className="handoff-safety"><ShieldCheck size={16} /><span>{tr("handoff.redacted", { count: draft.redaction_count })}</span><code>{draft.filename}</code></div>
        <div className="handoff-context-summary">{tr(`handoff.context.${draft.context_source}`, { count: draft.included_message_count, tools: draft.omitted_tool_count })}</div>
        {draft.warnings.map((warning) => <div className="warning" key={warning}><CircleAlert size={14} />{tr(`handoff.warning.${warning}`)}</div>)}
        <textarea aria-label={tr("handoff.preview")} value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
      </div> : summaryRequired ? <div className="handoff-summary-confirm">
        <div className="handoff-summary-icon"><Sparkles size={22} /></div>
        <div><h3>{tr("handoff.summaryRequired")}</h3><p>{tr("handoff.summaryReason", { count: summaryRequired.message_count, size: formatBytes(summaryRequired.estimated_bytes) })}</p></div>
        <div className="warning"><CircleAlert size={14} />{tr("handoff.summaryConsent", { agent: sourceAgentName })}</div>
      </div> : <div className="handoff-compose handoff-compose-simple">
        <div className="handoff-fields">
          <label className="wide">{tr("handoff.target")}<select value={targetAgent} onChange={(event) => setTargetAgent(event.target.value as AgentKind)}>{availableTargets.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <div className="handoff-auto-context"><ShieldCheck size={16} /><div><strong>{tr("handoff.autoContext")}</strong><span>{tr("handoff.autoContextDetail")}</span></div></div>
          <details className="handoff-advanced"><summary>{tr("handoff.advanced")}</summary><label>{tr("handoff.format")}<select value={format} onChange={(event) => setFormat(event.target.value as HandoffFormat)}><option value="markdown">Markdown</option><option value="json">JSON</option></select></label></details>
        </div>
      </div>}
      <footer>{draft ? <><button className="ghost" onClick={reset}>{tr("common.back")}</button><button className="ghost" disabled={busy} onClick={() => void copy()}><Copy size={14} />{tr(copied ? "handoff.copied" : "handoff.copy")}</button><button className="primary" disabled={busy} onClick={() => void plan()}><FileOutput size={14} />{tr("handoff.reviewSave")}</button></> : summaryRequired ? <><button className="ghost" disabled={busy} onClick={() => setSummaryRequired(undefined)}>{tr("common.cancel")}</button><button className="primary" disabled={busy} onClick={() => void summarize()}><Sparkles size={14} />{tr(summarizing ? "handoff.summarizing" : "handoff.summarizeWith", { agent: sourceAgentName })}</button></> : <button className="primary" disabled={busy} onClick={() => void prepare()}><FileOutput size={14} />{tr(busy ? "common.loading" : "handoff.prepare")}</button>}</footer>
    </section>
  </div>;
}

function agentName(agent: AgentKind) {
  return targets.find(([value]) => value === agent)?.[1] ?? agent;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

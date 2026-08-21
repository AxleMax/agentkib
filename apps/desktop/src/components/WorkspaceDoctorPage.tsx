import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Minus, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { api } from "../api";
import { localizeMessage, tr } from "../i18n";
import type { ContextDoctorReport, DoctorAssetStatus, WorkspaceSummary } from "../types";
import { AgentIcon } from "./AgentIcon";

export function WorkspaceDoctorPage({
  workspace,
  onRepair,
}: {
  workspace: WorkspaceSummary;
  onRepair: () => Promise<void>;
}) {
  const [report, setReport] = useState<ContextDoctorReport>();
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    setReport(undefined);
    try {
      const nextReport = await api.workspaceDoctorReport(workspace.id);
      if (requestId === requestIdRef.current && nextReport.summary.workspace_id === workspace.id) {
        setReport(nextReport);
      }
    } catch (reason) {
      if (requestId === requestIdRef.current) setError(localizeMessage(reason));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    void load();
    return () => { requestIdRef.current += 1; };
  }, [load]);

  const activeReport = report?.summary.workspace_id === workspace.id ? report : undefined;

  const repair = async () => {
    setRepairing(true);
    setError("");
    try {
      await onRepair();
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setRepairing(false);
    }
  };

  if (loading && !activeReport) {
    return <div className="compact-state doctor-loading"><RefreshCw className="spin" size={20} /><span>{tr("doctor.running")}</span></div>;
  }

  return <div className="stack doctor-page">
    <Card className="panel doctor-summary">
      <div>
        <span className="eyebrow">Context Doctor</span>
        <h2>{tr("doctor.title")}</h2>
        <p>{tr("doctor.description")}</p>
      </div>
      <div className="doctor-summary-counts">
        <Badge variant="destructive"><strong>{activeReport?.summary.error_count ?? 0}</strong>{tr("doctor.errors")}</Badge>
        <Badge variant="outline"><strong>{activeReport?.summary.warning_count ?? 0}</strong>{tr("doctor.warnings")}</Badge>
        <Badge variant="secondary"><strong>{activeReport?.summary.repairable_count ?? 0}</strong>{tr("doctor.repairable")}</Badge>
      </div>
      <div className="doctor-actions">
        <Button className="ghost" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} />{tr("common.refresh")}</Button>
        <Button className="primary" onClick={() => void repair()} disabled={loading || repairing || !activeReport?.summary.repairable_count}><Wrench size={14} />{tr(repairing ? "doctor.planning" : "doctor.reviewRepair")}</Button>
      </div>
    </Card>
    {error && <div className="alert"><CircleAlert size={16} />{error}</div>}
    {activeReport && <Card className="panel doctor-matrix-panel">
      <div className="panel-head"><div><h2>{tr("doctor.matrix")}</h2><p>{tr("doctor.matrixDescription")}</p></div></div>
      <div className="doctor-matrix" role="table">
        <div className="doctor-matrix-row heading" role="row"><span>{tr("doctor.agent")}</span><span>Instructions</span><span>Skills</span><span>MCP</span></div>
        {activeReport.matrix.map((row) => <div className="doctor-matrix-row" role="row" key={row.agent}>
          <span className="doctor-agent"><AgentIcon agent={row.agent} /><strong>{agentLabel(row.agent)}</strong>{!row.writable && <em>{tr("doctor.readOnly")}</em>}</span>
          <DoctorCell value={row.instructions} />
          <DoctorCell value={row.skills} />
          <DoctorCell value={row.mcp} />
        </div>)}
      </div>
    </Card>}
    {activeReport && <Card className="panel doctor-issues">
      <div className="panel-head"><div><h2>{tr("doctor.issues")}</h2><p>{tr("doctor.deterministicOnly")}</p></div></div>
      {!activeReport.issues.length && <div className="compact-state"><ShieldCheck size={22} /><strong>{tr("doctor.allClear")}</strong></div>}
      {activeReport.issues.map((issue) => <article className={`doctor-issue ${issue.severity}`} key={issue.id}>
        <CircleAlert size={16} />
        <div><header><strong>{tr(`doctor.issue.${issue.code}`)}</strong><span className={`status ${issue.severity}`}>{tr(`doctor.severity.${issue.severity}`)}</span>{issue.repairable && <span className="tag"><Wrench size={11} />{tr("doctor.repairable")}</span>}</header>
          <p>{issue.agent ? `${agentLabel(issue.agent)} · ` : ""}{issue.asset_kind ? tr(`status.asset.${issue.asset_kind}`) : tr("doctor.workspace")}</p>
          {issue.evidence.map((evidence, index) => <div className="doctor-evidence" key={`${issue.id}-${index}`}>{evidence.path && <code>{evidence.path}</code>}<span>{evidence.detail}</span>{evidence.expected && <small>{tr("doctor.expected")}: {shortHash(evidence.expected)} · {tr("doctor.actual")}: {shortHash(evidence.actual ?? tr("doctor.missing"))}</small>}</div>)}
        </div>
      </article>)}
    </Card>}
  </div>;
}

function DoctorCell({ value }: { value: DoctorAssetStatus }) {
  const Icon = value.status === "healthy" ? Check : value.status === "not-applicable" ? Minus : CircleAlert;
  return <span className={`doctor-cell ${value.status}`}><Icon size={14} /><strong>{tr(`doctor.status.${value.status}`)}</strong><small>{value.actual} / {value.expected}</small></span>;
}

function agentLabel(agent: string) {
  return ({ codex: "Codex", "claude-code": "Claude Code", cursor: "Cursor", "open-claw": "OpenClaw", hermes: "Hermes", "deepseek-harness": "DeepSeek Harness" } as Record<string, string>)[agent] ?? agent;
}

function shortHash(value: string) {
  return /^[a-f\d]{32,}$/i.test(value) ? `${value.slice(0, 12)}…` : value;
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Binary,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FileQuestion,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  GitMerge,
  History,
  RefreshCw,
  Search,
  Tags,
} from "lucide-react";
import { api } from "../api";
import { formatDateTime, localizeMessage, tr } from "../i18n";
import type {
  GitCommitSummary,
  GitDiff,
  GitDiffKind,
  GitDiffRequest,
  GitFileChange,
  GitHistoryQuery,
  GitWorkingTreeChange,
  GitWorkspaceSummary,
  WorkspaceSummary,
} from "../types";

type GitSection = "history" | "worktree";

export type GitSubview =
  | { kind: "commit"; oid: string }
  | { kind: "worktree"; path: string; diffKind: GitDiffKind };

interface WorkspaceGitPageProps {
  workspace: WorkspaceSummary;
  subview?: GitSubview;
  onSubviewChange?: (subview?: GitSubview) => void;
}

type DiffState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: GitDiff }
  | { status: "empty" }
  | { status: "error"; message: string };

interface GraphEdge { from: number; to: number; color: number }
export interface CommitGraphRow { lane: number; lanes: number; edges: GraphEdge[]; continuation: boolean }

const graphColors = ["#7668e8", "#35a8d4", "#db8b3d", "#3da36f", "#c35f86", "#8d69c7"];

export function layoutCommitGraph(commits: GitCommitSummary[]): CommitGraphRow[] {
  let lanes: string[] = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(commit.oid);
    }
    const before = [...lanes];
    const after = before.filter((oid) => oid !== commit.oid);
    commit.parents.forEach((parent, parentIndex) => {
      if (!after.includes(parent)) after.splice(Math.min(lane + parentIndex, after.length), 0, parent);
    });
    const edges: GraphEdge[] = [];
    before.forEach((oid, from) => {
      if (oid === commit.oid) return;
      const to = after.indexOf(oid);
      if (to >= 0) edges.push({ from, to, color: stableColor(oid) });
    });
    commit.parents.forEach((parent) => {
      const to = after.indexOf(parent);
      if (to >= 0) edges.push({ from: lane, to, color: stableColor(parent) });
    });
    const row = {
      lane,
      lanes: Math.max(before.length, after.length, 1),
      edges,
      continuation: commit.parents.some((parent) => !commits.some((candidate) => candidate.oid === parent)),
    };
    lanes = after;
    return row;
  });
}

function stableColor(value: string) {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % graphColors.length;
}

export function WorkspaceGitPage({ workspace, subview, onSubviewChange }: WorkspaceGitPageProps) {
  const [section, setSection] = useState<GitSection>("history");
  const [internalSubview, setInternalSubview] = useState<GitSubview>();
  const [summary, setSummary] = useState<GitWorkspaceSummary>();
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedOid, setSelectedOid] = useState<string>();
  const [files, setFiles] = useState<GitFileChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>();
  const [selectedWorktree, setSelectedWorktree] = useState<{ path: string; kind: GitDiffKind }>();
  const [diffState, setDiffState] = useState<DiffState>({ status: "idle" });
  const [search, setSearch] = useState("");
  const [reference, setReference] = useState("");
  const [author, setAuthor] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [path, setPath] = useState("");
  const [mergesOnly, setMergesOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [error, setError] = useState("");
  const [mobileDetailPane, setMobileDetailPane] = useState<"files" | "diff">("files");
  const historySequence = useRef(0);
  const filesSequence = useRef(0);
  const diffSequence = useRef(0);
  const historyListRef = useRef<HTMLDivElement>(null);
  const worktreeListRef = useRef<HTMLElement>(null);
  const historyScrollTop = useRef(0);
  const worktreeScrollTop = useRef(0);
  const [appliedFilters, setAppliedFilters] = useState({ reference: "", author: "", since: "", until: "", path: "", mergesOnly: false });
  const activeSubview = onSubviewChange ? subview : internalSubview;
  const setSubview = (next?: GitSubview) => {
    if (onSubviewChange) onSubviewChange(next);
    else setInternalSubview(next);
  };

  const historyQuery = (): GitHistoryQuery => ({
    reference: appliedFilters.reference || undefined,
    author: appliedFilters.author.trim() || undefined,
    since: appliedFilters.since || undefined,
    until: appliedFilters.until || undefined,
    path: appliedFilters.path.trim() || undefined,
    merges_only: appliedFilters.mergesOnly,
  });

  const load = async () => {
    const sequence = ++historySequence.current;
    setLoading(true);
    setError("");
    setSelectedFile(undefined);
    setDiffState({ status: "idle" });
    try {
      const nextSummary = await api.workspaceGitSummary(workspace.id);
      if (sequence !== historySequence.current) return;
      setSummary(nextSummary);
      if (!nextSummary) {
        setCommits([]);
        setNextCursor(undefined);
        return;
      }
      const page = await api.workspaceGitHistory(workspace.id, historyQuery());
      if (sequence !== historySequence.current) return;
      setCommits(page?.commits ?? []);
      setNextCursor(page?.next_cursor);
      setSelectedOid((current) => page?.commits.some((commit) => commit.oid === current) ? current : page?.commits[0]?.oid);
    } catch (reason) {
      if (sequence === historySequence.current) setError(localizeMessage(reason));
    } finally {
      if (sequence === historySequence.current) setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [workspace.id, appliedFilters]);

  useEffect(() => {
    if (
      reference === appliedFilters.reference
      && author === appliedFilters.author
      && since === appliedFilters.since
      && until === appliedFilters.until
      && path === appliedFilters.path
      && mergesOnly === appliedFilters.mergesOnly
    ) return;
    const timeout = window.setTimeout(() => setAppliedFilters({ reference, author, since, until, path, mergesOnly }), 300);
    return () => window.clearTimeout(timeout);
  }, [reference, author, since, until, path, mergesOnly, appliedFilters]);

  const filteredCommits = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return commits;
    return commits.filter((commit) =>
      commit.subject.toLocaleLowerCase().includes(needle)
      || commit.oid.toLocaleLowerCase().startsWith(needle)
      || commit.refs.some((ref) => ref.name.toLocaleLowerCase().includes(needle)),
    );
  }, [commits, search]);
  const graph = useMemo(() => layoutCommitGraph(filteredCommits), [filteredCommits]);
  const detailOid = activeSubview?.kind === "commit" ? activeSubview.oid : undefined;
  const selectedCommit = commits.find((commit) => commit.oid === detailOid);
  const selectedWorktreeChange = summary?.changes.find((change) => change.path === selectedWorktree?.path);
  const selectedWorktreeIsUntracked = selectedWorktree?.kind === "worktree" && selectedWorktreeChange?.kind === "untracked";

  const loadCommitFiles = async (oid: string) => {
    const sequence = ++filesSequence.current;
    setFiles([]);
    setFilesError("");
    setFilesLoading(true);
    try {
      const nextFiles = await api.gitCommitFiles(workspace.id, oid);
      if (sequence === filesSequence.current) setFiles(nextFiles ?? []);
    } catch (reason) {
      if (sequence === filesSequence.current) setFilesError(localizeMessage(reason));
    } finally {
      if (sequence === filesSequence.current) setFilesLoading(false);
    }
  };

  useEffect(() => {
    setSelectedFile(undefined);
    if (!detailOid) {
      setFiles([]);
      setFilesError("");
      setFilesLoading(false);
      return;
    }
    void loadCommitFiles(detailOid);
  }, [workspace.id, detailOid]);

  useEffect(() => {
    if (activeSubview?.kind === "commit") {
      setSection("history");
      setSelectedOid(activeSubview.oid);
      setSelectedFile(undefined);
    } else if (activeSubview?.kind === "worktree") {
      setSection("worktree");
      setSelectedWorktree({ path: activeSubview.path, kind: activeSubview.diffKind });
    }
  }, [workspace.id, activeSubview?.kind, activeSubview?.kind === "commit" ? activeSubview.oid : activeSubview?.path]);

  useEffect(() => {
    if (!activeSubview) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSubview(undefined);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeSubview, onSubviewChange]);

  useLayoutEffect(() => {
    if (activeSubview) return;
    const frame = window.requestAnimationFrame(() => {
      if (section === "history" && historyListRef.current) historyListRef.current.scrollTop = historyScrollTop.current;
      if (section === "worktree" && worktreeListRef.current) worktreeListRef.current.scrollTop = worktreeScrollTop.current;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSubview, section]);

  const diffRequest = useMemo<GitDiffRequest | undefined>(() => {
    if (activeSubview?.kind === "commit") return { kind: "commit", oid: activeSubview.oid, path: selectedFile };
    if (activeSubview?.kind === "worktree" && !selectedWorktreeIsUntracked) {
      return selectedWorktree ?? { kind: activeSubview.diffKind };
    }
    return undefined;
  }, [activeSubview, selectedFile, selectedWorktree, selectedWorktreeIsUntracked]);

  const loadDiff = async (request: GitDiffRequest | undefined) => {
    const sequence = ++diffSequence.current;
    if (!request) {
      setDiffState({ status: "idle" });
      return;
    }
    setDiffState({ status: "loading" });
    try {
      const value = await api.gitDiff(workspace.id, request);
      if (sequence !== diffSequence.current) return;
      if (!value || (!value.patch.trim() && !value.binary && !value.submodule)) setDiffState({ status: "empty" });
      else setDiffState({ status: "ready", value });
    } catch (reason) {
      if (sequence === diffSequence.current) setDiffState({ status: "error", message: localizeMessage(reason) });
    }
  };

  useEffect(() => {
    void loadDiff(diffRequest);
  }, [workspace.id, diffRequest]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.workspaceGitHistory(workspace.id, { ...historyQuery(), cursor: nextCursor });
      setCommits((current) => [...current, ...(page?.commits ?? [])]);
      setNextCursor(page?.next_cursor);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setLoadingMore(false);
    }
  };

  const worktreeEntries = useMemo(() => worktreeRows(summary?.changes ?? []), [summary?.changes]);
  const worktreeDetailFiles = useMemo(() => {
    if (activeSubview?.kind !== "worktree") return [];
    return (summary?.changes ?? []).flatMap((change): GitFileChange[] => {
      if (activeSubview.diffKind === "staged") {
        return change.index_status ? [{ status: change.index_status, path: change.path, old_path: change.old_path }] : [];
      }
      if (change.kind === "untracked") return [{ status: "?", path: change.path, old_path: change.old_path }];
      return change.worktree_status || change.conflicted ? [{ status: change.worktree_status || "U", path: change.path, old_path: change.old_path }] : [];
    });
  }, [activeSubview, summary?.changes]);

  const enterCommit = (oid: string) => {
    historyScrollTop.current = historyListRef.current?.scrollTop ?? 0;
    setSelectedOid(oid);
    setSelectedFile(undefined);
    setMobileDetailPane("files");
    setSubview({ kind: "commit", oid });
  };

  const enterWorktree = (path: string, diffKind: GitDiffKind) => {
    worktreeScrollTop.current = worktreeListRef.current?.scrollTop ?? 0;
    setSelectedWorktree({ path, kind: diffKind });
    setMobileDetailPane("files");
    setSubview({ kind: "worktree", path, diffKind });
  };

  const showHistory = () => { setSection("history"); setSubview(undefined); };
  const showWorktree = () => { setSection("worktree"); setSubview(undefined); };

  if (summary && activeSubview) {
    const commitDetail = activeSubview.kind === "commit";
    const detailTitle = commitDetail ? selectedCommit?.subject : tr("git.worktreeDetail");
    return <div className="workspace-git git-detail-view">
      <div className="git-detail-toolbar">
        <button className="ghost git-detail-back" onClick={() => setSubview(undefined)}><ArrowLeft size={14} />{tr("git.backToGit")}</button>
        <div className="git-detail-title"><strong>{detailTitle || tr("git.untitledCommit")}</strong>{commitDetail && selectedCommit && <span><code>{selectedCommit.oid.slice(0, 7)}</code><em>{selectedCommit.author_name}</em><time>{formatDateTime(selectedCommit.authored_at)}</time><span className="git-ref-list">{selectedCommit.refs.map((ref) => <em key={ref.full_name} className={ref.kind}>{ref.name}</em>)}</span></span>}</div>
      </div>
      <div className={`git-detail-browser${mobileDetailPane === "diff" ? " mobile-show-diff" : ""}`}>
        <aside className="git-detail-files git-file-tree">
          {commitDetail ? <>
            <button className={`git-all-changes${selectedFile ? "" : " active"}`} onClick={() => { setSelectedFile(undefined); setMobileDetailPane("diff"); }}><GitCompareArrows size={13} /><span>{tr("git.allChanges")}</span><em>{filesLoading ? "…" : files.length}</em></button>
            {filesLoading && <div className="git-file-tree-status"><RefreshCw size={14} className="spin" />{tr("common.loading")}</div>}
            {!filesLoading && filesError && <div className="git-file-tree-status error"><CircleAlert size={14} /><span>{tr("git.filesFailed")}</span><button className="ghost" onClick={() => { if (detailOid) void loadCommitFiles(detailOid); }}>{tr("git.retry")}</button></div>}
            {!filesLoading && !filesError && files.length > 0 && <FileTree files={files} selectedPath={selectedFile} onSelect={(path) => { setSelectedFile(path); setMobileDetailPane("diff"); }} />}
            {!filesLoading && !filesError && files.length === 0 && <div className="git-file-tree-status"><FileQuestion size={14} />{tr("git.noFiles")}</div>}
          </> : <>
            <button className={`git-all-changes${selectedWorktree ? "" : " active"}`} onClick={() => { setSelectedWorktree(undefined); setMobileDetailPane("diff"); }}><GitCompareArrows size={13} /><span>{tr(activeSubview.diffKind === "staged" ? "git.allStagedChanges" : "git.allWorktreeChanges")}</span><em>{worktreeDetailFiles.length}</em></button>
            <FileTree files={worktreeDetailFiles} selectedPath={selectedWorktree?.path} onSelect={(path) => { setSelectedWorktree({ path, kind: activeSubview.diffKind }); setSubview({ kind: "worktree", path, diffKind: activeSubview.diffKind }); setMobileDetailPane("diff"); }} />
          </>}
        </aside>
        <GitDiffPane
          title={commitDetail ? (selectedFile || tr("git.allChanges")) : (selectedWorktree?.path || tr(activeSubview.diffKind === "staged" ? "git.allStagedChanges" : "git.allWorktreeChanges"))}
          fileCount={commitDetail && !selectedFile ? files.length : undefined}
          diffState={diffState}
          untracked={!commitDetail && selectedWorktreeIsUntracked}
          onRetry={() => void loadDiff(diffRequest)}
          onBackToFiles={() => setMobileDetailPane("files")}
        />
      </div>
    </div>;
  }

  return <div className="workspace-git">
    <div className="git-toolbar">
      <div className="section-tabs git-section-tabs" role="tablist" aria-label={tr("git.sectionLabel")}>
        <button role="tab" aria-selected={section === "history"} className={section === "history" ? "active" : ""} onClick={showHistory}><History size={14} />{tr("git.history")}</button>
        <button role="tab" aria-selected={section === "worktree"} className={section === "worktree" ? "active" : ""} onClick={showWorktree}><FileCode2 size={14} />{tr("git.worktree")} {summary?.changes.length ? <em>{summary.changes.length}</em> : null}</button>
      </div>
      {summary && <div className="git-head-meta"><GitBranch size={14} /><strong>{summary.head ?? tr("git.detached")}</strong>{summary.upstream && <span>{summary.upstream}</span>}{(summary.ahead > 0 || summary.behind > 0) && <span>↑{summary.ahead} ↓{summary.behind}</span>}{summary.stash_count > 0 && <span>{tr("git.stashes", { count: summary.stash_count })}</span>}</div>}
      <button className="ghost icon-only" onClick={() => void load()} disabled={loading} aria-label={tr("common.refresh")} title={tr("common.refresh")}><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
    </div>
    {error && <div className="alert"><CircleAlert size={15} />{error}</div>}
    {!loading && !summary && <div className="compact-state git-not-repository"><GitBranch size={19} /><span>{tr("git.notRepository")}</span></div>}
    {summary && section === "history" && <>
      <div className="git-filterbar">
        <div className="search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("git.searchPlaceholder")} /></div>
        <select value={reference} onChange={(event) => setReference(event.target.value)} aria-label={tr("git.reference")}><option value="">{tr("git.allRefs")}</option>{summary.refs.filter((ref) => ref.kind === "local-branch" || ref.kind === "remote-branch" || ref.kind === "tag").map((ref) => <option key={ref.full_name} value={ref.full_name}>{ref.name}</option>)}</select>
        <select value={mergesOnly ? "merges" : "all"} onChange={(event) => setMergesOnly(event.target.value === "merges")} aria-label={tr("git.commitKind")}><option value="all">{tr("git.allCommits")}</option><option value="merges">{tr("git.mergesOnly")}</option></select>
        <input value={author} onChange={(event) => setAuthor(event.target.value)} placeholder={tr("git.author")} aria-label={tr("git.author")} />
        <input type="date" value={since} onChange={(event) => setSince(event.target.value)} aria-label={tr("git.since")} />
        <input type="date" value={until} onChange={(event) => setUntil(event.target.value)} aria-label={tr("git.until")} />
        <input value={path} onChange={(event) => setPath(event.target.value)} placeholder={tr("git.path")} aria-label={tr("git.path")} />
      </div>
      <div className="git-list-surface">
        <section className="git-master git-master-full">
          <div ref={historyListRef} className="git-commit-list" role="listbox" aria-label={tr("git.history")}>
            {filteredCommits.map((commit, index) => <button key={commit.oid} role="option" aria-selected={selectedOid === commit.oid} className={selectedOid === commit.oid ? "active" : ""} onClick={() => enterCommit(commit.oid)}>
              <CommitGraph row={graph[index]} commit={commit} />
              <span className="git-commit-main"><strong>{commit.subject || tr("git.untitledCommit")}</strong><span className="git-ref-list">{commit.refs.map((ref) => <em key={ref.full_name} className={ref.kind}>{ref.kind === "tag" && <Tags size={10} />}{ref.name}</em>)}</span></span>
              <span className="git-commit-author">{commit.author_name}</span>
              <time>{formatDateTime(commit.authored_at)}</time>
              <ChevronRight size={14} />
            </button>)}
            {!filteredCommits.length && !loading && <div className="compact-state"><GitCommitHorizontal size={18} /><span>{tr("git.noCommits")}</span></div>}
          </div>
          {nextCursor && !search.trim() && <button className="ghost git-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{tr(loadingMore ? "common.loading" : "git.loadMore")}</button>}
        </section>
      </div>
    </>}
    {summary && section === "worktree" && <div className="git-list-surface">
      <section ref={worktreeListRef} className="git-master git-master-full git-worktree-list">
        {worktreeEntries.map(([group, entries]) => entries.length > 0 && <div className="git-change-group" key={group}><h3>{tr(`git.group.${group}`)}<em>{entries.length}</em></h3>{entries.map((entry) => <button key={`${entry.kind}:${entry.change.path}`} className={selectedWorktree?.path === entry.change.path && selectedWorktree.kind === entry.kind ? "active" : ""} onClick={() => enterWorktree(entry.change.path, entry.kind)}><ChangeIcon change={entry.change} /><span><strong>{fileName(entry.change.path)}</strong><small>{entry.change.old_path ? `${entry.change.old_path} → ${entry.change.path}` : entry.change.path}</small></span><em>{changeCode(entry.change, entry.kind)}</em><ChevronRight size={14} /></button>)}</div>)}
        {!summary.changes.length && <div className="compact-state"><GitCommitHorizontal size={18} /><span>{tr("git.clean")}</span></div>}
      </section>
    </div>}
  </div>;
}

function CommitGraph({ row, commit }: { row: CommitGraphRow; commit: GitCommitSummary }) {
  const width = Math.max(30, row.lanes * 16 + 12);
  const x = (lane: number) => lane * 16 + 10;
  return <svg className="git-graph" width={width} height="44" viewBox={`0 0 ${width} 44`} aria-hidden="true">
    {row.edges.map((edge, index) => <path key={`${edge.from}:${edge.to}:${index}`} d={`M ${x(edge.from)} 0 C ${x(edge.from)} 15, ${x(edge.to)} 28, ${x(edge.to)} 44`} stroke={graphColors[edge.color]} fill="none" strokeWidth="2" />)}
    <circle cx={x(row.lane)} cy="22" r={commit.parents.length > 1 ? 5 : 4} fill="var(--surface)" stroke={graphColors[stableColor(commit.oid)]} strokeWidth="2.5" />
    {commit.parents.length > 1 && <GitMerge x={x(row.lane) - 4} y={18} width="8" height="8" color={graphColors[stableColor(commit.oid)]} />}
  </svg>;
}

function GitDiffPane({ title, fileCount, diffState, onRetry, untracked, onBackToFiles }: {
  title: string;
  fileCount?: number;
  diffState: DiffState;
  onRetry: () => void;
  untracked?: boolean;
  onBackToFiles: () => void;
}) {
  const diff = diffState.status === "ready" ? diffState.value : undefined;
  return <div className="git-diff-view">
      <div className="git-diff-header">
        <button className="ghost git-mobile-files-back" onClick={onBackToFiles}><ArrowLeft size={14} />{tr("git.backToFiles")}</button>
        <strong>{title}</strong>
        {fileCount !== undefined && <span>{tr("git.fileCount", { count: fileCount })}</span>}
        {diff?.truncated && <em>{tr("git.truncated")}</em>}
      </div>
      {untracked && <div className="compact-state"><FileQuestion size={20} /><span>{tr("git.untrackedNoDiff")}</span></div>}
      {!untracked && diffState.status === "idle" && <div className="compact-state"><FileQuestion size={20} /><span>{tr("git.diffEmpty")}</span></div>}
      {!untracked && diffState.status === "loading" && <div className="compact-state"><RefreshCw size={16} className="spin" /><span>{tr("git.loadingDiff")}</span></div>}
      {!untracked && diffState.status === "empty" && <div className="compact-state"><FileQuestion size={20} /><span>{tr("git.diffEmpty")}</span></div>}
      {!untracked && diffState.status === "error" && <div className="compact-state git-diff-error"><CircleAlert size={18} /><span>{tr("git.diffFailed")}</span><small>{diffState.message}</small><button className="ghost" onClick={onRetry}>{tr("git.retry")}</button></div>}
      {diff?.binary && <div className="compact-state"><Binary size={18} /><span>{tr("git.binaryDiff")}</span></div>}
      {diff?.submodule && <div className="git-diff-notice"><GitBranch size={14} />{tr("git.submoduleDiff")}</div>}
      {diff?.encoding_lossy && <div className="git-diff-notice"><AlertTriangle size={14} />{tr("git.encodingLossy")}</div>}
      {diff && !diff.binary && diff.patch && <pre className="selectable">{diff.patch.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : ""}>{line || " "}</span>)}</pre>}
      {diff?.truncated && <div className="git-truncated"><AlertTriangle size={14} />{tr("git.diffTruncated")}</div>}
    </div>;
}

interface FileNode { name: string; path: string; children: Map<string, FileNode>; file?: GitFileChange }
function FileTree({ files, selectedPath, onSelect }: { files: GitFileChange[]; selectedPath?: string; onSelect: (path: string) => void }) {
  const root: FileNode = { name: "", path: "", children: new Map() };
  files.forEach((file) => {
    let current = root;
    file.path.split("/").forEach((name, index, parts) => {
      const path = parts.slice(0, index + 1).join("/");
      if (!current.children.has(name)) current.children.set(name, { name, path, children: new Map() });
      current = current.children.get(name)!;
    });
    current.file = file;
  });
  return <div>{[...root.children.values()].map((node) => <FileNodeRow key={node.path} node={node} selectedPath={selectedPath} onSelect={onSelect} />)}</div>;
}

function FileNodeRow({ node, selectedPath, onSelect }: { node: FileNode; selectedPath?: string; onSelect: (path: string) => void }) {
  if (node.file) return <button className={selectedPath === node.file.path ? "active" : ""} onClick={() => onSelect(node.file!.path)}><FileCode2 size={13} /><span>{node.name}</span><em>{node.file.status}</em></button>;
  return <details open><summary>{node.name}</summary><div>{[...node.children.values()].map((child) => <FileNodeRow key={child.path} node={child} selectedPath={selectedPath} onSelect={onSelect} />)}</div></details>;
}

function worktreeRows(changes: GitWorkingTreeChange[]) {
  const groups: Record<"conflicted" | "staged" | "unstaged" | "untracked", Array<{ change: GitWorkingTreeChange; kind: GitDiffKind }>> = { conflicted: [], staged: [], unstaged: [], untracked: [] };
  changes.forEach((change) => {
    if (change.conflicted) groups.conflicted.push({ change, kind: "worktree" });
    else if (change.kind === "untracked") groups.untracked.push({ change, kind: "worktree" });
    else {
      if (change.index_status) groups.staged.push({ change, kind: "staged" });
      if (change.worktree_status) groups.unstaged.push({ change, kind: "worktree" });
    }
  });
  return Object.entries(groups) as Array<[keyof typeof groups, Array<{ change: GitWorkingTreeChange; kind: GitDiffKind }>]>;
}

function ChangeIcon({ change }: { change: GitWorkingTreeChange }) {
  return change.conflicted ? <AlertTriangle size={14} /> : <FileCode2 size={14} />;
}
function changeCode(change: GitWorkingTreeChange, kind: GitDiffKind) { return kind === "staged" ? change.index_status : change.worktree_status; }
function fileName(path: string) { return path.split("/").pop() ?? path; }

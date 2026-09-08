import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Languages,
  MonitorSmartphone,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Unlink,
  X,
} from "lucide-react";
import {
  ApiError,
  WebClient,
  type Access,
  type Approval,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Decision,
  type Live,
} from "@agentkib/web-client";
import { Transcript } from "@agentkib/session-ui";
import { dictionaries, type Locale } from "./i18n";
const client = new WebClient();
export function Dialog({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button onClick={onClose} aria-label={closeLabel}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function App() {
  const [locale, setLocale] = useState<Locale>("zh-CN"),
    [theme, setTheme] = useState("system"),
    [accent, setAccent] = useState("blue");
  const t = dictionaries[locale];
  const [access, setAccess] = useState<Access>(),
    [sessions, setSessions] = useState<ConversationSessionSummary[]>([]),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState<ConversationEventPage>(),
    [live, setLive] = useState<Live>(),
    [online, setOnline] = useState(false),
    [indexEnabled, setIndexEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [notice, setNotice] = useState<"accepted" | "uncertain">(),
    [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [search, setSearch] = useState(""),
    [message, setMessage] = useState(""),
    [modal, setModal] = useState<"preferences" | "metadata" | ConversationEvent | Approval>();
  const generation = useRef(0),
    selection = useRef(""),
    accessRef = useRef<Access | undefined>(undefined),
    scroll = useRef<HTMLElement>(null),
    mutating = useRef(false);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
  }, [locale, theme, accent]);
  const clear = useCallback(() => {
    generation.current++;
    selection.current = "";
    setSelected("");
    setSessions([]);
    setPage(undefined);
    setLive(undefined);
    setModal(undefined);
    setMessage("");
    setSearch("");
    setNotice(undefined);
    setOnline(false);
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clear();
        const ended: Access = {
          status: "ended",
          csrfToken: "",
          bootId: "",
          experimentalEnabled: false,
        };
        accessRef.current = ended;
        setAccess(ended);
      } else if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(true);
        setOnline(false);
      }
    },
    [clear],
  );
  const syncAccess = useCallback(async () => {
    const g = generation.current;
    const next = await client.access();
    if (g !== generation.current) return;
    const old = accessRef.current;
    if (
      old?.status === "approved" &&
      (next.status !== "approved" ||
        old.bootId !== next.bootId ||
        old.device?.id !== next.device?.id)
    )
      clear();
    accessRef.current = next;
    setAccess(next);
    return next;
  }, [clear]);
  const refresh = useCallback(async () => {
    setError(false);
    setOnline(false);
    try {
      const next = await syncAccess();
      if (next?.status !== "approved") return;
      const g = generation.current;
      const catalog = await client.catalog();
      if (g !== generation.current) return;
      if (!catalog.indexEnabled) {
        clear();
        setIndexEnabled(false);
        return;
      }
      setIndexEnabled(true);
      setSessions(catalog.sessions);
      const id = selection.current;
      if (id) {
        const [history, state] = await Promise.all([client.events(id), client.live(id)]);
        if (g !== generation.current || selection.current !== id) return;
        setPage(history);
        setLive(state);
      }
      setOnline(true);
    } catch (e) {
      fail(e);
    }
  }, [syncAccess, fail, clear]);
  useEffect(() => {
    void refresh();
    let polling = false;
    const timer = setInterval(() => void refreshAccessOnly(), 4000);
    async function refreshAccessOnly() {
      if (polling) return;
      polling = true;
      try {
        const before = accessRef.current?.status;
        const next = await syncAccess();
        if (next?.status === "approved" && before !== "approved") void refresh();
        else if (next?.status === "approved") {
          const g = generation.current;
          const catalog = await client.catalog();
          if (g !== generation.current) return;
          if (!catalog.indexEnabled) {
            clear();
            setIndexEnabled(false);
          } else {
            setIndexEnabled(true);
            setSessions(catalog.sessions);
          }
        }
      } catch (e) {
        fail(e);
      } finally {
        polling = false;
      }
    }
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [refresh, syncAccess, fail, clear]);
  useEffect(() => {
    if (!selected || access?.status !== "approved") return;
    const id = selected,
      g = generation.current;
    let closed = false;
    const stream = new EventSource(`/api/web/v1/stream?${new URLSearchParams({ sessionId: id })}`);
    stream.addEventListener("snapshot", (event) => {
      if (closed || g !== generation.current || selection.current !== id) return;
      try {
        const state = JSON.parse((event as MessageEvent).data) as Live;
        if (state.sessionId !== id) return;
        setLive(state);
        setOnline(true);
      } catch {
        setOnline(false);
      }
    });
    stream.addEventListener("unavailable", () => {
      if (!closed) {
        clear();
        setError(true);
      }
    });
    stream.addEventListener("access-ended", () => {
      clear();
      accessRef.current = {
        status: "ended",
        csrfToken: "",
        bootId: "",
        experimentalEnabled: false,
      };
      setAccess(accessRef.current);
    });
    stream.onopen = () => {
      void (async () => {
        try {
          const next = await syncAccess();
          if (closed || g !== generation.current || next?.status !== "approved") return;
          const state = await client.live(id);
          if (!closed && g === generation.current && selection.current === id) {
            setLive(state);
            setOnline(true);
          }
        } catch (e) {
          fail(e);
        }
      })();
    };
    stream.onerror = () => {
      if (!closed) setOnline(false);
    };
    return () => {
      closed = true;
      stream.close();
    };
  }, [selected, access?.status, syncAccess, clear, fail]);
  useEffect(() => {
    if (!selected || !online || !live) return;
    const id = selected,
      g = generation.current;
    const timer = setTimeout(() => {
      void client
        .events(id)
        .then((latest) => {
          if (g !== generation.current || selection.current !== id) return;
          setPage((previous) => {
            if (!previous) return latest;
            const first = previous.events.findIndex((e) => e.id === latest.events[0]?.id);
            return first >= 0
              ? {
                  events: [...previous.events.slice(0, first), ...latest.events],
                  next_cursor: previous.next_cursor,
                  warnings: [...new Set([...previous.warnings, ...latest.warnings])],
                }
              : latest;
          });
        })
        .catch(fail);
    }, 500);
    return () => clearTimeout(timer);
  }, [selected, live?.revision, online, fail]);
  async function choose(id: string) {
    generation.current++;
    selection.current = id;
    setSelected(id);
    setPage(undefined);
    setLive(undefined);
    setModal(undefined);
    setMessage("");
    setNotice(undefined);
    setOnline(false);
    setError(false);
    const g = generation.current;
    try {
      const [history, state] = await Promise.all([client.events(id), client.live(id)]);
      if (g !== generation.current) return;
      setPage(history);
      setLive(state);
      setOnline(true);
      scroll.current?.scrollTo?.({ top: 0 });
    } catch (e) {
      fail(e);
    }
  }
  async function post(path: string, body: unknown) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError(false);
    try {
      await client.request(path, body);
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  async function pair(e: FormEvent) {
    e.preventDefault();
    await post("pair", { code, name: name.trim() || "Web" });
    setCode("");
  }
  async function earlier() {
    if (!page?.next_cursor || busy) return;
    setBusy(true);
    const id = selected,
      g = generation.current;
    const viewport = scroll.current;
    const anchor = viewport?.querySelector<HTMLElement>("[data-event-id]");
    const top = anchor?.getBoundingClientRect().top;
    const anchorId = anchor?.dataset.eventId;
    try {
      const older = await client.events(id, page.next_cursor);
      if (g !== generation.current || selection.current !== id) return;
      setPage((current) =>
        current
          ? {
              events: [...older.events, ...current.events].filter(
                (e, i, a) => a.findIndex((x) => x.id === e.id) === i,
              ),
              next_cursor: older.next_cursor,
              warnings: [...new Set([...older.warnings, ...current.warnings])],
            }
          : older,
      );
      requestAnimationFrame(() => {
        if (anchorId && top !== undefined && viewport) {
          const node = Array.from(viewport.querySelectorAll<HTMLElement>("[data-event-id]")).find(
            (n) => n.dataset.eventId === anchorId,
          );
          if (node) viewport.scrollTop += node.getBoundingClientRect().top - top;
        }
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function control(kind: "send" | "approve", approval?: Approval, decision?: Decision) {
    if (mutating.current || !access || !live || !online) return;
    mutating.current = true;
    setBusy(true);
    setNotice(undefined);
    const g = generation.current,
      id = selected;
    try {
      await client.request(kind, {
        sessionId: id,
        requestId: crypto.randomUUID(),
        bootId: access.bootId,
        expectedRevision: live.revision,
        ...(kind === "send"
          ? { text: message.trim() }
          : { turnId: approval!.turnId, approvalId: approval!.requestId, decision }),
      });
      if (g !== generation.current) return;
      setNotice("accepted");
      if (kind === "send") setMessage("");
      setModal(undefined);
      await refresh();
    } catch (e) {
      if (g === generation.current) {
        setNotice("uncertain");
        setOnline(false);
        fail(e);
      }
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  const current = sessions.find((s) => s.id === selected);
  const canSend =
    online &&
    !busy &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    !!live?.sendEnabled &&
    live.status === "idle";
  const liveText =
    live?.status === "idle"
      ? t.idle
      : live?.status === "running"
        ? t.running
        : live?.reason
          ? t.unavailable
          : t.unknown;
  const icon = <span className="brand-mark">K</span>;
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          {icon}
          <div>
            <strong>AgentKib</strong>
            <small>{t.remote}</small>
          </div>
          <span className="badge">Web</span>
        </div>
        <button aria-label={t.preferences} onClick={() => setModal("preferences")}>
          <Settings2 size={19} />
        </button>
      </header>
      {error && (
        <div role="alert" className="banner danger">
          {t.error} <button onClick={() => void refresh()}>{t.retry}</button>
        </div>
      )}
      {!access ? (
        <main className="center">
          <p role="status">{t.loading}</p>
        </main>
      ) : access.status === "unpaired" ? (
        <main className="pair-page">
          <div className="hero-icon">
            <MonitorSmartphone size={30} />
          </div>
          <h1>{t.pairTitle}</h1>
          <p>{t.pairInfo}</p>
          <form onSubmit={pair}>
            <label>
              {t.code}
              <input
                className="code"
                value={code}
                inputMode="numeric"
                pattern="[0-9]{8}"
                minLength={8}
                maxLength={8}
                autoComplete="one-time-code"
                required
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </label>
            <label>
              {t.name}
              <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>
            <aside className="info">
              <ShieldCheck size={19} />
              <span>{t.scope}</span>
            </aside>
            <button className="primary" disabled={busy || code.length !== 8}>
              {t.pair}
              <ChevronRight size={17} />
            </button>
          </form>
          <small className="muted">{t.safety}</small>
        </main>
      ) : access.status === "pending" ? (
        <main className="pair-page">
          <div className="hero-icon amber">
            <ShieldCheck size={30} />
          </div>
          <h1>{t.pending}</h1>
          <p>{t.verify}</p>
          <strong className="verification">{access.pending?.verification}</strong>
          {access.pending?.expiresAt && (
            <small>
              {t.expires} {new Date(access.pending.expiresAt).toLocaleString(locale)}
            </small>
          )}
          <aside className="info">{t.scope}</aside>
          <button onClick={() => void post("pair/cancel", {})} disabled={busy}>
            {t.cancel}
          </button>
        </main>
      ) : access.status === "ended" ? (
        <main className="pair-page">
          <div className="hero-icon red">
            <Unlink size={30} />
          </div>
          <h1>{t.ended}</h1>
          <p>{t.endedInfo}</p>
          <button className="primary" onClick={() => void post("logout", {})}>
            {t.again}
          </button>
        </main>
      ) : (
        <div className={`workspace ${selected ? "has-selection" : ""}`}>
          <aside className="catalog">
            <header>
              <h1>{t.sessions}</h1>
              <button aria-label={t.refresh} onClick={() => void refresh()}>
                <RefreshCw size={18} />
              </button>
            </header>
            <label className="search">
              <Search size={16} />
              <input
                placeholder={t.search}
                aria-label={t.search}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="catalog-list">
              {!indexEnabled ? (
                <p>{t.indexDisabled}</p>
              ) : (
                sessions
                  .filter((s) => (s.title ?? "").toLowerCase().includes(search.toLowerCase()))
                  .map((s) => (
                    <button
                      className={`session ${s.id === selected ? "selected" : ""}`}
                      key={s.id}
                      onClick={() => void choose(s.id)}
                    >
                      <span className="agent-dot">⌘</span>
                      <span>
                        <strong>{s.title || t.untitled}</strong>
                        <small>
                          {s.agent} · {s.workspace_id}
                        </small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))
              )}
              {indexEnabled && sessions.length === 0 && <p className="empty">{t.empty}</p>}
            </div>
            <footer>
              <small>
                {t.device}: {access.device?.name}
              </small>
              <button onClick={() => void post("logout", {})}>{t.logout}</button>
            </footer>
          </aside>
          <main className="reader">
            {!selected ? (
              <div className="center">
                <MonitorSmartphone size={34} />
                <h2>{t.select}</h2>
                <p>{t.selectInfo}</p>
              </div>
            ) : (
              <>
                <header className="reader-header">
                  <button
                    aria-label={t.back}
                    onClick={() => {
                      generation.current++;
                      selection.current = "";
                      setSelected("");
                      setPage(undefined);
                      setLive(undefined);
                      setModal(undefined);
                    }}
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <h1>{current?.title || t.untitled}</h1>
                  <button aria-label={t.details} onClick={() => setModal("metadata")}>
                    <Settings2 size={18} />
                  </button>
                  <button aria-label={t.refresh} onClick={() => void refresh()}>
                    <RefreshCw size={18} />
                  </button>
                </header>
                <div className="reader-state">
                  <span>{t.history}</span>
                  <span className={online ? "" : "warning"}>
                    {online ? `${t.live} · ${liveText}` : t.offline}
                  </span>
                </div>
                <section className="reader-scroll" ref={scroll}>
                  {page?.warnings.length ? (
                    <aside className="banner warning">
                      {t.warnings}: {page.warnings.join(" · ")}
                    </aside>
                  ) : null}
                  {page?.next_cursor && (
                    <button className="earlier" disabled={busy} onClick={() => void earlier()}>
                      {t.earlier}
                    </button>
                  )}
                  {!page ? (
                    <p role="status">{t.loading}</p>
                  ) : (
                    <Transcript
                      key={selected}
                      events={page.events}
                      incomplete={page.warnings.length > 0}
                      labels={t}
                      onTool={setModal}
                      locale={locale}
                    />
                  )}
                </section>
                {live?.approvals.map((a) => (
                  <button key={a.requestId} className="approval-banner" onClick={() => setModal(a)}>
                    <ShieldCheck size={19} />
                    {t.approval}
                    <ChevronRight size={18} />
                  </button>
                ))}
                {notice && (
                  <p role="status" className="notice">
                    {t[notice]}
                  </p>
                )}
                {access.experimentalEnabled && access.device?.send ? (
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (canSend && message.trim()) void control("send");
                    }}
                  >
                    <label className="sr-only" htmlFor="message">
                      {t.message}
                    </label>
                    <textarea
                      id="message"
                      value={message}
                      maxLength={32000}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder={t.message}
                      disabled={!online || busy}
                    />
                    <div>
                      <small>
                        {t.experimental} · {t.controlInfo}
                      </small>
                      <button
                        className="send"
                        aria-label={t.send}
                        disabled={!canSend || !message.trim()}
                      >
                        <ArrowUp size={20} />
                      </button>
                    </div>
                  </form>
                ) : (
                  <footer className="readonly">{t.readOnly}</footer>
                )}
              </>
            )}
          </main>
        </div>
      )}
      {modal === "preferences" && (
        <Dialog closeLabel={t.close} title={t.preferences} onClose={() => setModal(undefined)}>
          <div className="preferences">
            <label>
              <Languages size={16} />
              {t.language}
              <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                <option value="zh-CN">简体中文</option>
                <option value="zh-TW">繁體中文</option>
                <option value="en-US">English</option>
                <option value="ja-JP">日本語</option>
              </select>
            </label>
            <label>
              {t.theme}
              <select value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="system">{t.system}</option>
                <option value="light">{t.light}</option>
                <option value="dark">{t.dark}</option>
              </select>
            </label>
            <label>
              {t.accent}
              <select value={accent} onChange={(e) => setAccent(e.target.value)}>
                <option value="blue">{t.blue}</option>
                <option value="violet">{t.violet}</option>
                <option value="green">{t.green}</option>
              </select>
            </label>
          </div>
        </Dialog>
      )}
      {modal === "metadata" && (
        <Dialog closeLabel={t.close} title={t.metadata} onClose={() => setModal(undefined)}>
          <dl>
            <dt>{t.agent}</dt>
            <dd>{current?.agent}</dd>
            <dt>{t.workspace}</dt>
            <dd>{current?.workspace_id}</dd>
            <dt>{t.status}</dt>
            <dd>{online ? liveText : t.unknown}</dd>
          </dl>
          <p>{t.scope}</p>
        </Dialog>
      )}
      {typeof modal === "object" && "kind" in modal && (
        <Dialog closeLabel={t.close} title={t.tool} onClose={() => setModal(undefined)}>
          <h3>{modal.tool_name || t.unknownTool}</h3>
          <p>{modal.tool_status}</p>
          {modal.timestamp && <time>{new Date(modal.timestamp).toLocaleString(locale)}</time>}
          <pre>{modal.content || t.history}</pre>
          {modal.truncated && <p>{t.truncated}</p>}
        </Dialog>
      )}
      {typeof modal === "object" && "requestId" in modal && (
        <Dialog closeLabel={t.close} title={t.approval} onClose={() => setModal(undefined)}>
          <p>{t.decisionInfo}</p>
          {modal.cwd && (
            <dl>
              <dt>{t.cwd}</dt>
              <dd>{modal.cwd}</dd>
            </dl>
          )}
          <pre>{JSON.stringify(modal.command ?? modal.changes ?? null, null, 2)}</pre>
          {modal.supported &&
          access?.experimentalEnabled &&
          access.device?.approve &&
          online &&
          live?.approvals.some(
            (a) => a.requestId === modal.requestId && a.turnId === modal.turnId,
          ) ? (
            <div className="decision-actions">
              {modal.availableDecisions
                .filter((d) => ["accept", "decline", "cancel"].includes(d))
                .map((d) => (
                  <button
                    key={d}
                    className={d === "accept" ? "primary" : ""}
                    disabled={busy}
                    onClick={() => void control("approve", modal, d)}
                  >
                    {d === "accept" && <Check size={16} />} {d === "cancel" ? t.cancelTurn : t[d]}
                  </button>
                ))}
            </div>
          ) : (
            <aside className="info">{t.approvalFallback}</aside>
          )}
        </Dialog>
      )}
    </div>
  );
}

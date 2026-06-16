import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Database,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe2,
  Link2,
  Loader2,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Search,
  Timer,
  Trash2
} from "lucide-react";
import type { CrawlComplete, CrawlProgress, CrawlStatus } from "../shared/types";

const initialProgress: CrawlProgress = {
  processed: 0,
  queued: 0,
  totalDiscovered: 0,
  percent: 0
};

type LogKind = "info" | "success" | "warning" | "error";
type LogTab = "all" | "issues";
type ResourceMode = "all" | "pages" | "assets" | "issues";

interface LogEntry {
  raw: string;
  time: string;
  message: string;
  kind: LogKind;
}

interface ResourceRow {
  url: string;
  time: string;
  status: "queued" | "opening" | "saved" | "warning" | "error" | "info";
  type: string;
  savedPath: string;
  message: string;
}

function App(): JSX.Element {
  const [url, setUrl] = useState("");
  const [depth, setDepth] = useState(5);
  const [folder, setFolder] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<CrawlProgress>(initialProgress);
  const [status, setStatus] = useState<CrawlStatus>("idle");
  const [result, setResult] = useState<CrawlComplete | null>(null);
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [logTab, setLogTab] = useState<LogTab>("all");
  const [resourceMode, setResourceMode] = useState<ResourceMode>("all");
  const [resourceSearch, setResourceSearch] = useState("");
  const logWindowRef = useRef<HTMLDivElement | null>(null);

  const isRunning = status === "running";
  const canStart = useMemo(() => url.trim().length > 0 && folder.trim().length > 0 && !isRunning, [folder, isRunning, url]);

  const logEntries = useMemo(() => logs.map(parseLogEntry), [logs]);
  const issueEntries = useMemo(() => logEntries.filter((entry) => entry.kind === "error" || entry.kind === "warning"), [logEntries]);
  const errorEntries = useMemo(() => logEntries.filter((entry) => entry.kind === "error"), [logEntries]);
  const visibleLogs = logTab === "issues" ? issueEntries : logEntries;
  const resourceRows = useMemo(() => buildResourceRows(logEntries), [logEntries]);
  const visibleResources = useMemo(
    () =>
      resourceRows.filter((row) => {
        const matchesMode =
          resourceMode === "all" ||
          (resourceMode === "pages" && row.type === "document") ||
          (resourceMode === "assets" && row.type !== "document") ||
          (resourceMode === "issues" && (row.status === "error" || row.status === "warning"));
        const query = resourceSearch.trim().toLowerCase();
        const matchesSearch = !query || row.url.toLowerCase().includes(query) || row.savedPath.toLowerCase().includes(query);

        return matchesMode && matchesSearch;
      }),
    [resourceMode, resourceRows, resourceSearch]
  );

  const errorCount = result?.errors ?? errorEntries.length;
  const issueCount = issueEntries.length;
  const foundCount = Math.max(progress.totalDiscovered, progress.processed + progress.queued);
  const targetCount = Math.max(foundCount, progress.processed, 1);
  const speed = elapsedMs > 0 ? progress.processed / (elapsedMs / 1000) : 0;
  const startedAtLabel = startedAt ? formatTime(startedAt) : "-";
  const lastIssue = error || issueEntries.at(-1)?.message || "No issues reported";
  const percent = clamp(progress.percent, 0, 100);
  const completedShare = foundCount > 0 ? clamp((progress.processed / foundCount) * 100, 0, 100) : 0;
  const queuedShare = foundCount > 0 ? clamp((progress.queued / foundCount) * 100, 0, 100 - completedShare) : 0;
  const issueShare = foundCount > 0 ? clamp((issueCount / Math.max(foundCount, issueCount)) * 100, 0, 100 - completedShare - queuedShare) : 0;
  const summaryRingStyle = {
    background: `conic-gradient(#20b678 0 ${completedShare}%, #f4a83a ${completedShare}% ${
      completedShare + queuedShare
    }%, #ef4444 ${completedShare + queuedShare}% ${completedShare + queuedShare + issueShare}%, #d8dee8 ${
      completedShare + queuedShare + issueShare
    }% 100%)`
  };

  useEffect(() => {
    const removeLog = window.siteMirror.onLog((line) => {
      setLogs((current) => [...current, line]);
    });
    const removeProgress = window.siteMirror.onProgress(setProgress);

    return () => {
      removeLog();
      removeProgress();
    };
  }, []);

  useEffect(() => {
    const logWindow = logWindowRef.current;
    if (logWindow) {
      logWindow.scrollTop = logWindow.scrollHeight;
    }
  }, [visibleLogs]);

  useEffect(() => {
    if (!isRunning || startedAt === null) {
      return undefined;
    }

    const updateElapsed = () => setElapsedMs(Date.now() - startedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);

    return () => window.clearInterval(timer);
  }, [isRunning, startedAt]);

  async function chooseFolder(): Promise<void> {
    const selected = await window.siteMirror.selectOutputDirectory();
    if (selected) {
      setFolder(selected);
      setError("");
    }
  }

  async function startCrawl(): Promise<void> {
    if (!canStart) {
      setError("Enter a URL and choose a save folder.");
      return;
    }

    setStatus("running");
    setResult(null);
    setError("");
    setLogs([]);
    setProgress(initialProgress);
    const runStartedAt = Date.now();
    setStartedAt(runStartedAt);
    setElapsedMs(0);

    try {
      const completed = await window.siteMirror.startCrawl({
        startUrl: url,
        maxDepth: depth,
        outputDir: folder
      });
      setResult(completed);
      setStatus("complete");
      setProgress((current) => ({ ...current, percent: 100 }));
      setElapsedMs(Date.now() - runStartedAt);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setStatus("error");
      setError(message);
      setElapsedMs(Date.now() - runStartedAt);
      setLogs((current) => [...current, `[${new Date().toLocaleTimeString()}] Error: ${message}`]);
    }
  }

  async function openSavedCopy(): Promise<void> {
    try {
      await window.siteMirror.openSavedCopy();
      setError("");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
    }
  }

  async function openSavedCopyExternal(): Promise<void> {
    try {
      await window.siteMirror.openSavedCopyExternal();
      setError("");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
    }
  }

  function resetRun(): void {
    setLogs([]);
    setProgress(initialProgress);
    setResult(null);
    setStatus("idle");
    setError("");
    setStartedAt(null);
    setElapsedMs(0);
    setLogTab("all");
    setResourceSearch("");
  }

  function clearLogs(): void {
    setLogs([]);
    setLogTab("all");
    setResourceSearch("");
  }

  return (
    <main className="app-shell">
      <section className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Globe2 size={27} />
          </div>
          <div>
            <h1>Site Mirror</h1>
            <p>Browsertrix WACZ crawler</p>
          </div>
        </div>

        <div className="run-strip" aria-live="polite">
          <div className={`status-pill status-${status}`}>
            <span />
            {statusLabel(status)}
          </div>
          <div className="started-at">Started: {startedAtLabel}</div>
          {result ? (
            <>
              <button className="secondary-action open-action" type="button" title="Open local site in app" onClick={openSavedCopy}>
                <ExternalLink size={18} aria-hidden="true" />
                Open in app
              </button>
              <button
                className="secondary-action open-action"
                type="button"
                title="Open local site in default browser"
                onClick={openSavedCopyExternal}
              >
                <Globe2 size={18} aria-hidden="true" />
                Open in browser
              </button>
            </>
          ) : null}
        </div>
      </section>

      <section className="hero-grid">
        <form
          className="panel settings-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void startCrawl();
          }}
        >
          <div className="panel-heading">
            <h2>Crawl settings</h2>
          </div>

          <label className="field">
            <span>URL</span>
            <div className="input-shell">
              <Link2 size={17} aria-hidden="true" />
              <input
                type="url"
                placeholder="https://example.com"
                value={url}
                disabled={isRunning}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
          </label>

          <div className="settings-row">
            <label className="field depth-control">
              <span>Depth</span>
              <div className="number-stepper">
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={depth}
                  disabled={isRunning}
                  onChange={(event) => setDepth(clamp(Math.trunc(Number(event.target.value) || 0), 0, 50))}
                />
                <div className="stepper-buttons">
                  <button
                    className="icon-button"
                    type="button"
                    title="Decrease depth"
                    disabled={isRunning || depth <= 0}
                    onClick={() => setDepth((current) => Math.max(0, current - 1))}
                  >
                    <Minus size={16} aria-hidden="true" />
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="Increase depth"
                    disabled={isRunning || depth >= 50}
                    onClick={() => setDepth((current) => Math.min(50, current + 1))}
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </label>
          </div>

          <label className="field">
            <span>Save folder</span>
            <div className="input-shell folder-shell">
              <FolderOpen size={17} aria-hidden="true" />
              <input type="text" value={folder} readOnly placeholder="Choose a folder" />
              <button className="browse-button" type="button" title="Choose save folder" disabled={isRunning} onClick={chooseFolder}>
                <FolderOpen size={17} aria-hidden="true" />
                Browse
              </button>
            </div>
          </label>

          <div className="form-actions">
            <button className="primary-action" type="submit" disabled={!canStart}>
              {isRunning ? <Loader2 className="spin" size={19} aria-hidden="true" /> : <Play size={19} aria-hidden="true" />}
              Start crawl
            </button>
            <button className="secondary-action" type="button" disabled={isRunning} onClick={resetRun}>
              <RotateCcw size={18} aria-hidden="true" />
              Reset
            </button>
          </div>
        </form>

        <section className="panel progress-panel" aria-live="polite">
          <div className="panel-heading">
            <h2>Crawl progress</h2>
          </div>

          <div className="metric-grid">
            <div className="metric-card progress-card">
              <div>
                <span className="metric-label">Progress</span>
                <strong>{percent}%</strong>
                <small>
                  {progress.processed} / {targetCount} pages
                </small>
              </div>
              <div
                className="progress-ring"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                style={{ background: `conic-gradient(#2f7dd1 ${percent * 3.6}deg, #dfe6ef 0deg)` }}
              >
                <span />
              </div>
            </div>

            <MetricCard label="Processed" value={progress.processed} helper="pages" tone="blue" />
            <MetricCard label="Queued" value={progress.queued} helper="pages" tone="amber" />
            <MetricCard label="Found" value={foundCount} helper="resources" tone="green" />
            <MetricCard label="Errors" value={errorCount} helper="errors" tone="red" />
          </div>

          <div className="progress-track" role="presentation">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>

          <div className="run-metrics">
            <div>
              <Timer size={22} aria-hidden="true" />
              <span>Elapsed time</span>
              <strong>{formatDuration(elapsedMs)}</strong>
            </div>
            <div>
              <Clock3 size={22} aria-hidden="true" />
              <span>Speed</span>
              <strong>{speed.toFixed(2)} pages/s</strong>
            </div>
            <div>
              <Database size={22} aria-hidden="true" />
              <span>Saved pages</span>
              <strong>{result?.pages ?? progress.processed}</strong>
            </div>
            <div className={issueEntries.length || error ? "last-issue is-active" : "last-issue"}>
              <AlertCircle size={22} aria-hidden="true" />
              <span>Last issue</span>
              <strong>{lastIssue}</strong>
            </div>
          </div>

          <div className="summary-panel">
            <div className="summary-copy">
              <h3>Crawl summary</h3>
              <div className="summary-stats">
                <div>
                  <FileText size={18} aria-hidden="true" />
                  <span>Pages</span>
                  <strong>
                    {progress.processed} / {targetCount}
                  </strong>
                </div>
                <div>
                  <Database size={18} aria-hidden="true" />
                  <span>Queued</span>
                  <strong>{progress.queued}</strong>
                </div>
                <div>
                  <AlertCircle size={18} aria-hidden="true" />
                  <span>Issues</span>
                  <strong>{issueCount}</strong>
                </div>
              </div>
            </div>
            <div className="summary-chart" style={summaryRingStyle} aria-hidden="true">
              <span />
            </div>
            <div className="summary-legend">
              <LegendItem color="green" label="Completed" value={`${progress.processed} (${Math.round(completedShare)}%)`} />
              <LegendItem color="amber" label="In queue" value={`${progress.queued} (${Math.round(queuedShare)}%)`} />
              <LegendItem color="red" label="Issues" value={`${issueCount} (${Math.round(issueShare)}%)`} />
            </div>
          </div>

          {result ? (
            <div className="result-card">
              <CheckCircle2 size={20} aria-hidden="true" />
              <span>
                Saved {result.pages} page(s) with {result.errors} error(s) via {engineLabel(result.engine)} to {result.outputDir}
              </span>
            </div>
          ) : null}

          {error ? <div className="error-line">{error}</div> : null}
        </section>
      </section>

      <section className="bottom-grid">
        <section className="panel log-panel">
          <div className="tabbar">
            <button className={logTab === "all" ? "tab is-active" : "tab"} type="button" onClick={() => setLogTab("all")}>
              Crawl log
            </button>
            <button className={logTab === "issues" ? "tab is-active" : "tab"} type="button" onClick={() => setLogTab("issues")}>
              Issues ({issueCount})
            </button>
          </div>
          <div className="log-window" ref={logWindowRef}>
            {visibleLogs.length === 0 ? <p className="empty-log">Waiting for crawl activity.</p> : null}
            {visibleLogs.map((entry, index) => (
              <div className={`log-line log-${entry.kind}`} key={`${entry.raw}-${index}`}>
                <time>{entry.time}</time>
                <span>{entry.kind.toUpperCase()}</span>
                <p>{entry.message}</p>
              </div>
            ))}
          </div>
          <div className="panel-footer">
            <span>Saving to: {folder || "No folder selected"}</span>
            <button className="text-action" type="button" disabled={logs.length === 0 || isRunning} onClick={clearLogs}>
              <Trash2 size={16} aria-hidden="true" />
              Clear log
            </button>
          </div>
        </section>

        <section className="panel resources-panel">
          <div className="resources-header">
            <h2>Discovered resources</h2>
            <div className="resource-tools">
              <label className="select-control">
                <span>Show:</span>
                <select value={resourceMode} onChange={(event) => setResourceMode(event.target.value as ResourceMode)}>
                  <option value="all">All</option>
                  <option value="pages">Pages</option>
                  <option value="assets">Assets</option>
                  <option value="issues">Issues</option>
                </select>
                <ChevronDown size={16} aria-hidden="true" />
              </label>
              <label className="search-control">
                <Search size={17} aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Search..."
                  value={resourceSearch}
                  onChange={(event) => setResourceSearch(event.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="resource-table-wrap">
            <table className="resource-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Time</th>
                  <th>Saved path</th>
                </tr>
              </thead>
              <tbody>
                {visibleResources.length === 0 ? (
                  <tr>
                    <td className="empty-cell" colSpan={5}>
                      No resources yet.
                    </td>
                  </tr>
                ) : (
                  visibleResources.map((row) => (
                    <tr key={`${row.url}-${row.status}-${row.time}`}>
                      <td title={row.url}>{row.url}</td>
                      <td>
                        <span className={`status-badge resource-${row.status}`}>{statusText(row.status)}</span>
                      </td>
                      <td>{row.type}</td>
                      <td>{row.time}</td>
                      <td title={row.savedPath}>{row.savedPath}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}

function MetricCard({ label, value, helper, tone }: { label: string; value: number; helper: string; tone: "blue" | "amber" | "green" | "red" }) {
  return (
    <div className={`metric-card metric-${tone}`}>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </div>
  );
}

function LegendItem({ color, label, value }: { color: "green" | "amber" | "red"; label: string; value: string }) {
  return (
    <div className="legend-item">
      <span className={`legend-dot legend-${color}`} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function parseLogEntry(line: string): LogEntry {
  const match = /^\[(.*?)\]\s*(.*)$/.exec(line);
  const message = match ? match[2] : line;
  const kind = classifyLog(message);

  return {
    raw: line,
    time: match ? match[1] : "--:--:--",
    message,
    kind
  };
}

function classifyLog(message: string): LogKind {
  if (/^(Error:|Error on\b)|load failed|render process gone/i.test(message)) {
    return "error";
  }

  if (/skipped|timeout|blocked|unavailable|No saved copy/i.test(message)) {
    return "warning";
  }

  if (/^Saved\b|^Finished\b|^Local copy\b|^Replay copy\b|^WACZ archive\b|downloaded/i.test(message)) {
    return "success";
  }

  return "info";
}

function buildResourceRows(entries: LogEntry[]): ResourceRow[] {
  const rows = new Map<string, ResourceRow>();

  for (const entry of entries) {
    const url = extractUrl(entry.message);
    if (!url) {
      continue;
    }

    const status = resourceStatus(entry.message, entry.kind);
    rows.set(url, {
      url,
      time: entry.time,
      status,
      type: inferResourceType(url),
      savedPath: inferSavedPath(url),
      message: entry.message
    });
  }

  return [...rows.values()].reverse().slice(0, 120);
}

function extractUrl(message: string): string | null {
  const match = /(https?:\/\/[^\s)]+)/i.exec(message);
  return match ? match[1].replace(/[.,;:]+$/, "") : null;
}

function resourceStatus(message: string, kind: LogKind): ResourceRow["status"] {
  if (kind === "error") return "error";
  if (kind === "warning") return "warning";
  if (/^Queued\b/i.test(message)) return "queued";
  if (/^Opening\b/i.test(message)) return "opening";
  if (/^Saved\b|^Local copy\b|^Finished\b/i.test(message)) return "saved";
  return "info";
}

function inferResourceType(rawUrl: string): string {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    if (/\.(html?|php|aspx?)$/.test(pathname) || pathname === "/" || !/\.[a-z0-9]+$/.test(pathname)) return "document";
    if (/\.css$/.test(pathname)) return "text/css";
    if (/\.(mjs|js)$/.test(pathname)) return "javascript";
    if (/\.(png|jpe?g|webp|gif|avif|svg|ico)$/.test(pathname)) return `image/${pathname.split(".").at(-1)}`;
    if (/\.(mp4|webm|mov)$/.test(pathname)) return "video";
    if (/\.(woff2?|ttf|otf)$/.test(pathname)) return "font";
    if (/\.json$/.test(pathname)) return "json";
  } catch {
    return "resource";
  }

  return "resource";
}

function inferSavedPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || !/\.[a-z0-9]+$/i.test(pathname)) {
      const pageName = pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "-") || "index";
      return `/pages/${pageName}.html`;
    }

    return pathname;
  } catch {
    return "n/a";
  }
}

function statusLabel(current: CrawlStatus): string {
  switch (current) {
    case "running":
      return "Running";
    case "complete":
      return "Complete";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function statusText(status: ResourceRow["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "opening":
      return "Open";
    case "saved":
      return "200";
    case "warning":
      return "Warn";
    case "error":
      return "Error";
    default:
      return "Info";
  }
}

function engineLabel(engine: CrawlComplete["engine"]): string {
  return engine === "browsertrix" ? "Browsertrix/WACZ" : "legacy mirror";
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default App;

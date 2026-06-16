import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CrawlComplete, CrawlProgress, CrawlRequest, LinkIndexEntry } from "../shared/types";
import type { CrawlCallbacks } from "./crawler";

const maxPages = 100;
const dockerImage = "webrecorder/browsertrix-crawler";
const replayWebpageVersion = "2.4.6";
const require = createRequire(import.meta.url);

interface BrowsertrixAvailability {
  available: boolean;
  reason: string;
}

interface BrowsertrixRunStats {
  processed: number;
  discovered: number;
}

export async function getBrowsertrixAvailability(): Promise<BrowsertrixAvailability> {
  try {
    await runShortProcess("docker", ["info", "--format", "{{.ServerVersion}}"], 8_000);
    return { available: true, reason: "Docker daemon is available." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, reason: message };
  }
}

export async function crawlSiteWithBrowsertrix(request: CrawlRequest, callbacks: CrawlCallbacks): Promise<CrawlComplete> {
  const startUrl = normalizeStartUrl(request.startUrl);
  const maxDepth = Math.max(0, Math.trunc(request.maxDepth));
  const startedAt = Date.now();
  const outputRoot = path.join(request.outputDir, "output");
  const crawlsRoot = path.join(outputRoot, "browsertrix");
  const collection = `site-mirror-${Date.now()}`;
  const collectionDir = path.join(crawlsRoot, "collections", collection);
  const waczPath = path.join(collectionDir, `${collection}.wacz`);
  const indexPath = path.join(outputRoot, "links-index.json");
  const origin = new URL(startUrl).origin;

  await mkdir(outputRoot, { recursive: true });
  await mkdir(crawlsRoot, { recursive: true });
  await writeFile(indexPath, "[]\n", "utf8");

  callbacks.log(`Output folder: ${outputRoot}`);
  callbacks.log(`Starting Browsertrix crawl: ${startUrl}`);
  callbacks.log(`Crawler limits: maxDepth=${maxDepth}; maxPages=${maxPages}.`);
  callbacks.log(`ReplayWeb.page runtime: ${replayWebpageVersion}.`);
  callbacks.progress(makeProgress(0, 1, 1, 2));

  const stats = await runBrowsertrix({
    startUrl,
    maxDepth,
    crawlsRoot,
    collection,
    callbacks
  });

  callbacks.progress(makeProgress(stats.processed, 0, Math.max(stats.discovered, stats.processed), 84));
  callbacks.log("Preparing ReplayWeb.page viewer.");
  await writeReplayViewer(outputRoot, path.posix.join("browsertrix", "collections", collection, `${collection}.wacz`), startUrl);

  const records = await readBrowsertrixPageIndex(collectionDir, origin);
  await writeFile(indexPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  callbacks.progress(makeProgress(records.length || stats.processed, 0, Math.max(records.length, stats.discovered), 96));
  callbacks.log(`WACZ archive: ${waczPath}`);

  const server = await callbacks.startServer(outputRoot, origin);
  const localUrl = `http://localhost:${server.port}/`;
  const errors = records.filter((record) => record.status === "error").length;
  const pages = records.length || Math.max(stats.processed, 1);
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

  callbacks.progress(makeProgress(pages, 0, pages, 100));
  callbacks.log(`Finished in ${elapsedSeconds}s: ${pages} archived page(s), ${errors} error(s).`);
  callbacks.log(`Replay copy: ${localUrl}`);

  return {
    outputDir: outputRoot,
    indexPath,
    localUrl,
    pages,
    errors,
    engine: "browsertrix",
    archivePath: waczPath
  };
}

async function runBrowsertrix({
  startUrl,
  maxDepth,
  crawlsRoot,
  collection,
  callbacks
}: {
  startUrl: string;
  maxDepth: number;
  crawlsRoot: string;
  collection: string;
  callbacks: CrawlCallbacks;
}): Promise<BrowsertrixRunStats> {
  let processed = 0;
  let discovered = 1;
  const seenUrls = new Set<string>([startUrl]);
  const args = [
    "run",
    "--rm",
    "-v",
    `${path.resolve(crawlsRoot)}:/crawls`,
    dockerImage,
    "crawl",
    "--url",
    startUrl,
    "--collection",
    collection,
    "--overwrite",
    "--generateWACZ",
    "--text",
    "--depth",
    String(maxDepth),
    "--limit",
    String(maxPages),
    "--workers",
    "2",
    "--headless",
    "--scopeType",
    "host",
    "--waitUntil",
    "load,networkidle2",
    "--netIdleWait",
    "2",
    "--screenshot",
    "view"
  ];

  callbacks.log(`Docker image: ${dockerImage}`);

  await runStreamingProcess("docker", args, (line) => {
    const parsed = parseBrowsertrixLog(line);
    if (!parsed) {
      return;
    }

    callbacks.log(parsed.message);

    if (parsed.url && !seenUrls.has(parsed.url)) {
      seenUrls.add(parsed.url);
      discovered = Math.max(discovered, seenUrls.size);
    }

    if (parsed.completedPage) {
      processed = Math.min(maxPages, processed + 1);
    }

    callbacks.progress(makeProgress(processed, Math.max(0, discovered - processed), discovered, undefined));
  });

  return { processed, discovered };
}

async function writeReplayViewer(rootDir: string, waczPath: string, startUrl: string): Promise<void> {
  const replayDir = path.join(rootDir, "replay");
  await mkdir(replayDir, { recursive: true });
  await copyReplayAsset("ui.js", path.join(replayDir, "ui.js"));
  await copyReplayAsset("sw.js", path.join(replayDir, "sw.js"));

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Site Mirror Replay</title>
    <script src="/replay/ui.js"></script>
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        background: #05070a;
      }

      replay-web-page {
        display: block;
        width: 100%;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <replay-web-page replayBase="/replay/" source="/${escapeHtml(waczPath)}" url="${escapeHtml(startUrl)}" embed="full"></replay-web-page>
  </body>
</html>
`;

  await writeFile(path.join(rootDir, "index.html"), html, "utf8");
}

async function copyReplayAsset(assetName: "ui.js" | "sw.js", destination: string): Promise<void> {
  const packageJson = require.resolve("replaywebpage/package.json");
  const source = path.join(path.dirname(packageJson), assetName);
  try {
    await copyFile(source, destination);
  } catch (error) {
    const unpackedSource = source.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    if (unpackedSource === source) {
      throw error;
    }

    await copyFile(unpackedSource, destination);
  }
}

async function readBrowsertrixPageIndex(collectionDir: string, origin: string): Promise<LinkIndexEntry[]> {
  const files = [path.join(collectionDir, "pages", "pages.jsonl"), path.join(collectionDir, "pages", "extraPages.jsonl")];
  const records = new Map<string, LinkIndexEntry>();

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      try {
        const page = JSON.parse(line) as Record<string, unknown>;
        const url = pageUrl(page);
        if (!url || records.has(url)) {
          continue;
        }

        const status = pageStatus(page);
        records.set(url, {
          url,
          depth: pageDepth(page),
          localHtml: replayPathForUrl(url, origin),
          links: [],
          images: [],
          status: status >= 400 ? "error" : "success",
          httpStatus: status || undefined
        });
      } catch {
        // Ignore malformed JSONL rows from partial interrupted crawls.
      }
    }
  }

  return [...records.values()];
}

function parseBrowsertrixLog(line: string): { message: string; url?: string; completedPage: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { message: `Browsertrix: ${trimmed}`, completedPage: /(?:finished|complete|done)/i.test(trimmed) };
  }

  const message = stringValue(payload.message) ?? stringValue(payload.msg) ?? stringValue(payload.type) ?? "event";
  const details = objectValue(payload.details);
  const url = stringValue(payload.url) ?? stringValue(payload.page) ?? stringValue(details?.url) ?? stringValue(details?.pageUrl);
  const status = numberValue(payload.status) ?? numberValue(details?.status);
  const completedPage = /(?:page.*(?:done|complete|finished)|finished.*page|crawl.*page)/i.test(message) || status !== undefined;
  const suffix = [url, status ? `status ${status}` : ""].filter(Boolean).join("; ");

  return {
    message: suffix ? `Browsertrix: ${message} (${suffix})` : `Browsertrix: ${message}`,
    url,
    completedPage
  };
}

function pageUrl(page: Record<string, unknown>): string | null {
  return (
    stringValue(page.url) ??
    stringValue(page.pageUrl) ??
    stringValue(page.id) ??
    stringValue(objectValue(page.page)?.url) ??
    null
  );
}

function pageStatus(page: Record<string, unknown>): number {
  return (
    numberValue(page.status) ??
    numberValue(page.statusCode) ??
    numberValue(page.httpStatus) ??
    numberValue(objectValue(page.response)?.status) ??
    200
  );
}

function pageDepth(page: Record<string, unknown>): number {
  return numberValue(page.depth) ?? numberValue(objectValue(page.extra)?.depth) ?? 0;
}

function replayPathForUrl(url: string, origin: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin) {
      return url;
    }

    const route = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "-") || "index";
    return `replay/${route}`;
  } catch {
    return "replay";
  }
}

function normalizeStartUrl(input: string): string {
  const trimmed = input.trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  url.hash = "";
  return url.href;
}

function makeProgress(processed: number, queued: number, totalDiscovered: number, fixedPercent?: number): CrawlProgress {
  const denominator = queued === 0 ? Math.max(processed, 1) : Math.max(totalDiscovered, 1);
  return {
    processed,
    queued,
    totalDiscovered,
    percent: fixedPercent ?? (queued === 0 ? 100 : Math.min(99, Math.round((processed / denominator) * 100)))
  };
}

function runShortProcess(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not respond in time.`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function runStreamingProcess(command: string, args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    const consume = (chunk: Buffer, isError: boolean) => {
      const text = chunk.toString("utf8");
      const buffer = isError ? stderr + text : stdout + text;
      const lines = buffer.split(/\r?\n/);
      if (isError) {
        stderr = lines.pop() ?? "";
      } else {
        stdout = lines.pop() ?? "";
      }

      for (const line of lines) {
        onLine(line);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, true));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (stdout.trim()) onLine(stdout);
      if (stderr.trim()) onLine(stderr);

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Browsertrix Docker process exited with code ${code ?? "unknown"}.`));
    });
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export { replayWebpageVersion };

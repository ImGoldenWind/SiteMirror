import { app } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import type { CrawlComplete, CrawlProgress, CrawlRequest, LinkIndexEntry } from "../shared/types";
import { crawlSiteWithBrowsertrix, getBrowsertrixAvailability } from "./browsertrixCrawler";

const maxPages = 100;
const crawlConcurrency = 3;
const staticAssetDownloadConcurrency = 8;
const pageTimeoutMs = 30_000;
const domContentLoadedTimeoutMs = 15_000;
const networkIdleTimeoutMs = 3_000;
const scrollTimeoutMs = 12_000;
const assetBodyTimeoutMs = 12_000;
const staticAssetDownloadTimeoutMs = 12_000;
const savedResourceTypes = new Set(["document", "stylesheet", "script", "image", "font", "media", "fetch", "xhr", "other"]);
const cdnResourceTypes = new Set(["stylesheet", "script", "image", "font", "media"]);
const textFileExtensions = new Set([".html", ".css", ".js", ".json", ".webmanifest"]);
const referencedAssetExtensions = new Set([
  ".avif",
  ".bin",
  ".buf",
  ".exr",
  ".gif",
  ".glb",
  ".gltf",
  ".hdr",
  ".ico",
  ".jpg",
  ".jpeg",
  ".json",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".wav",
  ".webm",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2"
]);

export interface CrawlCallbacks {
  log: (line: string) => void;
  progress: (progress: CrawlProgress) => void;
  startServer: (rootDir: string, origin: string) => Promise<{ port: number }>;
}

interface QueueItem {
  url: string;
  depth: number;
}

interface OutputPaths {
  root: string;
  pages: string;
  images: string;
  assets: string;
  screenshots: string;
  index: string;
}

interface PageAssetSnapshot {
  html: string;
  links: string[];
  images: string[];
}

interface AssetRecord {
  url: string;
  localPath: string;
  diskPath: string;
  resourceType: string;
  contentType: string;
}

export async function crawlSite(request: CrawlRequest, callbacks: CrawlCallbacks): Promise<CrawlComplete> {
  const browsertrix = await getBrowsertrixAvailability();
  if (browsertrix.available) {
    callbacks.log("Browsertrix Crawler available; using WACZ capture pipeline.");
    try {
      return await crawlSiteWithBrowsertrix(request, callbacks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.log(`Browsertrix failed: ${message}`);
      callbacks.log("Falling back to built-in Playwright mirroring.");
    }
  }

  if (!browsertrix.available) {
    callbacks.log(`Browsertrix unavailable: ${browsertrix.reason}`);
    callbacks.log("Falling back to built-in Playwright mirroring.");
  }

  return crawlSiteLegacy(request, callbacks);
}

async function crawlSiteLegacy(request: CrawlRequest, callbacks: CrawlCallbacks): Promise<CrawlComplete> {
  configurePlaywrightBrowserPath();

  const playwrightPackage = "playwright";
  const { chromium } = (await import(playwrightPackage)) as typeof import("playwright");
  const startUrl = normalizeStartUrl(request.startUrl);
  const maxDepth = Math.max(0, Math.trunc(request.maxDepth));
  const paths = await prepareOutput(request.outputDir);
  const startOrigin = new URL(startUrl).origin;
  let currentLayer: QueueItem[] = [{ url: startUrl, depth: 0 }];
  const scheduled = new Set<string>([startUrl]);
  const pageNameByUrl = new Map<string, string>([[startUrl, "pages/index.html"]]);
  const usedPageNames = new Set<string>(["index.html"]);
  const records: LinkIndexEntry[] = [];
  const startedAt = Date.now();

  callbacks.log(`Output folder: ${paths.root}`);
  callbacks.log(`Starting crawl: ${startUrl}`);
  callbacks.log(`Crawler limits: maxDepth=${maxDepth}; maxPages=${maxPages}.`);
  callbacks.progress(makeProgress(0, currentLayer.length, scheduled.size));

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"]
    });
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 768 }
    });

    while (currentLayer.length > 0 && records.length < maxPages) {
      const nextLayer: QueueItem[] = [];
      let nextIndex = 0;

      const worker = async () => {
        while (records.length < maxPages) {
          const item = currentLayer[nextIndex];
          nextIndex += 1;

          if (!item) {
            return;
          }

          callbacks.log(`Opening depth ${item.depth}: ${item.url}`);
          const record = await crawlPage(context!, item, paths, pageNameByUrl, usedPageNames, callbacks.log);
          records.push(record);

          if (record.status === "success" && item.depth < maxDepth) {
            for (const link of record.links) {
              const normalizedLink = normalizeInternalUrl(link, startOrigin);
              if (!normalizedLink || scheduled.has(normalizedLink)) {
                continue;
              }

              if (scheduled.size >= maxPages) {
                callbacks.log(`Max pages limit reached (${maxPages}); skipping additional links.`);
                break;
              }

              scheduled.add(normalizedLink);
              nextLayer.push({ url: normalizedLink, depth: item.depth + 1 });
              ensurePageName(normalizedLink, startUrl, pageNameByUrl, usedPageNames);
              callbacks.log(`Queued depth ${item.depth + 1}: ${normalizedLink}`);
            }
          }

          callbacks.progress(makeProgress(records.length, Math.max(0, currentLayer.length - nextIndex) + nextLayer.length, scheduled.size));
        }
      };

      await Promise.all(Array.from({ length: Math.min(crawlConcurrency, currentLayer.length) }, worker));
      await writeIndex(paths.index, records);
      currentLayer = nextLayer;
    }

    if ((currentLayer.length > 0 || scheduled.size >= maxPages) && records.length >= maxPages) {
      callbacks.log(`Stopped after maxPages=${maxPages}.`);
    }
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  callbacks.progress({ ...makeProgress(records.length, 0, scheduled.size), percent: 82 });
  callbacks.log("Finalizing local links.");
  await rewriteInternalLinks(records, paths.root, pageNameByUrl, startOrigin);

  callbacks.progress({ ...makeProgress(records.length, 0, scheduled.size), percent: 88 });
  callbacks.log("Downloading referenced static assets.");
  await downloadReferencedAssets(paths.root, startOrigin, callbacks.log);

  callbacks.progress({ ...makeProgress(records.length, 0, scheduled.size), percent: 94 });
  callbacks.log("Patching local runtime.");
  await patchMirroredRuntime(paths.root, callbacks.log);
  await writeIndex(paths.index, records);

  const server = await callbacks.startServer(paths.root, startOrigin);
  const localUrl = `http://localhost:${server.port}/`;
  const errors = records.filter((record) => record.status === "error").length;
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

  callbacks.progress(makeProgress(records.length, 0, scheduled.size));
  callbacks.log(`Finished in ${elapsedSeconds}s: ${records.length} page(s), ${errors} error(s).`);
  callbacks.log(`Local copy: ${localUrl}`);

  return {
    outputDir: paths.root,
    indexPath: paths.index,
    localUrl,
    pages: records.length,
    errors,
    engine: "legacy"
  };
}

async function crawlPage(
  context: BrowserContext,
  item: QueueItem,
  paths: OutputPaths,
  pageNameByUrl: Map<string, string>,
  usedPageNames: Set<string>,
  log: (line: string) => void
): Promise<LinkIndexEntry> {
  const localHtml = ensurePageName(item.url, item.url, pageNameByUrl, usedPageNames);
  const htmlPath = path.join(paths.root, localHtml);
  const screenshot = `screenshots/${path.basename(localHtml, ".html")}.png`;
  const screenshotPath = path.join(paths.root, screenshot);
  const page = await context.newPage();
  let savedScreenshot: string | undefined;
  const pageOrigin = new URL(item.url).origin;
  const assetMap = new Map<string, AssetRecord>();
  const assetTasks: Array<Promise<void>> = [];

  page.on("response", (response) => {
    const task = saveResponseAsset(response, pageOrigin, paths, assetMap, log);
    assetTasks.push(task);
  });

  try {
    page.setDefaultTimeout(pageTimeoutMs);
    page.setDefaultNavigationTimeout(pageTimeoutMs);

    const response = await navigateToDocument(page, item.url, log);
    const responseHtml = await readDocumentResponseHtml(response);

    try {
      await page.waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs });
    } catch {
      log(`Network idle timeout, continuing: ${item.url}`);
    }

    await scrollToBottom(page);
    await restoreInitialViewport(page);
    await page.waitForTimeout(1_000);
    await settleAssetTasks(assetTasks);

    try {
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 });
      savedScreenshot = screenshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Screenshot skipped: ${item.url} (${message})`);
    }

    const snapshot = await collectPageSnapshot(page);
    await settleAssetTasks(assetTasks);
    await rewriteSavedCssAssets(assetMap, log);
    const rewrittenHtml = await rewritePageHtml(page, assetMap, localHtml, item.url, responseHtml, snapshot.html, log);

    await writeFile(htmlPath, rewrittenHtml || snapshot.html, "utf8");

    const internalLinks = [...new Set(snapshot.links.map((link) => normalizeInternalUrl(link, new URL(item.url).origin)).filter(Boolean) as string[])];
    const localImages = snapshot.images
      .map((image) => {
        const normalized = normalizeAssetUrl(image);
        return normalized ? assetMap.get(normalized) : undefined;
      })
      .filter(Boolean)
      .map((asset) => path.posix.relative(path.posix.dirname(localHtml), asset!.localPath));
    log(`Saved ${localHtml}; links: ${internalLinks.length}; assets: ${assetMap.size}`);

    return {
      url: item.url,
      depth: item.depth,
      localHtml,
      links: internalLinks,
      images: [...new Set(localImages)].map((imagePath) => imagePath.replaceAll("\\", "/")),
      status: "success",
      httpStatus: response?.status(),
      screenshot: savedScreenshot
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error on ${item.url}: ${message}`);

    return {
      url: item.url,
      depth: item.depth,
      localHtml,
      links: [],
      images: [],
      status: "error",
      error: message
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function prepareOutput(selectedDir: string): Promise<OutputPaths> {
  const root = path.join(selectedDir, "output");
  const pages = path.join(root, "pages");
  const images = path.join(root, "images");
  const assets = path.join(root, "assets");
  const screenshots = path.join(root, "screenshots");
  const index = path.join(root, "links-index.json");

  await mkdir(pages, { recursive: true });
  await mkdir(images, { recursive: true });
  await mkdir(assets, { recursive: true });
  await mkdir(screenshots, { recursive: true });
  await writeFile(index, "[]\n", "utf8");

  return { root, pages, images, assets, screenshots, index };
}

async function collectPageSnapshot(page: Page): Promise<PageAssetSnapshot> {
  return page.evaluate(() => {
    const srcsetUrls = (srcset: string): string[] =>
      srcset
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean)
        .map((url) => new URL(url, document.baseURI).href);

    const cssUrlRegex = /url\((['"]?)(.*?)\1\)/g;
    const backgroundUrls: string[] = [];

    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const backgroundImage = getComputedStyle(element).backgroundImage;
      let match: RegExpExecArray | null;
      while ((match = cssUrlRegex.exec(backgroundImage))) {
        if (match[2] && !match[2].startsWith("data:")) {
          backgroundUrls.push(new URL(match[2], document.baseURI).href);
        }
      }
    }

    const images = [
      ...Array.from(document.querySelectorAll<HTMLImageElement>("img[src]")).map((image) => image.currentSrc || image.src),
      ...Array.from(document.querySelectorAll<HTMLImageElement | HTMLSourceElement>("img[srcset], source[srcset]")).flatMap((element) =>
        srcsetUrls(element.getAttribute("srcset") ?? "")
      ),
      ...backgroundUrls
    ];

    return {
      html: document.documentElement.outerHTML,
      links: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((anchor) => anchor.href),
      images: images.filter((image) => image && !image.startsWith("data:"))
    };
  });
}

async function navigateToDocument(page: Page, url: string, log: (line: string) => void): Promise<Response | null> {
  const response = await page.goto(url, {
    waitUntil: "commit",
    timeout: pageTimeoutMs
  });

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: domContentLoadedTimeoutMs });
  } catch {
    log(`DOMContentLoaded timeout, continuing after initial document: ${url}`);
  }

  try {
    await page.waitForFunction(() => Boolean(document.documentElement), undefined, { timeout: 5_000 });
  } catch {
    log(`Document readiness timeout, continuing with captured response: ${url}`);
  }

  return response;
}

async function saveResponseAsset(
  response: Response,
  pageOrigin: string,
  paths: OutputPaths,
  assetMap: Map<string, AssetRecord>,
  log: (line: string) => void
): Promise<void> {
  const request = response.request();
  const resourceType = request.resourceType();
  const originalUrl = normalizeAssetUrl(response.url());

  if (!originalUrl || !shouldSaveResource(originalUrl, pageOrigin, resourceType)) {
    return;
  }

  if (assetMap.has(originalUrl)) {
    return;
  }

  try {
    if (response.status() >= 400 || response.status() === 204 || response.status() === 304) {
      return;
    }

    const contentType = response.headers()["content-type"] ?? "";
    const body = await withTimeout(response.body(), assetBodyTimeoutMs, `Timed out reading asset body: ${response.url()}`);
    if (body.length === 0) {
      return;
    }

    const url = new URL(originalUrl);
    const extension = extensionForAsset(originalUrl, contentType, resourceType);
    const localPath = localPathForAsset(url, pageOrigin, resourceType, extension);
    const diskPath = path.join(paths.root, localPath);

    await mkdir(path.dirname(diskPath), { recursive: true });
    await writeFile(diskPath, body);

    assetMap.set(originalUrl, {
      url: originalUrl,
      localPath,
      diskPath,
      resourceType,
      contentType
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Asset skipped: ${response.url()} (${message})`);
  }
}

function shouldSaveResource(url: string, pageOrigin: string, resourceType: string): boolean {
  if (!savedResourceTypes.has(resourceType)) {
    return false;
  }

  const origin = new URL(url).origin;
  if (origin === pageOrigin) {
    return true;
  }

  // Cross-origin CDN files are kept when they are render-critical assets observed in the page.
  return cdnResourceTypes.has(resourceType);
}

function localPathForAsset(url: URL, pageOrigin: string, resourceType: string, extension: string): string {
  if (resourceType === "image") {
    const originalPath = url.origin === pageOrigin ? safeOriginalAssetPath(url.pathname) : null;
    if (originalPath) {
      return path.posix.join("images", originalPath);
    }

    const baseName = safeBaseName(url.pathname) || "image";
    return path.posix.join("images", `${baseName}-${hash(url.href)}${extension}`);
  }

  if (url.origin === pageOrigin && resourceType !== "document") {
    const originalPath = safeOriginalAssetPath(url.pathname);
    if (originalPath) {
      return originalPath;
    }
  }

  const baseName = safeBaseName(url.pathname) || resourceType || "asset";
  const typeDir = sanitizeFilePart(resourceType || "asset") || "asset";
  const fileName = `${baseName}-${hash(url.href)}${extension}`;
  return path.posix.join("assets", typeDir, fileName);
}

function safeOriginalAssetPath(urlPath: string): string | null {
  const decodedPath = decodeURIComponent(urlPath).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!decodedPath || decodedPath.endsWith("/") || decodedPath.split("/").some((part) => part === "..")) {
    return null;
  }

  return decodedPath
    .split("/")
    .map((part) => sanitizeOriginalPathPart(part) || "asset")
    .join("/");
}

function sanitizeOriginalPathPart(value: string): string {
  return value.replace(/[<>:"|?*\x00-\x1F]/g, "_").trim();
}

async function settleAssetTasks(tasks: Array<Promise<void>>): Promise<void> {
  let settled = 0;

  while (settled < tasks.length) {
    const batch = tasks.slice(settled);
    settled = tasks.length;
    await Promise.allSettled(batch);
  }
}

async function readDocumentResponseHtml(response: Response | null | undefined): Promise<string | null> {
  if (!response) {
    return null;
  }

  try {
    if (response.request().resourceType() !== "document") {
      return null;
    }

    if (response.status() >= 400 || response.status() === 204 || response.status() === 304) {
      return null;
    }

    const contentType = response.headers()["content-type"] ?? "";
    if (!/html/i.test(contentType)) {
      return null;
    }

    const html = await withTimeout(response.text(), assetBodyTimeoutMs, `Timed out reading document HTML: ${response.url()}`);
    return html.trim() ? html : null;
  } catch {
    return null;
  }
}

async function rewritePageHtml(
  page: Page,
  assetMap: Map<string, AssetRecord>,
  localHtml: string,
  pageUrl: string,
  responseHtml: string | null,
  snapshotHtml: string,
  log: (line: string) => void
): Promise<string> {
  if (shouldPreferResponseHtml(responseHtml, snapshotHtml)) {
    try {
      log(`Using initial document HTML: ${pageUrl}`);
      return await rewriteAssetsInHtml(responseHtml!, assetMap, localHtml, pageUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Initial HTML rewrite failed, using rendered DOM: ${pageUrl} (${message})`);
    }
  }

  return rewriteAssetsInPage(page, assetMap, localHtml);
}

async function rewriteAssetsInHtml(html: string, assetMap: Map<string, AssetRecord>, localHtml: string, pageUrl: string): Promise<string> {
  const cheerioPackage = "cheerio";
  const cheerio = await import(cheerioPackage);
  const $ = cheerio.load(html, { decodeEntities: false });
  const htmlDir = path.posix.dirname(localHtml);
  const assets = new Map([...assetMap.values()].map((asset) => [asset.url, path.posix.relative(htmlDir, asset.localPath)] as const));

  const absolute = (value: string): string => {
    const normalized = normalizeAssetUrl(decodeHtmlEntities(value), pageUrl);
    return normalized ?? value;
  };

  const rewriteUrl = (value: string): string => assets.get(absolute(value)) ?? value;
  const rewriteSrcset = (srcset: string): string =>
    srcset
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const chunks = trimmed.split(/\s+/);
        const local = chunks[0] ? assets.get(absolute(chunks[0])) : null;
        return local ? [local, ...chunks.slice(1)].join(" ") : trimmed;
      })
      .join(", ");

  const rewriteCssUrls = (value: string): string =>
    value.replace(/url\((['"]?)(.*?)\1\)/g, (match, quote: string, rawUrl: string) => {
      if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
        return match;
      }

      const local = assets.get(absolute(rawUrl));
      return local ? `url("${local}")` : match;
    });

  const rewriteAttr = (selector: string, attr: string): void => {
    $(selector).each((_index: number, element: any) => {
      const value = $(element).attr(attr);
      if (!value) {
        return;
      }

      const local = rewriteUrl(value);
      if (local !== value) {
        $(element).attr(attr, local);
      }
    });
  };

  for (const [selector, attr] of [
    ["link[href]", "href"],
    ["script[src]", "src"],
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["video[src]", "src"],
    ["audio[src]", "src"],
    ["track[src]", "src"],
    ["iframe[src]", "src"],
    ["video[poster]", "poster"],
    ["audio[poster]", "poster"],
    ["[data-src]", "data-src"],
    ["[data-lazy-src]", "data-lazy-src"],
    ["[data-original]", "data-original"],
    ["[data-poster]", "data-poster"]
  ] as const) {
    rewriteAttr(selector, attr);
  }

  for (const [selector, attr] of [
    ["img[srcset]", "srcset"],
    ["source[srcset]", "srcset"],
    ["[data-srcset]", "data-srcset"]
  ] as const) {
    $(selector).each((_index: number, element: any) => {
      const value = $(element).attr(attr);
      if (value) {
        $(element).attr(attr, rewriteSrcset(value));
      }
    });
  }

  $("[style]").each((_index: number, element: any) => {
    const value = $(element).attr("style");
    if (value) {
      $(element).attr("style", rewriteCssUrls(value));
    }
  });

  $("style").each((_index: number, element: any) => {
    const value = $(element).html();
    if (value) {
      $(element).html(rewriteCssUrls(value));
    }
  });

  annotateOriginalTextSnapshots($);

  return ensureDoctype(injectMirrorTextNormalizer($.html()), html);
}

function annotateOriginalTextSnapshots($: any): void {
  const skipSelector = "script,style,svg,canvas,video,audio,picture,img,source,iframe,input,textarea,select,option";

  $("body *").each((_index: number, element: any) => {
    const current = $(element);
    if (current.is(skipSelector) || current.parents(skipSelector).length > 0 || current.children().length > 0) {
      return;
    }

    const text = normalizeInlineText(current.text());
    if (text.length < 2 || text.length > 300 || !/[A-Za-z0-9А-Яа-я]/.test(text)) {
      return;
    }

    const marker = `${current.attr("id") ?? ""} ${current.attr("class") ?? ""}`;
    if (!/(?:^|[-_\s])(text|title|line|heading|copy|label|caption|name|desc|paragraph|word|char|letter|split|award|brand|project)(?:[-_\s]|$)/i.test(marker)) {
      return;
    }

    current.attr("data-mirror-original-text", text);
  });
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shouldPreferResponseHtml(responseHtml: string | null, snapshotHtml: string): boolean {
  if (!responseHtml) {
    return false;
  }

  const responseTextLength = visibleHtmlTextLength(responseHtml);
  const snapshotTextLength = visibleHtmlTextLength(snapshotHtml);
  if (responseTextLength >= 100 && (snapshotTextLength === 0 || responseTextLength >= snapshotTextLength * 0.2)) {
    return true;
  }

  return responseTextLength > 0 && bodyElementCount(responseHtml) >= 40 && responseTextLength >= snapshotTextLength * 0.05;
}

function visibleHtmlTextLength(html: string): number {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const text = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<canvas\b[\s\S]*?<\/canvas>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim().length;
}

function bodyElementCount(html: string): number {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return (body.match(/<(?!\/|!)([a-z][\w:-]*)\b/gi) ?? []).filter((tag) => !/^<(script|style|noscript|meta|link)\b/i.test(tag)).length;
}

function ensureDoctype(serializedHtml: string, originalHtml: string): string {
  if (/^\s*<!doctype\b/i.test(serializedHtml)) {
    return serializedHtml;
  }

  const originalDoctype = originalHtml.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? "<!doctype html>";
  return `${originalDoctype}\n${serializedHtml}`;
}

function injectMirrorTextNormalizer(html: string): string {
  if (html.includes('data-mirror-helper="text-normalizer"')) {
    return html;
  }

  const script = `<script data-mirror-helper="text-normalizer">${mirrorTextNormalizerScript()}</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }

  return `${html}${script}`;
}

function mirrorTextNormalizerScript(): string {
  return String.raw`(()=> {
  if (window.__mirrorTextNormalizerInstalled) return;
  window.__mirrorTextNormalizerInstalled = true;

  const skipSelector = "script,style,svg,canvas,video,audio,picture,img,source,iframe,input,textarea,select,option";
  const startupSelector = "#preloader,[id*='preload' i],[class*='preload' i],[id*='loader' i],[class*='loader' i]";
  const installedAt = Date.now();
  let scheduled = false;
  let restoring = false;
  let runCount = 0;
  const maxRuns = 120;
  let intervalId = 0;
  let observer = null;
  let quietSince = Date.now();

  installOriginalTextWriteGuards();

  const schedule = () => {
    if (scheduled || runCount >= maxRuns) return;
    scheduled = true;

    const run = () => {
      scheduled = false;
      if (Date.now() - installedAt < 2500 && hasVisibleStartupBlocker()) {
        setTimeout(schedule, 500);
        return;
      }
      runCount += 1;
      normalizeTextSnapshotForMirror();
    };

    if ("requestIdleCallback" in window) {
      requestIdleCallback(run, { timeout: 750 });
      return;
    }

    requestAnimationFrame(run);
  };

  const start = () => {
    schedule();
    for (const delay of [50, 150, 300, 600, 1200, 2500, 5000, 8000, 12000]) {
      setTimeout(schedule, delay);
    }
    if (document.body) {
      observer = new MutationObserver(() => {
        quietSince = Date.now();
        schedule();
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      intervalId = window.setInterval(() => {
        if (Date.now() - quietSince > 8000 && Date.now() - installedAt > 12000) {
          stopWatching();
          return;
        }

        schedule();
      }, 1500);
      setTimeout(() => {
        stopWatching();
      }, 20000);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  window.addEventListener("load", schedule, { once: true });

  function stopWatching() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (intervalId) {
      window.clearInterval(intervalId);
      intervalId = 0;
    }
  }

  function hasVisibleStartupBlocker() {
    if (!document.body) return true;
    const candidates = document.querySelectorAll(startupSelector);
    for (const element of candidates) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      const zIndex = Number.parseInt(style.zIndex || "0", 10) || 0;
      if ((style.position === "fixed" || style.position === "absolute") && zIndex >= 10 && rect.width >= innerWidth * 0.5 && rect.height >= innerHeight * 0.5) {
        return true;
      }
    }
    return false;
  }

  function normalizeTextSnapshotForMirror() {
    if (!document.body) return;
    restoreOriginalTextSnapshotsNow();
  }

  function restoreOriginalTextSnapshotsNow() {
    if (restoring || !document.body) return;
    restoring = true;
    try {
      restoreOriginalTextSnapshots();
    } finally {
      restoring = false;
    }
  }

  function restoreOriginalTextSnapshots() {
    for (const element of Array.from(document.querySelectorAll("[data-mirror-original-text]"))) {
      if (shouldSkipTextNormalization(element)) continue;
      const original = normalizedAttributeText(element.getAttribute("data-mirror-original-text") || "");
      const current = normalizedText(element);
      if (!original || current === original) continue;
      const children = directElementChildren(element);
      if (shouldPreserveAnimatedTextStructure(element, children, original, current)) continue;
      if (looksRestorableOriginalTextElement(element, original, current) && looksCorruptedTextReplacement(original, current)) {
        element.textContent = original;
      }
    }
  }

  function installOriginalTextWriteGuards() {
    guardTextSetter(Node.prototype, "textContent", (node) => originalTextElementForNode(node));
    guardTextSetter(Node.prototype, "nodeValue", (node) => originalTextElementForNode(node));
    if (typeof CharacterData !== "undefined") {
      guardTextSetter(CharacterData.prototype, "data", (node) => originalTextElementForNode(node));
    }
    if (typeof HTMLElement !== "undefined") {
      guardTextSetter(HTMLElement.prototype, "innerText", (node) => (node instanceof HTMLElement ? node : null));
    }
  }

  function guardTextSetter(prototype, property, resolveElement) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor || !descriptor.set || !descriptor.get || descriptor.set.__mirrorGuarded) return;
    const guardedSetter = function(value) {
      const element = resolveElement(this);
      const protectedValue = protectedOriginalTextValue(element, value);
      descriptor.set.call(this, protectedValue === null ? value : protectedValue);
    };
    guardedSetter.__mirrorGuarded = true;
    Object.defineProperty(prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: function() {
        return descriptor.get.call(this);
      },
      set: guardedSetter
    });
  }

  function originalTextElementForNode(node) {
    if (node instanceof Element) return node;
    if (node instanceof CharacterData) return node.parentElement;
    return null;
  }

  function protectedOriginalTextValue(element, value) {
    if (!element || shouldSkipTextNormalization(element)) return null;
    const original = normalizedAttributeText(element.getAttribute("data-mirror-original-text") || "");
    if (!original) return null;
    const requested = normalizedAttributeText(value);
    if (requested === original) return null;
    return looksRestorableOriginalTextElement(element, original, requested) && looksCorruptedTextReplacement(original, requested) ? original : null;
  }

  function looksRestorableOriginalTextElement(element, original, current) {
    const marker = String(element.id || "") + " " + String(element.className || "");
    if (/(?:^|[-_\s])(text|title|line|heading|copy|label|caption|name|desc|paragraph|word|char|letter|split|award|brand|project)(?:[-_\s]|$)/i.test(marker)) {
      return true;
    }
    const children = directElementChildren(element);
    return (children.length >= 2 && looksLikeTextLayerContainer(element, children)) || current.length > original.length * 1.25 || original.length > current.length * 1.25;
  }

  function collapseRepeatedTextStacks() {
    const elements = Array.from(document.body.querySelectorAll("*")).reverse();
    for (const element of elements) {
      if (shouldSkipTextNormalization(element)) continue;
      const children = directElementChildren(element);
      if (children.length < 2 || children.some(shouldSkipTextNormalization)) continue;
      if (shouldPreserveAnimatedTextStructure(element, children, "", normalizedText(element))) continue;
      const directTexts = children.map((child) => normalizedText(child)).filter(Boolean);
      if (directTexts.length >= 2 && directTexts.every((text) => text === directTexts[0]) && looksLikeTextLayerContainer(element, children)) {
        element.textContent = directTexts[0];
        continue;
      }
      const tokens = children.map((child) => repeatedTextToken(child));
      const meaningfulTokens = tokens.filter(Boolean);
      if (meaningfulTokens.length >= 2 && meaningfulTokens.every((token) => token === meaningfulTokens[0]) && looksLikeTextLayerContainer(element, children)) {
        element.textContent = meaningfulTokens[0];
      }
    }
  }

  function collapseTokenizedTextRuns() {
    const elements = Array.from(document.body.querySelectorAll("*")).reverse();
    for (const element of elements) {
      if (shouldSkipTextNormalization(element)) continue;
      const children = directElementChildren(element);
      if (children.length < 2 || children.some(shouldSkipTextNormalization) || !looksLikeTextLayerContainer(element, children)) continue;
      if (shouldPreserveAnimatedTextStructure(element, children, "", normalizedText(element))) continue;
      const tokens = children.map((child) => repeatedTextToken(child));
      if (tokens.some((token) => token === null) || tokens.filter(Boolean).length < 2) continue;
      const collapsed = joinRepeatedTextTokens(tokens);
      if (collapsed && collapsed.length < normalizedText(element).length) {
        element.textContent = collapsed;
      }
    }
  }

  function collapseSingleCharacterRuns() {
    const elements = Array.from(document.body.querySelectorAll("*")).reverse();
    for (const element of elements) {
      if (shouldSkipTextNormalization(element)) continue;
      const children = directElementChildren(element);
      if (children.length < 3 || children.some(shouldSkipTextNormalization)) continue;
      if (shouldPreserveAnimatedTextStructure(element, children, "", normalizedText(element))) continue;
      const tokens = children.map((child) => {
        const repeated = repeatedTextToken(child);
        if (repeated && Array.from(repeated).length === 1) return repeated;
        const text = normalizedText(child);
        if (text.length === 1) return text;
        return hasExplicitTextGap(child) ? " " : null;
      });
      if (tokens.some((token) => token === null) || tokens.filter((token) => token && token !== " ").length < 2) continue;
      const collapsed = joinRepeatedTextTokens(tokens);
      if (collapsed && (collapsed.length < normalizedText(element).length || tokens.includes(" "))) {
        element.textContent = collapsed;
      }
    }
  }

  function flattenTextWrapperChildren() {
    const candidates = Array.from(document.body.querySelectorAll("p,h1,h2,h3,h4,h5,h6,a,span,button,label,small,strong,em,li,dt,dd"));
    for (const element of candidates) {
      if (shouldSkipTextNormalization(element)) continue;
      const children = directElementChildren(element);
      if (children.length === 0 || children.some((child) => !isInlineTextWrapper(child))) continue;
      if (shouldPreserveAnimatedTextStructure(element, children, element.getAttribute("data-mirror-original-text") || "", normalizedText(element))) continue;
      const fragment = document.createDocumentFragment();
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          fragment.append(document.createTextNode(node.textContent || ""));
        } else if (node instanceof HTMLElement) {
          fragment.append(document.createTextNode(node.textContent || ""));
        }
      }
      element.replaceChildren(fragment);
    }
  }

  function repeatedTextToken(element) {
    const children = directElementChildren(element);
    if (children.length >= 2) {
      const childTexts = children.map((child) => normalizedText(child)).filter(Boolean);
      if (childTexts.length >= 2 && childTexts.every((text) => text === childTexts[0])) return childTexts[0];
    }
    const text = normalizedText(element);
    if (!text) return hasExplicitTextGap(element) ? " " : null;
    const first = Array.from(text)[0] || null;
    return first && Array.from(text).every((character) => character === first) ? first : null;
  }

  function joinRepeatedTextTokens(tokens) {
    const hasWordToken = tokens.some((token) => token && token.trim() && Array.from(token.trim()).length > 1);
    return (hasWordToken ? tokens.map((token) => token.trim()).filter(Boolean).join(" ") : tokens.join("")).replace(/\s+/g, " ").trim();
  }

  function isInlineTextWrapper(element) {
    if (shouldSkipTextNormalization(element) || element.childElementCount > 0) return false;
    const className = typeof element.className === "string" ? element.className : "";
    const display = getComputedStyle(element).display;
    return /(?:^|[-_\s])(word|char|letter|split|line|text)(?:[-_\s]|$)/i.test(className) || display === "inline-block";
  }

  function looksLikeTextLayerContainer(element, children) {
    const className = typeof element.className === "string" ? element.className : "";
    const style = getComputedStyle(element);
    return /(?:^|[-_\s])(word|char|letter|split|line|text|mask|wrapper|inner|list)(?:[-_\s]|$)/i.test(className) || style.flexDirection === "column" || style.overflow === "hidden" || children.some((child) => child.style.transform || getComputedStyle(child).transform !== "none");
  }

  function shouldPreserveAnimatedTextStructure(element, children, original, current) {
    if (!children || children.length === 0) return false;
    const marker = String(element.id || "") + " " + String(element.className || "");
    const childMarker = children.map((child) => String(child.id || "") + " " + String(child.className || "")).join(" ");
    const hasTextAnimationMarker = /(?:^|[-_\s])(word|char|letter|split|line|text|mask|wrapper|inner|list)(?:[-_\s]|$)/i.test(marker + " " + childMarker);
    const hasMotion = hasMotionStyle(element) || children.some(hasMotionStyle);
    const tokens = children.map((child) => repeatedTextToken(child));
    const stackTokenCount = tokens.filter((token) => token !== null).length;
    const hasCharacterStacks = stackTokenCount >= 2 && tokens.every((token) => token !== null) && children.some((child) => directElementChildren(child).length >= 2 || hasMotionStyle(child) || hasExplicitTextGap(child));
    const hasRepeatedAnimatedChildren = stackTokenCount >= 2 && tokens.every((token) => token !== null) && new Set(tokens.filter(Boolean)).size <= 1 && hasTextAnimationMarker && hasMotion;
    const normalizedOriginal = normalizedAttributeText(original);

    if (hasRepeatedAnimatedChildren) return true;
    if (hasCharacterStacks && (hasTextAnimationMarker || hasMotion || looksLikeTextLayerContainer(element, children))) return true;
    if (normalizedOriginal && current === normalizedOriginal && hasTextAnimationMarker && (hasMotion || children.length >= 2)) return true;

    return false;
  }

  function hasMotionStyle(element) {
    const inline = element.style || {};
    if (inline.transform || inline.translate || inline.rotate || inline.scale || inline.animation || inline.transition || inline.willChange) return true;
    const style = getComputedStyle(element);
    return style.transform !== "none" || style.animationName !== "none";
  }

  function looksCorruptedTextReplacement(original, current) {
    const source = normalizedAttributeText(original);
    const value = normalizedAttributeText(current);
    if (!source || !value || source === value) return false;

    const sourceChars = Array.from(source);
    const valueChars = Array.from(value);
    if (valueChars.length > Math.max(sourceChars.length + 4, Math.ceil(sourceChars.length * 1.35))) return true;
    if (/(.)\1{3,}/u.test(value)) return true;

    const prefix = commonPrefixLength(source, value);
    const suffix = value.slice(prefix);
    const sourceLetters = new Set(Array.from(source.toLowerCase()));
    const alienChars = Array.from(suffix.toLowerCase()).filter((character) => character.trim() && !sourceLetters.has(character));
    const hasNoisyPunctuation = /[\\~@#$%^&*_=+{}[\]|;<>?]/.test(suffix);
    const hasUsefulPrefix = prefix >= Math.min(12, Math.max(3, Math.floor(sourceChars.length * 0.35)));

    if (hasUsefulPrefix && suffix.length > 0 && (alienChars.length >= 2 || hasNoisyPunctuation)) return true;
    if (prefix > 0 && valueChars.length >= Math.min(sourceChars.length, 6) && alienChars.length >= Math.max(2, Math.ceil(valueChars.length * 0.35))) return true;

    return false;
  }

  function commonPrefixLength(left, right) {
    const max = Math.min(left.length, right.length);
    let index = 0;
    while (index < max && left[index] === right[index]) index += 1;
    return index;
  }

  function shouldSkipTextNormalization(element) {
    return Boolean(element.closest(skipSelector) || element.closest(startupSelector) || element.querySelector(skipSelector));
  }

  function directElementChildren(element) {
    return Array.from(element.children).filter((child) => child instanceof HTMLElement);
  }

  function hasExplicitTextGap(element) {
    const inlineWidth = element.style.width || element.style.minWidth || element.style.marginLeft || element.style.marginRight;
    if (inlineWidth && inlineWidth !== "0px") return true;
    const style = getComputedStyle(element);
    return style.width !== "0px" && normalizedText(element) === "";
  }

  function normalizedText(element) {
    return (element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function normalizedAttributeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
})();`;
}

async function rewriteAssetsInPage(page: Page, assetMap: Map<string, AssetRecord>, localHtml: string): Promise<string> {
  const htmlDir = path.posix.dirname(localHtml);
  const entries = [...assetMap.values()].map((asset) => [asset.url, path.posix.relative(htmlDir, asset.localPath)] as const);

  const html = await page.evaluate((assetEntries) => {
    const assets = new Map(assetEntries);
    const absolute = (value: string) => {
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return value;
      }
    };

    const rewriteUrl = (value: string) => assets.get(absolute(value)) ?? value;

    const rewriteSrcset = (srcset: string) =>
      srcset
        .split(",")
        .map((part) => {
          const chunks = part.trim().split(/\s+/);
          const local = assets.get(absolute(chunks[0]));
          return local ? [local, ...chunks.slice(1)].join(" ") : part.trim();
        })
        .join(", ");

    const rewriteCssUrls = (value: string) =>
      value.replace(/url\((['"]?)(.*?)\1\)/g, (_match, quote: string, rawUrl: string) => {
        if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
          return `url(${quote}${rawUrl}${quote})`;
        }

        const local = assets.get(absolute(rawUrl));
        return local ? `url("${local}")` : `url(${quote}${rawUrl}${quote})`;
      });

    for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>("link[href]"))) {
      const local = assets.get(absolute(link.getAttribute("href") ?? link.href));
      if (local) {
        link.setAttribute("href", local);
      }
    }

    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))) {
      script.setAttribute("src", rewriteUrl(script.getAttribute("src") ?? script.src));
    }

    for (const image of Array.from(document.querySelectorAll<HTMLImageElement>("img[src]"))) {
      image.setAttribute("src", rewriteUrl(image.getAttribute("src") ?? image.src));
      if (image.hasAttribute("srcset")) {
        image.setAttribute("srcset", rewriteSrcset(image.getAttribute("srcset") ?? ""));
      }
    }

    for (const source of Array.from(document.querySelectorAll<HTMLSourceElement>("source[srcset]"))) {
      source.setAttribute("srcset", rewriteSrcset(source.getAttribute("srcset") ?? ""));
    }

    for (const element of Array.from(document.querySelectorAll<HTMLSourceElement | HTMLVideoElement | HTMLAudioElement>("source[src], video[src], audio[src]"))) {
      const src = element.getAttribute("src");
      if (src) {
        element.setAttribute("src", rewriteUrl(src));
      }
    }

    for (const element of Array.from(document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video[poster], audio[poster]"))) {
      const poster = element.getAttribute("poster");
      if (poster) {
        element.setAttribute("poster", rewriteUrl(poster));
      }
    }

    for (const element of Array.from(document.querySelectorAll<HTMLElement>("[style]"))) {
      element.setAttribute("style", rewriteCssUrls(element.getAttribute("style") ?? ""));
    }

    for (const style of Array.from(document.querySelectorAll<HTMLStyleElement>("style"))) {
      style.textContent = rewriteCssUrls(style.textContent ?? "");
    }

    normalizeTextSnapshotForMirror();

    return `<!doctype html>\n${document.documentElement.outerHTML}`;

    function normalizeTextSnapshotForMirror(): void {
      collapseRepeatedTextStacks();
      collapseTokenizedTextRuns();
      collapseSingleCharacterRuns();
      flattenTextWrapperChildren();
    }

    function collapseRepeatedTextStacks(): void {
      const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*")).reverse();

      for (const element of elements) {
        if (shouldSkipTextNormalization(element)) {
          continue;
        }

        const children = directElementChildren(element);
        if (children.length < 2 || children.some(shouldSkipTextNormalization)) {
          continue;
        }
        if (shouldPreserveAnimatedTextStructure(element, children, "", normalizedText(element))) {
          continue;
        }

        const directTexts = children.map((child) => normalizedText(child)).filter(Boolean);
        if (directTexts.length >= 2 && directTexts.every((text) => text === directTexts[0]) && looksLikeTextLayerContainer(element, children)) {
          element.textContent = directTexts[0];
          continue;
        }

        const tokens = children.map((child) => repeatedTextToken(child));
        const meaningfulTokens = tokens.filter((token): token is string => Boolean(token));
        if (meaningfulTokens.length < 2) {
          continue;
        }

        if (meaningfulTokens.every((token) => token === meaningfulTokens[0]) && looksLikeTextLayerContainer(element, children)) {
          element.textContent = meaningfulTokens[0];
        }
      }
    }

    function collapseTokenizedTextRuns(): void {
      const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*")).reverse();

      for (const element of elements) {
        if (shouldSkipTextNormalization(element)) {
          continue;
        }

        const children = directElementChildren(element);
        if (children.length < 2 || children.some(shouldSkipTextNormalization) || !looksLikeTextLayerContainer(element, children)) {
          continue;
        }
        if (shouldPreserveAnimatedTextStructure(element, children, "", normalizedText(element))) {
          continue;
        }

        const tokens = children.map((child) => repeatedTextToken(child));
        if (tokens.some((token) => token === null) || tokens.filter(Boolean).length < 2) {
          continue;
        }

        const collapsed = joinRepeatedTextTokens(tokens as string[]);
        if (collapsed && collapsed.length < normalizedText(element).length) {
          element.textContent = collapsed;
        }
      }
    }

    function collapseSingleCharacterRuns(): void {
      const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*")).reverse();

      for (const element of elements) {
        if (shouldSkipTextNormalization(element)) {
          continue;
        }

        const children = directElementChildren(element);
        if (children.length < 3 || children.some(shouldSkipTextNormalization)) {
          continue;
        }
        if (shouldPreserveAnimatedTextStructure(element, children, "", normalizedText(element))) {
          continue;
        }

        const tokens = children.map((child) => {
          const repeated = repeatedTextToken(child);
          if (repeated && Array.from(repeated).length === 1) {
            return repeated;
          }

          const text = normalizedText(child);
          if (text.length === 1) {
            return text;
          }

          return hasExplicitTextGap(child) ? " " : null;
        });

        if (tokens.some((token) => token === null) || tokens.filter((token) => token && token !== " ").length < 2) {
          continue;
        }

        const collapsed = tokens.join("").replace(/\s+/g, " ").trim();
        if (collapsed && (collapsed.length < normalizedText(element).length || tokens.includes(" "))) {
          element.textContent = collapsed;
        }
      }
    }

    function flattenTextWrapperChildren(): void {
      const candidates = Array.from(
        document.body.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,h5,h6,a,span,button,label,small,strong,em,li,dt,dd")
      );

      for (const element of candidates) {
        if (shouldSkipTextNormalization(element)) {
          continue;
        }

        const children = directElementChildren(element);
        if (children.length === 0 || children.some((child) => !isInlineTextWrapper(child))) {
          continue;
        }
        if (shouldPreserveAnimatedTextStructure(element, children, element.getAttribute("data-mirror-original-text") ?? "", normalizedText(element))) {
          continue;
        }

        const fragment = document.createDocumentFragment();
        for (const node of Array.from(element.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE) {
            fragment.append(document.createTextNode(node.textContent ?? ""));
            continue;
          }

          if (node instanceof HTMLElement) {
            fragment.append(document.createTextNode(node.textContent ?? ""));
          }
        }

        element.replaceChildren(fragment);
      }
    }

    function repeatedTextToken(element: HTMLElement): string | null {
      const children = directElementChildren(element);
      if (children.length >= 2) {
        const childTexts = children.map((child) => normalizedText(child)).filter(Boolean);
        if (childTexts.length >= 2 && childTexts.every((text) => text === childTexts[0])) {
          return childTexts[0];
        }
      }

      const text = normalizedText(element);
      if (!text) {
        return hasExplicitTextGap(element) ? " " : null;
      }

      const first = firstTextCharacter(text);
      if (first && Array.from(text).every((character) => character === first)) {
        return first;
      }

      return null;
    }

    function isInlineTextWrapper(element: HTMLElement): boolean {
      if (shouldSkipTextNormalization(element) || element.childElementCount > 0) {
        return false;
      }

      const className = typeof element.className === "string" ? element.className : "";
      const display = getComputedStyle(element).display;

      return /(?:^|[-_\s])(word|char|letter|split|line|text)(?:[-_\s]|$)/i.test(className) || display === "inline-block";
    }

    function looksLikeTextLayerContainer(element: HTMLElement, children: HTMLElement[]): boolean {
      const className = typeof element.className === "string" ? element.className : "";
      const style = getComputedStyle(element);

      return (
        /(?:^|[-_\s])(word|char|letter|split|line|text|mask|wrapper|inner|list)(?:[-_\s]|$)/i.test(className) ||
        style.flexDirection === "column" ||
        style.overflow === "hidden" ||
        children.some((child) => child.style.transform || getComputedStyle(child).transform !== "none")
      );
    }

    function shouldPreserveAnimatedTextStructure(element: HTMLElement, children: HTMLElement[], original: string, current: string): boolean {
      if (children.length === 0) {
        return false;
      }

      const marker = `${String(element.id || "")} ${String(element.className || "")}`;
      const childMarker = children.map((child) => `${String(child.id || "")} ${String(child.className || "")}`).join(" ");
      const hasTextAnimationMarker = /(?:^|[-_\s])(word|char|letter|split|line|text|mask|wrapper|inner|list)(?:[-_\s]|$)/i.test(
        `${marker} ${childMarker}`
      );
      const hasMotion = hasMotionStyle(element) || children.some(hasMotionStyle);
      const tokens = children.map((child) => repeatedTextToken(child));
      const stackTokenCount = tokens.filter((token) => token !== null).length;
      const hasCharacterStacks =
        stackTokenCount >= 2 &&
        tokens.every((token) => token !== null) &&
        children.some((child) => directElementChildren(child).length >= 2 || hasMotionStyle(child) || hasExplicitTextGap(child));
      const hasRepeatedAnimatedChildren =
        stackTokenCount >= 2 &&
        tokens.every((token) => token !== null) &&
        new Set(tokens.filter(Boolean)).size <= 1 &&
        hasTextAnimationMarker &&
        hasMotion;
      const normalizedOriginal = original.replace(/\s+/g, " ").trim();

      if (hasRepeatedAnimatedChildren) {
        return true;
      }
      if (hasCharacterStacks && (hasTextAnimationMarker || hasMotion || looksLikeTextLayerContainer(element, children))) {
        return true;
      }
      if (normalizedOriginal && current === normalizedOriginal && hasTextAnimationMarker && (hasMotion || children.length >= 2)) {
        return true;
      }

      return false;
    }

    function hasMotionStyle(element: HTMLElement): boolean {
      if (
        element.style.transform ||
        element.style.translate ||
        element.style.rotate ||
        element.style.scale ||
        element.style.animation ||
        element.style.transition ||
        element.style.willChange
      ) {
        return true;
      }

      const style = getComputedStyle(element);
      return style.transform !== "none" || style.animationName !== "none";
    }

    function shouldSkipTextNormalization(element: HTMLElement): boolean {
      const skipSelector = "script,style,svg,canvas,video,audio,picture,img,source,iframe,input,textarea,select,option";
      const startupSelector = "#preloader,[id*='preload' i],[class*='preload' i],[id*='loader' i],[class*='loader' i]";
      return Boolean(element.closest(skipSelector) || element.closest(startupSelector) || element.querySelector(skipSelector));
    }

    function directElementChildren(element: HTMLElement): HTMLElement[] {
      return Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    }

    function hasExplicitTextGap(element: HTMLElement): boolean {
      const inlineWidth = element.style.width || element.style.minWidth || element.style.marginLeft || element.style.marginRight;
      if (inlineWidth && inlineWidth !== "0px") {
        return true;
      }

      const style = getComputedStyle(element);
      return style.width !== "0px" && normalizedText(element) === "";
    }

    function normalizedText(element: HTMLElement): string {
      return (element.textContent ?? "").replace(/\s+/g, " ").trim();
    }

    function firstTextCharacter(value: string): string | null {
      return Array.from(value)[0] ?? null;
    }

    function joinRepeatedTextTokens(tokens: string[]): string {
      const hasWordToken = tokens.some((token) => token.trim() && Array.from(token.trim()).length > 1);
      return (hasWordToken ? tokens.map((token) => token.trim()).filter(Boolean).join(" ") : tokens.join("")).replace(/\s+/g, " ").trim();
    }

  }, entries);

  return injectMirrorTextNormalizer(html);
}

async function rewriteSavedCssAssets(assetMap: Map<string, AssetRecord>, log: (line: string) => void): Promise<void> {
  const cssAssets = [...assetMap.values()].filter((asset) => asset.resourceType === "stylesheet" || asset.contentType.includes("text/css"));

  await Promise.all(
    cssAssets.map(async (asset) => {
      try {
        const css = await readFile(asset.diskPath, "utf8");
        const rewritten = rewriteCssText(css, asset, assetMap);
        await writeFile(asset.diskPath, rewritten, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`CSS rewrite skipped: ${asset.url} (${message})`);
      }
    })
  );
}

function rewriteCssText(css: string, owner: AssetRecord, assetMap: Map<string, AssetRecord>): string {
  const ownerDir = path.posix.dirname(owner.localPath);
  const toLocal = (rawUrl: string): string | null => {
    const absolute = normalizeAssetUrl(rawUrl, owner.url);
    if (!absolute) {
      return null;
    }

    const asset = assetMap.get(absolute);
    return asset ? path.posix.relative(ownerDir, asset.localPath) : null;
  };

  return css
    .replace(/url\((['"]?)(.*?)\1\)/g, (match, _quote: string, rawUrl: string) => {
      if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
        return match;
      }

      const local = toLocal(rawUrl);
      return local ? `url("${local}")` : match;
    })
    .replace(/@import\s+(['"])(.*?)\1/g, (match, quote: string, rawUrl: string) => {
      const local = toLocal(rawUrl);
      return local ? `@import ${quote}${local}${quote}` : match;
    });
}

async function rewriteInternalLinks(
  records: LinkIndexEntry[],
  rootDir: string,
  pageNameByUrl: Map<string, string>,
  origin: string
): Promise<void> {
  const cheerioPackage = "cheerio";
  const cheerio = await import(cheerioPackage);

  for (const record of records) {
    if (record.status !== "success") {
      continue;
    }

    const fullPath = path.join(rootDir, record.localHtml);
    const html = await readFile(fullPath, "utf8");
    const $ = cheerio.load(html);

    $("a[href]").each((_index: number, element: any) => {
      const href = $(element).attr("href");
      if (!href) {
        return;
      }

      const normalized = normalizeInternalUrl(href, origin);
      if (!normalized) {
        return;
      }

      const targetLocal = pageNameByUrl.get(normalized);
      if (targetLocal) {
        const href = cleanRouteHrefForLocal(normalized, targetLocal) ?? path.posix.relative(path.posix.dirname(record.localHtml), targetLocal);
        $(element).attr("href", href || path.posix.basename(targetLocal));
      }
    });

    await writeFile(fullPath, $.html(), "utf8");
  }
}

function cleanRouteHrefForLocal(url: string, targetLocal: string): string | null {
  const parsed = new URL(url);
  if (parsed.search) {
    return null;
  }

  const pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/g, "");
  const routeName = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).join("-") || "index";
  const expectedLocal = `pages/${routeName}.html`;

  return targetLocal === expectedLocal ? pathname || "/" : null;
}

async function downloadReferencedAssets(rootDir: string, origin: string, log: (line: string) => void): Promise<void> {
  const files = await collectTextFiles(rootDir);
  const references = new Set<string>();
  const bases = new Set<string>();
  const fileNames = new Set<string>();

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    collectDirectAssetReferences(text, references);
    collectComposableAssetReferences(text, bases, fileNames);
    collectDynamicAssetReferences(text, references);
  }

  for (const base of bases) {
    for (const fileName of fileNames) {
      if (assetFileMatchesBase(base, fileName)) {
        references.add(`${base}${fileName}`);
      }
    }
  }

  let downloaded = 0;
  let existing = 0;
  let missing = 0;
  const pending = [...references].filter((reference) => normalizeDownloadableAsset(reference, origin));
  let index = 0;

  const worker = async () => {
    while (index < pending.length) {
      const reference = pending[index];
      index += 1;

      const result = await downloadAssetReference(reference, origin, rootDir);
      if (result === "downloaded") downloaded += 1;
      if (result === "existing") existing += 1;
      if (result === "missing") missing += 1;
    }
  };

  await Promise.all(Array.from({ length: Math.min(staticAssetDownloadConcurrency, pending.length) }, worker));

  if (pending.length > 0) {
    log(`Static asset references: ${downloaded} downloaded, ${existing} already present, ${missing} missing.`);
  }
}

async function patchMirroredRuntime(rootDir: string, log: (line: string) => void): Promise<void> {
  const files = (await collectTextFiles(rootDir)).filter((file) => path.extname(file).toLowerCase() === ".js");
  let patched = 0;

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const original = text;
    text = guardMirroredVideoPlayback(text);

    if (text !== original) {
      await writeFile(file, text, "utf8");
      patched += 1;
    }
  }

  if (patched > 0) {
    log(`Patched local runtime in ${patched} script file(s).`);
  }
}

function guardMirroredVideoPlayback(text: string): string {
  return text.replace(/this\.video\.paused&&this\.video\.play\(\)/g, "this.video.paused&&this.video.play().catch(()=>{})");
}

async function collectTextFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          return;
        }

        if (entry.isFile() && textFileExtensions.has(path.extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      })
    );
  }

  await visit(rootDir);
  return files;
}

function collectDirectAssetReferences(text: string, references: Set<string>): void {
  const quotedAssetRegex = /["'`]([^"'`]+?)["'`]/g;
  const cssUrlRegex = /url\((['"]?)([^'")]+)\1\)/g;
  let match: RegExpExecArray | null;

  while ((match = quotedAssetRegex.exec(text))) {
    addAssetReference(match[1], references);
  }

  while ((match = cssUrlRegex.exec(text))) {
    addAssetReference(match[2], references);
  }
}

function collectComposableAssetReferences(text: string, bases: Set<string>, fileNames: Set<string>): void {
  const quotedStringRegex = /["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;

  while ((match = quotedStringRegex.exec(text))) {
    const value = decodeHtmlEntities(match[1].trim());
    if (!value) {
      continue;
    }

    if (/^(?:https?:\/\/[^/]+)?\/assets\/.+\/$/i.test(value) || /^\.{0,2}\/?assets\/.+\/$/i.test(value)) {
      bases.add(value);
      continue;
    }

    const extension = path.posix.extname(value.split(/[?#]/)[0]).toLowerCase();
    if (referencedAssetExtensions.has(extension) && !value.includes("/") && !value.includes("\\")) {
      fileNames.add(value);
    }
  }
}

function collectDynamicAssetReferences(text: string, references: Set<string>): void {
  collectAudioObjectReferences(text, references);
  collectSettingLiteralReferences(text, references);
  collectSettingTernaryReferences(text, references);
  collectSettingTernaryWithoutPrefixReferences(text, references);
  collectSettingTemplateTernaryReferences(text, references);
  collectPropertyFileNameReferences(text, references);
  collectProjectCardReferences(text, references);
}

function collectAudioObjectReferences(text: string, references: Set<string>): void {
  const audioObjectRegex = /\{id:"([^"]+)",ext:"(\.[a-z0-9]+)"[^}]*\}/gi;
  let match: RegExpExecArray | null;

  while ((match = audioObjectRegex.exec(text))) {
    const [id, extension] = [match[1], match[2]];
    for (const fileName of expandCountedAssetName(id)) {
      addAssetReference(`/assets/audios/${fileName}${extension}`, references);
    }
  }
}

function collectSettingLiteralReferences(text: string, references: Set<string>): void {
  const literalRegex = /settings\.(\w+_PATH)\s*\+\s*["']([^"']+\.[a-z0-9]+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = literalRegex.exec(text))) {
    addSettingAssetReference(match[1], match[2], references);
  }
}

function collectSettingTernaryReferences(text: string, references: Set<string>): void {
  const ternaryRegex =
    /settings\.(\w+_PATH)\s*\+\s*["']([^"']*)["']\s*\+\s*\([^?)]*\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\s*\)\s*\+\s*["'](\.[a-z0-9]+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = ternaryRegex.exec(text))) {
    const [, settingName, prefix, firstName, secondName, extension] = match;
    addSettingAssetReference(settingName, `${prefix}${firstName}${extension}`, references);
    addSettingAssetReference(settingName, `${prefix}${secondName}${extension}`, references);
  }
}

function collectSettingTernaryWithoutPrefixReferences(text: string, references: Set<string>): void {
  const ternaryRegex =
    /settings\.(\w+_PATH)\s*\+\s*\([^?)]*\?\s*["']([^"']+\.[a-z0-9]+)["']\s*:\s*["']([^"']+\.[a-z0-9]+)["']\s*\)/gi;
  let match: RegExpExecArray | null;

  while ((match = ternaryRegex.exec(text))) {
    const [, settingName, firstPath, secondPath] = match;
    addSettingAssetReference(settingName, firstPath, references);
    addSettingAssetReference(settingName, secondPath, references);
  }
}

function collectSettingTemplateTernaryReferences(text: string, references: Set<string>): void {
  const templateRegex =
    /\$\{settings\.(\w+_PATH)\}([^$`]*?)\$\{[^}?]+\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\}([^`$]*?\.[a-z0-9]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = templateRegex.exec(text))) {
    const [, settingName, prefix, firstName, secondName, suffix] = match;
    addSettingAssetReference(settingName, `${prefix}${firstName}${suffix}`, references);
    addSettingAssetReference(settingName, `${prefix}${secondName}${suffix}`, references);
  }
}

function collectPropertyFileNameReferences(text: string, references: Set<string>): void {
  const fileNames = collectQuotedPropertyValues(text, "fileName");
  if (fileNames.size === 0) {
    return;
  }

  const fileNameExpressionRegex =
    /settings\.(\w+_PATH)\s*\+\s*["']([^"']*\/)["']\s*\+\s*(?:this\.)?[\w$.]+\.fileName\s*\+\s*["'](\.[a-z0-9]+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = fileNameExpressionRegex.exec(text))) {
    const [, settingName, prefix, extension] = match;
    for (const fileName of fileNames) {
      addSettingAssetReference(settingName, `${prefix}${fileName}${extension}`, references);
    }
  }
}

function collectProjectCardReferences(text: string, references: Set<string>): void {
  const projectIds = new Set<string>();
  const routeRegexes = [
    /\/projects\/([a-z0-9_]+)(?=[/?#"'`<\\]|$)/gi,
    /\\\/projects\\\/([a-z0-9_]+)(?=[/?#"'`<\\]|$)/gi
  ];

  for (const regex of routeRegexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      projectIds.add(match[1]);
    }
  }

  for (const projectId of projectIds) {
    addAssetReference(`/assets/projects/${projectId}/home.webp`, references);
    addAssetReference(`/assets/projects/${projectId}/home_depth.webp`, references);
  }
}

function collectQuotedPropertyValues(text: string, propertyName: string): Set<string> {
  const values = new Set<string>();
  const propertyRegex = new RegExp(`${propertyName}:"([^"]+)"`, "g");
  let match: RegExpExecArray | null;

  while ((match = propertyRegex.exec(text))) {
    values.add(match[1]);
  }

  return values;
}

function expandCountedAssetName(value: string): string[] {
  const counted = /^(.*)_\[(\d+)\]$/.exec(value);
  if (!counted) {
    return [value];
  }

  const [, baseName, countText] = counted;
  const count = Number.parseInt(countText, 10);
  if (!Number.isFinite(count) || count <= 0) {
    return [value];
  }

  return Array.from({ length: count }, (_item, index) => `${baseName}_${index}`);
}

function addSettingAssetReference(settingName: string, relativePath: string, references: Set<string>): void {
  const basePath = settingAssetBasePath(settingName);
  if (!basePath) {
    return;
  }

  addAssetReference(`${basePath}${relativePath.replace(/^\/+/, "")}`, references);
}

function settingAssetBasePath(settingName: string): string | null {
  switch (settingName) {
    case "AUDIO_PATH":
      return "/assets/audios/";
    case "IMAGE_PATH":
      return "/assets/images/";
    case "MODEL_PATH":
      return "/assets/models/";
    case "PROJECT_PATH":
      return "/assets/projects/";
    case "SPRITE_PATH":
      return "/assets/sprites/";
    case "TEAM_PATH":
      return "/assets/team/";
    case "TEXTURE_PATH":
      return "/assets/textures/";
    default:
      return null;
  }
}

function addAssetReference(rawReference: string, references: Set<string>): void {
  const reference = decodeHtmlEntities(rawReference.trim());
  const pathname = reference.split(/[?#]/)[0];
  const extension = path.posix.extname(pathname).toLowerCase();
  const isUrlLikePath = /^(?:https?:\/\/|\/|\.{1,2}\/)/i.test(reference);

  if (isUrlLikePath && referencedAssetExtensions.has(extension)) {
    references.add(reference);
  }
}

function assetFileMatchesBase(base: string, fileName: string): boolean {
  const extension = path.posix.extname(fileName).toLowerCase();
  const normalizedBase = base.toLowerCase();

  if (normalizedBase.includes("/audios/")) {
    return [".mp3", ".ogg", ".wav"].includes(extension);
  }

  if (normalizedBase.includes("/models/")) {
    return [".bin", ".buf", ".glb", ".gltf"].includes(extension);
  }

  if (normalizedBase.includes("/textures/")) {
    return [".avif", ".exr", ".hdr", ".jpg", ".jpeg", ".png", ".webp"].includes(extension);
  }

  if (normalizedBase.includes("/meta/")) {
    return [".ico", ".json", ".png", ".svg", ".webmanifest", ".webp"].includes(extension);
  }

  if (normalizedBase.includes("/fonts/")) {
    return [".otf", ".ttf", ".woff", ".woff2"].includes(extension);
  }

  return true;
}

async function downloadAssetReference(reference: string, origin: string, rootDir: string): Promise<"downloaded" | "existing" | "missing"> {
  const url = normalizeDownloadableAsset(reference, origin);
  if (!url) {
    return "missing";
  }

  const localPath = safeOriginalAssetPath(url.pathname);
  if (!localPath) {
    return "missing";
  }

  const diskPath = path.join(rootDir, localPath);
  if (fs.existsSync(diskPath)) {
    return "existing";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), staticAssetDownloadTimeoutMs);

  try {
    const response = await fetch(url.href, { signal: controller.signal });

    if (!response.ok) {
      return "missing";
    }

    const body = Buffer.from(await withTimeout(response.arrayBuffer(), staticAssetDownloadTimeoutMs, `Timed out downloading asset: ${url.href}`));
    if (body.length === 0) {
      return "missing";
    }

    await mkdir(path.dirname(diskPath), { recursive: true });
    await writeFile(diskPath, body);
    return "downloaded";
  } catch {
    return "missing";
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeDownloadableAsset(reference: string, origin: string): URL | null {
  try {
    const normalizedReference = decodeHtmlEntities(reference.trim());
    const url = new URL(normalizedReference, origin);
    const extension = path.posix.extname(url.pathname).toLowerCase();

    if (!["http:", "https:"].includes(url.protocol) || !referencedAssetExtensions.has(extension)) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/");
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

function normalizeInternalUrl(input: string, origin: string): string | null {
  try {
    const url = new URL(input, origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function normalizeUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function normalizeAssetUrl(input: string, base?: string): string | null {
  try {
    const url = base ? new URL(input, base) : new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function ensurePageName(
  url: string,
  startUrl: string,
  pageNameByUrl: Map<string, string>,
  usedPageNames: Set<string>
): string {
  const existing = pageNameByUrl.get(url);
  if (existing) {
    return existing;
  }

  const start = new URL(startUrl);
  const current = new URL(url);
  const isStart = current.href === start.href;
  let base = isStart ? "index" : current.pathname.replace(/^\/+|\/+$/g, "").replace(/\.[a-z0-9]+$/i, "");

  if (!base) {
    base = "index";
  }

  base = base.split("/").filter(Boolean).join("-") || "index";
  if (current.search) {
    base = `${base}-${hash(current.search)}`;
  }

  let fileName = `${sanitizeFilePart(base)}.html`;
  if (usedPageNames.has(fileName)) {
    fileName = `${sanitizeFilePart(base)}-${hash(url)}.html`;
  }

  usedPageNames.add(fileName);
  const local = `pages/${fileName}`;
  pageNameByUrl.set(url, local);
  return local;
}

function extensionForImage(url: string, contentType?: string): string {
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  if (/^\.(png|jpe?g|gif|webp|svg|ico|avif)$/.test(extension)) {
    return extension;
  }

  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("jpeg")) return ".jpg";
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("svg")) return ".svg";
  if (contentType?.includes("avif")) return ".avif";
  return ".bin";
}

function extensionForAsset(url: string, contentType: string | undefined, resourceType: string): string {
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  if (extension && extension.length <= 12 && /^[a-z0-9.]+$/i.test(extension)) {
    return extension;
  }

  if (contentType?.includes("text/css")) return ".css";
  if (contentType?.includes("javascript")) return ".js";
  if (contentType?.includes("json")) return ".json";
  if (contentType?.includes("html")) return ".html";
  if (contentType?.includes("svg")) return ".svg";
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("jpeg")) return ".jpg";
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("avif")) return ".avif";
  if (contentType?.includes("woff2")) return ".woff2";
  if (contentType?.includes("woff")) return ".woff";
  if (contentType?.includes("font")) return ".font";
  if (contentType?.includes("mp4")) return ".mp4";
  if (contentType?.includes("webm")) return ".webm";

  if (resourceType === "stylesheet") return ".css";
  if (resourceType === "script") return ".js";
  if (resourceType === "document") return ".html";
  if (resourceType === "fetch" || resourceType === "xhr") return ".json";
  return ".bin";
}

function safeBaseName(urlPath: string): string {
  const parsed = path.parse(urlPath);
  return sanitizeFilePart(parsed.name);
}

function sanitizeFilePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

async function writeIndex(indexPath: string, records: LinkIndexEntry[]): Promise<void> {
  await writeFile(indexPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(
    async ({ timeoutMs }) => {
      await new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 700;
        const startedAt = Date.now();
        const timer = window.setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight - window.innerHeight || Date.now() - startedAt >= timeoutMs) {
            window.clearInterval(timer);
            window.scrollTo(0, Math.min(scrollHeight, totalHeight));
            resolve();
          }
        }, 120);
      });
    },
    { timeoutMs: scrollTimeoutMs }
  );
}

async function restoreInitialViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);

    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      if (element.scrollTop > 0 || element.scrollLeft > 0) {
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
    }

    window.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(500);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function makeProgress(processed: number, queued: number, totalDiscovered: number): CrawlProgress {
  const denominator = queued === 0 ? Math.max(processed, 1) : Math.max(totalDiscovered, 1);
  return {
    processed,
    queued,
    totalDiscovered,
    percent: queued === 0 ? 100 : Math.min(99, Math.round((processed / denominator) * 100))
  };
}

function configurePlaywrightBrowserPath(): void {
  const packagedPaths = app.isPackaged
    ? [
        path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "playwright-core", ".local-browsers"),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "playwright",
          "node_modules",
          "playwright-core",
          ".local-browsers"
        )
      ]
    : [];
  const localPath = path.join(process.cwd(), "node_modules", "playwright-core", ".local-browsers");
  const packagedPath = packagedPaths.find((candidate) => fs.existsSync(candidate));

  if (packagedPath) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = packagedPath;
  } else if (fs.existsSync(localPath)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = localPath;
  } else {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
  }
}

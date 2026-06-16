"use strict";
const electron = require("electron");
const path = require("node:path");
const node_url = require("node:url");
const node_crypto = require("node:crypto");
const promises = require("node:fs/promises");
const fs = require("node:fs");
const node_module = require("node:module");
const node_child_process = require("node:child_process");
const node_http = require("node:http");
const maxPages$1 = 100;
const dockerImage = "webrecorder/browsertrix-crawler";
const replayWebpageVersion = "2.4.6";
const require$1 = node_module.createRequire(require("url").pathToFileURL(__filename).href);
async function getBrowsertrixAvailability() {
  try {
    await runShortProcess("docker", ["info", "--format", "{{.ServerVersion}}"], 8e3);
    return { available: true, reason: "Docker daemon is available." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, reason: message };
  }
}
async function crawlSiteWithBrowsertrix(request, callbacks) {
  const startUrl = normalizeStartUrl$1(request.startUrl);
  const maxDepth = Math.max(0, Math.trunc(request.maxDepth));
  const startedAt = Date.now();
  const outputRoot = path.join(request.outputDir, "output");
  const crawlsRoot = path.join(outputRoot, "browsertrix");
  const collection = `site-mirror-${Date.now()}`;
  const collectionDir = path.join(crawlsRoot, "collections", collection);
  const waczPath = path.join(collectionDir, `${collection}.wacz`);
  const indexPath = path.join(outputRoot, "links-index.json");
  const origin = new URL(startUrl).origin;
  await promises.mkdir(outputRoot, { recursive: true });
  await promises.mkdir(crawlsRoot, { recursive: true });
  await promises.writeFile(indexPath, "[]\n", "utf8");
  callbacks.log(`Output folder: ${outputRoot}`);
  callbacks.log(`Starting Browsertrix crawl: ${startUrl}`);
  callbacks.log(`Crawler limits: maxDepth=${maxDepth}; maxPages=${maxPages$1}.`);
  callbacks.log(`ReplayWeb.page runtime: ${replayWebpageVersion}.`);
  callbacks.progress(makeProgress$1(0, 1, 1, 2));
  const stats = await runBrowsertrix({
    startUrl,
    maxDepth,
    crawlsRoot,
    collection,
    callbacks
  });
  callbacks.progress(makeProgress$1(stats.processed, 0, Math.max(stats.discovered, stats.processed), 84));
  callbacks.log("Preparing ReplayWeb.page viewer.");
  await writeReplayViewer(outputRoot, path.posix.join("browsertrix", "collections", collection, `${collection}.wacz`), startUrl);
  const records = await readBrowsertrixPageIndex(collectionDir, origin);
  await promises.writeFile(indexPath, `${JSON.stringify(records, null, 2)}
`, "utf8");
  callbacks.progress(makeProgress$1(records.length || stats.processed, 0, Math.max(records.length, stats.discovered), 96));
  callbacks.log(`WACZ archive: ${waczPath}`);
  const server = await callbacks.startServer(outputRoot, origin);
  const localUrl = `http://localhost:${server.port}/`;
  const errors = records.filter((record) => record.status === "error").length;
  const pages = records.length || Math.max(stats.processed, 1);
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1e3);
  callbacks.progress(makeProgress$1(pages, 0, pages, 100));
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
}) {
  let processed = 0;
  let discovered = 1;
  const seenUrls = /* @__PURE__ */ new Set([startUrl]);
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
    String(maxPages$1),
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
      processed = Math.min(maxPages$1, processed + 1);
    }
    callbacks.progress(makeProgress$1(processed, Math.max(0, discovered - processed), discovered, void 0));
  });
  return { processed, discovered };
}
async function writeReplayViewer(rootDir, waczPath, startUrl) {
  const replayDir = path.join(rootDir, "replay");
  await promises.mkdir(replayDir, { recursive: true });
  await copyReplayAsset("ui.js", path.join(replayDir, "ui.js"));
  await copyReplayAsset("sw.js", path.join(replayDir, "sw.js"));
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Site Mirror Replay</title>
    <script src="/replay/ui.js"><\/script>
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
  await promises.writeFile(path.join(rootDir, "index.html"), html, "utf8");
}
async function copyReplayAsset(assetName, destination) {
  const packageJson = require$1.resolve("replaywebpage/package.json");
  const source = path.join(path.dirname(packageJson), assetName);
  try {
    await promises.copyFile(source, destination);
  } catch (error) {
    const unpackedSource = source.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    if (unpackedSource === source) {
      throw error;
    }
    await promises.copyFile(unpackedSource, destination);
  }
}
async function readBrowsertrixPageIndex(collectionDir, origin) {
  const files = [path.join(collectionDir, "pages", "pages.jsonl"), path.join(collectionDir, "pages", "extraPages.jsonl")];
  const records = /* @__PURE__ */ new Map();
  for (const file of files) {
    let text;
    try {
      text = await promises.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const page = JSON.parse(line);
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
          httpStatus: status || void 0
        });
      } catch {
      }
    }
  }
  return [...records.values()];
}
function parseBrowsertrixLog(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let payload = null;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return { message: `Browsertrix: ${trimmed}`, completedPage: /(?:finished|complete|done)/i.test(trimmed) };
  }
  const message = stringValue(payload.message) ?? stringValue(payload.msg) ?? stringValue(payload.type) ?? "event";
  const details = objectValue(payload.details);
  const url = stringValue(payload.url) ?? stringValue(payload.page) ?? stringValue(details?.url) ?? stringValue(details?.pageUrl);
  const status = numberValue(payload.status) ?? numberValue(details?.status);
  const completedPage = /(?:page.*(?:done|complete|finished)|finished.*page|crawl.*page)/i.test(message) || status !== void 0;
  const suffix = [url, status ? `status ${status}` : ""].filter(Boolean).join("; ");
  return {
    message: suffix ? `Browsertrix: ${message} (${suffix})` : `Browsertrix: ${message}`,
    url,
    completedPage
  };
}
function pageUrl(page) {
  return stringValue(page.url) ?? stringValue(page.pageUrl) ?? stringValue(page.id) ?? stringValue(objectValue(page.page)?.url) ?? null;
}
function pageStatus(page) {
  return numberValue(page.status) ?? numberValue(page.statusCode) ?? numberValue(page.httpStatus) ?? numberValue(objectValue(page.response)?.status) ?? 200;
}
function pageDepth(page) {
  return numberValue(page.depth) ?? numberValue(objectValue(page.extra)?.depth) ?? 0;
}
function replayPathForUrl(url, origin) {
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
function normalizeStartUrl$1(input) {
  const trimmed = input.trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  url.hash = "";
  return url.href;
}
function makeProgress$1(processed, queued, totalDiscovered, fixedPercent) {
  const denominator = queued === 0 ? Math.max(processed, 1) : Math.max(totalDiscovered, 1);
  return {
    processed,
    queued,
    totalDiscovered,
    percent: fixedPercent ?? (queued === 0 ? 100 : Math.min(99, Math.round(processed / denominator * 100)))
  };
}
function runShortProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = node_child_process.spawn(command, args, { windowsHide: true });
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
function runStreamingProcess(command, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = node_child_process.spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const consume = (chunk, isError) => {
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
    child.stdout.on("data", (chunk) => consume(chunk, false));
    child.stderr.on("data", (chunk) => consume(chunk, true));
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
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const maxPages = 100;
const crawlConcurrency = 3;
const staticAssetDownloadConcurrency = 8;
const pageTimeoutMs = 3e4;
const domContentLoadedTimeoutMs = 15e3;
const networkIdleTimeoutMs = 3e3;
const scrollTimeoutMs = 12e3;
const assetBodyTimeoutMs = 12e3;
const staticAssetDownloadTimeoutMs = 12e3;
const savedResourceTypes = /* @__PURE__ */ new Set(["document", "stylesheet", "script", "image", "font", "media", "fetch", "xhr", "other"]);
const cdnResourceTypes = /* @__PURE__ */ new Set(["stylesheet", "script", "image", "font", "media"]);
const textFileExtensions = /* @__PURE__ */ new Set([".html", ".css", ".js", ".json", ".webmanifest"]);
const referencedAssetExtensions = /* @__PURE__ */ new Set([
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
async function crawlSite(request, callbacks) {
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
async function crawlSiteLegacy(request, callbacks) {
  configurePlaywrightBrowserPath();
  const playwrightPackage = "playwright";
  const { chromium } = await import(playwrightPackage);
  const startUrl = normalizeStartUrl(request.startUrl);
  const maxDepth = Math.max(0, Math.trunc(request.maxDepth));
  const paths = await prepareOutput(request.outputDir);
  const startOrigin = new URL(startUrl).origin;
  let currentLayer = [{ url: startUrl, depth: 0 }];
  const scheduled = /* @__PURE__ */ new Set([startUrl]);
  const pageNameByUrl = /* @__PURE__ */ new Map([[startUrl, "pages/index.html"]]);
  const usedPageNames = /* @__PURE__ */ new Set(["index.html"]);
  const records = [];
  const startedAt = Date.now();
  callbacks.log(`Output folder: ${paths.root}`);
  callbacks.log(`Starting crawl: ${startUrl}`);
  callbacks.log(`Crawler limits: maxDepth=${maxDepth}; maxPages=${maxPages}.`);
  callbacks.progress(makeProgress(0, currentLayer.length, scheduled.size));
  let browser;
  let context;
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
      const nextLayer = [];
      let nextIndex = 0;
      const worker = async () => {
        while (records.length < maxPages) {
          const item = currentLayer[nextIndex];
          nextIndex += 1;
          if (!item) {
            return;
          }
          callbacks.log(`Opening depth ${item.depth}: ${item.url}`);
          const record = await crawlPage(context, item, paths, pageNameByUrl, usedPageNames, callbacks.log);
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
    await context?.close().catch(() => void 0);
    await browser?.close().catch(() => void 0);
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
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1e3);
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
async function crawlPage(context, item, paths, pageNameByUrl, usedPageNames, log) {
  const localHtml = ensurePageName(item.url, item.url, pageNameByUrl, usedPageNames);
  const htmlPath = path.join(paths.root, localHtml);
  const screenshot = `screenshots/${path.basename(localHtml, ".html")}.png`;
  const screenshotPath = path.join(paths.root, screenshot);
  const page = await context.newPage();
  let savedScreenshot;
  const pageOrigin = new URL(item.url).origin;
  const assetMap = /* @__PURE__ */ new Map();
  const assetTasks = [];
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
    await page.waitForTimeout(1e3);
    await settleAssetTasks(assetTasks);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5e3 });
      savedScreenshot = screenshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Screenshot skipped: ${item.url} (${message})`);
    }
    const snapshot = await collectPageSnapshot(page);
    await settleAssetTasks(assetTasks);
    await rewriteSavedCssAssets(assetMap, log);
    const rewrittenHtml = await rewritePageHtml(page, assetMap, localHtml, item.url, responseHtml, snapshot.html, log);
    await promises.writeFile(htmlPath, rewrittenHtml || snapshot.html, "utf8");
    const internalLinks = [...new Set(snapshot.links.map((link) => normalizeInternalUrl(link, new URL(item.url).origin)).filter(Boolean))];
    const localImages = snapshot.images.map((image) => {
      const normalized = normalizeAssetUrl(image);
      return normalized ? assetMap.get(normalized) : void 0;
    }).filter(Boolean).map((asset) => path.posix.relative(path.posix.dirname(localHtml), asset.localPath));
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
    await page.close().catch(() => void 0);
  }
}
async function prepareOutput(selectedDir) {
  const root = path.join(selectedDir, "output");
  const pages = path.join(root, "pages");
  const images = path.join(root, "images");
  const assets = path.join(root, "assets");
  const screenshots = path.join(root, "screenshots");
  const index = path.join(root, "links-index.json");
  await promises.mkdir(pages, { recursive: true });
  await promises.mkdir(images, { recursive: true });
  await promises.mkdir(assets, { recursive: true });
  await promises.mkdir(screenshots, { recursive: true });
  await promises.writeFile(index, "[]\n", "utf8");
  return { root, pages, images, assets, screenshots, index };
}
async function collectPageSnapshot(page) {
  return page.evaluate(() => {
    const srcsetUrls = (srcset) => srcset.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).map((url) => new URL(url, document.baseURI).href);
    const cssUrlRegex = /url\((['"]?)(.*?)\1\)/g;
    const backgroundUrls = [];
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const backgroundImage = getComputedStyle(element).backgroundImage;
      let match;
      while (match = cssUrlRegex.exec(backgroundImage)) {
        if (match[2] && !match[2].startsWith("data:")) {
          backgroundUrls.push(new URL(match[2], document.baseURI).href);
        }
      }
    }
    const images = [
      ...Array.from(document.querySelectorAll("img[src]")).map((image) => image.currentSrc || image.src),
      ...Array.from(document.querySelectorAll("img[srcset], source[srcset]")).flatMap(
        (element) => srcsetUrls(element.getAttribute("srcset") ?? "")
      ),
      ...backgroundUrls
    ];
    return {
      html: document.documentElement.outerHTML,
      links: Array.from(document.querySelectorAll("a[href]")).map((anchor) => anchor.href),
      images: images.filter((image) => image && !image.startsWith("data:"))
    };
  });
}
async function navigateToDocument(page, url, log) {
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
    await page.waitForFunction(() => Boolean(document.documentElement), void 0, { timeout: 5e3 });
  } catch {
    log(`Document readiness timeout, continuing with captured response: ${url}`);
  }
  return response;
}
async function saveResponseAsset(response, pageOrigin, paths, assetMap, log) {
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
    await promises.mkdir(path.dirname(diskPath), { recursive: true });
    await promises.writeFile(diskPath, body);
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
function shouldSaveResource(url, pageOrigin, resourceType) {
  if (!savedResourceTypes.has(resourceType)) {
    return false;
  }
  const origin = new URL(url).origin;
  if (origin === pageOrigin) {
    return true;
  }
  return cdnResourceTypes.has(resourceType);
}
function localPathForAsset(url, pageOrigin, resourceType, extension) {
  if (resourceType === "image") {
    const originalPath = url.origin === pageOrigin ? safeOriginalAssetPath(url.pathname) : null;
    if (originalPath) {
      return path.posix.join("images", originalPath);
    }
    const baseName2 = safeBaseName(url.pathname) || "image";
    return path.posix.join("images", `${baseName2}-${hash(url.href)}${extension}`);
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
function safeOriginalAssetPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!decodedPath || decodedPath.endsWith("/") || decodedPath.split("/").some((part) => part === "..")) {
    return null;
  }
  return decodedPath.split("/").map((part) => sanitizeOriginalPathPart(part) || "asset").join("/");
}
function sanitizeOriginalPathPart(value) {
  return value.replace(/[<>:"|?*\x00-\x1F]/g, "_").trim();
}
async function settleAssetTasks(tasks) {
  let settled = 0;
  while (settled < tasks.length) {
    const batch = tasks.slice(settled);
    settled = tasks.length;
    await Promise.allSettled(batch);
  }
}
async function readDocumentResponseHtml(response) {
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
async function rewritePageHtml(page, assetMap, localHtml, pageUrl2, responseHtml, snapshotHtml, log) {
  if (shouldPreferResponseHtml(responseHtml, snapshotHtml)) {
    try {
      log(`Using initial document HTML: ${pageUrl2}`);
      return await rewriteAssetsInHtml(responseHtml, assetMap, localHtml, pageUrl2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Initial HTML rewrite failed, using rendered DOM: ${pageUrl2} (${message})`);
    }
  }
  return rewriteAssetsInPage(page, assetMap, localHtml);
}
async function rewriteAssetsInHtml(html, assetMap, localHtml, pageUrl2) {
  const cheerioPackage = "cheerio";
  const cheerio = await import(cheerioPackage);
  const $ = cheerio.load(html, { decodeEntities: false });
  const htmlDir = path.posix.dirname(localHtml);
  const assets = new Map([...assetMap.values()].map((asset) => [asset.url, path.posix.relative(htmlDir, asset.localPath)]));
  const absolute = (value) => {
    const normalized = normalizeAssetUrl(decodeHtmlEntities(value), pageUrl2);
    return normalized ?? value;
  };
  const rewriteUrl = (value) => assets.get(absolute(value)) ?? value;
  const rewriteSrcset = (srcset) => srcset.split(",").map((part) => {
    const trimmed = part.trim();
    const chunks = trimmed.split(/\s+/);
    const local = chunks[0] ? assets.get(absolute(chunks[0])) : null;
    return local ? [local, ...chunks.slice(1)].join(" ") : trimmed;
  }).join(", ");
  const rewriteCssUrls = (value) => value.replace(/url\((['"]?)(.*?)\1\)/g, (match, quote, rawUrl) => {
    if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
      return match;
    }
    const local = assets.get(absolute(rawUrl));
    return local ? `url("${local}")` : match;
  });
  const rewriteAttr = (selector, attr) => {
    $(selector).each((_index, element) => {
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
  ]) {
    rewriteAttr(selector, attr);
  }
  for (const [selector, attr] of [
    ["img[srcset]", "srcset"],
    ["source[srcset]", "srcset"],
    ["[data-srcset]", "data-srcset"]
  ]) {
    $(selector).each((_index, element) => {
      const value = $(element).attr(attr);
      if (value) {
        $(element).attr(attr, rewriteSrcset(value));
      }
    });
  }
  $("[style]").each((_index, element) => {
    const value = $(element).attr("style");
    if (value) {
      $(element).attr("style", rewriteCssUrls(value));
    }
  });
  $("style").each((_index, element) => {
    const value = $(element).html();
    if (value) {
      $(element).html(rewriteCssUrls(value));
    }
  });
  annotateOriginalTextSnapshots($);
  return ensureDoctype(injectMirrorTextNormalizer($.html()), html);
}
function annotateOriginalTextSnapshots($) {
  const skipSelector = "script,style,svg,canvas,video,audio,picture,img,source,iframe,input,textarea,select,option";
  $("body *").each((_index, element) => {
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
function normalizeInlineText(value) {
  return value.replace(/\s+/g, " ").trim();
}
function shouldPreferResponseHtml(responseHtml, snapshotHtml) {
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
function visibleHtmlTextLength(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const text = body.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ").replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<canvas\b[\s\S]*?<\/canvas>/gi, " ").replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim().length;
}
function bodyElementCount(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return (body.match(/<(?!\/|!)([a-z][\w:-]*)\b/gi) ?? []).filter((tag) => !/^<(script|style|noscript|meta|link)\b/i.test(tag)).length;
}
function ensureDoctype(serializedHtml, originalHtml) {
  if (/^\s*<!doctype\b/i.test(serializedHtml)) {
    return serializedHtml;
  }
  const originalDoctype = originalHtml.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? "<!doctype html>";
  return `${originalDoctype}
${serializedHtml}`;
}
function injectMirrorTextNormalizer(html) {
  if (html.includes('data-mirror-helper="text-normalizer"')) {
    return html;
  }
  const script = `<script data-mirror-helper="text-normalizer">${mirrorTextNormalizerScript()}<\/script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  return `${html}${script}`;
}
function mirrorTextNormalizerScript() {
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
async function rewriteAssetsInPage(page, assetMap, localHtml) {
  const htmlDir = path.posix.dirname(localHtml);
  const entries = [...assetMap.values()].map((asset) => [asset.url, path.posix.relative(htmlDir, asset.localPath)]);
  const html = await page.evaluate((assetEntries) => {
    const assets = new Map(assetEntries);
    const absolute = (value) => {
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return value;
      }
    };
    const rewriteUrl = (value) => assets.get(absolute(value)) ?? value;
    const rewriteSrcset = (srcset) => srcset.split(",").map((part) => {
      const chunks = part.trim().split(/\s+/);
      const local = assets.get(absolute(chunks[0]));
      return local ? [local, ...chunks.slice(1)].join(" ") : part.trim();
    }).join(", ");
    const rewriteCssUrls = (value) => value.replace(/url\((['"]?)(.*?)\1\)/g, (_match, quote, rawUrl) => {
      if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
        return `url(${quote}${rawUrl}${quote})`;
      }
      const local = assets.get(absolute(rawUrl));
      return local ? `url("${local}")` : `url(${quote}${rawUrl}${quote})`;
    });
    for (const link of Array.from(document.querySelectorAll("link[href]"))) {
      const local = assets.get(absolute(link.getAttribute("href") ?? link.href));
      if (local) {
        link.setAttribute("href", local);
      }
    }
    for (const script of Array.from(document.querySelectorAll("script[src]"))) {
      script.setAttribute("src", rewriteUrl(script.getAttribute("src") ?? script.src));
    }
    for (const image of Array.from(document.querySelectorAll("img[src]"))) {
      image.setAttribute("src", rewriteUrl(image.getAttribute("src") ?? image.src));
      if (image.hasAttribute("srcset")) {
        image.setAttribute("srcset", rewriteSrcset(image.getAttribute("srcset") ?? ""));
      }
    }
    for (const source of Array.from(document.querySelectorAll("source[srcset]"))) {
      source.setAttribute("srcset", rewriteSrcset(source.getAttribute("srcset") ?? ""));
    }
    for (const element of Array.from(document.querySelectorAll("source[src], video[src], audio[src]"))) {
      const src = element.getAttribute("src");
      if (src) {
        element.setAttribute("src", rewriteUrl(src));
      }
    }
    for (const element of Array.from(document.querySelectorAll("video[poster], audio[poster]"))) {
      const poster = element.getAttribute("poster");
      if (poster) {
        element.setAttribute("poster", rewriteUrl(poster));
      }
    }
    for (const element of Array.from(document.querySelectorAll("[style]"))) {
      element.setAttribute("style", rewriteCssUrls(element.getAttribute("style") ?? ""));
    }
    for (const style of Array.from(document.querySelectorAll("style"))) {
      style.textContent = rewriteCssUrls(style.textContent ?? "");
    }
    normalizeTextSnapshotForMirror();
    return `<!doctype html>
${document.documentElement.outerHTML}`;
    function normalizeTextSnapshotForMirror() {
      collapseRepeatedTextStacks();
      collapseTokenizedTextRuns();
      collapseSingleCharacterRuns();
      flattenTextWrapperChildren();
    }
    function collapseRepeatedTextStacks() {
      const elements = Array.from(document.body.querySelectorAll("*")).reverse();
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
        const meaningfulTokens = tokens.filter((token) => Boolean(token));
        if (meaningfulTokens.length < 2) {
          continue;
        }
        if (meaningfulTokens.every((token) => token === meaningfulTokens[0]) && looksLikeTextLayerContainer(element, children)) {
          element.textContent = meaningfulTokens[0];
        }
      }
    }
    function collapseTokenizedTextRuns() {
      const elements = Array.from(document.body.querySelectorAll("*")).reverse();
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
        const collapsed = joinRepeatedTextTokens(tokens);
        if (collapsed && collapsed.length < normalizedText(element).length) {
          element.textContent = collapsed;
        }
      }
    }
    function collapseSingleCharacterRuns() {
      const elements = Array.from(document.body.querySelectorAll("*")).reverse();
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
    function flattenTextWrapperChildren() {
      const candidates = Array.from(
        document.body.querySelectorAll("p,h1,h2,h3,h4,h5,h6,a,span,button,label,small,strong,em,li,dt,dd")
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
    function repeatedTextToken(element) {
      const children = directElementChildren(element);
      if (children.length >= 2) {
        const childTexts = children.map((child) => normalizedText(child)).filter(Boolean);
        if (childTexts.length >= 2 && childTexts.every((text2) => text2 === childTexts[0])) {
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
    function isInlineTextWrapper(element) {
      if (shouldSkipTextNormalization(element) || element.childElementCount > 0) {
        return false;
      }
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
      const hasCharacterStacks = stackTokenCount >= 2 && tokens.every((token) => token !== null) && children.some((child) => directElementChildren(child).length >= 2 || hasMotionStyle(child) || hasExplicitTextGap(child));
      const hasRepeatedAnimatedChildren = stackTokenCount >= 2 && tokens.every((token) => token !== null) && new Set(tokens.filter(Boolean)).size <= 1 && hasTextAnimationMarker && hasMotion;
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
    function hasMotionStyle(element) {
      if (element.style.transform || element.style.translate || element.style.rotate || element.style.scale || element.style.animation || element.style.transition || element.style.willChange) {
        return true;
      }
      const style = getComputedStyle(element);
      return style.transform !== "none" || style.animationName !== "none";
    }
    function shouldSkipTextNormalization(element) {
      const skipSelector = "script,style,svg,canvas,video,audio,picture,img,source,iframe,input,textarea,select,option";
      const startupSelector = "#preloader,[id*='preload' i],[class*='preload' i],[id*='loader' i],[class*='loader' i]";
      return Boolean(element.closest(skipSelector) || element.closest(startupSelector) || element.querySelector(skipSelector));
    }
    function directElementChildren(element) {
      return Array.from(element.children).filter((child) => child instanceof HTMLElement);
    }
    function hasExplicitTextGap(element) {
      const inlineWidth = element.style.width || element.style.minWidth || element.style.marginLeft || element.style.marginRight;
      if (inlineWidth && inlineWidth !== "0px") {
        return true;
      }
      const style = getComputedStyle(element);
      return style.width !== "0px" && normalizedText(element) === "";
    }
    function normalizedText(element) {
      return (element.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    function firstTextCharacter(value) {
      return Array.from(value)[0] ?? null;
    }
    function joinRepeatedTextTokens(tokens) {
      const hasWordToken = tokens.some((token) => token.trim() && Array.from(token.trim()).length > 1);
      return (hasWordToken ? tokens.map((token) => token.trim()).filter(Boolean).join(" ") : tokens.join("")).replace(/\s+/g, " ").trim();
    }
  }, entries);
  return injectMirrorTextNormalizer(html);
}
async function rewriteSavedCssAssets(assetMap, log) {
  const cssAssets = [...assetMap.values()].filter((asset) => asset.resourceType === "stylesheet" || asset.contentType.includes("text/css"));
  await Promise.all(
    cssAssets.map(async (asset) => {
      try {
        const css = await promises.readFile(asset.diskPath, "utf8");
        const rewritten = rewriteCssText(css, asset, assetMap);
        await promises.writeFile(asset.diskPath, rewritten, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`CSS rewrite skipped: ${asset.url} (${message})`);
      }
    })
  );
}
function rewriteCssText(css, owner, assetMap) {
  const ownerDir = path.posix.dirname(owner.localPath);
  const toLocal = (rawUrl) => {
    const absolute = normalizeAssetUrl(rawUrl, owner.url);
    if (!absolute) {
      return null;
    }
    const asset = assetMap.get(absolute);
    return asset ? path.posix.relative(ownerDir, asset.localPath) : null;
  };
  return css.replace(/url\((['"]?)(.*?)\1\)/g, (match, _quote, rawUrl) => {
    if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
      return match;
    }
    const local = toLocal(rawUrl);
    return local ? `url("${local}")` : match;
  }).replace(/@import\s+(['"])(.*?)\1/g, (match, quote, rawUrl) => {
    const local = toLocal(rawUrl);
    return local ? `@import ${quote}${local}${quote}` : match;
  });
}
async function rewriteInternalLinks(records, rootDir, pageNameByUrl, origin) {
  const cheerioPackage = "cheerio";
  const cheerio = await import(cheerioPackage);
  for (const record of records) {
    if (record.status !== "success") {
      continue;
    }
    const fullPath = path.join(rootDir, record.localHtml);
    const html = await promises.readFile(fullPath, "utf8");
    const $ = cheerio.load(html);
    $("a[href]").each((_index, element) => {
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
        const href2 = cleanRouteHrefForLocal(normalized, targetLocal) ?? path.posix.relative(path.posix.dirname(record.localHtml), targetLocal);
        $(element).attr("href", href2 || path.posix.basename(targetLocal));
      }
    });
    await promises.writeFile(fullPath, $.html(), "utf8");
  }
}
function cleanRouteHrefForLocal(url, targetLocal) {
  const parsed = new URL(url);
  if (parsed.search) {
    return null;
  }
  const pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/g, "");
  const routeName = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).join("-") || "index";
  const expectedLocal = `pages/${routeName}.html`;
  return targetLocal === expectedLocal ? pathname || "/" : null;
}
async function downloadReferencedAssets(rootDir, origin, log) {
  const files = await collectTextFiles(rootDir);
  const references = /* @__PURE__ */ new Set();
  const bases = /* @__PURE__ */ new Set();
  const fileNames = /* @__PURE__ */ new Set();
  for (const file of files) {
    let text;
    try {
      text = await promises.readFile(file, "utf8");
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
async function patchMirroredRuntime(rootDir, log) {
  const files = (await collectTextFiles(rootDir)).filter((file) => path.extname(file).toLowerCase() === ".js");
  let patched = 0;
  for (const file of files) {
    let text;
    try {
      text = await promises.readFile(file, "utf8");
    } catch {
      continue;
    }
    const original = text;
    text = guardMirroredVideoPlayback(text);
    if (text !== original) {
      await promises.writeFile(file, text, "utf8");
      patched += 1;
    }
  }
  if (patched > 0) {
    log(`Patched local runtime in ${patched} script file(s).`);
  }
}
function guardMirroredVideoPlayback(text) {
  return text.replace(/this\.video\.paused&&this\.video\.play\(\)/g, "this.video.paused&&this.video.play().catch(()=>{})");
}
async function collectTextFiles(rootDir) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await promises.readdir(directory, { withFileTypes: true });
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
function collectDirectAssetReferences(text, references) {
  const quotedAssetRegex = /["'`]([^"'`]+?)["'`]/g;
  const cssUrlRegex = /url\((['"]?)([^'")]+)\1\)/g;
  let match;
  while (match = quotedAssetRegex.exec(text)) {
    addAssetReference(match[1], references);
  }
  while (match = cssUrlRegex.exec(text)) {
    addAssetReference(match[2], references);
  }
}
function collectComposableAssetReferences(text, bases, fileNames) {
  const quotedStringRegex = /["'`]([^"'`]+)["'`]/g;
  let match;
  while (match = quotedStringRegex.exec(text)) {
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
function collectDynamicAssetReferences(text, references) {
  collectAudioObjectReferences(text, references);
  collectSettingLiteralReferences(text, references);
  collectSettingTernaryReferences(text, references);
  collectSettingTernaryWithoutPrefixReferences(text, references);
  collectSettingTemplateTernaryReferences(text, references);
  collectPropertyFileNameReferences(text, references);
  collectProjectCardReferences(text, references);
}
function collectAudioObjectReferences(text, references) {
  const audioObjectRegex = /\{id:"([^"]+)",ext:"(\.[a-z0-9]+)"[^}]*\}/gi;
  let match;
  while (match = audioObjectRegex.exec(text)) {
    const [id, extension] = [match[1], match[2]];
    for (const fileName of expandCountedAssetName(id)) {
      addAssetReference(`/assets/audios/${fileName}${extension}`, references);
    }
  }
}
function collectSettingLiteralReferences(text, references) {
  const literalRegex = /settings\.(\w+_PATH)\s*\+\s*["']([^"']+\.[a-z0-9]+)["']/gi;
  let match;
  while (match = literalRegex.exec(text)) {
    addSettingAssetReference(match[1], match[2], references);
  }
}
function collectSettingTernaryReferences(text, references) {
  const ternaryRegex = /settings\.(\w+_PATH)\s*\+\s*["']([^"']*)["']\s*\+\s*\([^?)]*\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\s*\)\s*\+\s*["'](\.[a-z0-9]+)["']/gi;
  let match;
  while (match = ternaryRegex.exec(text)) {
    const [, settingName, prefix, firstName, secondName, extension] = match;
    addSettingAssetReference(settingName, `${prefix}${firstName}${extension}`, references);
    addSettingAssetReference(settingName, `${prefix}${secondName}${extension}`, references);
  }
}
function collectSettingTernaryWithoutPrefixReferences(text, references) {
  const ternaryRegex = /settings\.(\w+_PATH)\s*\+\s*\([^?)]*\?\s*["']([^"']+\.[a-z0-9]+)["']\s*:\s*["']([^"']+\.[a-z0-9]+)["']\s*\)/gi;
  let match;
  while (match = ternaryRegex.exec(text)) {
    const [, settingName, firstPath, secondPath] = match;
    addSettingAssetReference(settingName, firstPath, references);
    addSettingAssetReference(settingName, secondPath, references);
  }
}
function collectSettingTemplateTernaryReferences(text, references) {
  const templateRegex = /\$\{settings\.(\w+_PATH)\}([^$`]*?)\$\{[^}?]+\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\}([^`$]*?\.[a-z0-9]+)/gi;
  let match;
  while (match = templateRegex.exec(text)) {
    const [, settingName, prefix, firstName, secondName, suffix] = match;
    addSettingAssetReference(settingName, `${prefix}${firstName}${suffix}`, references);
    addSettingAssetReference(settingName, `${prefix}${secondName}${suffix}`, references);
  }
}
function collectPropertyFileNameReferences(text, references) {
  const fileNames = collectQuotedPropertyValues(text, "fileName");
  if (fileNames.size === 0) {
    return;
  }
  const fileNameExpressionRegex = /settings\.(\w+_PATH)\s*\+\s*["']([^"']*\/)["']\s*\+\s*(?:this\.)?[\w$.]+\.fileName\s*\+\s*["'](\.[a-z0-9]+)["']/gi;
  let match;
  while (match = fileNameExpressionRegex.exec(text)) {
    const [, settingName, prefix, extension] = match;
    for (const fileName of fileNames) {
      addSettingAssetReference(settingName, `${prefix}${fileName}${extension}`, references);
    }
  }
}
function collectProjectCardReferences(text, references) {
  const projectIds = /* @__PURE__ */ new Set();
  const routeRegexes = [
    /\/projects\/([a-z0-9_]+)(?=[/?#"'`<\\]|$)/gi,
    /\\\/projects\\\/([a-z0-9_]+)(?=[/?#"'`<\\]|$)/gi
  ];
  for (const regex of routeRegexes) {
    let match;
    while (match = regex.exec(text)) {
      projectIds.add(match[1]);
    }
  }
  for (const projectId of projectIds) {
    addAssetReference(`/assets/projects/${projectId}/home.webp`, references);
    addAssetReference(`/assets/projects/${projectId}/home_depth.webp`, references);
  }
}
function collectQuotedPropertyValues(text, propertyName) {
  const values = /* @__PURE__ */ new Set();
  const propertyRegex = new RegExp(`${propertyName}:"([^"]+)"`, "g");
  let match;
  while (match = propertyRegex.exec(text)) {
    values.add(match[1]);
  }
  return values;
}
function expandCountedAssetName(value) {
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
function addSettingAssetReference(settingName, relativePath, references) {
  const basePath = settingAssetBasePath(settingName);
  if (!basePath) {
    return;
  }
  addAssetReference(`${basePath}${relativePath.replace(/^\/+/, "")}`, references);
}
function settingAssetBasePath(settingName) {
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
function addAssetReference(rawReference, references) {
  const reference = decodeHtmlEntities(rawReference.trim());
  const pathname = reference.split(/[?#]/)[0];
  const extension = path.posix.extname(pathname).toLowerCase();
  const isUrlLikePath = /^(?:https?:\/\/|\/|\.{1,2}\/)/i.test(reference);
  if (isUrlLikePath && referencedAssetExtensions.has(extension)) {
    references.add(reference);
  }
}
function assetFileMatchesBase(base, fileName) {
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
async function downloadAssetReference(reference, origin, rootDir) {
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
    await promises.mkdir(path.dirname(diskPath), { recursive: true });
    await promises.writeFile(diskPath, body);
    return "downloaded";
  } catch {
    return "missing";
  } finally {
    clearTimeout(timeout);
  }
}
function normalizeDownloadableAsset(reference, origin) {
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
function decodeHtmlEntities(value) {
  return value.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/");
}
function normalizeStartUrl(input) {
  const trimmed = input.trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  url.hash = "";
  return url.href;
}
function normalizeInternalUrl(input, origin) {
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
function normalizeAssetUrl(input, base) {
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
function ensurePageName(url, startUrl, pageNameByUrl, usedPageNames) {
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
function extensionForAsset(url, contentType, resourceType) {
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
function safeBaseName(urlPath) {
  const parsed = path.parse(urlPath);
  return sanitizeFilePart(parsed.name);
}
function sanitizeFilePart(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function hash(value) {
  return node_crypto.createHash("sha1").update(value).digest("hex").slice(0, 10);
}
async function writeIndex(indexPath, records) {
  await promises.writeFile(indexPath, `${JSON.stringify(records, null, 2)}
`, "utf8");
}
async function scrollToBottom(page) {
  await page.evaluate(
    async ({ timeoutMs }) => {
      await new Promise((resolve) => {
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
async function restoreInitialViewport(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);
    for (const element of Array.from(document.querySelectorAll("*"))) {
      if (element.scrollTop > 0 || element.scrollLeft > 0) {
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
    }
    window.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(500);
}
async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
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
function makeProgress(processed, queued, totalDiscovered) {
  const denominator = queued === 0 ? Math.max(processed, 1) : Math.max(totalDiscovered, 1);
  return {
    processed,
    queued,
    totalDiscovered,
    percent: queued === 0 ? 100 : Math.min(99, Math.round(processed / denominator * 100))
  };
}
function configurePlaywrightBrowserPath() {
  const packagedPaths = electron.app.isPackaged ? [
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
  ] : [];
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
const defaultPort = 43110;
const maxPortAttempts = 100;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".exr": "image/aces",
  ".hdr": "image/vnd.radiance",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".buf": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wacz": "application/wacz",
  ".warc": "application/warc",
  ".gz": "application/gzip",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};
const fetchableMissingExtensions = new Set(Object.keys(mimeTypes).filter((extension) => extension !== ".html"));
const localMirrorContentSecurityPolicy = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' about: data: blob: https:",
  "object-src 'none'",
  "base-uri 'self'"
].join("; ");
async function startStaticServer(rootDir, preferredPort = defaultPort, fallbackOrigin) {
  const normalizedRoot = path.resolve(rootDir);
  for (let attempt = 0; attempt < maxPortAttempts; attempt += 1) {
    const port = preferredPort + attempt;
    const server = createStaticServer(normalizedRoot, fallbackOrigin);
    const started = await listen(server, port);
    if (started) {
      return {
        rootDir: normalizedRoot,
        port,
        close: () => closeServer(server)
      };
    }
  }
  throw new Error(`Could not start local HTTP server on ports ${preferredPort}-${preferredPort + maxPortAttempts - 1}.`);
}
function createStaticServer(normalizedRoot, fallbackOrigin) {
  let legacyAssetIndex = null;
  return node_http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const decodedPath = decodeURIComponent(requestUrl.pathname);
      if (decodedPath === "/pages/index.html") {
        response.writeHead(302, { Location: "/" });
        response.end();
        return;
      }
      const requestedPath = await resolveStaticPath(normalizedRoot, decodedPath, () => {
        legacyAssetIndex ??= buildLegacyAssetIndex(path.join(normalizedRoot, "assets"));
        return legacyAssetIndex;
      });
      const localOrFetchedPath = requestedPath ?? (fallbackOrigin ? await fetchMissingAsset(normalizedRoot, decodedPath, fallbackOrigin) : null);
      if (!localOrFetchedPath) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      if (!isInsideRoot(normalizedRoot, localOrFetchedPath)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      await serveFile(request, response, localOrFetchedPath);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
}
async function serveFile(request, response, filePath) {
  const fileStat = await promises.stat(filePath);
  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.range;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  if (contentType.startsWith("text/html")) {
    response.setHeader("Content-Security-Policy", localMirrorContentSecurityPolicy);
  }
  if (!range) {
    response.setHeader("Content-Length", fileStat.size);
    fs.createReadStream(filePath).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
    response.end();
    return;
  }
  const requestedStart = match[1] ? Number.parseInt(match[1], 10) : 0;
  const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : fileStat.size - 1;
  const start = Math.max(0, requestedStart);
  const end = Math.min(fileStat.size - 1, requestedEnd);
  if (start > end || start >= fileStat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${fileStat.size}`
  });
  fs.createReadStream(filePath, { start, end }).pipe(response);
}
async function fetchMissingAsset(normalizedRoot, decodedPath, fallbackOrigin) {
  const extension = path.extname(decodedPath).toLowerCase();
  if (!fetchableMissingExtensions.has(extension)) {
    return null;
  }
  const relativePath = decodedPath.replace(/^\/+/, "");
  if (!relativePath || relativePath.split("/").some((part) => part === "..")) {
    return null;
  }
  const diskPath = path.resolve(normalizedRoot, relativePath);
  if (!isInsideRoot(normalizedRoot, diskPath)) {
    return null;
  }
  for (const origin of remoteAssetOrigins(fallbackOrigin)) {
    try {
      const url = new URL(decodedPath, origin);
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0) {
        continue;
      }
      await promises.mkdir(path.dirname(diskPath), { recursive: true });
      await promises.writeFile(diskPath, body);
      return diskPath;
    } catch {
    }
  }
  return null;
}
function remoteAssetOrigins(fallbackOrigin) {
  const origins = /* @__PURE__ */ new Set();
  try {
    const url = new URL(fallbackOrigin);
    origins.add(url.origin);
  } catch {
  }
  return [...origins];
}
async function resolveStaticPath(normalizedRoot, decodedPath, getLegacyAssetIndex) {
  const candidates = routeCandidates(normalizedRoot, decodedPath);
  for (const candidate of candidates) {
    if (!isInsideRoot(normalizedRoot, candidate)) {
      continue;
    }
    try {
      const fileStat = await promises.stat(candidate);
      if (fileStat.isFile()) {
        return candidate;
      }
    } catch {
    }
  }
  if (decodedPath.startsWith("/assets/")) {
    const legacyAsset = findLegacyAsset(await getLegacyAssetIndex(), decodedPath);
    if (legacyAsset) {
      return legacyAsset;
    }
  }
  return null;
}
function routeCandidates(normalizedRoot, decodedPath) {
  const requestedPath = path.resolve(normalizedRoot, `.${decodedPath}`);
  const candidates = [requestedPath];
  if (decodedPath === "/" || decodedPath === "") {
    candidates.push(path.join(normalizedRoot, "index.html"));
    candidates.push(path.join(normalizedRoot, "pages", "index.html"));
    return candidates;
  }
  const extension = path.extname(decodedPath);
  if (extension.toLowerCase() === ".html") {
    const routeName = decodedPath.replace(/^\/+|\/+$/g, "").replace(/\.html$/i, "").split("/").filter(Boolean).join("-");
    candidates.push(path.join(normalizedRoot, "pages", `${routeName || "index"}.html`));
  }
  if (!extension) {
    const routeName = decodedPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).join("-");
    if (routeName) {
      candidates.push(path.join(normalizedRoot, "pages", `${routeName}.html`));
    }
  }
  return candidates;
}
function isInsideRoot(normalizedRoot, candidate) {
  const relative = path.relative(normalizedRoot, candidate);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function buildLegacyAssetIndex(assetsRoot) {
  const index = /* @__PURE__ */ new Map();
  async function visit(directory) {
    let entries;
    try {
      entries = await promises.readdir(directory, { withFileTypes: true });
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
        if (!entry.isFile()) {
          return;
        }
        const originalName = entry.name.replace(/-[a-f0-9]{10}(?=\.[^.]+$)/i, "");
        const normalizedName = normalizeLegacyAssetName(originalName);
        const matches = index.get(normalizedName) ?? [];
        matches.push(fullPath);
        index.set(normalizedName, matches);
      })
    );
  }
  await visit(assetsRoot);
  return index;
}
function findLegacyAsset(index, decodedPath) {
  const requestedName = normalizeLegacyAssetName(path.posix.basename(decodedPath));
  return index.get(requestedName)?.[0] ?? null;
}
function normalizeLegacyAssetName(fileName) {
  const parsed = path.parse(fileName.toLowerCase());
  return `${parsed.name.replace(/[^a-z0-9]+/g, "")}${parsed.ext}`;
}
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
}
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
const __dirname$1 = path.dirname(node_url.fileURLToPath(require("url").pathToFileURL(__filename).href));
let mainWindow = null;
let localCopyWindow = null;
let crawling = false;
let staticServer = null;
let latestLocalUrl = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "Site Mirror",
    backgroundColor: "#f4f7fb",
    webPreferences: {
      preload: path.join(__dirname$1, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  void loadRenderer(mainWindow);
}
async function loadRenderer(window2) {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl && await isReachable(devUrl)) {
    await window2.loadURL(devUrl);
    return;
  }
  if (devUrl) {
    console.warn(`Renderer dev server is unavailable at ${devUrl}; loading bundled renderer.`);
  }
  await window2.loadFile(path.join(__dirname$1, "../renderer/index.html"));
}
async function isReachable(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(url, {
      method: "HEAD",
      signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
electron.app.whenReady().then(() => {
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("before-quit", () => {
  void staticServer?.close();
});
electron.ipcMain.handle("dialog:select-output-directory", async () => {
  const options = {
    title: "Choose save folder",
    properties: ["openDirectory", "createDirectory"]
  };
  const result = mainWindow ? await electron.dialog.showOpenDialog(mainWindow, options) : await electron.dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0];
});
electron.ipcMain.handle("crawler:start", async (event, request) => {
  if (crawling) {
    throw new Error("Crawler is already running.");
  }
  crawling = true;
  latestLocalUrl = null;
  try {
    const result = await crawlSite(request, {
      log: (line) => event.sender.send("crawler:log", `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${line}`),
      progress: (progress) => event.sender.send("crawler:progress", progress),
      startServer: async (rootDir, origin) => {
        if (staticServer) {
          await staticServer.close().catch(() => void 0);
          staticServer = null;
        }
        staticServer = await startStaticServer(rootDir, void 0, origin);
        return { port: staticServer.port };
      }
    });
    latestLocalUrl = result.localUrl;
    return result;
  } finally {
    crawling = false;
  }
});
electron.ipcMain.handle("crawler:open-copy", async () => {
  if (!latestLocalUrl) {
    throw new Error("No saved copy is available yet.");
  }
  if (localCopyWindow && !localCopyWindow.isDestroyed()) {
    localCopyWindow.focus();
    await localCopyWindow.loadURL(latestLocalUrl);
    localCopyWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }
  localCopyWindow = new electron.BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: "Local Site Copy",
    backgroundColor: "#050505",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: "local-copy-viewer"
    }
  });
  localCopyWindow.on("closed", () => {
    localCopyWindow = null;
  });
  attachLocalCopyDiagnostics(localCopyWindow, latestLocalUrl);
  await localCopyWindow.loadURL(latestLocalUrl);
  localCopyWindow.webContents.openDevTools({ mode: "detach" });
});
electron.ipcMain.handle("crawler:open-copy-external", async () => {
  if (!latestLocalUrl) {
    throw new Error("No saved copy is available yet.");
  }
  await electron.shell.openExternal(latestLocalUrl);
});
function attachLocalCopyDiagnostics(window2, initialUrl) {
  const localOrigin = new URL(initialUrl).origin;
  const sendLog = (line) => mainWindow?.webContents.send("crawler:log", `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] Viewer: ${line}`);
  window2.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const source = sourceId ? `${sourceId}:${line}` : `line ${line}`;
    sendLog(`console[${level}] ${message} (${source})`);
  });
  window2.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    sendLog(`load failed ${errorCode} ${errorDescription}; mainFrame=${isMainFrame}; url=${validatedUrl}`);
  });
  window2.webContents.on("did-finish-load", () => {
    sendLog(`loaded ${window2.webContents.getURL()}`);
  });
  window2.webContents.on("did-navigate", (_event, url) => {
    sendLog(`navigated ${url}`);
  });
  window2.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) {
      sendLog(`in-page navigation ${url}`);
    }
  });
  window2.webContents.on("render-process-gone", (_event, details) => {
    sendLog(`render process gone: ${details.reason}; exitCode=${details.exitCode}`);
  });
  window2.webContents.on("unresponsive", () => {
    sendLog("window became unresponsive");
  });
  window2.webContents.on("will-navigate", (event, url) => {
    let nextOrigin;
    try {
      nextOrigin = new URL(url).origin;
    } catch {
      event.preventDefault();
      sendLog(`blocked invalid navigation ${url}`);
      return;
    }
    if (nextOrigin !== localOrigin) {
      event.preventDefault();
      sendLog(`blocked external navigation ${url}`);
    }
  });
  window2.webContents.setWindowOpenHandler(({ url }) => {
    sendLog(`blocked popup ${url}`);
    return { action: "deny" };
  });
}

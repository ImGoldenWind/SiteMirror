import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultPort = 43110;
const maxPortAttempts = 100;

const mimeTypes: Record<string, string> = {
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

export interface StaticServerHandle {
  rootDir: string;
  port: number;
  close: () => Promise<void>;
}

export async function startStaticServer(rootDir: string, preferredPort = defaultPort, fallbackOrigin?: string): Promise<StaticServerHandle> {
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

function createStaticServer(normalizedRoot: string, fallbackOrigin?: string): Server {
  let legacyAssetIndex: Promise<Map<string, string[]>> | null = null;

  return createServer(async (request, response) => {
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

      const localOrFetchedPath =
        requestedPath ?? (fallbackOrigin ? await fetchMissingAsset(normalizedRoot, decodedPath, fallbackOrigin) : null);

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

async function serveFile(request: IncomingMessage, response: ServerResponse, filePath: string): Promise<void> {
  const fileStat = await stat(filePath);
  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.range;

  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  if (contentType.startsWith("text/html")) {
    response.setHeader("Content-Security-Policy", localMirrorContentSecurityPolicy);
  }

  if (!range) {
    response.setHeader("Content-Length", fileStat.size);
    createReadStream(filePath).pipe(response);
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
  createReadStream(filePath, { start, end }).pipe(response);
}

async function fetchMissingAsset(normalizedRoot: string, decodedPath: string, fallbackOrigin: string): Promise<string | null> {
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

      await mkdir(path.dirname(diskPath), { recursive: true });
      await writeFile(diskPath, body);
      return diskPath;
    } catch {
      // Try the next fallback origin.
    }
  }

  return null;
}

function remoteAssetOrigins(fallbackOrigin: string): string[] {
  const origins = new Set<string>();

  try {
    const url = new URL(fallbackOrigin);
    origins.add(url.origin);
  } catch {
    // Ignore invalid fallback origins.
  }

  return [...origins];
}

async function resolveStaticPath(
  normalizedRoot: string,
  decodedPath: string,
  getLegacyAssetIndex: () => Promise<Map<string, string[]>>
): Promise<string | null> {
  const candidates = routeCandidates(normalizedRoot, decodedPath);

  for (const candidate of candidates) {
    if (!isInsideRoot(normalizedRoot, candidate)) {
      continue;
    }

    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next route candidate.
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

function routeCandidates(normalizedRoot: string, decodedPath: string): string[] {
  const requestedPath = path.resolve(normalizedRoot, `.${decodedPath}`);
  const candidates = [requestedPath];

  if (decodedPath === "/" || decodedPath === "") {
    candidates.push(path.join(normalizedRoot, "index.html"));
    candidates.push(path.join(normalizedRoot, "pages", "index.html"));
    return candidates;
  }

  const extension = path.extname(decodedPath);
  if (extension.toLowerCase() === ".html") {
    const routeName = decodedPath
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.html$/i, "")
      .split("/")
      .filter(Boolean)
      .join("-");

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

function isInsideRoot(normalizedRoot: string, candidate: string): boolean {
  const relative = path.relative(normalizedRoot, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function buildLegacyAssetIndex(assetsRoot: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();

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

function findLegacyAsset(index: Map<string, string[]>, decodedPath: string): string | null {
  const requestedName = normalizeLegacyAssetName(path.posix.basename(decodedPath));
  return index.get(requestedName)?.[0] ?? null;
}

function normalizeLegacyAssetName(fileName: string): string {
  const parsed = path.parse(fileName.toLowerCase());
  return `${parsed.name.replace(/[^a-z0-9]+/g, "")}${parsed.ext}`;
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.listen(port, "127.0.0.1", () => resolve(true));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

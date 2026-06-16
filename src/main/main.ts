import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawlSite } from "./crawler";
import { startStaticServer, type StaticServerHandle } from "./localServer";
import type { CrawlRequest } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: Electron.BrowserWindow | null = null;
let localCopyWindow: Electron.BrowserWindow | null = null;
let crawling = false;
let staticServer: StaticServerHandle | null = null;
let latestLocalUrl: string | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "Site Mirror",
    backgroundColor: "#f4f7fb",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  void loadRenderer(mainWindow);
}

async function loadRenderer(window: Electron.BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;

  if (devUrl && (await isReachable(devUrl))) {
    await window.loadURL(devUrl);
    return;
  }

  if (devUrl) {
    console.warn(`Renderer dev server is unavailable at ${devUrl}; loading bundled renderer.`);
  }

  await window.loadFile(path.join(__dirname, "../renderer/index.html"));
}

async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);

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

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void staticServer?.close();
});

ipcMain.handle("dialog:select-output-directory", async () => {
  const options: Electron.OpenDialogOptions = {
    title: "Choose save folder",
    properties: ["openDirectory", "createDirectory"]
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("crawler:start", async (event, request: CrawlRequest) => {
  if (crawling) {
    throw new Error("Crawler is already running.");
  }

  crawling = true;
  latestLocalUrl = null;

  try {
    const result = await crawlSite(request, {
      log: (line) => event.sender.send("crawler:log", `[${new Date().toLocaleTimeString()}] ${line}`),
      progress: (progress) => event.sender.send("crawler:progress", progress),
      startServer: async (rootDir, origin) => {
        if (staticServer) {
          await staticServer.close().catch(() => undefined);
          staticServer = null;
        }

        staticServer = await startStaticServer(rootDir, undefined, origin);
        return { port: staticServer.port };
      }
    });

    latestLocalUrl = result.localUrl;
    return result;
  } finally {
    crawling = false;
  }
});

ipcMain.handle("crawler:open-copy", async () => {
  if (!latestLocalUrl) {
    throw new Error("No saved copy is available yet.");
  }

  if (localCopyWindow && !localCopyWindow.isDestroyed()) {
    localCopyWindow.focus();
    await localCopyWindow.loadURL(latestLocalUrl);
    localCopyWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  localCopyWindow = new BrowserWindow({
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

ipcMain.handle("crawler:open-copy-external", async () => {
  if (!latestLocalUrl) {
    throw new Error("No saved copy is available yet.");
  }

  await shell.openExternal(latestLocalUrl);
});

function attachLocalCopyDiagnostics(window: Electron.BrowserWindow, initialUrl: string): void {
  const localOrigin = new URL(initialUrl).origin;
  const sendLog = (line: string) => mainWindow?.webContents.send("crawler:log", `[${new Date().toLocaleTimeString()}] Viewer: ${line}`);

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const source = sourceId ? `${sourceId}:${line}` : `line ${line}`;
    sendLog(`console[${level}] ${message} (${source})`);
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    sendLog(`load failed ${errorCode} ${errorDescription}; mainFrame=${isMainFrame}; url=${validatedUrl}`);
  });

  window.webContents.on("did-finish-load", () => {
    sendLog(`loaded ${window.webContents.getURL()}`);
  });

  window.webContents.on("did-navigate", (_event, url) => {
    sendLog(`navigated ${url}`);
  });

  window.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) {
      sendLog(`in-page navigation ${url}`);
    }
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    sendLog(`render process gone: ${details.reason}; exitCode=${details.exitCode}`);
  });

  window.webContents.on("unresponsive", () => {
    sendLog("window became unresponsive");
  });

  window.webContents.on("will-navigate", (event, url) => {
    let nextOrigin: string;
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

  window.webContents.setWindowOpenHandler(({ url }) => {
    sendLog(`blocked popup ${url}`);
    return { action: "deny" };
  });
}

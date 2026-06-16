import electron from "electron";
import type { CrawlProgress, CrawlRequest, SiteMirrorApi } from "../shared/types";

const { contextBridge, ipcRenderer } = electron;

const api: SiteMirrorApi = {
  selectOutputDirectory: () => ipcRenderer.invoke("dialog:select-output-directory"),
  startCrawl: (request: CrawlRequest) => ipcRenderer.invoke("crawler:start", request),
  openSavedCopy: () => ipcRenderer.invoke("crawler:open-copy"),
  openSavedCopyExternal: () => ipcRenderer.invoke("crawler:open-copy-external"),
  onLog: (callback: (line: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) => callback(line);
    ipcRenderer.on("crawler:log", listener);
    return () => ipcRenderer.removeListener("crawler:log", listener);
  },
  onProgress: (callback: (progress: CrawlProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: CrawlProgress) => callback(progress);
    ipcRenderer.on("crawler:progress", listener);
    return () => ipcRenderer.removeListener("crawler:progress", listener);
  }
};

contextBridge.exposeInMainWorld("siteMirror", api);

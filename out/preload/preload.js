"use strict";
const electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
const api = {
  selectOutputDirectory: () => ipcRenderer.invoke("dialog:select-output-directory"),
  startCrawl: (request) => ipcRenderer.invoke("crawler:start", request),
  openSavedCopy: () => ipcRenderer.invoke("crawler:open-copy"),
  openSavedCopyExternal: () => ipcRenderer.invoke("crawler:open-copy-external"),
  onLog: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on("crawler:log", listener);
    return () => ipcRenderer.removeListener("crawler:log", listener);
  },
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("crawler:progress", listener);
    return () => ipcRenderer.removeListener("crawler:progress", listener);
  }
};
contextBridge.exposeInMainWorld("siteMirror", api);

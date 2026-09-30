// Bridge between the sandboxed page and the main process. Only these calls are exposed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inklingHost", {
  platform: process.platform,
  info: () => ipcRenderer.invoke("app:info"),
  list: () => ipcRenderer.invoke("lib:list"),
  save: (doc) => ipcRenderer.invoke("lib:save", doc),
  remove: (id) => ipcRenderer.invoke("lib:remove", id),
  folder: () => ipcRenderer.invoke("lib:folder"),
  reveal: () => ipcRenderer.invoke("lib:reveal"),
  chooseFolder: () => ipcRenderer.invoke("lib:choose-folder"),
  openFiles: () => ipcRenderer.invoke("file:open"),
  exportFile: (name, ext, text) => ipcRenderer.invoke("file:export", { name, ext, text }),
  exportPdf: (name, html, header) => ipcRenderer.invoke("file:pdf", { name, html, header }),
  aiKeys: () => ipcRenderer.invoke("ai:keys"),
  aiSecure: () => ipcRenderer.invoke("ai:secure"),
  aiSetKey: (provider, key) => ipcRenderer.invoke("ai:set-key", provider, key),
  aiCall: (req) => ipcRenderer.invoke("ai:call", req),
  aiModels: (provider) => ipcRenderer.invoke("ai:models", provider),
  onomaPack: () => ipcRenderer.invoke("onoma:pack"),
  setTheme: (t) => ipcRenderer.send("theme:set", t),
  setMenuState: (s) => ipcRenderer.send("menu:state", s),
  setTitle: (t) => ipcRenderer.send("title:set", t),
  onMenu: (cb) => ipcRenderer.on("menu", (_e, action) => cb(action)),
  onOpenFile: (cb) => ipcRenderer.on("open-file", (_e, payload) => cb(payload)),
});

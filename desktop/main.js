// Inkling desktop — main process.
// Owns the window, the native menu, and the library folder on disk (one .inkling JSON file per piece).
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");

const isMac = process.platform === "darwin";
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");

let win = null;
let rendererReady = false;
let queuedOpens = [];
let castNames = [];
let menuState = { focus: false, typewriter: false, pingpong: false, theme: "system", mode: "prose" };

/* ---------------- settings & library folder ---------------- */
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")); } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
}
function libraryDir() {
  const s = readSettings();
  const dir = s.libraryDir || path.join(app.getPath("documents"), "Inkling");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function safeId(id) {
  return String(id).replace(/[^a-z0-9_-]/gi, "");
}
function docPath(id) {
  return path.join(libraryDir(), safeId(id) + ".inkling");
}
function listDocs() {
  const dir = libraryDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".inkling"))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; }
    })
    .filter((d) => d && d.id);
}
function saveDoc(doc) {
  const p = docPath(doc.id);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
  fs.renameSync(tmp, p);
  return true;
}

/* ---------------- Onoma: AI keys, model calls, offline pack ---------------- */
// Keys are encrypted with the OS keychain (safeStorage) and never sent to the page.
const KEYS_FILE = () => path.join(app.getPath("userData"), "ai-keys.json");
function readKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(KEYS_FILE(), "utf8"));
    const out = {};
    for (const [p, v] of Object.entries(raw)) {
      try { out[p] = v.enc ? safeStorage.decryptString(Buffer.from(v.enc, "base64")) : v.plain; } catch { /* unreadable on this machine */ }
    }
    return out;
  } catch { return {}; }
}
function writeKeys(keys) {
  const raw = {};
  const enc = safeStorage.isEncryptionAvailable();
  for (const [p, v] of Object.entries(keys)) if (v) raw[p] = enc ? { enc: safeStorage.encryptString(v).toString("base64") } : { plain: v };
  fs.mkdirSync(path.dirname(KEYS_FILE()), { recursive: true });
  fs.writeFileSync(KEYS_FILE(), JSON.stringify(raw), { mode: 0o600 });
}
function llmRequest(provider, model, key, system, user) {
  if (provider === "claude") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: { model, max_tokens: 1500, system, messages: [{ role: "user", content: user }] },
      text: (j) => (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""),
    };
  }
  const url = { openai: "https://api.openai.com/v1/chat/completions", deepseek: "https://api.deepseek.com/chat/completions", openrouter: "https://openrouter.ai/api/v1/chat/completions" }[provider];
  if (!url) throw new Error("other|Unknown provider " + provider);
  const headers = { "content-type": "application/json", authorization: "Bearer " + key };
  if (provider === "openrouter") { headers["X-Title"] = "Inkling"; headers["HTTP-Referer"] = "https://github.com/Topre60/bookbot"; }
  const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (provider !== "openrouter") body.response_format = { type: "json_object" };
  return { url, headers, body, text: (j) => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "" };
}
function httpCode(status, msg) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || (status === 400 && /model/i.test(msg))) return "model";
  if (status === 429) return "rate";
  return "other";
}
async function getJSON(url, init) {
  let r;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) }); } catch (e) { throw new Error("net|couldn’t connect (" + (e.name === "TimeoutError" ? "timed out" : e.message) + ")"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String((j.error && (j.error.message || j.error)) || j.message || "HTTP " + r.status);
    throw new Error(httpCode(r.status, msg) + "|" + msg);
  }
  return j;
}
ipcMain.handle("ai:keys", () => Object.keys(readKeys()));
ipcMain.handle("ai:secure", () => safeStorage.isEncryptionAvailable());
ipcMain.handle("ai:set-key", (_e, provider, key) => {
  const keys = readKeys();
  if (key) keys[provider] = String(key).trim(); else delete keys[provider];
  writeKeys(keys);
  return Object.keys(keys);
});
ipcMain.handle("ai:call", async (_e, { provider, model, system, user }) => {
  const key = readKeys()[provider];
  if (!key) throw new Error("nokey|No API key saved.");
  const req = llmRequest(provider, model, key, system, user);
  const j = await getJSON(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  return req.text(j);
});
ipcMain.handle("ai:models", async (_e, provider) => {
  const key = readKeys()[provider] || "";
  const q = {
    claude: { url: "https://api.anthropic.com/v1/models?limit=100", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } },
    openai: { url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer " + key } },
    deepseek: { url: "https://api.deepseek.com/models", headers: { authorization: "Bearer " + key } },
    openrouter: { url: "https://openrouter.ai/api/v1/models", headers: {} },
  }[provider];
  const j = await getJSON(q.url, { headers: q.headers });
  return (j.data || []).map((m) => m.id).sort();
});
// the offline word pack lives in the repo's data/ folder in development and in resources/data when packaged
ipcMain.handle("onoma:pack", () => {
  const file = app.isPackaged ? path.join(process.resourcesPath, "data", "onoma-offline.json") : path.join(__dirname, "..", "data", "onoma-offline.json");
  return fs.readFileSync(file, "utf8");
});

/* ---------------- files opened from Finder / Explorer ---------------- */
function readForImport(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return { name: path.basename(file), ext: path.extname(file).slice(1).toLowerCase(), text };
  } catch {
    return null;
  }
}
function deliverOpen(file) {
  const payload = readForImport(file);
  if (!payload) return;
  if (win && rendererReady) win.webContents.send("open-file", payload);
  else queuedOpens.push(payload);
}

/* ---------------- window ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    title: "Inkling",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111410" : "#e6eae2",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 16, y: 15 } : undefined,
    autoHideMenuBar: false,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.on("did-finish-load", () => {
    rendererReady = true;
    queuedOpens.forEach((p) => win.webContents.send("open-file", p));
    queuedOpens = [];
  });
  // links open in the real browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // right-click: spelling fixes, clipboard, and the writing actions for a selection
  win.webContents.on("context-menu", (_e, p) => {
    const items = [];
    if (!p.selectionText && p.isEditable && !p.misspelledWord) items.push({ label: "Onoma: Find a Better Word", click: send("thes") }, { type: "separator" });
    if (p.misspelledWord) {
      p.dictionarySuggestions.slice(0, 5).forEach((w) => items.push({ label: w, click: () => win.webContents.replaceMisspelling(w) }));
      if (!p.dictionarySuggestions.length) items.push({ label: "No suggestions", enabled: false });
      items.push({ label: "Add to Dictionary", click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: "separator" });
    }
    const hasSel = !!(p.selectionText && p.selectionText.trim());
    if (hasSel && p.isEditable) {
      const word = p.selectionText.trim();
      if (word.length <= 200) items.push({ label: "Onoma: “" + (word.length > 20 ? word.slice(0, 20) + "…" : word) + "”", click: send("thes") });
      items.push({ label: "Quote Selection “ ”", click: send("quote") });
      items.push({ label: "Move to Side Notes", accelerator: "CmdOrCtrl+Shift+M", click: send("notes:move") });
      items.push({ label: "Copy to Side Notes", accelerator: "CmdOrCtrl+Shift+J", click: send("notes:copy") });
      items.push({ type: "separator" });
    }
    if (p.isEditable) items.push({ role: "cut", enabled: hasSel }, { role: "copy", enabled: hasSel }, { role: "paste" }, { role: "selectAll" });
    else if (hasSel) items.push({ role: "copy" });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); }
  });
  // flush unsaved work before closing
  let closing = false;
  win.on("close", (e) => {
    if (closing || !rendererReady) return;
    e.preventDefault();
    closing = true;
    win.webContents.send("menu", "flush");
    setTimeout(() => { if (win) win.destroy(); }, 400);
  });
  win.on("closed", () => { win = null; rendererReady = false; });
}

/* ---------------- menu ---------------- */
function send(action) {
  return () => { if (win) win.webContents.send("menu", action); };
}
function buildMenu() {
  const castItems = castNames.length
    ? castNames.slice(0, 9).map((n, i) => ({ label: "Speak as " + n, accelerator: "Alt+" + (i + 1), click: send("speak:" + i) }))
    : [{ label: "No characters yet", enabled: false }];
  const theme = (t, label) => ({ label, type: "radio", checked: menuState.theme === t, click: send("theme:" + t) });
  const mode = (m, label, key) => ({ label, type: "radio", checked: menuState.mode === m, accelerator: "CmdOrCtrl+Shift+" + key, click: send("mode:" + m) });

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Cmd+,", click: send("settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Prose", accelerator: "CmdOrCtrl+N", click: send("new:prose") },
        { label: "New Script", accelerator: "CmdOrCtrl+Shift+N", click: send("new:script") },
        { label: "New Poem", accelerator: "CmdOrCtrl+Alt+N", click: send("new:poem") },
        { label: "New from Template…", accelerator: "CmdOrCtrl+T", click: send("templates") },
        { type: "separator" },
        { label: "Open or Import…", accelerator: "CmdOrCtrl+O", click: send("open") },
        { label: "Duplicate", accelerator: "CmdOrCtrl+Shift+D", click: send("duplicate") },
        { type: "separator" },
        { label: "Export PDF…", accelerator: "CmdOrCtrl+P", click: send("export:pdf") },
        { label: "Export Fountain (.fountain)…", click: send("export:fountain") },
        { label: "Export Markdown (.md)…", click: send("export:md") },
        { label: "Export Plain Text (.txt)…", click: send("export:txt") },
        { type: "separator" },
        { label: "Show Library Folder", click: () => shell.openPath(libraryDir()) },
        { label: "Change Library Folder…", click: send("choose-folder") },
        ...(isMac ? [] : [{ type: "separator" }, { label: "Settings…", accelerator: "Ctrl+,", click: send("settings") }, { type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "selectAll" },
        { type: "separator" },
        { label: "Quote Selection “ ”", accelerator: "CmdOrCtrl+'", click: send("quote") },
        { label: "Single Quotes ‘ ’", accelerator: "CmdOrCtrl+Shift+'", click: send("squote") },
        { label: "Em Dash —", accelerator: "Alt+-", click: send("ins:—") },
        { type: "separator" },
        { label: "Move Selection to Side Notes", accelerator: "CmdOrCtrl+Shift+M", click: send("notes:move") },
        { label: "Copy Selection to Side Notes", accelerator: "CmdOrCtrl+Shift+J", click: send("notes:copy") },
        { type: "separator" },
        { label: "Onoma: Find the Word…", accelerator: "CmdOrCtrl+Shift+L", click: send("thes") },
        { label: "AI Models for Onoma…", click: send("ai") },
        { label: "Word Goal or Limit…", accelerator: "CmdOrCtrl+Shift+G", click: send("goal") },
        { label: "Command Palette…", accelerator: "CmdOrCtrl+K", click: send("palette") },
      ],
    },
    {
      label: "Format",
      submenu: [
        mode("prose", "Prose", "1"), mode("script", "Script", "2"), mode("poem", "Poem", "3"),
        { type: "separator" },
        { label: "Scene Heading", accelerator: "CmdOrCtrl+1", click: send("type:scene") },
        { label: "Action", accelerator: "CmdOrCtrl+2", click: send("type:action") },
        { label: "Character", accelerator: "CmdOrCtrl+3", click: send("type:character") },
        { label: "Parenthetical", accelerator: "CmdOrCtrl+4", click: send("type:paren") },
        { label: "Dialogue", accelerator: "CmdOrCtrl+5", click: send("type:dialogue") },
        { label: "Transition", accelerator: "CmdOrCtrl+6", click: send("type:transition") },
        { type: "separator" },
        { label: "Prose Heading", accelerator: "CmdOrCtrl+Alt+H", click: send("type:h") },
        { label: "Prose Paragraph", accelerator: "CmdOrCtrl+Alt+0", click: send("type:p") },
      ],
    },
    {
      label: "Cast",
      submenu: [
        ...castItems,
        { type: "separator" },
        { label: "Back and Forth", type: "checkbox", checked: menuState.pingpong, accelerator: "CmdOrCtrl+Shift+B", click: send("pingpong") },
        { label: "Add Character…", accelerator: "CmdOrCtrl+Shift+C", click: send("cast-add") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Focus Mode", type: "checkbox", checked: menuState.focus, accelerator: "CmdOrCtrl+Shift+F", click: send("focus") },
        { label: "Typewriter Scrolling", type: "checkbox", checked: menuState.typewriter, accelerator: "CmdOrCtrl+Shift+T", click: send("typewriter") },
        { type: "separator" },
        { label: "Toggle Library", accelerator: "CmdOrCtrl+\\", click: send("toggle-side") },
        { label: "Toggle Side Panel", accelerator: "CmdOrCtrl+Alt+\\", click: send("toggle-panel") },
        { type: "separator" },
        { label: "Theme", submenu: [theme("system", "Match System"), theme("light", "Light"), theme("dark", "Dark")] },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "How Inkling Works", accelerator: "F1", click: send("help") },
        { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: send("keys") },
        { label: "Inkling on GitHub", click: () => shell.openExternal("https://github.com/Topre60/bookbot") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- IPC ---------------- */
ipcMain.handle("lib:list", () => listDocs());
ipcMain.handle("lib:save", (_e, doc) => saveDoc(doc));
ipcMain.handle("lib:remove", async (_e, id) => {
  const p = docPath(id);
  if (!fs.existsSync(p)) return true;
  try { await shell.trashItem(p); } catch { fs.unlinkSync(p); }
  return true;
});
ipcMain.handle("lib:folder", () => libraryDir());
ipcMain.handle("lib:reveal", () => { shell.openPath(libraryDir()); return true; });
ipcMain.handle("lib:choose-folder", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose a library folder",
    message: "Pick a folder for your writing. A synced folder (iCloud Drive, Dropbox, OneDrive) keeps it on all your computers.",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: libraryDir(),
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const s = readSettings();
  s.libraryDir = r.filePaths[0];
  writeSettings(s);
  return { folder: libraryDir(), docs: listDocs() };
});

ipcMain.handle("file:open", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Open or import",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Writing", extensions: ["inkling", "fountain", "txt", "md", "markdown"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (r.canceled) return [];
  return r.filePaths.map(readForImport).filter(Boolean);
});

ipcMain.handle("file:export", async (_e, { name, ext, text }) => {
  const r = await dialog.showSaveDialog(win, {
    title: "Export",
    defaultPath: path.join(app.getPath("documents"), name + "." + ext),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, "utf8");
  return r.filePath;
});

ipcMain.handle("file:pdf", async (_e, { name, html, header }) => {
  const r = await dialog.showSaveDialog(win, {
    title: "Export PDF",
    defaultPath: path.join(app.getPath("documents"), name + ".pdf"),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (r.canceled || !r.filePath) return null;
  // point @font-face at the bundled fonts so the PDF matches the editor
  const fontRoot = (pkg) => pathToFileURL(path.dirname(require.resolve(pkg + "/package.json"))).href;
  const page = html
    .replace(/%%COURIER%%/g, fontRoot("@fontsource/courier-prime"))
    .replace(/%%NEWSREADER%%/g, fontRoot("@fontsource/newsreader"));
  const tmp = path.join(os.tmpdir(), "inkling-print-" + Date.now() + ".html");
  fs.writeFileSync(tmp, page, "utf8");
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await pw.loadFile(tmp);
    await pw.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    const data = await pw.webContents.printToPDF({
      pageSize: "Letter",
      printBackground: false,
      preferCSSPageSize: true,
      displayHeaderFooter: !!header,
      headerTemplate: header || "<span></span>",
      footerTemplate: "<span></span>",
    });
    fs.writeFileSync(r.filePath, data);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  } finally {
    pw.destroy();
    fs.rm(tmp, () => {});
  }
});

ipcMain.handle("app:info", () => ({ platform: process.platform, version: app.getVersion() }));
ipcMain.on("theme:set", (_e, t) => {
  nativeTheme.themeSource = t;
  menuState.theme = t;
  buildMenu();
});
ipcMain.on("menu:state", (_e, s) => {
  if (s.cast) castNames = s.cast;
  Object.assign(menuState, s);
  buildMenu();
});
ipcMain.on("title:set", (_e, title) => { if (win) win.setTitle(title ? title + " — Inkling" : "Inkling"); });

/* ---------------- lifecycle ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    argv.slice(1).filter((a) => /\.(inkling|fountain|txt|md)$/i.test(a)).forEach(deliverOpen);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on("open-file", (e, file) => { e.preventDefault(); deliverOpen(file); });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    process.argv.slice(1).filter((a) => /\.(inkling|fountain|txt|md)$/i.test(a)).forEach(deliverOpen);
    app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on("window-all-closed", () => { if (!isMac) app.quit(); });
}

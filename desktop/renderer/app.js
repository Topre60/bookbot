/* Inkling desktop — renderer.
   The editor engine (blocks, quotes, cast dialogue, mode conversion) matches the phone version;
   storage goes through window.inklingHost (Electron) or falls back to localStorage in a plain browser. */
(function () {
  "use strict";

  /* ================================================================
     Host: Electron bridge, or a browser fallback for development
     ================================================================ */
  var isElectron = !!window.inklingHost;
  var host = window.inklingHost || (function () {
    var KEY = "inkling.desktop.docs";
    function all() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } }
    function put(m) { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) { /* ignore */ } }
    return {
      platform: /Mac/.test(navigator.platform) ? "darwin" : "browser",
      list: function () { var m = all(); return Promise.resolve(Object.keys(m).map(function (k) { return m[k]; })); },
      save: function (doc) { var m = all(); m[doc.id] = doc; put(m); return Promise.resolve(true); },
      remove: function (id) { var m = all(); delete m[id]; put(m); return Promise.resolve(true); },
      folder: function () { return Promise.resolve("Browser storage (development)"); },
      reveal: function () { toast("The library folder is only available in the desktop app"); return Promise.resolve(); },
      chooseFolder: function () { toast("Choosing a folder needs the desktop app"); return Promise.resolve(null); },
      openFiles: function () {
        return new Promise(function (res) {
          var inp = document.createElement("input");
          inp.type = "file"; inp.multiple = true; inp.accept = ".inkling,.fountain,.txt,.md,.markdown";
          inp.onchange = function () {
            var files = Array.prototype.slice.call(inp.files);
            Promise.all(files.map(function (f) { return f.text().then(function (t) { return { name: f.name, ext: f.name.split(".").pop().toLowerCase(), text: t }; }); })).then(res);
          };
          inp.click();
        });
      },
      exportFile: function (name, ext, text) {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        a.download = name + "." + ext; a.click();
        return Promise.resolve(name + "." + ext);
      },
      exportPdf: function () { toast("PDF export needs the desktop app"); return Promise.resolve(null); },
      setTheme: function () {}, setMenuState: function () {}, setTitle: function (t) { document.title = t ? t + " — Inkling" : "Inkling"; },
      onMenu: function () {}, onOpenFile: function () {}
    };
  })();

  var STORE_SETTINGS = "inkling.desktop.settings";
  var COLORS = ["c1", "c2", "c3", "c4", "c5", "c6"];
  var TYPES = { prose: ["p", "h"], script: ["scene", "action", "character", "paren", "dialogue", "transition"], poem: ["verse"] };
  var DEFAULT_TYPE = { prose: "p", script: "action", poem: "verse" };
  var NEXT = { scene: "action", action: "action", character: "dialogue", paren: "dialogue", dialogue: "action", transition: "scene", p: "p", h: "p", verse: "verse" };
  var CYCLE = ["scene", "action", "character", "paren", "dialogue", "transition"];
  var TYPE_NAME = { scene: "Scene heading", action: "Action", character: "Character", paren: "Parenthetical", dialogue: "Dialogue", transition: "Transition", p: "Paragraph", h: "Heading", verse: "Line" };
  var MODE_NAME = { prose: "Prose", script: "Script", poem: "Poem" };
  var VERB_PRESENT = ["says", "asks", "replies", "whispers", "shouts", "murmurs", "snaps", "laughs"];
  var PAST = { says: "said", asks: "asked", replies: "replied", whispers: "whispered", shouts: "shouted", murmurs: "murmured", snaps: "snapped", laughs: "laughed" };
  var TAG_VERBS = "says|said|asks|asked|replies|replied|whispers|whispered|shouts|shouted|murmurs|murmured|yells|yelled|cries|cried|mutters|muttered|answers|answered|calls|called|exclaims|exclaimed|adds|added|continues|continued|snaps|snapped|laughs|laughed|sighs|sighed|tells|told";
  var MOD = host.platform === "darwin" ? "⌘" : "Ctrl+";

  var $ = function (id) { return document.getElementById(id); };
  var editor = $("editor");
  var win = $("win");

  var state = {
    docs: {}, currentId: null,
    settings: { theme: "system", smart: true, tag: "verb-name", tense: "present", verb: "auto", pingpong: false,
      side: true, panel: true, focus: false, typewriter: false, tab: "cast", filter: "all", scale: 1, author: "", lastId: null }
  };
  var pending = null, lastSpeakers = [], savedRange = null;
  var saveTimer = null, decorateQueued = false, savedFlag = true, dirtyIds = {};
  var sessionStart = {};

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function now() { return Date.now(); }
  function cur() { return state.docs[state.currentId]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]; }); }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /* ================================================================
     Storage
     ================================================================ */
  function loadSettings() {
    try { Object.assign(state.settings, JSON.parse(localStorage.getItem(STORE_SETTINGS) || "{}")); } catch (e) { /* ignore */ }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_SETTINGS, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
    pushMenuState();
  }
  function markDirty() {
    var d = cur();
    if (!d) return;
    d.updatedAt = now();
    dirtyIds[d.id] = true;
    setSaved(false);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 500);
  }
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (cur()) collect();
    var ids = Object.keys(dirtyIds);
    dirtyIds = {};
    return Promise.all(ids.map(function (id) { return state.docs[id] ? host.save(state.docs[id]) : null; }))
      .then(function () { setSaved(true); renderLibrary(); })
      .catch(function (e) { setSaved(false); toast("Couldn’t save: " + (e && e.message || e)); });
  }
  function setSaved(v) { savedFlag = v; renderStatus(); }

  function newDoc(mode, title, blocks, extra) {
    var d = Object.assign({
      id: uid(), title: title || "", mode: mode,
      blocks: blocks || [{ t: DEFAULT_TYPE[mode], x: "" }],
      cast: [], goal: 0, createdAt: now(), updatedAt: now()
    }, extra || {});
    state.docs[d.id] = d;
    dirtyIds[d.id] = true;
    return d;
  }
  function sortedDocs() {
    return Object.keys(state.docs).map(function (k) { return state.docs[k]; }).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  function seedSamples() {
    var cast = [
      { id: uid(), name: "Jun", key: "J", color: "c2", notes: "Ferry mechanic. Answers questions with questions. Never says what’s in the envelope." },
      { id: uid(), name: "Lena", key: "L", color: "c1", notes: "Always early. Talks in short sentences when nervous." }
    ];
    var P = function (x) { return { t: "p", x: x }; };
    var prose = newDoc("prose", "The Night Ferry (sample)", [
      P("The ferry left at eleven, the last one of the night, and Jun had the rail almost to themselves. The water was black and the island lights were already small."),
      P("“You’re late,” says Lena."),
      P("Jun didn’t turn around. “The ferry’s late. I’m exactly on time.”"),
      P("“Did you bring it?” asks Lena."),
      P("“I brought something,” says Jun."),
      P("Lena leaned on the rail beside them and waited. Somewhere below, the engine changed its note."),
      { t: "p", x: "", ph: "Your turn: press Alt+1 for Jun or Alt+2 for Lena and keep the scene going." }
    ], { cast: cast, goal: 1000 });
    var t0 = now();
    prose.updatedAt = t0 + 2;
    var script = newDoc("script", "The Night Ferry (as a script)", convertBlocks(prose.blocks.slice(0, 6), "prose", "script", cast), { cast: JSON.parse(JSON.stringify(cast)) });
    script.blocks.unshift({ t: "scene", x: "EXT. FERRY DECK — NIGHT" });
    script.updatedAt = t0 + 1;
    var poem = newDoc("poem", "Harbour haiku (sample)", [
      { t: "verse", x: "last boat of the night", syl: 5 },
      { t: "verse", x: "the island lights go under", syl: 7 },
      { t: "verse", x: "one star at a time", syl: 5 }
    ]);
    poem.updatedAt = t0;
    state.currentId = prose.id;
    state.settings.lastId = prose.id;
  }

  /* ================================================================
     Editor DOM ⇄ blocks
     ================================================================ */
  function makeBlock(b) {
    var p = document.createElement("p");
    p.dataset.t = b.t;
    if (b.ph) p.dataset.ph = b.ph;
    if (b.syl) p.dataset.target = b.syl;
    setBlockText(p, b.x || "");
    return p;
  }
  function setBlockText(p, s) { p.textContent = s; if (!s) p.appendChild(document.createElement("br")); }
  function renderEditor() {
    var d = cur();
    editor.className = "editor m-" + d.mode;
    win.classList.toggle("m-script-page", d.mode === "script");
    editor.textContent = "";
    var frag = document.createDocumentFragment();
    d.blocks.forEach(function (b) { frag.appendChild(makeBlock(b)); });
    editor.appendChild(frag);
    ensureBlocks();
    decorateAll();
  }
  function collect() {
    var d = cur();
    if (!d || !editor.children.length) return;
    d.blocks = Array.prototype.map.call(editor.children, function (p) {
      var b = { t: p.dataset.t || DEFAULT_TYPE[d.mode], x: p.textContent };
      if (p.dataset.ph) b.ph = p.dataset.ph;
      if (p.dataset.target) b.syl = +p.dataset.target;
      return b;
    });
  }
  function ensureBlocks() {
    var d = cur(), def = DEFAULT_TYPE[d.mode];
    var caret = caretInfo(), changed = false;
    Array.prototype.slice.call(editor.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && n.nodeName === "P") {
        if (!n.dataset.t || TYPES[d.mode].indexOf(n.dataset.t) < 0) n.dataset.t = mapType(n.dataset.t, d.mode);
        if (n.querySelector("*:not(br)")) { setBlockText(n, n.textContent); changed = true; }
        return;
      }
      if (n.nodeType === 3 && !n.textContent.trim()) { editor.removeChild(n); return; }
      var p = document.createElement("p");
      p.dataset.t = def;
      setBlockText(p, n.textContent.replace(/\n+/g, " "));
      editor.replaceChild(p, n);
      changed = true;
    });
    if (!editor.firstElementChild) { editor.appendChild(makeBlock({ t: def, x: "" })); changed = true; }
    if (changed && caret && editor.contains(caret.block)) setSel(caret.block, caret.a);
  }
  function blockOf(node) {
    if (!node || !editor.contains(node) || node === editor) return null;
    while (node && node.parentNode !== editor) node = node.parentNode;
    return node && node.nodeName === "P" ? node : null;
  }
  function curBlock() {
    var s = getSelection();
    if (!s.rangeCount) return null;
    return blockOf(s.anchorNode) || (s.anchorNode === editor ? editor.children[Math.min(s.anchorOffset, editor.children.length - 1)] : null);
  }
  function offsetIn(block, node, off) {
    if (node === editor) return off > Array.prototype.indexOf.call(editor.children, block) ? block.textContent.length : 0;
    var r = document.createRange();
    r.setStart(block, 0);
    try { r.setEnd(node, off); } catch (e) { return 0; }
    return r.toString().length;
  }
  function caretInfo() {
    var s = getSelection();
    if (!s.rangeCount) return null;
    var r = s.getRangeAt(0);
    var b1 = blockOf(r.startContainer), b2 = blockOf(r.endContainer);
    if (!b1 || !b2) return null;
    return { block: b1, endBlock: b2, a: offsetIn(b1, r.startContainer, r.startOffset), b: offsetIn(b2, r.endContainer, r.endOffset), collapsed: r.collapsed };
  }
  function pointAt(block, pos) {
    var w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), n, left = pos, last = null;
    while ((n = w.nextNode())) { last = n; if (left <= n.length) return [n, left]; left -= n.length; }
    return last ? [last, last.length] : [block, 0];
  }
  function setSel(block, a, b) {
    if (b == null) b = a;
    var r = document.createRange(), p1 = pointAt(block, a), p2 = pointAt(block, b);
    r.setStart(p1[0], p1[1]); r.setEnd(p2[0], p2[1]);
    var s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function insertText(str) {
    var ok = false;
    try { ok = document.execCommand("insertText", false, str); } catch (e) { ok = false; }
    if (!ok) {
      var s = getSelection(), r = s.getRangeAt(0);
      r.deleteContents();
      var tn = document.createTextNode(str);
      r.insertNode(tn); r.setStartAfter(tn); r.collapse(true);
      s.removeAllRanges(); s.addRange(r);
      var b = blockOf(tn); if (b) { var br = b.querySelector("br"); if (br && b.textContent) br.remove(); }
    }
  }
  function replaceRange(block, a, b, str) {
    setSel(block, a, b);
    if (str === "" && a !== b) { document.execCommand("delete"); return; }
    insertText(str);
  }
  function restoreSel() {
    if (document.activeElement !== editor) editor.focus({ preventScroll: true });
    var s = getSelection();
    if (savedRange && (!s.rangeCount || !editor.contains(s.anchorNode))) { s.removeAllRanges(); s.addRange(savedRange); }
    if (!curBlock()) { var last = editor.lastElementChild; setSel(last, last.textContent.length); }
  }
  function newLineAfter(block, type) {
    setSel(block, block.textContent.length);
    var ok = false;
    try { ok = document.execCommand("insertParagraph"); } catch (e) { ok = false; }
    var nb = curBlock();
    if (!ok || !nb || nb === block) { nb = makeBlock({ t: type, x: "" }); block.after(nb); setSel(nb, 0); }
    nb.dataset.t = type;
    delete nb.dataset.ph; delete nb.dataset.target; delete nb.dataset.num;
    nb.removeAttribute("class"); nb.removeAttribute("style");
    return nb;
  }

  function handleEnter() {
    var d = cur(), c = caretInfo();
    if (!c) return false;
    if (!c.collapsed) { document.execCommand("delete"); c = caretInfo(); if (!c) return true; }
    var b = c.block, t = b.dataset.t, len = b.textContent.length;
    if (pending && pending.block === b) {
      var spoke = finishPending();
      if (!spoke && !b.textContent) { afterStructural(); return true; }
      var nb = newLineAfter(b, DEFAULT_TYPE[d.mode]);
      if (spoke && state.settings.pingpong) { var other = otherSpeaker(spoke); if (other) openLine(nb, other); }
      afterStructural();
      return true;
    }
    if (c.a === 0 && len > 0) { b.before(makeBlock({ t: t, x: "" })); setSel(b, 0); afterStructural(); return true; }
    if (d.mode === "script" && len === 0 && t !== "action") { b.dataset.t = "action"; afterStructural(); return true; }
    var type = c.a >= len ? NEXT[t] || DEFAULT_TYPE[d.mode] : t;
    var ok = false;
    try { ok = document.execCommand("insertParagraph"); } catch (e) { ok = false; }
    var n2 = curBlock();
    if (!ok || !n2 || n2 === b) {
      var tail = b.textContent.slice(c.a);
      setBlockText(b, b.textContent.slice(0, c.a));
      n2 = makeBlock({ t: type, x: tail }); b.after(n2); setSel(n2, 0);
    }
    n2.dataset.t = type;
    delete n2.dataset.ph; delete n2.dataset.target; delete n2.dataset.num;
    n2.removeAttribute("class"); n2.removeAttribute("style");
    afterStructural();
    return true;
  }
  function afterStructural() { ensureBlocks(); decorateSoon(); markDirty(); keepCaretVisible(); syncTypeButtons(); }

  function keepCaretVisible() {
    var b = curBlock(), sc = $("scroll");
    if (!b) return;
    var r = b.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    if (state.settings.typewriter) {
      var target = sr.top + sr.height * 0.42;
      sc.scrollTop += (r.top + Math.min(r.height, 40) / 2) - target;
      return;
    }
    if (r.bottom > sr.bottom - 40) sc.scrollTop += r.bottom - sr.bottom + 80;
    else if (r.top < sr.top + 8) sc.scrollTop -= sr.top - r.top + 40;
  }
  function markCurrent() {
    var b = curBlock();
    var old = editor.querySelector("p.current");
    if (old && old !== b) old.classList.remove("current");
    if (b) b.classList.add("current");
  }

  /* ---------------- decoration ---------------- */
  function decorateSoon() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(function () { decorateQueued = false; decorateAll(); collect(); renderStatus(); renderPanelSoon(); });
  }
  function decorateAll() {
    var d = cur();
    var castByName = {};
    d.cast.forEach(function (c) { castByName[c.name.toUpperCase()] = c; });
    var saidRe = null;
    if (d.mode === "prose" && d.cast.length) {
      var names = d.cast.map(function (c) { return reEsc(c.name); }).join("|");
      saidRe = new RegExp("(?:(?:" + TAG_VERBS + ")\\s+(" + names + ")|(" + names + ")\\s+(?:" + TAG_VERBS + "))(?![\\p{L}])", "u");
    }
    var sceneN = 0;
    Array.prototype.forEach.call(editor.children, function (p) {
      var txt = p.textContent;
      p.classList.toggle("empty", txt.length === 0);
      var who = null;
      if (saidRe && txt.indexOf("“") >= 0) {
        var sm = txt.match(saidRe);
        who = sm && castByName[(sm[1] || sm[2]).toUpperCase()];
      }
      p.classList.toggle("said", !!who);
      if (d.mode === "script" && p.dataset.t === "character") who = castByName[txt.replace(/\s*\(.*\)\s*$/, "").trim().toUpperCase()];
      if (who) p.style.setProperty("--who", "var(--" + who.color + ")"); else p.style.removeProperty("--who");
      if (d.mode === "script" && p.dataset.t === "scene") p.dataset.num = ++sceneN; else delete p.dataset.num;
      if (d.mode === "poem") {
        if (txt.trim()) {
          var n = syllables(txt), tg = +p.dataset.target || 0;
          p.dataset.syl = tg ? n + "/" + tg : String(n);
          p.classList.toggle("syl-ok", !!tg && n === tg);
          p.classList.toggle("syl-off", !!tg && n !== tg);
        } else if (p.dataset.target) { p.dataset.syl = "0/" + p.dataset.target; p.classList.remove("syl-ok", "syl-off"); }
        else delete p.dataset.syl;
      } else delete p.dataset.syl;
    });
    markOverLimit(d);
    if (pending) {
      if (!editor.contains(pending.block)) { pending = null; renderCastStrip(); }
      else {
        var pc = castById(pending.id);
        pending.block.classList.add("speaking");
        if (pc) pending.block.style.setProperty("--who", "var(--" + pc.color + ")");
      }
    }
    markCurrent();
  }
  /* syllables: rules for English plus a list of common words the rules get wrong */
  var SYL_EXCEPT = { every: 2, everything: 3, everyone: 3, everywhere: 3, evening: 2, different: 3, family: 3, poem: 2, poems: 2, poet: 2, quiet: 2, science: 2, lion: 2, idea: 3, area: 3, being: 2, create: 2, created: 3, business: 2, beautiful: 3, people: 2, fire: 1, hour: 1, our: 1, flower: 2, flowers: 2, power: 2, towards: 2, toward: 2, heaven: 2, maybe: 2, somewhere: 2, someone: 2, something: 2, sometimes: 2, anyone: 3, orange: 2, forever: 3, whisper: 2, whispered: 2, naked: 2, wicked: 2, sacred: 2, beloved: 3, learned: 1, real: 1, ocean: 2, ancient: 2, special: 2, usual: 3, actually: 4, interesting: 3, chocolate: 3, vegetable: 4, comfortable: 3, lonely: 2, silence: 2, moonlight: 2, starlight: 2, shoreline: 2, likely: 2, lovely: 2, eye: 1, eyes: 1, one: 1, once: 1, the: 1, iron: 2, via: 2, radio: 3, piano: 3, video: 3, violet: 3, diamond: 2, dying: 2, lying: 2, crying: 2, trying: 2, flying: 2, going: 2, doing: 2, seeing: 2, saying: 2, playing: 2, tired: 2, cruel: 2, fuel: 2, jewel: 2, poetry: 3, cafe: 2, recipe: 3, simile: 3, apostrophe: 4, catastrophe: 4 };
  function wordSyl(w) {
    w = w.toLowerCase().replace(/[’']/g, "").replace(/[^a-z]/g, "");
    if (!w) return 0;
    if (SYL_EXCEPT[w] != null) return SYL_EXCEPT[w];
    if (w.length <= 3) return 1;
    var base = w;
    var extra = 0;
    if (/(?:s|x|z|ch|sh|c|g)es$/.test(base)) { base = base.slice(0, -2); extra = 1; }   // boxes, places, roses
    else if (/[^aeiouy]es$/.test(base)) base = base.slice(0, -2);                       // homes, leaves
    else if (/[^aeiou]ed$/.test(base) && !/[td]ed$/.test(base)) base = base.slice(0, -2); // jumped, leaned
    // silent e inside compounds: lonely, hopeful, movement, homeless, timeline
    base = base.replace(/([^aeiouy])e(ly|ful|ment|ness|less|line|like)$/, "$1$2");
    // silent final e, but "-le" after a consonant is its own syllable (table, little)
    if (/[^aeiouy]le$/.test(base)) { /* keep */ }
    else if (/[^aeiouy]e$/.test(base) || /[aeiou][^aeiouy]e$/.test(base)) base = base.slice(0, -1);
    base = base.replace(/^y/, "");
    var groups = base.match(/[aeiouy]+/g) || [];
    var n = groups.length;
    // vowel pairs that are two syllables: radio, piano, lion, react, create
    var splits = base.match(/[^cst]i[aou]|eo|ua(?!y)|uo|iet|ier$|rea(?![dlmnpst])|ia$/g);
    if (splits) n += splits.length;
    return Math.max(1, n + extra);
  }
  function syllables(line) {
      return (line.match(/[A-Za-z’']+/g) || []).reduce(function (s, w) { return s + wordSyl(w); }, 0);
    }

  /* ---------------- auto-closing pairs, like a code editor ---------------- */
  var PAIRS = { "“": "”", "‘": "’", "(": ")", "[": "]", "\"": "\"" };
  var CLOSERS = { "”": 1, "’": 1, ")": 1, "]": 1, "\"": 1 };
  function smartChar(ch, prev) {
    var opening = !prev || /[\s(\[{“‘—–\-]/.test(prev);
    if (ch === "\"") return state.settings.smart ? (opening ? "“" : "”") : "\"";
    if (ch === "'") return state.settings.smart ? (opening ? "‘" : "’") : "'";
    return ch;
  }
  /* handles a typed quote or bracket; returns false to let the browser type it */
  function typeChar(data) {
    var c = caretInfo();
    if (!c) return false;
    var auto = state.settings.autopair !== false;
    var txt = c.block.textContent, prev = c.a > 0 ? txt[c.a - 1] : "";
    var ch = smartChar(data, prev);
    // typing an opener over a selection wraps it: “selection”
    if (auto && !c.collapsed && PAIRS[ch] && ch !== "’" && c.block === c.endBlock) {
      var a = c.a, b = c.b;
      replaceRange(c.block, a, b, ch + txt.slice(a, b) + PAIRS[ch]);
      setSel(c.block, a + 1, b + 1);
      return true;
    }
    if (!c.collapsed) { document.execCommand("delete"); c = caretInfo(); if (!c) return false; txt = c.block.textContent; prev = c.a > 0 ? txt[c.a - 1] : ""; ch = smartChar(data, prev); }
    var next = txt[c.a] || "";
    // step over a closer that's already there
    if (auto && CLOSERS[ch] && next === ch) { setSel(c.block, c.a + 1); return true; }
    if (ch === "”" && auto && next === "\"") { setSel(c.block, c.a + 1); return true; }
    var closingStraight = ch === "\"" && prev && !/[\s(\[{]/.test(prev);
    if (auto && PAIRS[ch] && !closingStraight && (!next || /[\s.,;:!?)\]”’—…]/.test(next))) {
      insertText(ch + PAIRS[ch]);
      var cc = caretInfo();
      setSel(cc.block, cc.a - 1);
      return true;
    }
    if (ch !== data) { insertText(ch); return true; }
    return false;
  }
  /* Backspace inside an empty pair removes both halves */
  function backspacePair() {
    if (state.settings.autopair === false) return false;
    var c = caretInfo();
    if (!c || !c.collapsed || c.a === 0) return false;
    var txt = c.block.textContent, o = txt[c.a - 1], n = txt[c.a];
    if (!PAIRS[o] || PAIRS[o] !== n) return false;
    replaceRange(c.block, c.a - 1, c.a + 1, "");
    return true;
  }

  /* ---------------- word-at-a-time moving, selecting and deleting ---------------- */
  function wordMove(dir, extend) {
    var s = getSelection();
    if (!s.modify || !s.rangeCount) return;
    s.modify(extend ? "extend" : "move", dir < 0 ? "backward" : "forward", "word");
  }
  function wordDelete(dir) {
    var s = getSelection();
    if (!s.rangeCount) return;
    if (s.isCollapsed && s.modify) s.modify("extend", dir < 0 ? "backward" : "forward", "word");
    document.execCommand("delete");
  }
  /* Ctrl (or ⌥ on a Mac) + ←/→ jumps a word, add Shift to select, + Backspace/Delete removes a word */
  function wordKeys(e) {
    var mod = (e.ctrlKey || e.altKey) && !e.metaKey;
    if (!mod) return false;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); wordMove(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey); return true; }
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); wordDelete(e.key === "Backspace" ? -1 : 1); return true; }
    return false;
  }

  function countWords(s) { var m = s.match(/[\p{L}\p{N}][\p{L}\p{N}’'\-]*/gu); return m ? m.length : 0; }
  function wordCount(d) { return d.blocks.reduce(function (n, b) { return n + countWords(b.x); }, 0); }
  function markOverLimit(d) {
    var limit = d.goal && d.goalType === "limit" ? d.goal : 0, run = 0;
    Array.prototype.forEach.call(editor.children, function (p) {
      var n = countWords(p.textContent), before = run;
      run += n;
      p.classList.toggle("over", !!limit && before >= limit && n > 0);
      p.classList.toggle("cross", !!limit && before < limit && run > limit);
    });
  }
  function scriptPages(d) {
    var lines = d.blocks.reduce(function (s, b) {
      var w = b.t === "dialogue" ? 35 : b.t === "paren" ? 25 : 60;
      var extra = (b.t === "scene" || b.t === "action" || b.t === "character" || b.t === "transition") ? 1 : 0;
      return s + Math.max(1, Math.ceil(b.x.length / w)) + extra;
    }, 0);
    return lines / 55;
  }

  /* ================================================================
     Quotes & dialogue
     ================================================================ */
  function quoteSelection(open, close) {
    restoreSel();
    var c = caretInfo();
    if (!c) return;
    if (c.collapsed) {
      insertText(open + close);
      var cc = caretInfo(); setSel(cc.block, cc.a - 1);
    } else if (c.block === c.endBlock) {
      var txt = c.block.textContent, a = c.a, b = c.b;
      while (a < b && /\s/.test(txt[a])) a++;
      while (b > a && /\s/.test(txt[b - 1])) b--;
      if (txt[a - 1] === open && txt[b] === close) { replaceRange(c.block, a - 1, b + 1, txt.slice(a, b)); setSel(c.block, a - 1, b - 1); }
      else { replaceRange(c.block, a, b, open + txt.slice(a, b) + close); setSel(c.block, b + 2); }
    } else {
      var eb = c.endBlock, sb = c.block, ea = c.b, sa = c.a;
      setSel(eb, ea); insertText(close);
      setSel(sb, sa); insertText(open);
    }
    decorateSoon(); markDirty();
  }
  function castById(id) { return cur().cast.filter(function (c) { return c.id === id; })[0]; }
  function verbFor(core) {
    var v = state.settings.verb;
    if (v === "none") return "";
    if (v === "auto") v = /\?\s*$/.test(core) ? "asks" : "says";
    return state.settings.tense === "past" ? (PAST[v] || v) : v;
  }
  function tagged(core, ch, followedByPunct, extra) {
    core = core.trim().replace(/^[“"]|[”"]$/g, "").trim();
    var verb = verbFor(core), name = ch.name, last = core.slice(-1);
    if (!verb) { if (!/[.?!…—,]/.test(last)) core += "."; return "“" + core + "”"; }
    if (state.settings.tag === "before") {
      if (last === ",") core = core.slice(0, -1) + ".";
      else if (!/[.?!…—]/.test(last)) core += ".";
      return name + " " + verb + (extra ? " " + extra : "") + ", “" + core + "”";
    }
    if (last === ".") core = core.slice(0, -1) + ",";
    else if (!/[,?!…—\-]/.test(last)) core += ",";
    var tag = state.settings.tag === "name-verb" ? name + " " + verb : verb + " " + name;
    return "“" + core + "” " + tag + (extra ? ", " + extra : "") + (followedByPunct ? "" : ".");
  }
  function speak(id) {
    var d = cur(), ch = castById(id);
    if (!ch) return;
    restoreSel();
    var c = caretInfo();
    if (!c) return;
    remember(id);
    if (d.mode === "script") { speakScript(ch, c); return; }
    if (pending && editor.contains(pending.block)) {
      var pb = pending.block, same = pending.id === id;
      var spoke = finishPending();
      if (same || !spoke) { decorateSoon(); markDirty(); renderCastStrip(); return; }
      openLine(newLineAfter(pb, DEFAULT_TYPE[d.mode]), ch);
      afterStructural();
      return;
    }
    var txt = c.block.textContent;
    if (!c.collapsed && c.block === c.endBlock) {
      var a = c.a, b = c.b;
      while (a < b && /\s/.test(txt[a])) a++;
      while (b > a && /\s/.test(txt[b - 1])) b--;
      if (txt[a - 1] === "“" && txt[b] === "”") { a--; b++; }
      var after = txt.slice(b);
      var old = after.match(new RegExp("^,?\\s+(?:(?:" + TAG_VERBS + ")\\s+[\\p{Lu}][\\p{L}’'\\-]*|[\\p{Lu}][\\p{L}’'\\-]*\\s+(?:" + TAG_VERBS + "))\\.?", "u"));
      if (old) { b += old[0].length; after = txt.slice(b); }
      var out = tagged(txt.slice(a, b - (old ? old[0].length : 0)), ch, /^[.,!?;:…]/.test(after));
      replaceRange(c.block, a, b, out);
      setSel(c.block, a + out.length);
      decorateSoon(); markDirty();
      return;
    }
    var before = txt.slice(0, c.a);
    var m = before.match(/“([^“”]*)”\s*$/);
    if (m) {
      var start = c.a - m[0].length;
      var out2 = tagged(m[1], ch, /^[.,!?;:…]/.test(txt.slice(c.a)));
      replaceRange(c.block, start, c.a, out2);
      setSel(c.block, start + out2.length);
      decorateSoon(); markDirty();
      return;
    }
    var target = c.block;
    if (txt.trim()) target = newLineAfter(c.block, DEFAULT_TYPE[d.mode]);
    openLine(target, ch);
    afterStructural();
  }
  function openLine(block, ch) {
    setSel(block, block.textContent.length);
    insertText("“”");
    setSel(block, block.textContent.length - 1);
    pending = { id: ch.id, block: block };
    renderCastStrip(); decorateSoon();
  }
  function finishPending() {
    if (!pending) return null;
    var p = pending, b = p.block, ch = castById(p.id);
    pending = null;
    b.classList.remove("speaking"); b.style.removeProperty("--who");
    renderCastStrip();
    if (!editor.contains(b) || !ch) return null;
    var txt = b.textContent, open = txt.lastIndexOf("“");
    if (open < 0) return null;
    var close = txt.indexOf("”", open);
    close = close < 0 ? txt.length : close + 1;
    var core = txt.slice(open + 1, close - (txt[close - 1] === "”" ? 1 : 0));
    if (!core.trim()) { replaceRange(b, open, close, ""); if (!b.textContent) setBlockText(b, ""); setSel(b, b.textContent.length); return null; }
    var out = tagged(core, ch, /^[.,!?;:…]/.test(txt.slice(close)));
    replaceRange(b, open, close, out);
    setSel(b, b.textContent.length);
    return ch;
  }
  function remember(id) { lastSpeakers = [id].concat(lastSpeakers.filter(function (x) { return x !== id; })).slice(0, 6); }
  function otherSpeaker(ch) {
    var d = cur();
    var prev = lastSpeakers.filter(function (x) { return x !== ch.id && castById(x); })[0];
    if (prev) { remember(prev); return castById(prev); }
    if (d.cast.length < 2) return null;
    var nx = d.cast[(d.cast.indexOf(ch) + 1) % d.cast.length];
    remember(nx.id);
    return nx;
  }
  function speakScript(ch, c) {
    var b = c.block, txt = b.textContent, name = ch.name.toUpperCase();
    if (!c.collapsed && c.block === c.endBlock) {
      var a = c.a, e = c.b;
      while (a < e && /\s/.test(txt[a])) a++;
      while (e > a && /\s/.test(txt[e - 1])) e--;
      var core = txt.slice(a, e).replace(/^[“"]|[”"]$/g, "").replace(/,$/, ".");
      var pre = txt.slice(0, a).replace(/[“"]\s*$/, "").trim(), post = txt.slice(e).replace(/^[”"]/, "").trim();
      var list = [];
      if (pre) list.push({ t: b.dataset.t, x: pre });
      list.push({ t: "character", x: name }, { t: "dialogue", x: core });
      if (post) list.push({ t: "action", x: post });
      var nodes = list.map(makeBlock);
      nodes.forEach(function (n) { b.before(n); });
      b.remove();
      var dl = nodes[pre ? 2 : 1];
      setSel(dl, dl.textContent.length);
      afterStructural();
      return;
    }
    if (b.dataset.t === "character") {
      // already on a cue: rename it and drop into its dialogue
      replaceRange(b, 0, txt.length, name);
      var nx = b.nextElementSibling;
      if (nx && (nx.dataset.t === "dialogue" || nx.dataset.t === "paren")) setSel(nx, nx.textContent.length);
      else newLineAfter(b, "dialogue");
      afterStructural();
      return;
    }
    var target = b;
    if (txt.trim()) target = newLineAfter(b, "character");
    target.dataset.t = "character";
    setSel(target, 0);
    insertText(name);
    newLineAfter(target, "dialogue");
    afterStructural();
  }

  /* ================================================================
     Conversion between modes
     ================================================================ */
  function mapType(t, mode) {
    if (TYPES[mode].indexOf(t) >= 0) return t;
    if (mode === "prose") return t === "scene" ? "h" : "p";
    if (mode === "script") return t === "h" ? "scene" : "action";
    return "verse";
  }
  function titleCaseName(n, cast) {
    var hit = (cast || []).filter(function (c) { return c.name.toUpperCase() === n.toUpperCase(); })[0];
    if (hit) return hit.name;
    return n.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, function (m, a, b) { return a + b.toUpperCase(); });
  }
  function convertBlocks(blocks, from, to, cast) {
    if (from === to) return blocks.slice();
    if (from === "script" && to !== "script") {
      var prose = scriptToProse(blocks, cast);
      return to === "poem" ? prose.filter(function (b) { return b.t === "p"; }).map(function (b) { return { t: "verse", x: b.x }; }) : prose;
    }
    if (to === "script") return proseToScript(from === "poem" ? blocks.map(function (b) { return { t: "p", x: b.x }; }) : blocks, cast);
    if (to === "poem") return blocks.map(function (b) { return { t: "verse", x: b.x }; });
    return blocks.filter(function (b, i, arr) { return b.x.trim() || (i > 0 && arr[i - 1].x.trim()); }).map(function (b) { return { t: "p", x: b.x }; });
  }
  function proseToScript(blocks, cast) {
    cast = cast || [];
    var out = [], recent = [];
    var NAME = "([\\p{Lu}][\\p{L}’'\\-]*|he|she|they|I|we)";
    var afterRe = new RegExp("^\\s*,?\\s*(?:" + NAME + "\\s+(?:" + TAG_VERBS + ")|(?:" + TAG_VERBS + ")\\s+" + NAME + ")\\b[^.!?]*[.!?]?", "u");
    var beforeRe = new RegExp(NAME + "\\s+(?:" + TAG_VERBS + ")\\b[^“]*?,?\\s*$", "u");
    var tryName = function (n) { return !n || /^(he|she|they|i|we)$/i.test(n) ? null : n; };
    blocks.forEach(function (b) {
      if (!b.x.trim()) return;
      if (b.t === "h") { out.push({ t: "scene", x: b.x.toUpperCase() }); return; }
      var txt = b.x, quotes = [], re = /“([^”]*)”?/g, m;
      while ((m = re.exec(txt))) quotes.push({ s: m.index, e: m.index + m[0].length, q: m[1] });
      if (!quotes.length) { out.push({ t: "action", x: txt.trim() }); return; }
      var speaker = null, pre = txt.slice(0, quotes[0].s), post = txt.slice(quotes[quotes.length - 1].e), mid = [];
      for (var i = 0; i < quotes.length - 1; i++) mid.push(txt.slice(quotes[i].e, quotes[i + 1].s));
      var mA = post.match(afterRe);
      if (mA) { speaker = tryName(mA[1] || mA[2]); post = post.slice(mA[0].length); }
      for (var j = 0; j < mid.length && !speaker; j++) {
        var mm = mid[j].match(afterRe);
        if (mm) { speaker = tryName(mm[1] || mm[2]); mid[j] = mid[j].slice(mm[0].length); }
      }
      var mB = pre.match(beforeRe);
      if (mB) { if (!speaker) speaker = tryName(mB[1]); pre = pre.slice(0, mB.index); }
      var narration = (pre + " " + mid.join(" ") + " " + post).replace(/\s+/g, " ").trim();
      if (!speaker) { var hit = cast.filter(function (c) { return new RegExp("\\b" + reEsc(c.name) + "\\b").test(narration); })[0]; if (hit) speaker = hit.name; }
      if (!speaker && recent.length >= 2) speaker = recent[1];
      if (!speaker) speaker = "Voice";
      recent = [speaker].concat(recent.filter(function (x) { return x !== speaker; }));
      var line = quotes.map(function (q) { return q.q.trim(); }).join(" ").replace(/,$/, ".");
      if (pre.trim()) out.push({ t: "action", x: pre.trim() });
      out.push({ t: "character", x: speaker.toUpperCase() }, { t: "dialogue", x: line });
      var rest = (mid.join(" ") + " " + post).replace(/\s+/g, " ").trim();
      if (rest && rest !== ".") out.push({ t: "action", x: rest });
    });
    return out.length ? out : [{ t: "action", x: "" }];
  }
  function scriptToProse(blocks, cast) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.t === "character") {
        var name = titleCaseName(b.x.replace(/\s*\(.*\)\s*$/, "").trim(), cast), lines = [], how = "";
        while (i + 1 < blocks.length && (blocks[i + 1].t === "dialogue" || blocks[i + 1].t === "paren")) {
          i++;
          if (blocks[i].t === "paren") how = blocks[i].x.replace(/[()]/g, "").trim(); else lines.push(blocks[i].x.trim());
        }
        if (lines.length) out.push({ t: "p", x: tagged(lines.join(" "), { name: name }, false, how) });
        continue;
      }
      if (b.t === "transition") continue;
      if (b.t === "scene") { out.push({ t: "h", x: b.x }); continue; }
      if (b.x.trim()) out.push({ t: "p", x: b.x });
    }
    return out.length ? out : [{ t: "p", x: "" }];
  }
  function switchMode(mode) {
    var d = cur();
    if (d.mode === mode) return;
    collect();
    var hasText = d.blocks.some(function (b) { return b.x.trim(); });
    if (!hasText) { applyMode(mode, d.blocks.map(function (b) { return { t: mapType(b.t, mode), x: b.x }; })); return; }
    var note = mode === "script"
      ? "Convert turns tagged dialogue like “Hi,” says Jun. into a JUN character cue and a dialogue block. Everything else becomes action."
      : d.mode === "script" && mode === "prose"
        ? "Convert turns each character cue and dialogue block back into a quoted, tagged line of prose."
        : "Convert re-flows the text for " + MODE_NAME[mode].toLowerCase() + ". Layout only keeps every line as it is.";
    ask("Switch to " + MODE_NAME[mode] + "?", note, [
      { label: "Cancel" },
      { label: "Make a converted copy", fn: function () {
        var c = newDoc(mode, (d.title || "Untitled") + " (" + MODE_NAME[mode].toLowerCase() + ")", convertBlocks(d.blocks, d.mode, mode, d.cast), { cast: JSON.parse(JSON.stringify(d.cast)), goal: d.goal });
        open(c.id); toast("Made a " + MODE_NAME[mode].toLowerCase() + " copy");
      } },
      { label: "Layout only", fn: function () { snapshotThen(mode, d.blocks.map(function (b) { return { t: mapType(b.t, mode), x: b.x, ph: b.ph }; })); } },
      { label: "Convert", primary: true, fn: function () { snapshotThen(mode, convertBlocks(d.blocks, d.mode, mode, d.cast)); } }
    ]);
  }
  function snapshotThen(mode, blocks) {
    var d = cur(), snap = { mode: d.mode, blocks: JSON.parse(JSON.stringify(d.blocks)) };
    applyMode(mode, blocks);
    toast("Now in " + MODE_NAME[mode], "Undo", function () { applyMode(snap.mode, snap.blocks); });
  }
  function applyMode(mode, blocks) {
    var d = cur();
    pending = null;
    d.mode = mode;
    d.blocks = blocks.map(function (b) { var o = { t: b.t, x: b.x }; if (b.ph) o.ph = b.ph; if (b.syl) o.syl = b.syl; return o; });
    if (!d.blocks.length) d.blocks = [{ t: DEFAULT_TYPE[mode], x: "" }];
    d.updatedAt = now(); dirtyIds[d.id] = true;
    flush();
    renderAll();
  }

  /* ================================================================
     Templates
     ================================================================ */
  function V(ph, syl) { return { t: "verse", x: "", ph: ph, syl: syl }; }
  function B(t, ph) { return { t: t, x: "", ph: ph }; }
  var STANZA = { t: "verse", x: "" };
  var TEMPLATES = [
    { group: "Poem", items: [
      { name: "Haiku", note: "Three lines, a moment and a turn.", meta: "5 · 7 · 5", mode: "poem", blocks: function () { return [V("five syllables: set the scene", 5), V("seven syllables: something moves", 7), V("five syllables: the turn", 5)]; } },
      { name: "Tanka", note: "A haiku with two more lines of feeling.", meta: "5 · 7 · 5 · 7 · 7", mode: "poem", blocks: function () { return [V("image", 5), V("image continues", 7), V("pivot", 5), V("feeling", 7), V("resolve", 7)]; } },
      { name: "Limerick", note: "Bouncy, rude if possible.", meta: "AABBA", mode: "poem", blocks: function () { return [V("A · There once was a…", 9), V("A · who…", 9), V("B · short line", 6), V("B · short line", 6), V("A · the punchline", 9)]; } },
      { name: "Sonnet", note: "Shakespearean: three quatrains and a couplet.", meta: "ABAB CDCD EFEF GG · 10", mode: "poem", blocks: function () {
        var out = [];
        "ABABCDCDEFEFGG".split("").forEach(function (r, i) {
          if (i && i % 4 === 0) out.push(STANZA);
          out.push(V(r + (i === 12 ? " · the couplet turns it" : i === 0 ? " · ten syllables, da-DUM ×5" : ""), 10));
        });
        return out;
      } },
      { name: "Villanelle", note: "Two refrains that keep coming back.", meta: "19 lines · A1 b A2", mode: "poem", blocks: function () {
        var s = ["A1 · first refrain", "b", "A2 · second refrain", null, "a", "b", "A1", null, "a", "b", "A2", null, "a", "b", "A1", null, "a", "b", "A2", null, "a", "b", "A1", "A2"];
        return s.map(function (x) { return x === null ? STANZA : V(x, 10); });
      } },
      { name: "Cinquain", note: "Five lines that grow, then snap shut.", meta: "2 · 4 · 6 · 8 · 2", mode: "poem", blocks: function () { return [V("title", 2), V("describe it", 4), V("action", 6), V("feeling", 8), V("rename it", 2)]; } },
      { name: "Chain poem", note: "Each line starts with the last word of the one before.", meta: "endless", mode: "poem", blocks: function () { return [V("Begin anywhere…"), V("…start with the last word above"), V("…and again"), V("keep going until it stops")]; } },
      { name: "Free verse", note: "No rules. Line breaks are your only tool.", meta: "open", mode: "poem", blocks: function () { return [V("Start with something you saw today"), V(""), V("")]; } }
    ] },
    { group: "Prose", items: [
      { name: "Flash fiction", note: "A whole story in under a thousand words.", meta: "goal 1,000", mode: "prose", goal: 1000, blocks: function () { return [B("p", "Open in motion: someone wants something, right now."), B("p", "Complicate it. What’s in the way?"), B("p", "The turn: something changes that can’t be undone."), B("p", "End on an image, not an explanation.")]; } },
      { name: "Short story", note: "Six beats from hook to resolution.", meta: "goal 5,000", mode: "prose", goal: 5000, blocks: function () { return [B("h", "Hook"), B("p", "Who, where, and what’s wrong."), B("h", "Inciting incident"), B("p", "The thing that makes today different."), B("h", "Rising"), B("p", "Try, fail, try harder."), B("h", "Crisis"), B("p", "The choice with no good option."), B("h", "Climax"), B("p", "They choose."), B("h", "Resolution"), B("p", "The new normal.")]; } },
      { name: "Novel chapter", note: "Scene, sequel, hook for the next one.", meta: "goal 3,000", mode: "prose", goal: 3000, blocks: function () { return [B("h", "Chapter"), B("p", "Scene: goal, conflict, disaster."), B("p", "Sequel: reaction, dilemma, decision."), B("p", "Last line: a question the reader has to answer by turning the page.")]; } },
      { name: "Dialogue drill", note: "Two characters, one argument. Adds J and L to the cast.", meta: "cast J · L", mode: "prose", cast: true, blocks: function () { return [B("p", "One line of setting. Then press Alt+1 or Alt+2 and let them argue.")]; } },
      { name: "Character sketch", note: "Get to know someone before they speak.", meta: "profile", mode: "prose", blocks: function () { return [B("h", "Name"), B("p", "And what people call them."), B("h", "Wants"), B("p", "Out loud."), B("h", "Needs"), B("p", "What they won’t admit."), B("h", "Voice"), B("p", "Three lines they would say.")]; } },
      { name: "Letter", note: "Fiction told to one reader.", meta: "epistolary", mode: "prose", blocks: function () { return [B("p", "Dear …,"), B("p", "Why you’re writing now."), B("p", "What you can’t say in person."), B("p", "Signed,")]; } },
      { name: "Journal entry", note: "Today, honestly.", meta: "daily", mode: "prose", blocks: function () { return [{ t: "h", x: new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) }, B("p", "What happened."), B("p", "What you noticed."), B("p", "What you’re carrying into tomorrow.")]; } }
    ] },
    { group: "Script", items: [
      { name: "Scene", note: "Heading, action, an exchange.", meta: "INT./EXT.", mode: "script", blocks: function () { return [B("scene", "INT. LOCATION — DAY"), B("action", "What we see. Who’s here. Present tense."), B("character", "NAME"), B("dialogue", "What they say."), B("action", "")]; } },
      { name: "Two-hander", note: "A scene for two. Adds J and L to the cast.", meta: "cast J · L", mode: "script", cast: true, blocks: function () { return [B("scene", "INT. KITCHEN — NIGHT"), B("action", "Press Alt+1 or Alt+2 to start a character’s line.")]; } },
      { name: "Cold open", note: "Hook the audience before the titles.", meta: "1–3 pp", mode: "script", blocks: function () { return [{ t: "transition", x: "FADE IN:" }, B("scene", "EXT. SOMEWHERE STRIKING — NIGHT"), B("action", "An image we can’t look away from."), B("action", "Something goes wrong."), { t: "transition", x: "SMASH CUT TO:" }, B("scene", "TITLE CARD")]; } },
      { name: "Short film", note: "Three scenes: set up, push, pay off.", meta: "5–10 pp", mode: "script", blocks: function () { return [{ t: "transition", x: "FADE IN:" }, B("scene", "INT. SCENE ONE — DAY"), B("action", "Set up: normal life and what’s missing."), B("scene", "EXT. SCENE TWO — DAY"), B("action", "Push: the problem arrives."), B("scene", "INT. SCENE THREE — NIGHT"), B("action", "Pay off: they change, or they don’t."), { t: "transition", x: "FADE OUT." }]; } },
      { name: "TV pilot", note: "Teaser plus four acts.", meta: "~30 pp", mode: "script", blocks: function () {
        var out = [{ t: "transition", x: "FADE IN:" }, { t: "scene", x: "TEASER" }, B("action", "The hook.")];
        ["ACT ONE", "ACT TWO", "ACT THREE", "ACT FOUR"].forEach(function (a) { out.push({ t: "scene", x: a }, B("scene", "INT. LOCATION — DAY"), B("action", "")); });
        out.push({ t: "transition", x: "FADE OUT." });
        return out;
      } }
    ] }
  ];
  function renderTemplates() {
    $("tplBody").innerHTML = TEMPLATES.map(function (g, gi) {
      return "<h3>" + g.group + "</h3><div class=\"tpl-grid\">" + g.items.map(function (t, ti) {
        return "<button class=\"tpl\" data-tpl=\"" + gi + "." + ti + "\"><b>" + esc(t.name) + "</b><span>" + esc(t.note) + "</span><span class=\"meta\">" + esc(t.meta) + "</span></button>";
      }).join("") + "</div>";
    }).join("");
  }
  function defaultCast() { return [{ id: uid(), name: "Jun", key: "J", color: "c2", notes: "" }, { id: uid(), name: "Lena", key: "L", color: "c1", notes: "" }]; }
  function useTemplate(key) {
    var ix = key.split("."), t = TEMPLATES[+ix[0]].items[+ix[1]], blocks = t.blocks(), d = cur();
    collect();
    if ($("tplInsert").checked) {
      if (t.cast && !d.cast.length) d.cast = defaultCast();
      var conv = t.mode === d.mode ? blocks : blocks.map(function (b) { return { t: mapType(b.t, d.mode), x: b.x, ph: b.ph, syl: b.syl }; });
      restoreSel();
      var b = curBlock() || editor.lastElementChild, nodes = conv.map(makeBlock), anchor = b;
      nodes.forEach(function (n) { anchor.after(n); anchor = n; });
      if (!b.textContent) b.remove();
      setSel(nodes[0], 0);
      closeModals(); afterStructural(); renderCastStrip(); renderPanel();
      toast("Added " + t.name);
      return;
    }
    var nd = newDoc(t.mode, t.name === "Journal entry" ? "Journal" : "Untitled " + t.name.toLowerCase(), blocks, { goal: t.goal || 0, cast: t.cast ? defaultCast() : [] });
    open(nd.id);
    closeModals();
    setTimeout(function () { editor.focus(); setSel(editor.firstElementChild, 0); }, 40);
  }

  /* ================================================================
     Cast: strip above the page + cards in the side panel
     ================================================================ */
  function renderCastStrip() {
    var d = cur();
    var html = "<span class=\"row-label\">Cast</span>";
    d.cast.forEach(function (c, i) {
      var live = pending && pending.id === c.id;
      html += "<button class=\"chip" + (live ? " live" : "") + "\" data-speak=\"" + c.id + "\" style=\"--who:var(--" + c.color + ")\" title=\"Speak as " + esc(c.name) + "\">" +
        "<span class=\"key\">" + esc(c.key) + "</span>" + esc(c.name) + (i < 9 ? " <span class=\"sc\">Alt " + (i + 1) + "</span>" : "") + "</button>";
    });
    html += "<button class=\"chip ghost\" id=\"castAdd\">+ Character</button>";
    if (d.cast.length && d.mode !== "script") {
      html += "<span class=\"sep\"></span><button class=\"tool\" id=\"pingBtn\" aria-pressed=\"" + !!state.settings.pingpong + "\" title=\"After Enter, the other character speaks next\">⇄ Back and forth</button>";
      html += "<select class=\"mini-select\" id=\"verbSel\" aria-label=\"Dialogue verb\">" + ["auto"].concat(VERB_PRESENT).concat(["none"]).map(function (v) {
        var label = v === "auto" ? "says / asks" : v === "none" ? "no tag" : (state.settings.tense === "past" ? PAST[v] : v);
        return "<option value=\"" + v + "\"" + (state.settings.verb === v ? " selected" : "") + ">" + label + "</option>";
      }).join("") + "</select>";
    }
    $("castRow").innerHTML = html;
    pushMenuState();
  }
  function renderCastPanel() {
    var d = cur();
    var html = "<p class=\"hint\">Characters in this piece. Notes are just for you. Press a character’s shortcut to write their next line.</p>";
    html += d.cast.map(function (c, i) {
      return "<div class=\"ccard\" data-cid=\"" + c.id + "\" style=\"--who:var(--" + c.color + ")\">" +
        "<div class=\"ccard-head\"><input class=\"key-in\" data-f=\"key\" maxlength=\"3\" value=\"" + esc(c.key) + "\" aria-label=\"Button letter\">" +
        "<input class=\"name-in\" data-f=\"name\" value=\"" + esc(c.name) + "\" aria-label=\"Name\" spellcheck=\"false\"></div>" +
        "<textarea data-f=\"notes\" placeholder=\"Look, voice, what they want…\" aria-label=\"Notes\">" + esc(c.notes || "") + "</textarea>" +
        "<div class=\"ccard-foot\"><span class=\"sc\">" + (i < 9 ? "Alt+" + (i + 1) + " · " : "") + lineCount(c) + (lineCount(c) === 1 ? " line" : " lines") + "</span><div class=\"swatches\">" +
        COLORS.map(function (k) { return "<button class=\"swatch\" data-sw=\"" + k + "\" style=\"--sw:var(--" + k + ")\" aria-pressed=\"" + (k === c.color) + "\" aria-label=\"Colour\"></button>"; }).join("") +
        "</div><button class=\"link-btn\" data-cdel title=\"Remove from cast\">Remove</button></div></div>";
    }).join("");
    html += "<button class=\"add-card\" id=\"castAddCard\">+ Add character</button>";
    $("tabCast").innerHTML = html;
  }
  function lineCount(c) {
    var d = cur(), n = 0, up = c.name.toUpperCase();
    var re = new RegExp("(?:(?:" + TAG_VERBS + ")\\s+" + reEsc(c.name) + "|" + reEsc(c.name) + "\\s+(?:" + TAG_VERBS + "))(?![\\p{L}])", "u");
    d.blocks.forEach(function (b) {
      if (d.mode === "script") { if (b.t === "character" && b.x.replace(/\s*\(.*\)\s*$/, "").trim().toUpperCase() === up) n++; }
      else if (b.x.indexOf("“") >= 0 && re.test(b.x)) n++;
    });
    return n;
  }
  function addCharacter() {
    var d = cur();
    var used = d.cast.map(function (x) { return x.color; });
    var color = COLORS.filter(function (x) { return used.indexOf(x) < 0; })[0] || COLORS[d.cast.length % COLORS.length];
    var c = { id: uid(), name: "", key: "", color: color, notes: "" };
    d.cast.push(c);
    showPanel("cast");
    renderCastPanel();
    var inp = document.querySelector("[data-cid=\"" + c.id + "\"] .name-in");
    if (inp) { inp.placeholder = "Name"; inp.focus(); }
    markDirty();
  }

  /* ================================================================
     Side panel: outline + stats
     ================================================================ */
  var panelTimer = null;
  function renderPanelSoon() { clearTimeout(panelTimer); panelTimer = setTimeout(renderPanel, 350); }
  function renderPanel() {
    var tab = state.settings.tab;
    if (tab === "cast") { if (!$("tabCast").contains(document.activeElement)) renderCastPanel(); }
    else if (tab === "outline") renderOutline();
    else if (tab === "stats") renderStats();
    else if (tab === "words" && !words.q) { renderWordTabs(); renderWordHint(); }
  }
  function renderOutline() {
    var d = cur(), items = [];
    d.blocks.forEach(function (b, i) {
      if (d.mode === "script" && b.t === "scene" && b.x.trim()) items.push({ i: i, t: b.x, s: summaryAfter(d, i) });
      if (d.mode === "prose" && b.t === "h" && b.x.trim()) items.push({ i: i, t: b.x, s: summaryAfter(d, i) });
      if (d.mode === "poem" && b.x.trim() && (i === 0 || !d.blocks[i - 1].x.trim())) items.push({ i: i, t: b.x, s: "stanza" });
    });
    var empty = d.mode === "script" ? "Scene headings (INT. / EXT.) appear here." : d.mode === "prose" ? "Headings appear here. Add one with the Heading button." : "Stanzas appear here.";
    $("tabOutline").innerHTML = items.length
      ? "<h4>" + (d.mode === "script" ? items.length + " scenes" : d.mode === "prose" ? items.length + " sections" : items.length + " stanzas") + "</h4><ul class=\"outline " + d.mode + "\">" +
        items.map(function (it, n) { return "<li data-jump=\"" + it.i + "\"><span class=\"n\">" + (n + 1) + "</span><span class=\"t\">" + esc(it.t) + "</span><span class=\"s\">" + esc(it.s) + "</span></li>"; }).join("") + "</ul>"
      : "<p class=\"hint\">" + empty + "</p>";
  }
  function summaryAfter(d, i) {
    for (var j = i + 1; j < d.blocks.length; j++) {
      var b = d.blocks[j];
      if (b.t === "scene" || b.t === "h") break;
      if (b.x.trim()) return b.x.trim().slice(0, 80);
    }
    return "";
  }
  function renderStats() {
    var d = cur(), words = wordCount(d);
    var tiles = [
      [words.toLocaleString(), "words"],
      [Math.max(1, Math.round(words / 230)) + " min", "reading time"]
    ];
    if (d.mode === "script") {
      var pg = scriptPages(d);
      tiles = [[pg.toFixed(1), "pages"], ["≈ " + Math.max(1, Math.round(pg)) + " min", "screen time"], [String(d.blocks.filter(function (b) { return b.t === "scene"; }).length), "scenes"], [words.toLocaleString(), "words"]];
    } else if (d.mode === "poem") {
      tiles.push([String(d.blocks.filter(function (b) { return b.x.trim(); }).length), "lines"]);
      tiles.push([String(d.blocks.reduce(function (s, b) { return s + syllables(b.x); }, 0)), "syllables"]);
    } else {
      tiles.push([String(d.blocks.filter(function (b) { return b.t === "p" && b.x.trim(); }).length), "paragraphs"]);
      var dlg = d.blocks.reduce(function (s, b) { var m = b.x.match(/“[^”]*”/g); return s + (m ? m.reduce(function (a, q) { return a + countWords(q); }, 0) : 0); }, 0);
      tiles.push([words ? Math.round(dlg / words * 100) + "%" : "0%", "dialogue"]);
    }
    var session = words - (sessionStart[d.id] || 0);
    tiles.push([(session >= 0 ? "+" : "") + session.toLocaleString(), "this session"]);
    if (d.goal) tiles.push([Math.min(100, Math.round(words / d.goal * 100)) + "%", "of " + d.goal.toLocaleString() + " goal"]);
    var html = "<div class=\"stat-grid\">" + tiles.map(function (t) { return "<div class=\"stat-tile\"><b>" + t[0] + "</b><span>" + t[1] + "</span></div>"; }).join("") + "</div>";
    if (d.cast.length) {
      var counts = d.cast.map(function (c) { return { c: c, n: lineCount(c) }; });
      var total = counts.reduce(function (s, x) { return s + x.n; }, 0);
      html += "<h4>Who talks most</h4><div class=\"share\">" + counts.map(function (x) {
        var pc = total ? Math.round(x.n / total * 100) : 0;
        return "<div class=\"share-row\" style=\"--who:var(--" + x.c.color + ")\"><span class=\"nm\">" + esc(x.c.name || "?") + "</span><span class=\"bar\"><span style=\"width:" + pc + "%\"></span></span><span class=\"pc\">" + x.n + "</span></div>";
      }).join("") + "</div>";
    }
    html += "<h4 style=\"margin-top:18px\">Word goal</h4><div class=\"opt\" style=\"padding-top:0\"><span>" + (d.goal ? (d.goalType === "limit" ? "Limit: at most " : "Target: ") + d.goal.toLocaleString() + " words" : "No goal") + "</span><button class=\"btn sm\" id=\"goalOpen\">" + (d.goal ? "Change…" : "Set…") + "</button></div>";
    $("tabStats").innerHTML = html;
  }
  function showPanel(tab) {
    state.settings.tab = tab;
    if (!state.settings.panel) { state.settings.panel = true; applyChrome(); }
    document.querySelectorAll(".tabs button").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === tab)); });
    $("tabCast").hidden = tab !== "cast"; $("tabOutline").hidden = tab !== "outline"; $("tabStats").hidden = tab !== "stats"; $("tabWords").hidden = tab !== "words";
    saveSettings();
    renderPanel();
  }

  /* ================================================================
     Library sidebar
     ================================================================ */
  function renderLibrary() {
    var q = ($("search").value || "").trim().toLowerCase();
    var f = state.settings.filter;
    var docs = sortedDocs().filter(function (d) {
      if (f !== "all" && d.mode !== f) return false;
      if (!q) return true;
      return (d.title || "").toLowerCase().indexOf(q) >= 0 || d.blocks.some(function (b) { return b.x.toLowerCase().indexOf(q) >= 0; });
    });
    $("docList").innerHTML = docs.length ? docs.map(function (d) {
      return "<li class=\"doc-item" + (d.id === state.currentId ? " on" : "") + "\" data-open=\"" + d.id + "\" tabindex=\"0\">" +
        "<span class=\"dt\">" + esc(d.title || "Untitled") + "</span><span class=\"badge\">" + MODE_NAME[d.mode] + "</span>" +
        "<span class=\"dm\">" + wordCount(d).toLocaleString() + " words · " + relTime(new Date(d.updatedAt)) + "</span></li>";
    }).join("") : "<li class=\"doc-empty\">" + (q ? "Nothing matches “" + esc(q) + "”." : "Nothing here yet.") + "</li>";
    document.querySelectorAll(".side-filter button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.filter === f)); });
  }
  function relTime(d) {
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  function open(id) {
    if (state.currentId && state.docs[state.currentId]) collect();
    flush();
    pending = null;
    state.currentId = id;
    state.settings.lastId = id;
    if (sessionStart[id] == null) sessionStart[id] = wordCount(state.docs[id]);
    saveSettings();
    renderAll();
  }
  function deleteCurrent() {
    var d = cur();
    ask("Move “" + (d.title || "Untitled") + "” to the " + (host.platform === "darwin" ? "Bin" : "Recycle Bin") + "?", "You can restore it from there if you change your mind.", [
      { label: "Cancel" },
      { label: "Move to " + (host.platform === "darwin" ? "Bin" : "Recycle Bin"), danger: true, fn: function () {
        delete state.docs[d.id];
        host.remove(d.id);
        var rest = sortedDocs();
        state.currentId = rest.length ? rest[0].id : newDoc("prose", "").id;
        flush(); renderAll();
        toast("Deleted");
      } }
    ]);
  }

  /* ================================================================
     Import / export
     ================================================================ */
  function toFountain(d) {
    var out = [];
    if (d.title) out.push("Title: " + d.title, state.settings.author ? "Author: " + state.settings.author : "", "");
    d.blocks.forEach(function (b) {
      var x = b.x.trim();
      if (!x) return;
      if (b.t === "scene") out.push("", /^(INT|EXT|EST|I\/E)/i.test(x) ? x.toUpperCase() : "." + x.toUpperCase());
      else if (b.t === "character") out.push("", x.toUpperCase());
      else if (b.t === "paren") out.push(/^\(/.test(x) ? x : "(" + x + ")");
      else if (b.t === "dialogue") out.push(x);
      else if (b.t === "transition") out.push("", /TO:$/.test(x.toUpperCase()) ? x.toUpperCase() : "> " + x.toUpperCase());
      else out.push("", x);
    });
    return out.filter(function (l, i) { return l !== "" || i > 0; }).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }
  function parseFountain(text) {
    var lines = text.replace(/\r/g, "").split("\n"), out = [], i = 0;
    while (i < lines.length && /^[A-Za-z ]+:/.test(lines[i])) { i++; while (i < lines.length && /^(\s{2,}|\t)/.test(lines[i])) i++; }
    for (; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var prevBlank = i === 0 || !lines[i - 1].trim(), next = lines[i + 1] != null ? lines[i + 1].trim() : "";
      if (prevBlank && (/^(INT|EXT|EST|INT\.?\/EXT|I\/E)[.\s]/i.test(line) || /^\.[^.]/.test(line))) { out.push({ t: "scene", x: line.replace(/^\./, "") }); continue; }
      if (prevBlank && ((/^>/.test(line) && !/<$/.test(line)) || (/TO:$/.test(line) && line === line.toUpperCase()))) { out.push({ t: "transition", x: line.replace(/^>\s*/, "") }); continue; }
      if (prevBlank && next && ((line === line.toUpperCase() && /\p{Lu}/u.test(line)) || /^@/.test(line))) {
        out.push({ t: "character", x: line.replace(/^@/, "") });
        while (i + 1 < lines.length && lines[i + 1].trim()) { i++; var l = lines[i].trim(); out.push({ t: /^\(.*\)$/.test(l) ? "paren" : "dialogue", x: l }); }
        continue;
      }
      out.push({ t: "action", x: line.replace(/^!/, "") });
    }
    return out;
  }
  function plainText(d) {
    if (d.mode === "script") return toFountain(d);
    if (d.mode === "poem") return (d.title ? d.title + "\n\n" : "") + d.blocks.map(function (b) { return b.x; }).join("\n") + "\n";
    return (d.title ? d.title + "\n\n" : "") + d.blocks.filter(function (b) { return b.x.trim(); }).map(function (b) { return b.t === "h" ? b.x.toUpperCase() : b.x; }).join("\n\n") + "\n";
  }
  function markdown(d) {
    if (d.mode === "script") return toFountain(d);
    if (d.mode === "poem") return (d.title ? "# " + d.title + "\n\n" : "") + d.blocks.map(function (b) { return b.x ? b.x + "  " : ""; }).join("\n") + "\n";
    return (d.title ? "# " + d.title + "\n\n" : "") + d.blocks.filter(function (b) { return b.x.trim(); }).map(function (b) { return b.t === "h" ? "## " + b.x : b.x; }).join("\n\n") + "\n";
  }
  function importPayloads(list) {
    var last = null;
    (list || []).forEach(function (f) {
      var name = f.name.replace(/\.[^.]+$/, "");
      if (f.ext === "inkling") {
        try {
          var d = JSON.parse(f.text);
          if (!d.id || state.docs[d.id]) d.id = uid();
          d.updatedAt = now(); state.docs[d.id] = d; dirtyIds[d.id] = true; last = d;
        } catch (e) { toast("Couldn’t read " + f.name); }
      } else if (f.ext === "fountain") {
        var tm = f.text.match(/^Title:\s*(.+)$/m);
        last = newDoc("script", tm ? tm[1].trim() : name, parseFountain(f.text));
      } else {
        var blocks = f.text.replace(/\r/g, "").split(/\n\s*\n/).map(function (s) { return s.replace(/\n/g, " ").trim(); }).filter(Boolean)
          .map(function (p) { var h = p.match(/^#{1,6}\s+(.*)$/); return h ? { t: "h", x: h[1] } : { t: "p", x: p }; });
        last = newDoc("prose", name, blocks.length ? blocks : undefined);
      }
    });
    if (last) { open(last.id); toast(list.length > 1 ? "Imported " + list.length + " files" : "Opened " + list[0].name); }
  }
  function fileBase(d) { return (d.title || "untitled").replace(/[\\/:*?"<>|]+/g, "").trim() || "untitled"; }

  function exportAs(kind) {
    collect(); flush();
    var d = cur();
    closeModals();
    if (kind === "copy") { copyText(plainText(d)); return; }
    if (kind === "pdf") {
      var built = printHtml(d);
      host.exportPdf(fileBase(d), built.html, built.header).then(function (p) { if (p) toast("Saved PDF"); }).catch(function (e) { toast("PDF export failed: " + e.message); });
      return;
    }
    var text = kind === "fountain" ? toFountain(d) : kind === "md" ? markdown(d) : plainText(d);
    host.exportFile(fileBase(d), kind, text).then(function (p) { if (p) toast("Exported " + String(p).split(/[\\/]/).pop()); });
  }
  function copyText(text) {
    navigator.clipboard.writeText(text).then(function () { toast("Copied to clipboard"); }, function () { toast("Couldn’t copy to the clipboard"); });
  }

  /* print layouts: standard screenplay on US Letter, manuscript format for prose */
  function printHtml(d) {
    var author = state.settings.author;
    var fonts = "@font-face{font-family:'Courier Prime';src:url('%%COURIER%%/files/courier-prime-latin-400-normal.woff2') format('woff2');font-weight:400}" +
      "@font-face{font-family:'Courier Prime';src:url('%%COURIER%%/files/courier-prime-latin-700-normal.woff2') format('woff2');font-weight:700}" +
      "@font-face{font-family:'Newsreader';src:url('%%NEWSREADER%%/files/newsreader-latin-400-normal.woff2') format('woff2');font-weight:400}" +
      "@font-face{font-family:'Newsreader';src:url('%%NEWSREADER%%/files/newsreader-latin-400-italic.woff2') format('woff2');font-weight:400;font-style:italic}";
    var body = "", css = "", header = null;
    if (d.mode === "script") {
      css = "@page{size:letter;margin:1in 1in 1in 1.5in}body{margin:0;font:12pt/12pt 'Courier Prime','Courier New',monospace;color:#000}" +
        "p{margin:12pt 0 0;white-space:pre-wrap}.scene{text-transform:uppercase;font-weight:700;break-after:avoid;margin-top:24pt}" +
        ".speech{break-inside:avoid;margin-top:12pt}.speech p{margin-top:0;margin-bottom:0}.character{margin-left:2.2in;text-transform:uppercase}" +
        ".paren{margin-left:1.6in;width:2in}.dialogue{margin-left:1in;width:3.5in}.transition{text-align:right;text-transform:uppercase}" +
        ".title{height:9in;display:flex;flex-direction:column;justify-content:center;text-align:center;break-after:page}.title h1{font:inherit;text-transform:uppercase;text-decoration:underline;margin:0 0 24pt}";
      if (d.title) body += "<section class=\"title\"><h1>" + esc(d.title) + "</h1>" + (author ? "<div>written by</div><div style=\"margin-top:12pt\">" + esc(author) + "</div>" : "") + "</section>";
      for (var i = 0; i < d.blocks.length; i++) {
        var b = d.blocks[i];
        if (!b.x.trim()) continue;
        if (b.t === "character") {
          var sp = "<div class=\"speech\"><p class=\"character\">" + esc(b.x) + "</p>";
          while (i + 1 < d.blocks.length && (d.blocks[i + 1].t === "dialogue" || d.blocks[i + 1].t === "paren")) {
            i++;
            var x = d.blocks[i].x.trim();
            if (d.blocks[i].t === "paren" && !/^\(/.test(x)) x = "(" + x + ")";
            sp += "<p class=\"" + d.blocks[i].t + "\">" + esc(x) + "</p>";
          }
          body += sp + "</div>";
        } else body += "<p class=\"" + b.t + "\">" + esc(b.x) + "</p>";
      }
      header = "<div style=\"width:100%;font:12pt 'Courier New',monospace;text-align:right;padding:0 1in 0 0;box-sizing:border-box\"><span class=\"pageNumber\"></span>.</div>";
    } else if (d.mode === "poem") {
      css = "@page{size:letter;margin:1in 1.25in}body{margin:0;font:12pt/1.7 'Newsreader',Georgia,serif;color:#000}h1{font-weight:400;font-size:18pt;margin:0 0 24pt}p{margin:0;min-height:1.7em}.by{font-style:italic;margin:-18pt 0 24pt}";
      body = (d.title ? "<h1>" + esc(d.title) + "</h1>" : "") + (author ? "<p class=\"by\">" + esc(author) + "</p>" : "") + d.blocks.map(function (b) { return "<p>" + esc(b.x) + "</p>"; }).join("");
    } else {
      css = "@page{size:letter;margin:1in}body{margin:0;font:12pt/2 'Newsreader',Georgia,serif;color:#000}" +
        ".head{text-align:center;margin:2.5in 0 1in}.head h1{font-weight:400;font-size:16pt;margin:0}.head div{font-style:italic}" +
        "p{margin:0;text-indent:.5in}h2{font:inherit;text-align:center;letter-spacing:.2em;text-transform:uppercase;margin:24pt 0 12pt}h2+p{text-indent:0}.head+p{text-indent:0}";
      body = (d.title ? "<div class=\"head\"><h1>" + esc(d.title) + "</h1>" + (author ? "<div>by " + esc(author) + "</div>" : "") + "</div>" : "") +
        d.blocks.filter(function (b) { return b.x.trim(); }).map(function (b) { return b.t === "h" ? "<h2>" + esc(b.x) + "</h2>" : "<p>" + esc(b.x) + "</p>"; }).join("");
    }
    return { html: "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>" + fonts + css + "</style></head><body>" + body + "</body></html>", header: header };
  }

  /* ================================================================
     Modals, palette, toast
     ================================================================ */
  function openModal(id) { closeModals(); $("scrim").hidden = false; $(id).hidden = false; }
  function closeModals() {
    ["tplModal", "exportModal", "askModal", "settingsModal", "helpModal", "palette", "goalModal", "keysModal"].forEach(function (m) { $(m).hidden = true; });
    $("scrim").hidden = true;
  }
  function ask(title, text, buttons) {
    $("askH").textContent = title; $("askP").textContent = text;
    var box = $("askBtns"); box.innerHTML = "";
    buttons.forEach(function (b) {
      var el = document.createElement("button");
      el.className = "btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : "");
      el.textContent = b.label;
      el.addEventListener("click", function () { closeModals(); if (b.fn) b.fn(); });
      box.appendChild(el);
    });
    openModal("askModal");
    var p = box.querySelector(".primary, .danger"); if (p) p.focus();
  }
  var toastTimer;
  function toast(msg, actLabel, fn) {
    $("toastMsg").textContent = msg;
    var b = $("toastAct");
    b.hidden = !actLabel; b.textContent = actLabel || "";
    b.onclick = function () { $("toast").hidden = true; if (fn) fn(); };
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $("toast").hidden = true; }, actLabel ? 6000 : 2200);
  }

  var palItems = [], palIndex = 0;
  function commands() {
    var d = cur(), list = [
      ["New prose", "new:prose", MOD + "N"], ["New script", "new:script", MOD + "⇧N"], ["New poem", "new:poem"], ["New from template…", "templates", MOD + "T"],
      ["Open or import…", "open", MOD + "O"], ["Export PDF…", "export:pdf", MOD + "P"], ["Export…", "export"], ["Duplicate this piece", "duplicate"], ["Delete this piece", "delete"],
      ["Switch to Prose", "mode:prose"], ["Switch to Script", "mode:script"], ["Switch to Poem", "mode:poem"],
      ["Focus mode", "focus", MOD + "⇧F"], ["Typewriter scrolling", "typewriter", MOD + "⇧T"], ["Toggle library", "toggle-side"], ["Toggle side panel", "toggle-panel"],
      ["Light theme", "theme:light"], ["Dark theme", "theme:dark"], ["Match system theme", "theme:system"],
      ["Add character", "cast-add"], ["Back and forth", "pingpong"], ["Show outline", "tab:outline"], ["Show stats", "tab:stats"],
      ["Move selection to side notes", "notes:move", MOD + "⇧M"], ["Copy selection to side notes", "notes:copy", MOD + "⇧J"],
      ["Thesaurus for the word at the cursor", "thes", MOD + "⇧L"], ["Show thesaurus", "tab:words"],
      ["Word goal or limit…", "goal", MOD + "⇧G"], ["Keyboard shortcuts", "keys", MOD + "/"],
      ["Settings", "settings"], ["How Inkling works", "help"]
    ].map(function (c) { return { g: "Command", label: c[0], act: c[1], k: c[2] || "" }; });
    d.cast.forEach(function (c, i) { list.unshift({ g: "Cast", label: "Speak as " + c.name, act: "speak:" + i, k: i < 9 ? "Alt+" + (i + 1) : "" }); });
    sortedDocs().forEach(function (x) { list.push({ g: MODE_NAME[x.mode], label: x.title || "Untitled", act: "doc:" + x.id, k: "" }); });
    return list;
  }
  function openPalette() {
    closeModals();
    $("scrim").hidden = false; $("palette").hidden = false;
    $("palInput").value = ""; filterPalette(); $("palInput").focus();
  }
  function filterPalette() {
    var q = $("palInput").value.trim().toLowerCase();
    palItems = commands().filter(function (c) { var hay = (c.g + " " + c.label).toLowerCase(); return !q || q.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; }); }).slice(0, 40);
    palIndex = 0;
    drawPalette();
  }
  function drawPalette() {
    $("palList").innerHTML = palItems.map(function (c, i) {
      return "<li role=\"option\" data-pi=\"" + i + "\" class=\"" + (i === palIndex ? "on" : "") + "\"><span class=\"g\">" + esc(c.g) + "</span>" + esc(c.label) + "<span class=\"k\">" + esc(c.k) + "</span></li>";
    }).join("") || "<li>No matches</li>";
    var on = $("palList").querySelector(".on"); if (on) on.scrollIntoView({ block: "nearest" });
  }
  function runPalette(i) {
    var c = palItems[i];
    closeModals();
    if (c) setTimeout(function () { action(c.act); }, 0);
  }

  /* ================================================================
     Side notes: lines lifted out of the page, kept per piece
     ================================================================ */
  function selectionBlocks() {
    var c = caretInfo();
    if (!c || c.collapsed) return null;
    var out = [], n = c.block;
    for (;;) {
      var t = n.textContent, a = n === c.block ? c.a : 0, b = n === c.endBlock ? c.b : t.length;
      var x = t.slice(a, b).trim();
      if (x) out.push({ t: n.dataset.t, x: x });
      if (n === c.endBlock || !n.nextElementSibling) break;
      n = n.nextElementSibling;
    }
    return out;
  }
  function toNotes(move) {
    restoreSel();
    var bl = selectionBlocks();
    if (!bl || !bl.length) { toast("Select some text first, then send it to side notes"); return; }
    var d = cur(), note = { id: uid(), blocks: bl, mode: d.mode, at: now() };
    d.notes = d.notes || [];
    d.notes.unshift(note);
    if (move) { document.execCommand("delete"); ensureBlocks(); decorateSoon(); }
    hideBubble();
    markDirty();
    showNotes(note.id);
    toast(move ? "Moved to side notes" : "Copied to side notes", move ? "Undo" : null, move ? function () {
      editor.focus(); document.execCommand("undo");
      d.notes = d.notes.filter(function (x) { return x.id !== note.id; });
      renderNotes(); ensureBlocks(); decorateSoon(); markDirty();
    } : null);
  }
  function showNotes(flashId) {
    var s = state.settings;
    if (!s.panel) { s.panel = true; }
    if (s.notesHidden) s.notesHidden = false;
    applyChrome(); saveSettings();
    renderNotes(flashId);
  }
  function noteText(n) { return n.blocks.map(function (b) { return b.x; }).join("\n"); }
  function renderNotes(flashId) {
    var d = cur(), notes = (d && d.notes) || [];
    $("notesCount").textContent = notes.length ? "· " + notes.length : "";
    if (!notes.length) {
      $("noteList").innerHTML = "<li class=\"notes-empty\">Cut lines, ideas, research. Select text in your writing and press " + MOD + "⇧M to move it here, or " + MOD + "⇧J to copy it. You can also right-click a selection.</li>";
      return;
    }
    $("noteList").innerHTML = notes.map(function (n) {
      var from = n.mode === "free" ? "Jotted" : "From " + MODE_NAME[n.mode].toLowerCase();
      return "<li class=\"note from-" + n.mode + (n.id === flashId ? " flash" : "") + "\" data-nid=\"" + n.id + "\">" +
        "<div class=\"note-text\" contenteditable=\"plaintext-only\" spellcheck=\"true\">" + esc(noteText(n)) + "</div>" +
        "<div class=\"note-foot\"><span>" + from + " · " + relTime(new Date(n.at)) + "</span>" +
        "<button data-nact=\"insert\" title=\"Put it back at the cursor\">Insert</button><button data-nact=\"copy\">Copy</button><button data-nact=\"del\">Delete</button></div></li>";
    }).join("");
  }
  function noteById(id) { return (cur().notes || []).filter(function (n) { return n.id === id; })[0]; }
  function insertNote(n) {
    var d = cur();
    restoreSel();
    var b = curBlock() || editor.lastElementChild;
    var nodes = n.blocks.map(function (x) { return makeBlock({ t: n.mode === d.mode ? x.t : mapType(n.mode === "free" ? DEFAULT_TYPE[d.mode] : x.t, d.mode), x: x.x }); });
    var anchor = b;
    nodes.forEach(function (x) { anchor.after(x); anchor = x; });
    if (!b.textContent) b.remove();
    var last = nodes[nodes.length - 1];
    setSel(last, last.textContent.length);
    afterStructural();
    toast("Inserted from side notes");
  }
  function addJot() {
    var v = $("noteInput").value.trim();
    if (!v) return;
    var d = cur(), note = { id: uid(), mode: "free", at: now(), blocks: v.split(/\n/).map(function (l) { return { t: "p", x: l }; }) };
    d.notes = d.notes || [];
    d.notes.unshift(note);
    $("noteInput").value = "";
    markDirty(); renderNotes(note.id);
  }

  /* floating toolbar over a selection */
  var bubbleTimer = null, mouseIsDown = false;
  function hideBubble() { $("bubble").hidden = true; }
  function updateBubble() {
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () {
      var s = getSelection(), el = $("bubble");
      if (mouseIsDown || state.settings.focus || !s.rangeCount || s.isCollapsed || !editor.contains(s.anchorNode) || !s.toString().trim()) { el.hidden = true; return; }
      var r = s.getRangeAt(0).getBoundingClientRect();
      if (!r.width && !r.height) { el.hidden = true; return; }
      var d = cur(), html = "<button class=\"q\" data-b=\"quote\" title=\"Quote\">“ ”</button>";
      if (d.cast.length) {
        html += "<span class=\"bsep\"></span>";
        d.cast.slice(0, 6).forEach(function (c, i) {
          html += "<button data-b=\"speak:" + i + "\" style=\"--who:var(--" + c.color + ")\" title=\"" + esc(c.name) + " says this\"><span class=\"key\">" + esc(c.key) + "</span></button>";
        });
      }
      html += "<span class=\"bsep\"></span><button data-b=\"thes\" title=\"" + MOD + "⇧L\">Thesaurus</button>";
      html += "<span class=\"bsep\"></span><button data-b=\"notes:move\" title=\"" + MOD + "⇧M\">Move to notes</button><button data-b=\"notes:copy\" title=\"" + MOD + "⇧J\">Copy to notes</button>";
      el.innerHTML = html;
      el.hidden = false;
      var w = el.offsetWidth, h = el.offsetHeight;
      var top = r.top - h - 10;
      if (top < 60) top = r.bottom + 10;
      el.style.top = top + "px";
      el.style.left = Math.max(10, Math.min(window.innerWidth - w - 10, r.left + r.width / 2 - w / 2)) + "px";
    }, 120);
  }

  /* keyboard shortcuts page and word goal */
  function openKeys() {
    var mac = host.platform === "darwin";
    var C = mac ? "⌘" : "Ctrl", A = mac ? "⌥" : "Alt", S = mac ? "⇧" : "Shift", W = mac ? "⌥ or Ctrl" : "Ctrl";
    var k = function () { return Array.prototype.map.call(arguments, function (x) { return "<kbd>" + x + "</kbd>"; }).join(" + "); };
    var groups = [
      ["Dialogue", [[k(A, "1–9"), "Speak as cast member 1–9"], [k("Enter"), "Finish the line and add the tag"], [k("Esc"), "Cancel an open line"],
        [k(C, "'"), "Quote the selection “ ”"], [k(C, S, "'"), "Single quotes ‘ ’"], [k(C, S, "B"), "Back and forth on/off"], [k(C, S, "C"), "Add a character"]]],
      ["Moving and selecting", [[k(W, "←") + " " + k("→"), "Jump one word"], [k(W, S, "←") + " " + k("→"), "Select one word at a time"],
        [k(W, "Backspace"), "Delete the word before the cursor"], [k(W, "Delete"), "Delete the word after the cursor"]]],
      ["Typing", [[k("\"") + " " + k("(") + " " + k("["), "Types both halves, cursor in between"], ["with text selected", "Wraps the selection instead"],
        [k("Backspace"), "Inside an empty pair, removes both"]]],
      ["Words", [[k(C, S, "L"), "Thesaurus for the word at the cursor"], ["right-click a word", "Look it up"]]],
      ["Side notes", [[k(C, S, "M"), "Move the selection to side notes"], [k(C, S, "J"), "Copy the selection to side notes"], ["right-click", "Same options on any selection"]]],
      ["Script", [[k(C, "1") + " … " + k("6"), "Scene, Action, Character, Paren, Dialogue, Transition"], [k("Tab") + " " + k(S, "Tab"), "Next / previous element"],
        [k(C, S, "1") + " " + k("2") + " " + k("3"), "Prose, Script, Poem"]]],
      ["Pieces", [[k(C, "N"), "New prose"], [k(C, S, "N"), "New script"], [k(C, A, "N"), "New poem"], [k(C, "T"), "Templates"],
        [k(C, "O"), "Open or import"], [k(C, "P"), "Export PDF"], [k(C, S, "D"), "Duplicate"], [k(C, S, "G"), "Word goal or limit"]]],
      ["View", [[k(C, "K"), "Command palette"], [k(C, S, "F"), "Focus mode"], [k(C, S, "T"), "Typewriter scrolling"], [k(C, "\\"), "Show / hide library"],
        [k(C, A, "\\"), "Show / hide side panel"], [k(C, "/"), "This page"], [k(C, "+") + " " + k(C, "−"), "Zoom"]]]
    ];
    $("keysBody").innerHTML = groups.map(function (g) {
      return "<div><h3>" + g[0] + "</h3><table class=\"keys\">" + g[1].map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; }).join("") + "</table></div>";
    }).join("");
    openModal("keysModal");
  }
  var GOAL_PRESETS = [
    [50, "Mini saga", "limit"], [100, "Drabble", "limit"], [300, ""], [500, ""], [1000, "Flash", "limit"],
    [2500, ""], [7500, "Short story"], [17500, "Novelette"], [50000, "Novel"]
  ];
  function openGoal() {
    collect();
    $("goalNum").value = cur().goal || "";
    renderGoal();
    openModal("goalModal");
    $("goalNum").focus();
  }
  function renderGoal() {
    var d = cur(), words = wordCount(d), limit = d.goalType === "limit";
    document.querySelectorAll("[data-gt]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.gt === (limit ? "limit" : "target"))); });
    $("goalPresets").innerHTML = GOAL_PRESETS.map(function (p) {
      return "<button data-n=\"" + p[0] + "\"" + (p[2] ? " data-type=\"" + p[2] + "\"" : "") + " aria-pressed=\"" + (d.goal === p[0]) + "\">" + p[0].toLocaleString() + (p[1] ? "<span>" + p[1] + "</span>" : "") + "</button>";
    }).join("");
    var msg;
    if (d.goal && limit) msg = words > d.goal ? "<b>" + (words - d.goal).toLocaleString() + " words over</b> the limit. The extra text is marked in red." : "<b>" + (d.goal - words).toLocaleString() + " words</b> left before the limit.";
    else if (d.goal) msg = words >= d.goal ? "<b>Goal reached.</b> " + words.toLocaleString() + " words." : "<b>" + (d.goal - words).toLocaleString() + " words</b> to go.";
    else msg = "No goal set. You’re at " + words.toLocaleString() + " words.";
    $("goalPreview").innerHTML = msg;
  }
  function goalChanged() { markDirty(); renderGoal(); decorateSoon(); renderStatus(); renderPanelSoon(); }

  /* ================================================================
     Thesaurus — Datamuse (https://www.datamuse.com/api/): free, no key.
     Where outside sites are blocked (the Claude preview) it asks Claude instead.
     ================================================================ */
  var WORDS_API = "https://api.datamuse.com/words";
  var WORD_TABS = [
    { id: "syn", label: "Similar", q: "ml" },
    { id: "ant", label: "Opposite", q: "rel_ant" },
    { id: "rhy", label: "Rhymes", q: "rel_rhy" },
    { id: "adj", label: "Describe it", q: "rel_jjb" },
    { id: "rel", label: "Related", q: "rel_trg" }
  ];
  var ASK = { syn: "synonyms and close alternatives", ant: "antonyms", rhy: "perfect rhymes", adj: "adjectives writers often use to describe it", rel: "words strongly associated with it" };
  var POS = { n: "noun", v: "verb", adj: "adjective", adv: "adverb" };
  var wordCache = {}, words = { q: "", tab: "syn", target: null, seq: 0 };
  var sampleP = null;
  function viaClaude(prompt) {
    if (!window.claude || !window.claude.use) return Promise.reject(new Error("offline"));
    sampleP = sampleP || window.claude.use("sample");
    return sampleP.then(function (s) { if (!s) throw new Error("offline"); return s.json(prompt, { modelTier: "quick" }); });
  }
  function fetchJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }
  function lookup(kind, word) {
    var key = kind + ":" + word.toLowerCase();
    if (wordCache[key]) return Promise.resolve(wordCache[key]);
    var tab = WORD_TABS.filter(function (t) { return t.id === kind; })[0];
    var get = function (param) {
      return fetchJSON(WORDS_API + "?" + param + "=" + encodeURIComponent(word) + "&md=s&max=80").then(function (l) {
        return l.map(function (x) { return { w: x.word, syl: x.numSyllables || syllables(x.word) }; });
      });
    };
    return get(tab.q).then(function (l) {
      if (kind === "rhy" && l.length < 12) return get("rel_nry").then(function (n) { return l.concat(n.map(function (x) { x.near = true; return x; })); });
      return l;
    }).then(null, function () {
      return viaClaude("List up to 40 " + ASK[kind] + " for the English word \"" + word + "\", most useful first. Reply with JSON only: {\"words\":[\"...\"]}")
        .then(function (r) { return ((r && r.words) || []).map(function (w) { return { w: String(w), syl: syllables(String(w)) }; }); });
    }).then(function (l) {
      var seen = {};
      l = l.filter(function (x) {
        var k = x.w.toLowerCase();
        if (seen[k] || k === word.toLowerCase() || !/^\p{L}[\p{L}’' \-]*$/u.test(x.w)) return false;
        seen[k] = 1; return true;
      });
      wordCache[key] = l;
      return l;
    });
  }
  function define(word) {
    var key = "def:" + word.toLowerCase();
    if (wordCache[key]) return Promise.resolve(wordCache[key]);
    return fetchJSON(WORDS_API + "?sp=" + encodeURIComponent(word) + "&md=d&max=1").then(function (l) {
      var hit = l[0] && l[0].word.toLowerCase() === word.toLowerCase() ? l[0].defs || [] : [];
      return hit.map(function (s) { var t = s.split("\t"); return { pos: t[0], text: t[1] }; });
    }).then(null, function () {
      return viaClaude("Define the English word \"" + word + "\" in at most 2 short senses. Reply with JSON only: {\"defs\":[{\"pos\":\"n|v|adj|adv\",\"text\":\"...\"}]}")
        .then(function (r) { return (r && r.defs) || []; }, function () { return []; });
    }).then(function (d) { wordCache[key] = d; return d; });
  }

  /* the word to swap: the selection, or the word the cursor is in */
  function wordAtCaret() {
    var c = caretInfo();
    if (!c || c.block !== c.endBlock) return null;
    var txt = c.block.textContent, a = c.a, b = c.b, W = /[\p{L}\p{N}’'\-]/u;
    if (c.collapsed) {
      while (a > 0 && W.test(txt[a - 1])) a--;
      while (b < txt.length && W.test(txt[b])) b++;
    }
    while (a < b && !/[\p{L}\p{N}]/u.test(txt[a])) a++;
    while (b > a && !/[\p{L}\p{N}]/u.test(txt[b - 1])) b--;
    var w = txt.slice(a, b);
    if (!w || w.length > 40 || /\s{2,}/.test(w)) return null;
    return { block: c.block, a: a, b: b, word: w };
  }
  function matchCase(orig, w) {
    if (orig.length > 1 && orig === orig.toUpperCase() && /\p{L}/u.test(orig)) return w.toUpperCase();
    if (/^\p{Lu}/u.test(orig)) return w.charAt(0).toUpperCase() + w.slice(1);
    return w;
  }
  function openThesaurus() {
    words.target = wordAtCaret();
    if (cur().mode === "poem" && !words.q) words.tab = "rhy";
    showThesaurus();
    if (words.target) wordsGo(words.target.word);
    else { renderWordTabs(); renderWordHint(); if (!words.q) $("wordsRes").innerHTML = "<p class=\"w-note\">Put the cursor in a word or select one, then open the thesaurus. Or type any word above.</p>"; }
  }
  function wordsGo(q, tab) {
    q = (q || "").trim();
    if (!q) return;
    words.q = q;
    if (tab) words.tab = tab;
    $("wordsQ").value = q;
    renderWordTabs(); renderWordHint();
    var seq = ++words.seq;
    $("wordsRes").innerHTML = "<p class=\"w-note\">Looking up “" + esc(q) + "”…</p>";
    $("wordsDef").innerHTML = "";
    define(q).then(function (d) {
      if (seq !== words.seq) return;
      $("wordsDef").innerHTML = d.slice(0, 2).map(function (x) { return "<span class=\"pos\">" + esc(POS[x.pos] || x.pos || "") + "</span> " + esc(x.text || ""); }).join("<br>");
    });
    lookup(words.tab, q).then(function (l) {
      if (seq !== words.seq) return;
      renderWordResults(l);
    }, function () {
      if (seq !== words.seq) return;
      $("wordsRes").innerHTML = "<p class=\"w-note\">Couldn’t reach the thesaurus. Check that you’re online and try again.</p>";
    });
  }
  function renderWordTabs() {
    $("wordsTabs").innerHTML = WORD_TABS.map(function (t) {
      return "<button role=\"tab\" data-wt=\"" + t.id + "\" aria-selected=\"" + (t.id === words.tab) + "\">" + t.label + "</button>";
    }).join("");
  }
  function renderWordHint() {
    var t = words.target;
    $("wordsHint").innerHTML = t && editor.contains(t.block)
      ? "Tap a word to swap it in for “<b>" + esc(t.word) + "</b>”. Tap › to look that word up instead."
      : "Tap a word to add it at the cursor. Tap › to look it up.";
  }
  function chip(x, showSyl) {
    return "<span class=\"wchip\"><button class=\"w-use\" data-w=\"" + esc(x.w) + "\">" + esc(x.w) + (showSyl ? "<small>" + x.syl + "</small>" : "") +
      "</button><button class=\"w-go\" data-go=\"" + esc(x.w) + "\" title=\"Look up " + esc(x.w) + "\" aria-label=\"Look up " + esc(x.w) + "\">›</button></span>";
  }
  function renderWordResults(l) {
    if (!l.length) { $("wordsRes").innerHTML = "<p class=\"w-note\">Nothing found for “" + esc(words.q) + "” here. Try another tab or a simpler form of the word.</p>"; return; }
    var poem = cur().mode === "poem", html = "";
    if (words.tab === "rhy") {
      var groups = {}, near = [];
      l.forEach(function (x) { if (x.near) near.push(x); else (groups[x.syl] = groups[x.syl] || []).push(x); });
      Object.keys(groups).sort(function (a, b) { return a - b; }).forEach(function (n) {
        html += "<h5>" + n + (n === "1" ? " syllable" : " syllables") + "</h5><div class=\"wgrid\">" + groups[n].slice(0, 30).map(function (x) { return chip(x, false); }).join("") + "</div>";
      });
      if (near.length) html += "<h5>Near rhymes</h5><div class=\"wgrid\">" + near.slice(0, 30).map(function (x) { return chip(x, true); }).join("") + "</div>";
    } else {
      html = "<div class=\"wgrid\">" + l.slice(0, 60).map(function (x) { return chip(x, poem); }).join("") + "</div>";
    }
    $("wordsRes").innerHTML = html;
  }
  function useWord(w) {
    var t = words.target, from = t && t.word;
    editor.focus({ preventScroll: true });
    if (t && editor.contains(t.block) && t.block.textContent.slice(t.a, t.b) === t.word) {
      var out = matchCase(t.word, w);
      replaceRange(t.block, t.a, t.b, out);
      setSel(t.block, t.a + out.length);
      words.target = { block: t.block, a: t.a, b: t.a + out.length, word: out };
    } else {
      restoreSel();
      var c = caretInfo(), prev = c && c.a > 0 ? c.block.textContent[c.a - 1] : "";
      insertText((prev && !/\s/.test(prev) ? " " : "") + w);
    }
    decorateSoon(); markDirty(); renderWordHint();
    return from;
  }
  function wireThesaurus(afterUse) {
    $("wordsForm").addEventListener("submit", function (e) { e.preventDefault(); wordsGo($("wordsQ").value); });
    $("wordsTabs").addEventListener("click", function (e) { var b = e.target.closest("[data-wt]"); if (b) wordsGo(words.q, b.dataset.wt); });
    $("wordsRes").addEventListener("mousedown", function (e) { if (e.target.closest(".w-use")) e.preventDefault(); });
    $("wordsRes").addEventListener("click", function (e) {
      var u = e.target.closest("[data-w]"), g = e.target.closest("[data-go]");
      if (g) { wordsGo(g.dataset.go); return; }
      if (u) { var from = useWord(u.dataset.w); if (afterUse) afterUse(from, u.dataset.w); }
    });
  }

  function showThesaurus() { showPanel("words"); }

  /* ================================================================
     Chrome: theme, panels, focus
     ================================================================ */
  function applyTheme() {
    var t = state.settings.theme, l = state.settings.light || "paper";
    if (l === "paper") document.documentElement.removeAttribute("data-light");
    else document.documentElement.setAttribute("data-light", l);
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    host.setTheme(t);
  }
  function isDark() { return state.settings.theme === "dark" || (state.settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches); }
  function applyChrome() {
    var s = state.settings;
    win.classList.toggle("no-side", !s.side);
    win.classList.toggle("no-panel", !s.panel);
    win.classList.toggle("focus", !!s.focus);
    $("focusBtn").setAttribute("aria-pressed", String(!!s.focus));
    document.documentElement.style.setProperty("--scale", s.scale || 1);
    if (s.notesh) $("panel").style.setProperty("--notesh", s.notesh + "px");
    $("notes").classList.toggle("collapsed", !!s.notesHidden);
    $("notesToggle").textContent = s.notesHidden ? "Show" : "Hide";
    $("notesToggle").setAttribute("aria-expanded", String(!s.notesHidden));
  }
  function toggleFocus() {
    var s = state.settings;
    s.focus = !s.focus;
    if (s.focus) { s._side = s.side; s._panel = s.panel; s.side = false; s.panel = false; }
    else { s.side = s._side !== false; s.panel = s._panel !== false; }
    applyChrome(); saveSettings();
    hideBubble();
    editor.focus({ preventScroll: true });
    toast(s.focus ? "Focus mode. " + MOD + "⇧F to leave" : "Focus mode off");
  }
  function pushMenuState() {
    var d = cur();
    host.setMenuState({
      cast: d ? d.cast.map(function (c) { return c.name || "?"; }) : [],
      focus: !!state.settings.focus, typewriter: !!state.settings.typewriter, pingpong: !!state.settings.pingpong,
      theme: state.settings.theme, mode: d ? d.mode : "prose"
    });
  }

  /* ================================================================
     Rendering
     ================================================================ */
  function renderAll() {
    var d = cur();
    $("title").value = d.title || "";
    host.setTitle(d.title || "Untitled");
    document.querySelectorAll(".seg button[data-mode]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === d.mode)); });
    document.querySelectorAll("[data-when]").forEach(function (el) { el.hidden = el.dataset.when !== d.mode; });
    renderEditor(); renderCastStrip(); renderLibrary(); renderStatus(); syncTypeButtons(); renderNotes();
    showPanel(state.settings.tab);
  }
  function renderStatus() {
    var d = cur();
    if (!d) return;
    var words = wordCount(d);
    var limit = d.goal && d.goalType === "limit", over = limit ? words - d.goal : 0;
    $("stWords").innerHTML = over > 0 ? "<span class=\"over-n\">" + words.toLocaleString() + "</span> words" : "<b>" + words.toLocaleString() + "</b> words";
    $("stGoalWrap").hidden = !d.goal;
    if (d.goal) {
      var bar = $("stGoal").parentNode;
      bar.className = "goal-bar" + (limit ? " limit" + (over > 0 ? " over" : words >= d.goal * 0.9 ? " near" : "") : "");
      $("stGoal").style.width = Math.min(100, words / d.goal * 100) + "%";
      $("stGoalTxt").innerHTML = limit
        ? (over > 0 ? "<span class=\"over-n\">" + over.toLocaleString() + " over</span> the " + d.goal.toLocaleString() + " limit" : (d.goal - words).toLocaleString() + " left of " + d.goal.toLocaleString() + " max")
        : Math.min(100, Math.round(words / d.goal * 100)) + "% of " + d.goal.toLocaleString();
    }
    var b = curBlock();
    $("stExtra").textContent = d.mode === "script" ? scriptPages(d).toFixed(1) + " pages · " + (b ? TYPE_NAME[b.dataset.t] : "")
      : d.mode === "poem" ? d.blocks.filter(function (x) { return x.x.trim(); }).length + " lines · " + d.blocks.reduce(function (n, x) { return n + syllables(x.x); }, 0) + " syllables" : Math.max(1, Math.round(words / 230)) + " min read";
    var s = words - (sessionStart[d.id] || 0);
    $("stSession").textContent = s ? (s > 0 ? "+" : "") + s.toLocaleString() + " this session" : "";
    $("stSaved").innerHTML = "<span class=\"dot" + (savedFlag ? "" : " dirty") + "\"></span>" + (savedFlag ? "Saved" : "Saving…");
  }
  function syncTypeButtons() {
    var b = curBlock(), t = b ? b.dataset.t : null;
    document.querySelectorAll("[data-type]").forEach(function (el) { el.setAttribute("aria-pressed", String(el.dataset.type === t)); });
  }
  function setType(t) {
    var d = cur();
    if (TYPES[d.mode].indexOf(t) < 0) { toast(TYPE_NAME[t] + " is a " + (TYPES.script.indexOf(t) >= 0 ? "Script" : "Prose") + " element"); return; }
    restoreSel();
    var c = caretInfo();
    if (!c) return;
    var n = c.block;
    n.dataset.t = t;
    while (n !== c.endBlock && n.nextElementSibling) { n = n.nextElementSibling; n.dataset.t = t; }
    decorateSoon(); markDirty(); syncTypeButtons();
  }

  /* ================================================================
     Actions (menu, palette, buttons all route through here)
     ================================================================ */
  function action(a) {
    var d = cur(), parts = a.split(":"), verb = parts[0], arg = parts.slice(1).join(":");
    switch (verb) {
      case "flush": collect(); flush(); break;
      case "new": { var nd = newDoc(arg, ""); open(nd.id); setTimeout(function () { $("title").focus(); }, 30); break; }
      case "templates": renderTemplates(); openModal("tplModal"); break;
      case "open": host.openFiles().then(importPayloads); break;
      case "duplicate": { collect(); var c = JSON.parse(JSON.stringify(d)); var dup = newDoc(d.mode, (d.title || "Untitled") + " (copy)", c.blocks, { cast: c.cast, goal: c.goal }); open(dup.id); toast("Duplicated"); break; }
      case "delete": deleteCurrent(); break;
      case "export": if (arg) exportAs(arg); else openExport(); break;
      case "mode": switchMode(arg); break;
      case "type": setType(arg); break;
      case "quote": quoteSelection("“", "”"); break;
      case "squote": quoteSelection("‘", "’"); break;
      case "ins": restoreSel(); insertText(arg); markDirty(); break;
      case "speak": { var ch = d.cast[+arg]; if (ch) speak(ch.id); else toast("Add characters in the Cast panel first"); break; }
      case "pingpong": state.settings.pingpong = !state.settings.pingpong; saveSettings(); renderCastStrip(); toast(state.settings.pingpong ? "Back and forth on: Enter hands the next line over" : "Back and forth off"); break;
      case "cast-add": addCharacter(); break;
      case "focus": toggleFocus(); break;
      case "typewriter": state.settings.typewriter = !state.settings.typewriter; saveSettings(); keepCaretVisible(); toast(state.settings.typewriter ? "Typewriter scrolling on" : "Typewriter scrolling off"); break;
      case "toggle-side": state.settings.side = !state.settings.side; applyChrome(); saveSettings(); break;
      case "toggle-panel": state.settings.panel = !state.settings.panel; applyChrome(); saveSettings(); break;
      case "tab": showPanel(arg); break;
      case "theme": state.settings.theme = arg; applyTheme(); saveSettings(); break;
      case "settings": openSettings(); break;
      case "help": openModal("helpModal"); break;
      case "keys": openKeys(); break;
      case "thes": openThesaurus(); break;
      case "goal": openGoal(); break;
      case "notes": toNotes(arg === "move"); break;
      case "palette": openPalette(); break;
      case "choose-folder": chooseFolder(); break;
      case "doc": open(arg); break;
    }
  }
  function openExport() {
    var d = cur();
    $("exportLede").textContent = "“" + (d.title || "Untitled") + "” · " + MODE_NAME[d.mode];
    $("pdfNote").textContent = d.mode === "script" ? "Standard screenplay format on US Letter, with a title page." : d.mode === "poem" ? "Title and lines, stanza breaks kept." : "Manuscript format: double-spaced, title page.";
    document.querySelectorAll("#exportModal [data-when]").forEach(function (el) { el.hidden = el.dataset.when !== d.mode; });
    openModal("exportModal");
  }
  function openSettings() {
    var s = state.settings;
    $("setTheme").value = s.theme; $("setSmart").checked = !!s.smart; $("setLight").value = s.light || "paper"; $("setPair").checked = s.autopair !== false; $("setTag").value = s.tag; $("setTense").value = s.tense;
    $("setAuthor").value = s.author || ""; $("setSize").value = String(s.scale || 1);
    host.folder().then(function (f) { $("setFolder").textContent = f; });
    openModal("settingsModal");
  }
  function chooseFolder() {
    host.chooseFolder().then(function (r) {
      if (!r) return;
      state.docs = {};
      r.docs.forEach(function (d) { state.docs[d.id] = d; });
      if (!Object.keys(state.docs).length) seedSamples();
      state.currentId = sortedDocs()[0].id;
      flush(); renderAll(); showFolder(r.folder);
      $("setFolder").textContent = r.folder;
      toast("Library folder changed");
    });
  }
  function showFolder(f) {
    var short = String(f).replace(/^\/Users\/[^/]+/, "~").replace(/^[A-Z]:\\Users\\[^\\]+/, "~");
    $("folderPath").textContent = short;
    $("folderBtn").title = f;
  }

  /* ================================================================
     Events
     ================================================================ */
  // toolbar buttons keep the editor's selection
  ["formatbar", "castRow"].forEach(function (id) {
    $(id).addEventListener("mousedown", function (e) { if (e.target.closest("button") && !e.target.closest("#castAdd,#tplBtn,#exportBtn,#paletteBtn")) e.preventDefault(); });
  });
  $("formatbar").addEventListener("click", function (e) {
    var t = e.target.closest("button"); if (!t) return;
    if (t.id === "tplBtn") return action("templates");
    if (t.id === "exportBtn") return action("export");
    if (t.id === "paletteBtn") return action("palette");
    var a = t.dataset.act;
    if (a === "quote" || a === "squote") return action(a);
    if (a === "ins") return action("ins:" + t.dataset.text);
    if (a === "undo" || a === "redo") { restoreSel(); document.execCommand(a); pending = null; renderCastStrip(); ensureBlocks(); decorateSoon(); markDirty(); return; }
    if (t.dataset.type) return setType(t.dataset.type);
  });
  $("castRow").addEventListener("click", function (e) {
    var t = e.target.closest("button"); if (!t) return;
    if (t.dataset.speak) speak(t.dataset.speak);
    else if (t.id === "castAdd") addCharacter();
    else if (t.id === "pingBtn") action("pingpong");
  });
  $("castRow").addEventListener("change", function (e) { if (e.target.id === "verbSel") { state.settings.verb = e.target.value; saveSettings(); restoreSel(); } });

  // cast cards
  $("tabCast").addEventListener("input", function (e) {
    var card = e.target.closest("[data-cid]"); if (!card) return;
    var c = castById(card.dataset.cid), f = e.target.dataset.f; if (!c || !f) return;
    if (f === "name") {
      var old = c.name;
      c.name = e.target.value.trim();
      if (!c.key || c.key === (old[0] || "").toUpperCase()) { c.key = (c.name[0] || "").toUpperCase(); card.querySelector(".key-in").value = c.key; }
      if (old && cur().mode === "script") Array.prototype.forEach.call(editor.children, function (p) {
        if (p.dataset.t === "character" && p.textContent.trim().toUpperCase() === old.toUpperCase() && c.name) setBlockText(p, c.name.toUpperCase());
      });
    } else if (f === "key") c.key = e.target.value.trim().toUpperCase();
    else if (f === "notes") c.notes = e.target.value;
    renderCastStrip(); decorateSoon(); markDirty();
  });
  $("tabCast").addEventListener("click", function (e) {
    if (e.target.closest("#castAddCard")) return addCharacter();
    var card = e.target.closest("[data-cid]"); if (!card) return;
    var d = cur(), id = card.dataset.cid;
    var sw = e.target.closest("[data-sw]");
    if (sw) { castById(id).color = sw.dataset.sw; renderCastPanel(); renderCastStrip(); decorateSoon(); markDirty(); }
    if (e.target.closest("[data-cdel]")) {
      var c = castById(id);
      d.cast = d.cast.filter(function (x) { return x.id !== id; });
      if (pending && pending.id === id) pending = null;
      renderCastPanel(); renderCastStrip(); decorateSoon(); markDirty();
      toast("Removed " + (c.name || "character"), "Undo", function () { d.cast.push(c); renderCastPanel(); renderCastStrip(); decorateSoon(); markDirty(); });
    }
  });
  $("tabCast").addEventListener("focusout", function () { setTimeout(function () { if (!$("tabCast").contains(document.activeElement)) { var d = cur(); d.cast = d.cast.filter(function (c) { return c.name; }); renderCastPanel(); renderCastStrip(); } }, 0); });
  $("tabOutline").addEventListener("click", function (e) {
    var li = e.target.closest("[data-jump]"); if (!li) return;
    var p = editor.children[+li.dataset.jump]; if (!p) return;
    editor.focus({ preventScroll: true }); setSel(p, 0);
    var sc = $("scroll"); sc.scrollTop += p.getBoundingClientRect().top - sc.getBoundingClientRect().top - 60;
  });
  $("tabStats").addEventListener("click", function (e) { if (e.target.closest("#goalOpen")) openGoal(); });
  document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { showPanel(b.dataset.tab); }); });

  // editor
  editor.addEventListener("beforeinput", function (e) {
    var it = e.inputType;
    if (it === "insertParagraph" || it === "insertLineBreak") { e.preventDefault(); handleEnter(); return; }
    if (it === "insertText" && e.data && e.data.length === 1 && "\"'“‘”’()[]".indexOf(e.data) >= 0) {
      e.preventDefault();
      if (!typeChar(e.data)) insertText(e.data);
      return;
    }
    if (it === "deleteContentBackward" && backspacePair()) { e.preventDefault(); return; }
  });
  editor.addEventListener("input", function (e) {
    if (e.inputType === "insertParagraph" || e.inputType === "insertFromPaste" || e.inputType === "historyUndo" || e.inputType === "historyRedo") ensureBlocks();
    else if (editor.querySelector(":scope > :not(p), :scope > p *:not(br)") || (editor.firstChild && editor.firstChild.nodeType === 3) || !editor.firstElementChild) ensureBlocks();
    var d = cur(), b = curBlock();
    if (b && d.mode === "script" && b.dataset.t === "action") {
      var x = b.textContent;
      if (/^(INT|EXT|EST|INT\.\/EXT|I\/E)[.\s]/i.test(x)) { b.dataset.t = "scene"; syncTypeButtons(); }
      else if (/^[A-Z .]+ TO:$/.test(x)) { b.dataset.t = "transition"; syncTypeButtons(); }
    }
    if (b && d.mode === "script" && b.dataset.t === "dialogue" && b.textContent === "(") { b.dataset.t = "paren"; syncTypeButtons(); }
    if (pending && pending.block && pending.block.textContent.indexOf("“") < 0) { pending = null; renderCastStrip(); }
    if (state.settings.typewriter) keepCaretVisible();
    decorateSoon(); markDirty();
  });
  editor.addEventListener("keydown", function (e) {
    var d = cur(), mod = e.ctrlKey || e.metaKey;
    if (wordKeys(e)) { decorateSoon(); markDirty(); return; }
    if (e.key === "Tab" && d.mode === "script") {
      e.preventDefault();
      var b = curBlock(); if (!b) return;
      var i = CYCLE.indexOf(b.dataset.t);
      b.dataset.t = CYCLE[(i + (e.shiftKey ? CYCLE.length - 1 : 1)) % CYCLE.length];
      decorateSoon(); markDirty(); syncTypeButtons(); renderStatus();
      return;
    }
    if (e.key === "Escape" && pending) { pending.block.classList.remove("speaking"); pending = null; renderCastStrip(); return; }
    if (isElectron) return; // the native menu owns the remaining shortcuts
    if (mod && (e.key === "'" || e.key === "\"")) { e.preventDefault(); action(e.shiftKey ? "squote" : "quote"); return; }
    if (e.altKey && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); action("speak:" + (+e.code.slice(5) - 1)); return; }
    if (mod && /^[1-6]$/.test(e.key)) { e.preventDefault(); setType(CYCLE[+e.key - 1]); }
    if (mod && e.shiftKey && e.key.toLowerCase() === "m") { e.preventDefault(); toNotes(true); }
    if (mod && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); openThesaurus(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === "j") { e.preventDefault(); toNotes(false); }
  });
  editor.addEventListener("paste", function (e) {
    var text = e.clipboardData.getData("text/plain");
    e.preventDefault();
    if (!text) return;
    var d = cur(), lines = text.replace(/\r/g, "").split("\n");
    if (lines.length === 1) { insertText(text); return; }
    var c = caretInfo(); if (!c) return;
    if (!c.collapsed) { document.execCommand("delete"); c = caretInfo(); }
    var b = c.block, full = b.textContent, tail = full.slice(c.a), blocks;
    if (d.mode === "script") blocks = parseFountain(text);
    else if (d.mode === "poem") blocks = lines.map(function (l) { return { t: "verse", x: l }; });
    else blocks = text.replace(/\r/g, "").split(/\n\s*\n|\n/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) { return { t: "p", x: s }; });
    if (!blocks.length) return;
    setBlockText(b, full.slice(0, c.a) + blocks[0].x);
    var anchor = b, last = b;
    blocks.slice(1).forEach(function (nb) { var n = makeBlock(nb); anchor.after(n); anchor = n; last = n; });
    var pos = last.textContent.length;
    setBlockText(last, last.textContent + tail);
    setSel(last, pos);
    afterStructural();
  });
  document.addEventListener("selectionchange", function () {
    var s = getSelection();
    if (s.rangeCount && editor.contains(s.anchorNode)) {
      savedRange = s.getRangeAt(0).cloneRange();
      syncTypeButtons(); markCurrent();
      if (cur().mode === "script") renderStatus();
      if (pending && curBlock() !== pending.block) { pending.block.classList.remove("speaking"); pending.block.style.removeProperty("--who"); pending = null; renderCastStrip(); }
    }
  });

  // title bar & library
  $("title").addEventListener("input", function () { cur().title = this.value; host.setTitle(this.value); markDirty(); });
  $("title").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); editor.focus(); } });
  document.querySelectorAll(".seg button[data-mode]").forEach(function (b) { b.addEventListener("click", function () { switchMode(b.dataset.mode); }); });
  $("themeBtn").addEventListener("click", function () { action("theme:" + (isDark() ? "light" : "dark")); });
  $("focusBtn").addEventListener("click", toggleFocus);
  $("sideBtn").addEventListener("click", function () { action("toggle-side"); });
  $("panelBtn").addEventListener("click", function () { action("toggle-panel"); });
  $("search").addEventListener("input", renderLibrary);
  document.querySelectorAll(".side-filter button").forEach(function (b) { b.addEventListener("click", function () { state.settings.filter = b.dataset.filter; saveSettings(); renderLibrary(); }); });
  document.querySelectorAll("[data-new]").forEach(function (b) { b.addEventListener("click", function () { action("new:" + b.dataset.new); }); });
  $("docList").addEventListener("click", function (e) { var li = e.target.closest("[data-open]"); if (li) open(li.dataset.open); });
  $("docList").addEventListener("keydown", function (e) {
    var li = e.target.closest("[data-open]"); if (!li) return;
    if (e.key === "Enter") open(li.dataset.open);
    if (e.key === "ArrowDown" && li.nextElementSibling) { e.preventDefault(); li.nextElementSibling.focus(); }
    if (e.key === "ArrowUp" && li.previousElementSibling) { e.preventDefault(); li.previousElementSibling.focus(); }
    if ((e.key === "Delete" || e.key === "Backspace") && li.dataset.open === state.currentId) deleteCurrent();
  });
  $("docList").addEventListener("contextmenu", function (e) {
    var li = e.target.closest("[data-open]"); if (!li) return;
    e.preventDefault();
    if (li.dataset.open !== state.currentId) open(li.dataset.open);
    ask("“" + (cur().title || "Untitled") + "”", "What would you like to do with this piece?", [
      { label: "Cancel" }, { label: "Delete", danger: true, fn: deleteCurrent }, { label: "Duplicate", fn: function () { action("duplicate"); } }, { label: "Export…", primary: true, fn: openExport }
    ]);
  });
  $("folderBtn").addEventListener("click", function () { host.reveal(); });
  $("settingsBtn").addEventListener("click", openSettings);

  // modals
  $("scrim").addEventListener("click", closeModals);
  document.addEventListener("click", function (e) { if (e.target.closest("[data-close]")) closeModals(); });
  $("tplBody").addEventListener("click", function (e) { var t = e.target.closest("[data-tpl]"); if (t) useTemplate(t.dataset.tpl); });
  $("exportModal").addEventListener("click", function (e) { var t = e.target.closest("[data-export]"); if (t) exportAs(t.dataset.export); });
  $("setTheme").addEventListener("change", function () { action("theme:" + this.value); });
  $("setSmart").addEventListener("change", function () { state.settings.smart = this.checked; saveSettings(); });
  $("setLight").addEventListener("change", function () { state.settings.light = this.value; applyTheme(); saveSettings(); });
  wireThesaurus(null);
  $("setPair").addEventListener("change", function () { state.settings.autopair = this.checked; saveSettings(); });
  $("setTag").addEventListener("change", function () { state.settings.tag = this.value; saveSettings(); });
  $("setTense").addEventListener("change", function () { state.settings.tense = this.value; saveSettings(); renderCastStrip(); });
  $("setAuthor").addEventListener("input", function () { state.settings.author = this.value; saveSettings(); });
  $("setSize").addEventListener("change", function () { state.settings.scale = +this.value; applyChrome(); saveSettings(); });
  $("revealBtn").addEventListener("click", function () { host.reveal(); });
  $("chooseFolderBtn").addEventListener("click", chooseFolder);
  $("palInput").addEventListener("input", filterPalette);
  $("palInput").addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); palIndex = Math.min(palItems.length - 1, palIndex + 1); drawPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palIndex = Math.max(0, palIndex - 1); drawPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(palIndex); }
  });
  $("palList").addEventListener("click", function (e) { var li = e.target.closest("[data-pi]"); if (li) runPalette(+li.dataset.pi); });
  document.addEventListener("keydown", function (e) {
    if (!isElectron && (e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); openKeys(); }
    if (e.key === "Escape") { if (!$("scrim").hidden) closeModals(); else if (state.settings.focus) toggleFocus(); }
    if (!isElectron && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    if (!isElectron && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); toggleFocus(); }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { if (state.settings.theme === "system") applyTheme(); });

  // side notes
  $("noteInput").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addJot(); } });
  $("notesToggle").addEventListener("click", function () { state.settings.notesHidden = !state.settings.notesHidden; applyChrome(); saveSettings(); });
  $("noteList").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-nact]"), li = e.target.closest("[data-nid]");
    if (!btn || !li) return;
    var d = cur(), n = noteById(li.dataset.nid);
    if (!n) return;
    if (btn.dataset.nact === "insert") insertNote(n);
    if (btn.dataset.nact === "copy") copyText(noteText(n));
    if (btn.dataset.nact === "del") {
      var i = d.notes.indexOf(n);
      d.notes.splice(i, 1); renderNotes(); markDirty();
      toast("Note deleted", "Undo", function () { d.notes.splice(i, 0, n); renderNotes(); markDirty(); });
    }
  });
  $("noteList").addEventListener("mousedown", function (e) { if (e.target.closest("[data-nact=insert]")) e.preventDefault(); });
  $("noteList").addEventListener("focusout", function (e) {
    var li = e.target.closest("[data-nid]"); if (!li || !e.target.classList.contains("note-text")) return;
    var n = noteById(li.dataset.nid); if (!n) return;
    var text = e.target.innerText.replace(/\n+$/, "");
    if (text === noteText(n)) return;
    var lines = text.split("\n");
    n.blocks = lines.map(function (l, i) { return { t: (n.blocks[i] || n.blocks[n.blocks.length - 1] || { t: "p" }).t, x: l }; }).filter(function (b) { return b.x.trim(); });
    if (!n.blocks.length) cur().notes = cur().notes.filter(function (x) { return x !== n; });
    markDirty(); renderNotes();
  });
  $("notesHandle").addEventListener("mousedown", function (e) {
    e.preventDefault();
    var panel = $("panel"), pr = panel.getBoundingClientRect();
    function move(ev) {
      var h = Math.max(90, Math.min(pr.height - 150, pr.bottom - ev.clientY));
      panel.style.setProperty("--notesh", h + "px");
      state.settings.notesh = Math.round(h);
    }
    function up() { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); saveSettings(); }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    if (state.settings.notesHidden) { state.settings.notesHidden = false; applyChrome(); }
  });
  // selection bubble
  editor.addEventListener("mousedown", function () { mouseIsDown = true; hideBubble(); });
  document.addEventListener("mouseup", function () { if (mouseIsDown) { mouseIsDown = false; updateBubble(); } });
  editor.addEventListener("keyup", function (e) { if (e.shiftKey || e.key === "Shift") updateBubble(); else hideBubble(); });
  editor.addEventListener("input", hideBubble);
  $("scroll").addEventListener("scroll", hideBubble);
  $("bubble").addEventListener("mousedown", function (e) { e.preventDefault(); });
  $("bubble").addEventListener("click", function (e) { var b = e.target.closest("[data-b]"); if (b) { hideBubble(); action(b.dataset.b); } });
  // goal + keys
  $("stGoalBtn").addEventListener("click", openGoal);
  $("stKeys").addEventListener("click", openKeys);
  $("helpKeys").addEventListener("click", openKeys);
  $("goalNum").addEventListener("input", function () { cur().goal = Math.max(0, parseInt(this.value.replace(/\D/g, ""), 10) || 0); goalChanged(); });
  $("goalNum").addEventListener("keydown", function (e) { if (e.key === "Enter") closeModals(); });
  $("goalClear").addEventListener("click", function () { cur().goal = 0; $("goalNum").value = ""; goalChanged(); closeModals(); });
  document.querySelectorAll("[data-gt]").forEach(function (b) { b.addEventListener("click", function () { cur().goalType = b.dataset.gt; goalChanged(); }); });
  $("goalPresets").addEventListener("click", function (e) {
    var b = e.target.closest("[data-n]"); if (!b) return;
    var d = cur();
    d.goal = +b.dataset.n;
    if (b.dataset.type) d.goalType = b.dataset.type;
    $("goalNum").value = d.goal;
    goalChanged();
  });

  host.onMenu(action);
  host.onOpenFile(function (p) { importPayloads([p]); });
  window.addEventListener("beforeunload", function () { collect(); flush(); });

  /* ---------------- boot ---------------- */
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) { /* ignore */ }
  loadSettings();
  if (host.platform === "darwin") win.classList.add("mac");
  $("paletteKbd").textContent = MOD === "⌘" ? "⌘K" : "Ctrl K";
  applyTheme(); applyChrome();
  Promise.all([host.list(), host.folder()]).then(function (res) {
    res[0].forEach(function (d) { if (d && d.id) state.docs[d.id] = d; });
    if (!Object.keys(state.docs).length) seedSamples();
    state.currentId = state.docs[state.settings.lastId] ? state.settings.lastId : sortedDocs()[0].id;
    Object.keys(state.docs).forEach(function (id) { sessionStart[id] = wordCount(state.docs[id]); });
    showFolder(res[1]);
    renderAll();
    flush();
    editor.focus({ preventScroll: true });
  });

  window.__inkling = { state: state, action: action, convertBlocks: convertBlocks, printHtml: printHtml, toFountain: toFountain };
})();

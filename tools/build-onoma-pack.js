// Builds data/onoma-offline.json: Onoma's offline word pack.
//   Meanings, synonyms, opposites, related words: WordNet 3.1 (Princeton University, WordNet licence)
//   Rhymes and syllable counts: CMU Pronouncing Dictionary (Carnegie Mellon University, BSD licence)
// Usage: npm install --no-save wordnet-db@3.1.14 cmu-pronouncing-dictionary@3.0.0 && node tools/build-onoma-pack.js
const fs = require("fs");
const path = require("path");

const dict = path.join(path.dirname(require.resolve("wordnet-db/package.json")), "dict");
const cmuMod = require("cmu-pronouncing-dictionary");
const cmu = cmuMod.dictionary || cmuMod;

const POS = { noun: "n", verb: "v", adj: "a", adv: "r" };
const synsets = [];          // [pos, words, gloss, ants, rels]
const idOf = Object.create(null);             // "n12345" -> index
const raw = [];

// ---- read synsets
for (const [file, p] of Object.entries(POS)) {
  for (const line of fs.readFileSync(path.join(dict, "data." + file), "utf8").split("\n")) {
    if (!line || line[0] === " ") continue;
    const [head, glossRaw = ""] = line.split(" | ");
    const t = head.trim().split(" ");
    const offset = t[0];
    const wcnt = parseInt(t[3], 16);
    const words = [];
    let i = 4;
    for (let k = 0; k < wcnt; k++, i += 2) words.push(t[i].replace(/\(.*\)$/, "").replace(/_/g, " "));
    const pcnt = parseInt(t[i], 10); i++;
    const ptrs = [];
    for (let k = 0; k < pcnt; k++, i += 4) ptrs.push({ sym: t[i], off: t[i + 1], pos: t[i + 2] === "s" ? "a" : t[i + 2] });
    let gloss = glossRaw.split(/;\s*"/)[0].split("; ")[0].replace(/\s+$/, "");
    if (gloss.length > 110) gloss = gloss.slice(0, 107).replace(/\s+\S*$/, "") + "…";
    idOf[p + offset] = synsets.length;
    raw.push(ptrs);
    synsets.push([p, [...new Set(words)].join("|"), gloss, null, null]);
  }
}
// ---- pointers: opposites and related (broader, narrower, similar, see also)
synsets.forEach((s, n) => {
  const ants = [], rels = [];
  for (const q of raw[n]) {
    const target = idOf[q.pos + q.off];
    if (target == null) continue;
    if (q.sym === "!") ants.push(target);
    else if ((q.sym === "@" || q.sym === "&" || q.sym === "^" || q.sym === "@i") && rels.length < 10) rels.push(target);
    else if ((q.sym === "~" || q.sym === "~i") && rels.length < 10) rels.push(target);
  }
  // indices as base-36 lists keep the file small
  s[3] = ants.length ? [...new Set(ants)].map((x) => x.toString(36)).join(",") : "";
  s[4] = rels.length ? [...new Set(rels)].map((x) => x.toString(36)).join(",") : "";
});

// ---- how often each meaning appears in tagged text: puts common senses first
const SS = { 1: "n", 2: "v", 3: "a", 4: "r", 5: "a" };
for (const line of fs.readFileSync(path.join(dict, "index.sense"), "utf8").split("\n")) {
  const t = line.trim().split(" ");
  if (t.length < 4) continue;
  const p = SS[t[0].split("%")[1].charAt(0)];
  const n = idOf[p + t[1]];
  if (n != null) synsets[n][5] = (synsets[n][5] || 0) + (parseInt(t[3], 10) || 0);
}
synsets.forEach((s) => { if (!s[5]) s[5] = 0; });

// ---- lemma -> synsets, most common sense first
const w = Object.create(null);
for (const [file, p] of Object.entries(POS)) {
  for (const line of fs.readFileSync(path.join(dict, "index." + file), "utf8").split("\n")) {
    if (!line || line[0] === " ") continue;
    const t = line.trim().split(" ");
    const lemma = t[0].replace(/_/g, " ");
    const scnt = parseInt(t[2], 10);
    const tagged = parseInt(t[t.length - scnt - 1], 10) || 0;
    const ids = t.slice(t.length - scnt).map((o) => idOf[p + o]).filter((x) => x != null);
    (w[lemma] = w[lemma] || []).push({ tagged, ids });
  }
}
const W = Object.create(null);
for (const [lemma, groups] of Object.entries(w)) W[lemma] = groups.sort((a, b) => b.tagged - a.tagged).flatMap((g) => g.ids);

// ---- irregular forms (mice -> mouse, went -> go)
const E = Object.create(null);
for (const file of ["noun", "verb", "adj", "adv"]) {
  const f = path.join(dict, file + ".exc");
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const [a, b] = line.trim().split(" ");
    if (a && b && !E[a]) E[a.replace(/_/g, " ")] = b.replace(/_/g, " ");
  }
}

// ---- rhymes: group words by the sounds from the last stressed vowel onward
const known = new Set(Object.keys(W).filter((x) => !/ /.test(x)));
const base = (x) => [x, x.replace(/s$/, ""), x.replace(/es$/, ""), x.replace(/ies$/, "y"), x.replace(/ed$/, ""), x.replace(/ed$/, "e"),
  x.replace(/ing$/, ""), x.replace(/ing$/, "e"), x.replace(/er$/, ""), x.replace(/est$/, ""), x.replace(/ly$/, ""), E[x]].filter(Boolean);
const groups = Object.create(null);
let rhymeWords = 0;
for (const [word, pron] of Object.entries(cmu)) {
  if (!/^[a-z]{2,15}$/.test(word)) continue;
  if (!base(word).some((b) => known.has(b))) continue;        // drops names, brands and oddities
  const ph = pron.split(" ");
  const syl = ph.filter((x) => /\d/.test(x)).length;
  let last = -1;
  ph.forEach((x, i) => { if (/[12]/.test(x)) last = i; });
  if (last < 0) ph.forEach((x, i) => { if (/\d/.test(x)) last = i; });
  if (last < 0) continue;
  const key = ph.slice(last).join(" ").replace(/[12]/g, "1");
  ((groups[key] = groups[key] || Object.create(null))[syl] = groups[key][syl] || []).push(word);
  rhymeWords++;
}
const R = Object.create(null);
for (const [key, bySyl] of Object.entries(groups)) {
  const total = Object.values(bySyl).reduce((n, l) => n + l.length, 0);
  if (total < 2) continue;
  R[key] = Object.keys(bySyl).sort((a, b) => a - b).map((s) => s + ":" + bySyl[s].sort().join(" ")).join(";");
}

const out = {
  v: 1,
  about: "WordNet 3.1 (Princeton University, WordNet licence) and the CMU Pronouncing Dictionary (Carnegie Mellon University, BSD licence).",
  s: synsets, e: E, r: R
};
const file = path.join(__dirname, "..", "data", "onoma-offline.json");
fs.writeFileSync(file, JSON.stringify(out));
console.log("synsets", synsets.length, "rhyme groups", Object.keys(R).length, "rhyme words", rhymeWords,
  "size", (fs.statSync(file).size / 1e6).toFixed(1) + " MB");

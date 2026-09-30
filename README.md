# Inkling

A writing app for prose, screenplays and poems. Built as the next step after
*typie*, focused only on writing.

There are two versions in this repo:

| | Where | For |
| --- | --- | --- |
| **Prototype 1** | `index.html` (repo root) | Phones and tablets. A web app you can add to your home screen. |
| **Prototype 2** | [`desktop/`](desktop/README.md) | Mac and Windows. Real files, three-pane layout, PDF export. |

## Prototype 1: phone

Open `index.html` in a browser, or host the repo on GitHub Pages / Netlify
(no build step). On a phone, use **Share → Add to Home Screen**: it opens
full-screen like an app and keeps working offline.

Phone-specific touches: large touch targets, undo/redo buttons (no Ctrl+Z on a
phone keyboard), **‹ Word / Word ›** buttons that select a word at a time and
**⌫ Word** to delete one, a **Done** button to hide the keyboard, and a toolbar
that moves to the top of the screen while you type so the keyboard can't cover it.

Both versions: quotes and brackets close themselves as you type (select text and
type `"` to wrap it), a word goal can be a target or a limit (tap the word count),
and poem lines show a syllable count.

**Onoma: find the word** (both). Named after *onomasiology*, going from an idea to
the word for it. Describe what you mean (“the smell of rain on dry ground”) or put
the cursor in a word for similar words, opposites, rhymes (grouped by syllables),
describing words and related words. Tap a result to put it in. The small button
inside the search box picks where Onoma looks:

- **AI model** (default): Claude, ChatGPT, DeepSeek or OpenRouter, using your own
  API key (Settings → AI models). The AI also sees the sentence the word is in, so
  suggestions fit the context. Keys stay on your device; on desktop they're
  encrypted with the system keychain and the calls are made by the app itself,
  not the page. Inside the Claude preview, which blocks outside sites, Claude
  answers without a key.
- **Online**: the free [Datamuse API](https://www.datamuse.com/api/), no key.
- **Offline**: a bundled word pack (`data/onoma-offline.json`, 3.7 MB compressed)
  built from WordNet 3.1 and the CMU Pronouncing Dictionary. See
  [data/LICENSES.md](data/LICENSES.md). On a phone it downloads the first time you
  pick it. Once loaded, it also makes poem syllable counts exact.

If the chosen source can't answer (no key, no connection), Onoma tries the next one
and says so. To rebuild the pack: `npm install --no-save wordnet-db@3.1.14
cmu-pronouncing-dictionary@3.0.0 && node tools/build-onoma-pack.js`.

**Light styles** (Settings → Light style): Paper (white, the new default),
Sage (the original green-grey) and Ivory (warm).

## What it does

- **Cast bar for fast dialogue.** Add characters (e.g. Jun = `J`, Lena = `L`).
  Tap `J`, type the line, press Enter, and you get `“Where is it,” says Jun.`
  Punctuation is fixed for you (`.` becomes `,`, questions get *asks*).
  - Highlight text you already wrote and tap a character to quote and tag it.
  - **⇄ Back and forth**: Enter hands the next line to the other character.
    Enter on an empty quote stops.
  - Choose the verb (says, asks, whispers…), tag style (`says Jun` /
    `Jun says` / `Jun says, “…”`) and tense in Settings.
- **“ ” quote tool.** Highlight anything and tap it. Tap again to unquote.
  Straight quotes become curly quotes as you type.
- **Prose ⇄ Script ⇄ Poem.** Switching modes can convert the text: tagged
  dialogue becomes `CHARACTER` + dialogue blocks, and back again.
- **Screenplay formatting.** Scene / Action / Character / Paren / Dialogue /
  Transition. Enter picks the next element; `INT.`/`EXT.` lines become scene
  headings; Tab cycles on desktop. Page estimate (≈ 1 page per minute).
  Exports as Fountain.
- **Poem mode.** Line numbers and a live syllable count per line.
- **Templates toolbox.** Haiku, tanka, limerick, sonnet, cinquain, chain poem,
  flash fiction, short story beats, dialogue drill, character sketch, letter,
  journal, screenplay scene, two-hander, cold open, short film.
- Light / dark / match device. Word goals. Copy, download (.md / .txt /
  .fountain), import (.txt / .md / .fountain).
- Saves automatically in the browser (localStorage).

## Turning on Google sign-in + Firebase

1. In the [Firebase console](https://console.firebase.google.com), create a
   project (or reuse one), add a **Web app**, and copy its config object.
2. **Authentication → Sign-in method →** enable **Google**. Under
   **Settings → Authorized domains**, add the domain you host Inkling on.
3. **Firestore Database →** create a database, then set these rules so each
   person can only read and write their own writing:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{db}/documents {
       match /users/{uid}/docs/{docId} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```
4. In `index.html`, replace `var FIREBASE_CONFIG = null;` with your config
   object. The Sign in button in the library drawer then works, and writing
   syncs to `users/{uid}/docs/{docId}` (newest edit wins).

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl` + `'` | Quote the selection |
| `Alt` + `1`–`9` | Speak as cast member 1–9 |
| `Tab` / `Shift+Tab` | Cycle screenplay element |
| `Esc` | Cancel an open line of dialogue |

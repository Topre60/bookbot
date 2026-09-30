# Inkling

A writing app for prose, screenplays and poems. Built as the next step after
*typie*, focused only on writing.

Open `index.html` in a browser, or host the folder on GitHub Pages / Netlify.
No build step.

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

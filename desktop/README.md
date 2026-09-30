# Inkling for Mac and Windows

The desktop version of Inkling. Same editor and dialogue engine as the phone
version, built for a keyboard and a big screen.

## Get the app

Every push that touches `desktop/` runs **Actions → Desktop builds** on GitHub.
Open the latest run and download from **Artifacts**:

- **Inkling-mac**: `.dmg` for Apple silicon (`arm64`) and Intel (`x64`)
- **Inkling-windows**: `-setup.exe` for x64 and ARM

You can also start a build by hand: Actions → Desktop builds → **Run workflow**.

The builds aren't signed with a paid certificate yet, so the first launch needs one extra step:

- **Mac:** drag Inkling to Applications, then right-click it → **Open** → **Open**.
  If macOS says the app is damaged, run `xattr -cr /Applications/Inkling.app` in Terminal once.
- **Windows:** if SmartScreen appears, click **More info → Run anyway**.

## What's different from the phone version

- **Three panes**: library on the left, the page in the middle, and Cast / Outline / Stats on the right.
- **Real files**: each piece is a `.inkling` file in `Documents/Inkling`, saved as you type.
  Move the library into iCloud Drive, Dropbox or OneDrive (Settings → Library folder) and it follows you
  between computers. Deleting moves a file to the Bin / Recycle Bin.
- **Side notes** (bottom right): select lines and press `⌘/Ctrl ⇧ M` to move them out of the page, or `⌘/Ctrl ⇧ J` to copy.
  Right-click works too, and so does the small toolbar that pops up over a selection. **Insert** puts a note back at the cursor,
  and you can type quick notes straight into the box.
- **Word goal or limit** (click the word count): a target to reach, or a maximum like a 100-word drabble. Text past a limit turns red.
- **Typing helpers**: quotes and brackets close themselves (select text and type `"` to wrap it), and `Ctrl`/`⌥` + arrows moves a word at a time.
- **Thesaurus** tab (`⌘/Ctrl ⇧ L`, right-click a word, or the selection toolbar): similar words, opposites, rhymes,
  describing words and definitions from the free Datamuse API. Click a result to swap it in, click another to try that one instead.
- **Light styles**: Paper (default), Sage or Ivory in Settings.
- **Keyboard shortcuts page**: `⌘/Ctrl /`, or Help → Keyboard Shortcuts.
- **Character notes**: each cast member has a notes field and a colour, and shows how many lines they have.
- **Who talks most**: dialogue share per character in Stats, plus session words, reading time, pages and screen time.
- **Outline**: scene list for scripts, section list for prose; click to jump.
- **Focus mode** (`⌘/Ctrl ⇧ F`) dims everything but the paragraph you're on. **Typewriter scrolling** (`⌘/Ctrl ⇧ T`) keeps the line centred.
- **Command palette** (`⌘/Ctrl K`): run any command or jump to any piece.
- **PDF export**: standard screenplay format on US Letter with a title page and page numbers, or manuscript format for prose.
- **Native menus and shortcuts**, including `Alt+1…9` to speak as each cast member.
- Opens `.fountain`, `.txt`, `.md` and `.inkling` files, including by double-click.

## Keyboard

| Keys | Action |
| --- | --- |
| `Alt` + `1`–`9` | Speak as cast member |
| `⌘/Ctrl` + `'` | Quote the selection |
| `⌘/Ctrl` + `1`–`6` | Scene, Action, Character, Paren, Dialogue, Transition |
| `Tab` / `Shift+Tab` | Cycle screenplay element |
| `⌘/Ctrl` + `⇧` + `1`/`2`/`3` | Prose / Script / Poem |
| `⌘/Ctrl` + `K` | Command palette |
| `⌘/Ctrl` + `⇧` + `F` | Focus mode |
| `⌘/Ctrl` + `P` | Export PDF |
| `⌘/Ctrl` + `T` | Templates |
| `⌘/Ctrl` + `\` | Show / hide library |
| `Ctrl`/`⌥` + `←`/`→` | Jump a word (add `Shift` to select word by word) |
| `Ctrl`/`⌥` + `Backspace` | Delete the previous word |
| `⌘/Ctrl` + `⇧` + `M` / `J` | Move / copy the selection to side notes |
| `⌘/Ctrl` + `⇧` + `G` | Word goal or limit |
| `⌘/Ctrl` + `⇧` + `L` | Thesaurus for the word at the cursor |
| `⌘/Ctrl` + `/` | All keyboard shortcuts |

## Develop

```sh
cd desktop
npm install
npm start           # run the app
npm run dist:mac    # build a .dmg (on a Mac)
npm run dist:win    # build an installer (on Windows)
```

`renderer/` also runs in a normal browser (it falls back to browser storage), which is handy for quick UI work.

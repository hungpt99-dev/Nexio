# Shortcuts

Key caps render per OS from one helper (`keyLabel` in `src/main/platform/`;
footer hints use the same mapping).

| Action | Windows | macOS |
|---|---|---|
| Toggle Nexio | `Alt+Space` | `⌥Space` (Option+Space) |
| Stop run | `Ctrl+Alt+Esc` | `⌃⌥Esc` (Ctrl+Option+Esc) |
| Switch Do/Ask | `Tab` | `Tab` |
| Send | `Enter` | `Enter` |
| Queue task ("do this later") | `Ctrl+Enter` | `Cmd+Enter` |
| New line | `Shift+Enter` | `Shift+Enter` |
| Reorder queued task (Tasks view) | `Alt+Up` / `Alt+Down` | `Alt+Up` / `Alt+Down` |
| Stop / close | `Esc` | `Esc` |
| Settings | (footer button) | `Cmd+,` |
| Quit | (tray menu) | `Cmd+Q` |
| Copy / Paste / Select all | `Ctrl+C` / `Ctrl+V` / `Ctrl+A` | `Cmd+C` / `Cmd+V` / `Cmd+A` |
| Paste images/files | `Ctrl+V` with image data on the clipboard | `Cmd+V` with image data on the clipboard |
| Remove attachment | `Backspace` on empty composer or in tray | same |

Notes:

- Do NOT use `Cmd+Space` (Spotlight) or `Cmd+Option+Esc` (Force Quit) on macOS.
- `Option+Space` is also claimed by other launchers/AI apps; if Nexio reports
  a conflict, pick another hotkey in Settings.
- Typing respects IME composition (`isComposing`) identically on both OSes.

## Slash commands for context

Handled before the router, in Ask and Do:

- `/context` — show what Nexio can see right now (all sources + states).
- `/clip` — attach the clipboard (explains why when it can't).
- `/sel` — re-read the selection from the previous app (explains how when
  it is not available: select again and press the hotkey).
- `/screen [window|screen]` — capture the active window (default) or the
  display under the cursor. Explicit only: nothing is captured until you run
  this. The popup hides during capture. Review the thumbnail chip and remove
  it any time before sending; it rides the normal attachment pipeline
  (vision models get the image, others get a switch-model notice).
- Auto-capture toggle (context tray checkbox, per conversation, off by
  default): when on and a turn would otherwise stall asking for context,
  the window captures automatically. Never in incognito.
- `/schedule` — list/add/pause/resume/run/delete scheduled jobs
  (`/schedule help` prints usage).

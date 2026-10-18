# Context awareness

When the hotkey is pressed, Nexio knows what the user was pointing at in the
app they just left — the selected text, selected files in Explorer/Finder,
the open folder, the clipboard, the app, and the browser page — so short
requests like "summarize this", "translate this", "move these to Invoices"
or "what is this file?" work without explaining. One `ContextSnapshot`
(in memory only, main process) feeds the router and the agent.

There is no separate "screen context" feature: no screenshot source exists
yet (state `skipped:no_screen_context`). The page URL/title/text collector
described here is the browser-details collector; a screenshot reference
field is reserved in the snapshot for a future screen feature. Roadmap:
native helper (replace the script collectors), region selection, more apps.

## Concepts

- **Capture** runs at hotkey press, BEFORE Nexio shows: the visibility
  module records the external window (handle/pid, exe/bundle id, title),
  shows the popup with zero focus change (`showInactive` first), then the
  collectors run asynchronously against that recorded window (per-source
  budgets: 400 ms, 800 ms for Finder/Explorer scripts). A slow collector
  never blocks typing; chips fill in as results arrive.
- **Sources**: `selection`, `files`, `folder`, `clipboard`, `page`
  (+ reserved `screenshot`). Each has a state:
  `available | unavailable:<reason> | denied | skipped:<reason>` with
  reasons `no_permission`, `password_field`, `deny_listed_app`,
  `private_window`, `timeout`, `unsupported_app`, `empty`, `elevated_window`,
  `concealed`, `disabled`, `too_large`.
- **Snapshots expire 60 s after capture** (or when Nexio hides) and are
  re-captured on every show. They are never persisted, never logged with
  content, never included in history (history keeps only chip metadata),
  and are deleted on hide, Incognito exit and app quit. Tasks (spawn/queue/
  subtask) copy the snapshot AT CREATION when the user's message used it;
  background tasks never capture on their own; expired snapshots are never
  refreshed silently.

## Resolution order

The router (language-agnostic; one model call, no per-language regex)
receives context METADATA only (sources, kinds, counts, sizes, app name —
never contents) and returns `{ needsContext, deictic, ambiguity }` with
multilingual few-shot examples ("this", "these", "here", "cái này", ...).

Order for "this/these/here/that": selection > selected files > page >
clipboard (only when the user referred to it) > screenshot (offered once a
screen feature exists) > ask. More than one plausible source → one-tap
choice under the input (`Use: [Selected text] [3 files]`). Nothing
available + deictic → "I don't see anything selected. Select it and press
the hotkey again, or attach it." with [Attach a file] [Use clipboard].

## Consent, privacy, retention

- Settings > Context: master switch (default ON after a one-time inline
  explanation with [Continue] [Turn off]), auto-attach mode (Selected text
  and files / Ask each time / Off), per-source toggles, copy-fallback
  toggle (default OFF), shared deny-list editor, macOS permission status
  lines with [Open System Settings].
- Whatever will be sent appears as chips under the input before sending;
  the "You" row shows the same chips after sending. Remote providers show
  the one-line notice ("Sent to <Provider> when you press Enter.");
  localhost shows "Stays on this computer."
- Secrets: the secrets scanner runs over selection/page/clipboard text;
  hits mark the chip ("May contain secrets") and the model is told to ask
  for confirmation before using or sending. Credential-like file names
  trigger the same caution (structure-based, every language).
- All context text is UNTRUSTED DATA: delimited `<user_context>` /
  `<context_*>` blocks, never instructions; cannot grant approvals or
  trigger memory writes, task/subtask creation, web fetches or tool calls
  without the normal approval. A write after reading context shows
  "Requested after reading <selection/clipboard/page/file name>" on the
  approval card.
- Retention: snapshots live in memory only; logs record source names,
  counts, sizes, SHA-256 and timings — never content or full paths (file
  names only when "Save file names in logs" is on). Incognito records
  nothing beyond the live session. Notifications never include content.
- Permissions: no OS prompt except from explicit user action or the
  first-use flow; denial is handled without crashes, repeated prompts or
  error text ("Can't read the selection in this app", chip explains why).

## Tools

- `context_status` — sources and states. `context_get {source, range?}` —
  more of an ATTACHED source (selection chunks, full file list, page
  chunks). Both read-only, askSafe, and they never capture anything new
  (a new capture needs the hotkey or the chip).
- Do mode: file references are targets for the normal tools with the usual
  approval cards showing exact paths ("Move 12 files to <folder>" with an
  expandable list); allowed roots and locks apply. Folder context may
  propose the working folder ("Use <folder> as working folder?"), never
  switched silently.

## Platform notes (verified facts in `docs/platforms.md`)

- Windows: UIA selection varies by app (Office, native apps, Notepad,
  browsers with accessibility on; limited in some Electron apps, games,
  terminals). Elevated (admin) windows read as `unavailable:elevated_window`
  from a non-elevated Nexio. Remote desktop/VMs: skipped with a reason.
- macOS: `AXSelectedText` needs the Accessibility permission (grant to
  Nexio; the app may need a restart); Finder selection needs Automation
  permission for Finder; Terminal, some Electron apps and password fields
  don't expose selection; never prompts repeatedly.
- Both: multi-monitor safe (display with the cursor), full-screen apps work
  from the recorded handle, fast-changing selections use the value at
  capture time, huge selections truncate with a flag and a note, text is
  NFC and never split inside grapheme clusters, RTL and any script safe.

## Troubleshooting

- "Nothing captured": press the hotkey while the other app is focused;
  check Settings > Context toggles and the deny-list; on macOS grant
  Accessibility/Automation when a chip asks.
- Elevated window (Windows): restart Nexio elevated, or copy the text.
- Password fields and password-manager clipboards are never read by design.
- Hotkey-to-show gains one fast OS query (record window, then show);
  collectors fill chips after. If show feels slower, see logs for the
  per-source timings (metadata only).

# Web search

Optional and configurable. Off by default: with no provider configured the
web tools are NOT offered to the model, and the model is told exactly that
(`not_configured` → "Set it up in Settings > Web search").

## Setup (Settings > Web search)

- **Provider picker**: Off | Brave Search (hosted API) | SearXNG (self-hosted, no third-party key).
- **Key / URL field**: Brave keys are stored through the secrets module
  (`web:brave`, same envelope as provider keys); Test uses the unsaved panel
  value and never logs it. SearXNG needs only its base URL.
- **Test button**: runs a real tiny query. `Works: N result(s) in X ms`
  or the exact typed error (`RATE_LIMITED`, `KEY_UNREADABLE`, …).
- **Hints**: region (e.g. `US`), language (e.g. `en`), max results (default 5, max 20).
- **Allow web search in Ask mode** (default ON once a provider is configured).
- **Privacy line**: `Your search query is sent to <provider>.` Queries are
  never logged in full unless **Save search queries** is on (default off).

## Tools

- `web_search {query, count?, recency?}` and `web_fetch {url}` (both `read`
  risk, `askSafe: true`). Results: `{ title, url, snippet, source, date? }`.
- `web_fetch` returns extracted readable text (main-content extraction,
  plain text, no scripts executed, no cookies sent, no JS rendering):
  https/http only, 10 s timeout, 2 MB download cap, 100 KB extracted text
  per page; content types html/text/json/pdf-text only; 5-redirect limit.
- `/search <query>` runs a search directly in Ask and Do and shows results
  with sources.

## SSRF and abuse protection

Blocked: localhost, link-local, private and metadata IP ranges (DNS is
resolved first and re-checked after every redirect), `file:`/`data:`/`ftp:`
and custom schemes, URLs with embedded credentials. No requests to internal
hosts unless the user adds an allow-list entry. No cookies or local
credentials are sent; fixed `Nexio/1.0` user agent. Per-run caps: max 8
searches, 6 fetches. A 5-minute cache applies to identical queries/URLs
only — never to conversation turns.

## Privacy rules

Queries and URLs must not contain file contents, paths, secrets, memory text
or attachment text unless the user explicitly asked for that. A search or
fetch requested right after reading a local file/attachment shows the
one-line inline confirmation (`Send text from <file> to the web?`). Tracking
parameters are stripped from URLs shown to the user. The UI never fetches
favicons or images from the web. Run logs store queries only when
**Save search queries** is on.

## Honest states

Each run passes availability as structured data:
`available | not_configured | disabled_in_mode | error:<code>`.
The model must use web search for anything current/unknown/needing sources,
say exactly why when the state is not available (naming Settings > Web
search), report tool failures with the exact reason, never invent results or
sources, and cite only returned sources with inline `[1]`, `[2]` markers.
`NO_RESULTS` triggers exactly one reformulated query, then an honest answer
listing the queries tried. When web search is off, the answer carries an
inline `Web search is off. Set it up in Settings.` row with [Open Settings].

## Untrusted content

Results are UNTRUSTED data: each page/snippet is wrapped in delimited blocks
with its source URL; instructions inside have no authority and cannot
trigger tools, approvals, memory writes or subtasks. A write/destructive
call following web content shows `Requested after reading <domain>` on the
approval card.

## Answer language

The answer follows the user's latest message alone — earlier turns, memory
text and the UI locale never decide. Search queries may use whatever
language gives the best results; the step row always shows the exact query
sent.

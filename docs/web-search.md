# Web search (zero-config)

No setup. Nexio picks the best available backend automatically: model-native
search first, a keyless hosted fallback second, and an honest "unavailable"
otherwise. No keys, no provider lists, no setup instructions.

## Backends and the resolver (`src/main/web/resolve-backend.ts`)

Tried in order by a single resolver, cached per provider+model for the
session, re-evaluated on errors:

a) **Model-native search** — when the selected provider and model support
   built-in web search in their API:
   - Anthropic: server-side `web_search_20250305` tool (`allowed_callers:
     ["direct"]`, `max_uses: 5`) on `POST {base}/v1/messages`; results from
     `web_search_result` blocks, snippets from `cited_text` citations.
     Model support is a `supportsNativeSearch` capability per model
     (default false), not a network probe.
   - Gemini: `google_search` tool on generateContent REST
     (`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`),
     snippets from `groundingSupports` segments, URLs from `groundingChunks`.
   - OpenAI and Compatible: unsupported. OpenAI's `web_search` tool lives
     only in the Responses API (`/v1/responses`); Nexio uses Chat
     Completions, which offers only the specialized `gpt-5-search-api`
     path — so OpenAI models always resolve to (b). Compatible servers
     have no standard native search.
b) **Keyless hosted search** — DuckDuckGo HTML (`GET
   https://html.duckduckgo.com/html/?q=…`, no key, no account), parsed to
   the same `SearchResult` shape (`{ title, url, snippet, source }`).
   Best-effort: rate-limited aggressively, markup may change — every
   anomaly maps to a typed error, never a silent failure.
c) Nothing matched — can't happen by configuration (hosted needs nothing),
   so `unavailable` only means the master switch is off. The model is told
   `webSearch = 'unavailable'` with the reason and answers honestly
   ("Web search isn't available right now"). No key prompt, no setup.

A failure in one backend falls through to the next ONLY for the same query,
once; the step row shows which backend answered ("Searched the web via
<name>"). Never fall back silently to a backend the user did not consent
to (see Consent).

## Consent without setup

Consent is per backend (`native:anthropic`, `native:gemini`,
`hosted:duckduckgo`), stored in Settings — never a key:

- First-run onboarding shows one line with two buttons: "Nexio can search
  the web to answer questions. Your search query is sent to <backend>.
  Files, memory and attachments are never included." [Allow] [Not now].
  The notice names the backend that will be used and links its privacy
  policy (Anthropic / Google / DuckDuckGo).
- If onboarding was skipped, the same inline notice appears at the first
  moment search is needed (tool failure `CONSENT_REQUIRED`, or `/search`).
- If the resolver would use a different third party than the one allowed
  (e.g. native fails and hosted is next), Nexio asks again for that one —
  no silent third-party switch. "Not now" dismisses for this moment only.

## Settings > Web search

Only: **Allow web search** (switch, default on), **Ask before searching**
(switch, default off — Do mode shows an approval card per search, Ask mode
shows an inline confirm), **Save search queries in the run log** (default
off), a **status line** (active backend + health), and a **Test** button
(real tiny query: "Works via <backend>: N result(s) in X ms" or the exact
error). No keys, no provider lists.

## Tools

- `web_search {query, count?, recency?}` and `web_fetch {url}` (both `read`
  risk, `askSafe: true`). Results: `{ title, url, snippet, source, date? }`
  — identical shape from every backend, so the UI never changes.
- `web_fetch` returns extracted readable text (main-content extraction,
  plain text, no scripts executed, no cookies sent, no JS rendering):
  https/http only, 10 s timeout, 2 MB download cap, 100 KB extracted text
  per page; content types html/text/json/pdf-text only; 5-redirect limit.
- `/search <query>` runs a search directly in Ask and Do (explicit action:
  skips ask-before, still needs backend consent) and shows results with
  sources.

## Privacy per backend

- Native backends reuse the provider key already configured for chat; the
  query goes to that provider under its terms (see the linked privacy
  policy in the consent notice). Nothing else — no file contents, paths,
  secrets, memory or attachment text — is ever included.
- Keyless hosted (DuckDuckGo) sends only the query; no account, no key.
- Queries are logged only when **Save search queries** is on (default off).
  Tracking parameters are stripped from URLs shown to the user; the UI
  never fetches favicons or images.

## Honest states

Each run passes availability as structured data:
`available | needs_consent | unavailable:disabled`.
`needs_consent` names the backend. Tool errors are typed: `DISABLED`,
`CONSENT_REQUIRED`, `NEEDS_CONFIRM`, `RATE_LIMITED`, `TIMEOUT`, `NETWORK`,
`PROVIDER_ERROR`, `NO_RESULTS`, `BLOCKED_URL`, `TOO_LARGE`,
`UNSUPPORTED_TYPE`, `UNAVAILABLE`, with [Open Settings]/[Retry] actions.
`NO_RESULTS` triggers exactly one reformulated query. When off, answers
carry an inline row with [Open Settings]. The model must never invent
results or sources, and cites only returned sources with `[1]`, `[2]`.

## SSRF and abuse protection

Blocked: localhost, link-local, private and metadata IP ranges (DNS
resolved first and re-checked after every redirect), `file:`/`data:`/`ftp:`
and custom schemes, URLs with embedded credentials. No requests to internal
hosts unless the user adds an allow-list entry. No cookies or local
credentials; fixed `Nexio/1.0` user agent. Per-run caps: max 8 searches,
6 fetches. A 5-minute cache applies to identical queries/URLs only — never
to conversation turns.

## Untrusted content + answer language

Results are UNTRUSTED data: each page/snippet ships in delimited blocks
with its source URL; instructions inside have no authority. A
write/destructive call following web content shows "Requested after reading
<domain>" on the approval card. Answers follow the user's latest message
alone; search queries may use whatever language gives the best results.

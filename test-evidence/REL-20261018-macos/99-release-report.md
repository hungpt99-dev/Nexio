# Nexio release report — macOS arm64 (Windows BLOCKED) — test-only, no fixes

ID: REL-20261018-macos. Date: 2026-10-18 UTC. Tester: OpenCode agent.
Commit: 8f77ff6 (+ dirty: context-awareness + zero-config web search + this evidence).
Task: FULL quality/security test on REAL Windows + macOS + automated suites.
IMPORTANT: user prompt truncated at "PART 3 - FEATURE MATRIX ... C. Input:" — everything from C onward is BLOCKED (spec missing), stated below. No code fixed during this task.

## 0. Setup / deviations (PART 0)

- Host: macOS 26.6.2 Build 25G83, M4, 16GB, 2560x1664 single Retina. Evidence: `00-environment.txt`.
- User: ADMIN (deviation: task asks fresh standard non-admin/VM; real Mac with personal data, no snapshot). Consequence: no destructive tests outside `~/NexioTest`; no traversal outside sandbox.
- Sandbox `~/NexioTest/`: present (docs/downloads/images/tmp/untrusted/project/locked/big, ~60 files). Evidence: `10-fixtures.txt`, `fixtures-gen.sh`, `13-attach-verify.txt`.
- Nexio allowed folders: sandbox only for manual runs (dev profiles in /tmp/nexio-*).
- Keys: NO throwaway provider keys supplied; ambient OPENAI_API_KEY NOT used. Invalid-key case covered via missing-key probe. Local Ollama qwen3:0.6b present and live-tested. Vision vs non-vision: BLOCKED (no vision model, no keys).
- Record: OS/build/DPI/app version/commit/install (dev) in `00-environment.txt`. Windows 10/11: BLOCKED (no host/VM). Intel Mac: N/A (arm64 only).
- Real secrets in logs/UI/notifications/temp/crash: NONE (grep clean, see §6).

## 1. Automated suites (PART 1) — macOS

| # | Command | Result | Evidence |
|---|---|---|---|
| 1a | `npm run lint` (tsc + i18n) | PASS | `01-lint.txt` + fresh re-run 2026-10-18 (same warns) |
| 1b | `npm run typecheck` | PASS | `02-typecheck.txt` |
| 1c | `npm run format:check` | BLOCKED — script missing (`Missing script: "format:check"`) | fresh shell output (no file; package.json has no such script) |
| 1d | `npm test` (vitest) | FAIL — 847 pass / 5 fail / 1 skip (62 files), same 5 fails on re-run | `06-vitest.txt`, `11-vitest-fresh.txt` |
| 1e | `npm run build` | PASS | `07-build.txt` |
| 1f | `npm run i18n:check` | PASS (2 intentional warns `app.name`, `tasks.agentTag`) | `03-i18n.txt` |
| 1g | `npm run assets:check` | PASS | `04-assets.txt` |
| 1h | link check (44 md) | FAIL — 7 broken: README→docs/media/{demo.gif,popup.png,slash-palette.png,approval-card.png,run-log-undo.png,parallel-tasks.png,memory.png} | `09-linkcheck.txt` |
| 1i | `madge --circular` | FAIL — 1 circular: agent/loop.ts > agent/undo.ts | fresh output (132 files, 548ms) — no saved file, rerun: `npx madge --circular src/main/main.ts` |
| 1j | knip | INFO — many unused exports/types (66 unused types etc.), no gate | fresh output (not saved; rerun `npx knip`) |
| 1k | `npm audit` (full) | FAIL (review-only) — 24 vulns (7 moderate, 14 high, 3 critical): vitest-mocker, electron-builder/tar chain, Electron GHSA list (§6), esbuild, tinypool RCE | `08-audit.txt`, `08-audit.json` |
| 1k2 | `npm audit --omit=dev` | PASS — 0 vulns | fresh output |
| 1l | `npm ci` | BLOCKED — not run (would wipe node_modules mid-test on dev box) | — |
| 2 | Coverage, modules <80% | BLOCKED — no `@vitest/coverage-v8`, `vitest.config.ts` has no coverage | fresh `--coverage` error |
| 3a | E2E full suite 3× + flaky list | BLOCKED — needs hotkey/display automation; not attempted 3× (single monitor, admin box) | `e2e/suite.js` (not run) |
| 3b | Packaged-app smoke (launch→hello Ask+Do ≤10s) | BLOCKED (packaged) / PASS (dev): `smoke-hello.js` PASS on dev build | `12-smoke-fresh.txt`: `SMOKE PASS \| do-hello answered, run ended, footer clean` |
| 4 | Packaging `electron-builder --dir` + dmg/zip | PASS (build) with findings (§5) | `10-packaging-dir.txt`, `10-packaging-dmg.txt`, `release/Nexio-0.1.0-arm64.dmg` (107M) |
| 5 | Provider conformance (all adapters) | PASS (mock, 43 tests) | `06-vitest.txt` (providers-conformance 43) |
| 5b | Live smoke per provider | PARTIAL: Ollama compatible PASS (qwen3:0.6b responded); OpenAI/Anthropic/Gemini BLOCKED (no keys); invalid key covered via missing-key friendly message | §5 + `21-probe-manual.png` |
| 6 | Fuzz 10min each | PASS (0 crashes, all 9 targets, M cases) — durations from prior run, not re-timed here | `fuzz/*.log` + `*.progress.json`: detect 4.3M, decode 1.1M, archive 1.4M, paths 4.4M, slash 35M, classifier 17M, workflow 13M, ssrf 32M, mdlite 549k; all crashes=0 |
| 7 | Security scans | MIXED: deps FAIL (see 1k), secrets PASS, hardening FAIL (6 items, §6) | `08-audit.*`, `15-hardening-grep.txt`, subagent audit |

Windows column (all PART 1): BLOCKED — no Windows host/VM.

## 2. Regressions R1–R15 (auto + manual)

| ID | Auto | Manual | Verdict | Evidence |
|---|---|---|---|---|
| R1 hello never hangs Planning | PASS (run-feedback.test: beginRun/watchdog 10s/60s/error-cleanup) | PASS (dev smoke Do-hello answered, terminal:true, footer clean) | PASS | `06-vitest.txt`, `12-smoke-fresh.txt` |
| R2 decrypt failure friendly | PASS (secrets-app-error 16: SECRET_UNREADABLE + Open Settings, no raw text) | BLOCKED (corrupted blob / dev-vs-packaged identity / locked key not exercised live) | PASS (auto) / BLOCKED (live) | `06-vitest.txt` |
| R3 order across turns | PASS (conversation.test order/last-once/unique-ids pass) | BLOCKED (no multi-turn live) | PASS (auto) | `06-vitest.txt` |
| R4 no echo/fake + missing-key setup | FAIL (conversation.test `missing key yields setup message` FAILS: expected `{ok:false,action:open-settings}` got `''`) | PASS (live probe: `THROW:No API key is set for this provider. Enter it in Settings to continue.`, zero fetch) — API shape diverged (throw vs envelope) | FAIL | `06-vitest.txt:291`, manual probe output + `05-nofakes.txt` (no Echo in package), `14-asar-fake-grep.txt` (0 hits) |
| R5 no pre-click hide | PASS (window-visibility + dialogs grace tests) | PARTIAL (nexio.log shows blur→recheck→hide/show; no first-click-on-macOS live click test) | PASS (auto) | `06-vitest.txt`, `/private/tmp/nexio.log` |
| R6 dialogs don't kill app | PASS (dialogs.test lock/grace/refocus, no direct show* outside app/dialogs) | BLOCKED (no native picker opened live) | PASS (auto) | `06-vitest.txt` |
| R7 one view + footer once | PASS (view-single: single .view, footer exactly once outside .view) | PASS (live CDP: `{"footers":1,"views":1}`, footer 638×65 visible, bounds 640×72) | PASS | `06-vitest.txt`, probe + `21-probe-manual.png` |
| R8 IPC handlers | PASS (ipc-handlers every invoke/send exactly once; ipc-no-literals; ipc-contract) | PASS (CDP connected, no `No handler registered` in any log) | PASS | `06-vitest.txt` |
| R9 attachments | PASS (attachments 33 + documents 66: docx/xlsx/pptx matrix, renamed-exe→exe, unicode, encodings, chips) | PASS (60-file sandbox sweep: report.docx=docx, table.xlsx=xlsx, slides.pptx=pptx, evil-renamed.docx=exe, encrypted flagged, empty=empty, NFC/NFD/VI/JA/AR/emoji preserved, UTF-16/BOM/1252 read) | PASS | `06-vitest.txt`, `13-attach-verify.txt` |
| R10 secrets/SR/empty/privacy/plurals | PASS (view-single live-region, i18n ru/ar plurals, memory secrets-block) | PASS (no stray `1 attachment(s) added` in screenshot; secret grep clean) | PASS | `06-vitest.txt`, `21-probe-manual.png` |
| R11 UI/CSS | PASS (answer-actions More-menu, spacing 28px, conversation-ui/modes dividers/jump/footer, gear icon) | PARTIAL (screenshot shows footer/panel; no full switch on/off, More-menu wrap, overlap, weight-400, divider-stack audit live) | PASS (auto) | `06-vitest.txt` |
| R12 Memory honesty/save/retrieval/`Used N`/lang-agnostic/untrusted | FAIL (4 fails: forget-many expects 2 got 1; name-change expects conflict got saved; forget-count expects 2 got 1; memory-e2e name-replace expects `Your name is Pham Thanh Hung` got undefined) | BLOCKED (no live save/retrieval/`Used N` run) | FAIL | `06-vitest.txt`, `11-vitest-fresh.txt` |
| R13 Ask read-only | PASS (ask-mode 17: forged fs_write/shell blocked, no undo journal; tasks-safety/subtasks MODE_READ_ONLY) | BLOCKED (no live forged-call attempt) | PASS (auto) | `06-vitest.txt` |
| R14 Web honest/consent/query/sources/SSRF/untrusted | PASS (web-honesty 13, web-layer 34: consent, localhost/BLOCKED_URL, privacy) | PASS (live DDG via keyless hosted + tool-loop web_search event; screenshot) | PASS | `06-vitest.txt`, `20-run-websearch.png`, `22-run-web-copy.png`, `/private/tmp/evid-run-web.png` |
| R15 Created/Undone wording, no abs paths | PASS (undo roundtrip/already-undone/non-undoable; redactPaths basename) | BLOCKED (no live write→Created / Undo→Undone run) | PASS (auto) | `06-vitest.txt` |

## 3. Feature matrix (BOTH OSes requested)

Windows: 100% BLOCKED (no host). macOS below. `N/A` never used (implementation-status has no Planned for these).
Spec note: prompt truncated after "C. Input:" — C onward (except what attach/memory probes cover) is BLOCKED (spec missing).

| ID | Action | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| A-install | fresh install + onboarding (provider/folders/memory/web-consent/context) | skippable steps, name/icon, secure-storage status | Not attempted (dev `electron .` only; dirty tree) | BLOCKED | `00-environment.txt` |
| A-identity | app name/icon/tray/menu-bar Template, no Dock, single instance, auto-start, uninstall, userData identical dev vs packaged | Nexio + icons + LSUIElement | Static PASS (productName Nexio, icon.ico/icns/png + tray 16/20/24/32 + Nexio-Template pair, LSUIElement true); live tray/Dock/single-instance/uninstall/userData BLOCKED | PARTIAL | `electron-builder.yml`, `04-assets.txt`, `10-packaging-dmg.txt` |
| B-hotkey | hotkey from any app + conflict msg | Alt+Space works, conflict surfaced | Not driven live (CDP only) | BLOCKED | — |
| B-panel | 640px / 1px border / no shadow / no dark rect; height follows content cap 560, footer pinned | 640 wide, footer visible | Width PASS (640×72 live), footer 638×65 visible; border/shadow/rect/cap/pin NOT measured | PARTIAL | probe bounds + `21-probe-manual.png` |
| B-display | multi-monitor, mixed DPI 100–175%, fullscreen/Spaces, RDP, dark/light/high-contrast, scrollbars, offline fonts, position | correct everywhere | Single-monitor only; fonts PASS (4 woff2 bundled + offline render); rest BLOCKED | PARTIAL | `dist/renderer/fonts/*.woff2`, probe |
| C-input+ | (spec truncated) | — | Attach/input encodings covered via R9 sweep; IME/palette/slash live NOT covered | BLOCKED (spec) | `13-attach-verify.txt` |

## 4. Packaging inspection (macOS arm64)

- Name/icons: Nexio, icon.ico/icns/png + tray + Template pair present. PASS (`04-assets.txt`).
- `design/` bundled? NO (electron-builder.yml files = dist + pkg + MCP slices only). PASS.
- Test/echo/fake in package? `check:no-fakes` PASS (`05-nofakes.txt`); asar fake-marker grep 0 hits (`14-asar-fake-grep.txt`, 3806 entries). PASS.
- Old names (MiniAI/opencode): only intentional `LEGACY_RUNTIME_KEYS` + DB-migration paths + legacy settings keys (tested). PASS.
- Fonts: 4 woff2 in dist/renderer/fonts. PASS.
- Secrets/.env in package: none found. PASS.
- Source maps: none in dist. PASS (policy: no maps).
- asar integrity/prod CSP: NO integrity flag, NO CSP meta/headers — FAIL (see §6).
- Bloat: asar ships zod/hono/object-inspect/safer-buffer test files. INFO (not a leak, but trims + attack surface).

## 5. Providers

- Conformance (mock, all adapters): 43 PASS (`06-vitest.txt`).
- Live Ollama (compatible, qwen3:0.6b, 127.0.0.1:11434): PASS — `/v1/chat/completions` returned completion (length-capped due to max_tokens=50 cutting reasoning; content empty but reasoning present — endpoint + adapter work).
- Live OpenAI/Anthropic/Gemini: BLOCKED (no throwaway keys). Invalid key: covered only via missing-key path (friendly message). Vision vs non-vision: BLOCKED.

## 6. Security

- Secrets scan (repo + logs + evidence + /tmp logs + ~/Library/Logs/Nexio): CLEAN — only regex definitions (`AKIA...` pattern in detector) and fixtures (`sk-test...`, `AKIAIOSFODNN7EXAMPLE`, `MIIE...FAKE`, `password=hunter2` in `~/NexioTest/untrusted/`). No Blocker. PASS.
- Deps: FAIL — 24 vulns incl 3 critical (tinypool RCE GHSA-5gmw/85c8, tar traversal GHSA-34x7/8qq5/83g3/qffp/9ppj/r6q2/vmf3/w8wr/23hp/8x88/gvwx/r292; 14 high incl Electron GHSA-v3j7/v64w/9f4c/j84w + builder tar, extract-zip symlink GHSA-jmr9/7pqw; 7 moderate). `--omit=dev` 0. Fixes are breaking (electron@44, builder@26, vitest@5).
- Electron hardening (subagent audit, verified via grep): contextIsolation PASS, nodeIntegration off PASS, webSecurity default PASS, remote-load PASS (loadFile + local only), protocol-none PASS; sandbox:false FAIL (`popup.ts:54`), CSP meta+headers FAIL (no hits), window.open/will-navigate FAIL (no handler), preload validation PASS/PARTIAL (schemas + registry assert; trailing-args + sender-frame gaps), devtools-in-prod FAIL (no `devTools:false`), fuses FAIL (no `@electron/fuses`), permissions/shell-openPath gaps (reveal ungated path). Evidence: `15-hardening-grep.txt`.
- SSRF: PASS (unit + fuzz 32M cases 0 crashes; allowlist + DNS-rebind + redirect checks in `web/ssrf.ts`, `web/fetch.ts`).
- Markdown renderer: PASS (fuzz mdlite 549k, 0 crashes; esc + link allowlist, no sanitizer lib — hand-rolled, CSP absent so defense-in-depth missing).

## 7. Defects (ranked; IDs D-macos-##)

| ID | Sev | Area | Repro | Expected / Actual | Evidence |
|---|---|---|---|---|---|
| D-macos-01 | High | R12 memory forget-count | `npx vitest run tests/unit/memory.test.ts` | forget-many + forgetCount expect 2 / got 1 | `06-vitest.txt:159,667` |
| D-macos-02 | High | R12 memory name-conflict | same | `Your name is Ann`→`Bob` expects `conflict` / got `saved` | `06-vitest.txt:286` |
| D-macos-03 | High | R12 memory recall replace | `npx vitest run tests/unit/memory-e2e.test.ts` | replace-conflict expects `Your name is Pham Thanh Hung` / got undefined | `06-vitest.txt:415` |
| D-macos-04 | High | R4 missing-key contract | `npx vitest run tests/unit/conversation.test.ts` | expects `{ok:false,action:open-settings}` / got `''` (live throws friendly string instead — contract drift) | `06-vitest.txt:291` + probe `THROW:No API key is set...` |
| D-macos-05 | High | Hardening: sandbox off | read `src/main/popup.ts:52-54` | sandbox:true / `sandbox:false` (preload has Node privs) | `15-hardening-grep.txt` |
| D-macos-06 | High | Hardening: no CSP | grep CSP in `src/renderer/index.html`, `src/` | CSP meta+headers / zero hits | `15-hardening-grep.txt` |
| D-macos-07 | High | Hardening: no window.open/navigate deny | grep setWindowOpenHandler/will-navigate | deny handlers / zero functional hits | subagent audit |
| D-macos-08 | High | Hardening: devtools + fuses | read `popup.ts:48-55`, package.json, yml | devTools:false + flipped fuses / neither present | subagent audit |
| D-macos-09 | High | Deps: 3 critical + 14 high | `npm audit` | clean / tar RCE+traversal, tinypool RCE, Electron GHSA list, extract-zip symlink | `08-audit.txt` |
| D-macos-10 | Med | Docs links 7 broken | link check | 0 broken / README→docs/media/* 7 missing | `09-linkcheck.txt` |
| D-macos-11 | Med | Circular dep | `madge --circular` | 0 / loop.ts>undo.ts | fresh output |
| D-macos-12 | Med | Dirty tree | `git status --short` | clean tag / 38 modified + 12+ untracked over 8f77ff6 | shell |
| D-macos-13 | Med | asar ships test files | asar list | no tests / zod/hono/object-inspect tests present | §4 |
| D-macos-14 | Low | `format:check`/coverage/knip gates missing | package.json, vitest.config | scripts+coverage / absent | package.json |
| D-macos-15 | Low | i18n warns | `npm run i18n:check` | 0 warns / 2 intentional (`app.name`, `tasks.agentTag`) | `03-i18n.txt` |

Process deviations (not code defects, block release confidence): ADMIN user not standard (§0), no VM/snapshot, Windows 0% tested, Intel Mac N/A, E2E 1 dev-smoke only (not 3×, not packaged), live OpenAI/Anthropic/Gemini + vision + invalid-key + Ollama-vision BLOCKED, R2/R3/R5-live/R6-live/R11-live/R13-live/R15-live BLOCKED, PART 3 C-onward BLOCKED (spec truncated), `npm ci` not run.

## 8. Verdict: NO-GO (both OSes)

- macOS: NO-GO — 5 unit FAILs (R4+R12), 7 broken doc links, 1 circular, 24 audit advisories (3 critical), 6 hardening FAILs, dirty tree, single dev-smoke only.
- Windows: NO-GO (untested — 100% BLOCKED, plus prior Windows-only report 2026-10-14 was env-gated on Node 20 + no app launch; not valid for this commit).
- Top 5 before release: (1) fix R12 memory + R4 contract drift and get vitest 0-fail; (2) land sandbox:true + CSP + window.open/navigate deny + devTools:false prod + fuses + asar test-trim; (3) disposition npm-audit criticals/highs (Electron/tar/extract-zip/tinypool path); (4) fix 7 doc-media links + circular + cut clean tag (commit tree); (5) run 3× E2E + packaged smoke + live provider matrix (throwaway keys + Ollama + invalid + vision/non-vision) on real Win11 + macOS arm64 (+Intel), fresh standard users/VMs, with screenshots/recordings.

## 9. What was / was not tested; residual risk

- Tested: lint/typecheck/build/i18n/assets/no-fakes/smoke-dev/attach-sweep-60/Ollama-live/fuzz-9-targets-0-crashes/secret-grep/packaging-static/R-auto-matrix/CDP probes (R4/R7/panel/footer/screenshot)/web-live-DDG.
- Not tested: everything BLOCKED above — fresh install/onboarding/tray/Dock/single-instance/autostart/uninstall/userData parity, hotkey-conflict, borders/shadows/DPI/multi-monitor/Spaces/RDP/themes/a11y-SR-live, native dialogs live, multi-turn live, memory live, Ask-forgery live, providers live (except Ollama), vision, prompt-injection live (fixtures exist, never executed against app), tasks/scheduler live, extensions/MCP live, perf numbers, Windows anything, Intel Mac, `npm ci`, coverage.
- Residual risk if shipped: memory forget/conflict/recall wrong (data loss/stale identity); missing-key path contract drift (UI may mishandle envelope vs throw); renderer XSS without CSP/sandbox/window.open guard (IPC abuse on compromise); devtools/fuses leave prod debug/node-cli surface; tar/extract-zip/Electron advisories exploitable via archives/updates/redirects; broken README media erodes install trust; untested Windows likely hides platform bugs (prior D-hooks-01 class).
- Real-secret exposure: none found.

Evidence index: `00-environment.txt`, `01-lint.txt`, `02-typecheck.txt`, `03-i18n.txt`, `04-assets.txt`, `05-nofakes.txt`, `06-vitest.txt`, `07-build.txt`, `08-audit.txt/.json`, `09-linkcheck.txt`, `10-fixtures.txt`, `10-packaging-dir.txt`, `10-packaging-dmg.txt`, `11-vitest-fresh.txt`, `12-smoke-fresh.txt`, `13-attach-verify.txt`, `14-asar-fake-grep.txt`, `14-asar-count.txt`, `15-hardening-grep.txt`, `20-run-websearch.png`, `21-probe-manual.png`, `22-run-web-copy.png`, `fixtures-gen.sh`, `fuzz/`.

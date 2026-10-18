import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildRegistry } from '../../src/main/slash/registry';

const root = process.cwd();
const appJs = (): string => fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const html = (): string => fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const css = (): string => fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
const enDict = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, 'src/main/i18n/locales/en.json'), 'utf8'));

describe('context UI: one view, footer in shell, honest chips', () => {
  it('tray order is Selection, Files, Folder, Page, Clipboard; single-line ellipsis chips', () => {
    const src = appJs();
    expect(src).toContain("var CTX_ORDER = ['selection', 'files', 'folder', 'page', 'clipboard'];");
    expect(css()).toMatch(/\.ctx-chip \.ctx-tx \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/s);
  });
  it('chip states Attached/Available/Unavailable reuse selected/accent/muted tokens', () => {
    expect(css()).toContain('.ctx-chip.attached');
    expect(css()).toContain('var(--accent)');
    expect(css()).toContain('.ctx-chip.unavailable');
    expect(css()).toMatch(/\.ctx-choice|\#ctx-choice/);
  });
  it('no new views: only the tray + choice row mounts; footer untouched', () => {
    expect(html()).toContain('id="ctx-choice"');
    expect(html()).not.toContain('id="ctx-view"');
    expect(html()).not.toContain('id="ctx-panel"');
    expect(html()).toContain('id="hints"');
  });
  it('settings section uses shared SwitchRow components; Esc closes preview first', () => {
    expect(html()).toContain('id="set-ctx"');
    expect(html()).toContain('id="set-ctxauto-seg"');
    expect(html()).toContain('id="set-ctxdeny"');
    expect(appJs()).toContain("if (e.key !== 'Escape' || !ctxPreviewFor) return;");
  });
  it('slashes registered for all modes with i18n descriptions', () => {
    const reg = buildRegistry({});
    for (const t of ['/context', '/clip', '/sel']) {
      const found = reg.find((e) => e.trigger === t);
      expect(found?.scope).toBe('all');
    }
    const dict = enDict();
    for (const k of ['slash.context', 'slash.clip', 'slash.sel']) expect(dict[k]).toBeTruthy();
  });
  it('every renderer context string resolves through i18n (no hardcoded user copy)', () => {
    const dict = enDict();
    for (const k of ['context.label', 'context.detachAll', 'context.firstNotice', 'context.use', 'context.attachFile', 'context.useClipboard', 'context.suggestSummarize', 'context.suggestMove', 'context.whatSee', 'context.whatSeeNone', 'context.explainSel', 'context.noSelection']) {
      expect(typeof dict[k], k).toBe('string');
    }
    expect(dict['context.selectedText']).toMatchObject({ one: expect.any(String), other: expect.any(String) });
  });
  it('announcements go through the single sr-only live region', () => {
    expect(appJs()).toContain("document.getElementById('attach-live')");
    expect(html()).toContain('id="attach-live"');
  });
  it('RTL-safe: no direction-dependent chip CSS', () => {
    expect(css()).not.toMatch(/\.ctx-[a-z-]* \{[^}]*float: (left|right)/);
  });
});

describe('web search UI: zero-config consent + backend names', () => {
  const src = () => fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const idx = () => fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  it('settings keeps only Allow / Ask before / Save queries + status + Test (no keys, no provider lists)', () => {
    expect(idx()).toContain('id="set-weballow"');
    expect(idx()).toContain('id="set-webaskbefore"');
    expect(idx()).toContain('id="set-websave"');
    expect(idx()).toContain('id="web-status-line"');
    expect(idx()).toContain('id="btn-test-web"');
    expect(idx()).not.toContain('set-webkey');
    expect(idx()).not.toContain('set-webprov-seg');
    expect(src()).not.toContain('webSetKey');
  });
  it('onboarding has the one-line consent with Allow / Not now', () => {
    expect(src()).toContain('paintObWebConsent');
    expect(src()).toContain('ob-webconsent');
  });
  it('consent + needs-confirm inline rows exist; step row parses "via <backend>"', () => {
    expect(src()).toContain('showWebConsent');
    expect(src()).toContain('NEEDS_CONFIRM');
    expect(src()).toContain('webConsent');
    expect(src()).toContain('Searched the web via');
  });
  it('new web strings resolve through i18n (en + vi parity)', () => {
    const en = JSON.parse(fs.readFileSync(path.join(root, 'src/main/i18n/locales/en.json'), 'utf8'));
    const vi = JSON.parse(fs.readFileSync(path.join(root, 'src/main/i18n/locales/vi.json'), 'utf8'));
    for (const k of ['web.consentLine', 'web.allow', 'web.notNow', 'web.needsConfirm', 'web.searchOnce', 'web.resultsFor', 'web.offMsg', 'web.unavailableMsg', 'web.openSettings', 'web.privacyPolicy']) {
      expect(typeof en[k], k).toBe('string');
      expect(typeof vi[k], k).toBe('string');
    }
  });
});

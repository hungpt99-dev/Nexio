// Shared deny-list: password managers, credential dialogs + user entries.
// Structure-based substring matching on exe/bundle-id/name/title (any
// language — no word lists). Best-effort: absence from the list never
// implies safety (concealed formats + password fields are checked too).

const BUILTINS = [
  '1password', 'bitwarden', 'keepass', 'keepassxc', 'dashlane', 'lastpass',
  'keeper', 'enpass', 'protonpass', 'nordpass', 'keychain access', 'appletvpassword',
  'passwords', 'logmeonce', 'roboform', 'sticky password', 'passbolt',
];

export function isDenyListed(win: { id: string; name: string; windowTitle: string }, extra: string[] = []): boolean {
  const hay = `${win.id}\n${win.name}\n${win.windowTitle}`.toLowerCase();
  for (const p of [...BUILTINS, ...extra]) {
    const pat = String(p || '').trim().toLowerCase();
    if (pat.length >= 2 && hay.includes(pat)) return true;
  }
  return false;
}

/** Built-in patterns shown in Settings (user list is appended). */
export function builtInDenyPatterns(): string[] {
  return [...BUILTINS];
}

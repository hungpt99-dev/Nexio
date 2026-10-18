import type { ActiveWindow, BrowserPageRead, SelectedFilesRead, SelectionRead } from './types';
import { collectJson } from './shared';

const BROWSERS = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'arc.exe', 'vivaldi.exe'];

function ps(signal: AbortSignal, script: string, timeoutMs: number): Promise<unknown> {
  return collectJson('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs, signal);
}

export async function winActiveWindow(signal: AbortSignal, selfPid: number): Promise<ActiveWindow | null> {
  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public class FG {',
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '}"@',
    '$h=[FG]::GetForegroundWindow(); $p=0; [void][FG]::GetWindowThreadProcessId($h,[ref]$p)',
    '$sb=New-Object Text.StringBuilder 512; [void][FG]::GetWindowText($h,$sb,512)',
    'try { $pr=Get-Process -Id $p -ErrorAction Stop; $exe=[IO.Path]::GetFileName($pr.Path).ToLower(); $nm=$pr.ProcessName } catch { $exe=""; $nm="" }',
    '@{ pid=$p; hwnd=[int64]$h; exe=$exe; name=$nm; title=$sb.ToString() } | ConvertTo-Json -Compress',
  ].join('\n');
  let j: { pid?: number; exe?: string; name?: string; title?: string };
  try {
    j = (await ps(signal, script, 3000)) as typeof j;
  } catch {
    return null;
  }
  const pid = Number(j?.pid) || 0;
  if (!pid || pid === selfPid) return null;
  const exe = String(j?.exe || '').toLowerCase();
  if (!exe || /(nexio|electron)\.exe$/.test(exe)) return null;
  return {
    pid,
    id: exe,
    name: String(j?.name || exe.replace(/\.exe$/, '')),
    windowTitle: String(j?.title || ''),
    isBrowser: BROWSERS.includes(exe),
  };
}

export async function winReadSelection(hwnd: number, signal: AbortSignal): Promise<SelectionRead> {
  // Scoped to the recorded window handle: no focus needed, Nexio never reads itself.
  const script = [
    'param([int64]$hwnd)',
    'try {',
    'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
    '$el=[System.Windows.Automation.AutomationElement]::FromHandle((New-Object IntPtr $hwnd))',
    'if ($el -eq $null) { @{ s="empty" } | ConvertTo-Json -Compress; exit }',
    'if ($el.Current.IsPassword) { @{ s="password" } | ConvertTo-Json -Compress; exit }',
    '$found=$null',
    'try { $tp=$el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); $found=$el } catch {',
    '  $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty,$true)',
    '  $found=$el.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cond) }',
    'if ($found -eq $null) { @{ s="unsupported" } | ConvertTo-Json -Compress; exit }',
    'try { $tp=$found.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) } catch { @{ s="unsupported" } | ConvertTo-Json -Compress; exit }',
    '$ranges=$tp.GetSelection(); $t=@($ranges | ForEach-Object { $_.GetText(-1) }) -join "`n"',
    'if ([string]::IsNullOrWhiteSpace($t)) { @{ s="empty" } | ConvertTo-Json -Compress; exit }',
    '@{ s="ok"; t=$t } | ConvertTo-Json -Compress -Depth 2',
    '} catch [System.UnauthorizedAccessException] { @{ s="elevated" } | ConvertTo-Json -Compress }',
    'catch { @{ s="unsupported" } | ConvertTo-Json -Compress }',
  ].join('\n');
  let j: { s?: string; t?: string };
  try {
    j = (await collectJson('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, String(hwnd)], 4000, signal)) as typeof j;
  } catch {
    return { ok: false, skip: signal.aborted ? 'timeout' : 'unsupported_app' };
  }
  if (j?.s === 'ok') return { ok: true, text: String(j.t || '') };
  if (j?.s === 'password') return { ok: false, skip: 'password_field' };
  if (j?.s === 'elevated') return { ok: false, skip: 'elevated_window' };
  if (j?.s === 'empty') return { ok: false, skip: 'empty' };
  return { ok: false, skip: 'unsupported_app' };
}

export async function winReadSelectedFiles(signal: AbortSignal): Promise<SelectedFilesRead> {
  const script = [
    'try {',
    '$sh=New-Object -ComObject Shell.Application',
    '$out=@(); $total=0; $folder=""',
    'foreach ($w in $sh.Windows()) {',
    '  try { $doc=$w.Document; if ($doc -eq $null) { continue }',
    '    $sel=@($doc.SelectedItems() | ForEach-Object { $_.Path }); $total+=$sel.Count',
    '    foreach ($p in $sel) { $out+=@{ p=$p; dir=(Test-Path $p -PathType Container) } }',
    '    if ($sel.Count -gt 0) { try { $folder=$doc.Folder.Self.Path } catch { } }',
    '  } catch { } }',
    'try { $desk=(New-Object -ComObject Shell.Application).NameSpace(0).Self.Path } catch { $desk="" }',
    '@{ files=$out; total=$total; folder=$folder } | ConvertTo-Json -Compress -Depth 3',
    '} catch { @{ files=@(); total=0; folder="" } | ConvertTo-Json -Compress }',
  ].join('\n');
  let j: { files?: Array<{ p?: string; dir?: boolean }>; total?: number; folder?: string };
  try {
    j = (await ps(signal, script, 8000)) as typeof j;
  } catch {
    return { ok: false, skip: 'timeout' };
  }
  const files = (j?.files || []).map((f) => ({ path: String(f?.p || ''), isDir: f?.dir === true })).filter((f) => f.path);
  if (!files.length) return { ok: false, skip: 'empty' };
  const out: SelectedFilesRead = { ok: true, files, total: Number(j?.total) || files.length };
  if (j?.folder) out.folder = String(j.folder);
  return out;
}

export async function winReadBrowserPage(hwnd: number, signal: AbortSignal): Promise<BrowserPageRead> {
  const script = [
    'param([int64]$hwnd)',
    'try {',
    'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
    '$el=[System.Windows.Automation.AutomationElement]::FromHandle((New-Object IntPtr $hwnd))',
    'if ($el -eq $null) { @{ s="empty" } | ConvertTo-Json -Compress; exit }',
    '$names=@("Address and search bar","Search with Google or enter address","Address bar","Awesome Bar","Enter search or web address")',
    '$bar=$null; foreach ($n in $names) {',
    '  $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$n)',
    '  $bar=$el.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$c); if ($bar -ne $null) { break } }',
    'if ($bar -eq $null) { @{ s="unsupported" } | ConvertTo-Json -Compress; exit }',
    'try { $vp=$bar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch { @{ s="unsupported" } | ConvertTo-Json -Compress; exit }',
    '$url=$vp.Current.Value; $title=$el.Current.Name',
    '@{ s="ok"; url=$url; title=$title } | ConvertTo-Json -Compress -Depth 2',
    '} catch [System.UnauthorizedAccessException] { @{ s="elevated" } | ConvertTo-Json -Compress }',
    'catch { @{ s="unsupported" } | ConvertTo-Json -Compress }',
  ].join('\n');
  let j: { s?: string; url?: string; title?: string };
  try {
    j = (await collectJson('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, String(hwnd)], 4000, signal)) as typeof j;
  } catch {
    return { ok: false, skip: 'timeout' };
  }
  if (j?.s === 'ok' && j.url) {
    const url = String(j.url);
    const title = String(j.title || '');
    const priv = /incognito|inprivate|private browsing/i.test(`${title} ${url}`);
    if (priv) return { ok: false, skip: 'private_window' };
    return { ok: true, url, title };
  }
  if (j?.s === 'elevated') return { ok: false, skip: 'elevated_window' };
  return { ok: false, skip: 'unsupported_app' };
}

/** Best-effort clipboard concealment check (presence of exclusion formats). */
export function winClipboardConcealed(formats: string[]): boolean {
  const lower = formats.map((f) => f.toLowerCase());
  if (lower.some((f) => f.includes('excludeclipboardcontentfrommonitorprocessing'))) return true;
  return false;
}

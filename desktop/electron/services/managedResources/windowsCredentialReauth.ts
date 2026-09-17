import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type CredentialRevealAuthorization =
  | { status: 'authorized' }
  | { status: 'cancelled' }
  | { status: 'denied' }
  | { status: 'unavailable' }

export type CredentialRevealAuthorizer = {
  authorize(): Promise<CredentialRevealAuthorization>
}

export type CreateWindowsCredentialRevealAuthorizerOptions = {
  platform?: NodeJS.Platform
  runPrompt?: (script: string) => Promise<string>
}

// The password is collected and validated entirely inside this short-lived
// PowerShell/C# helper. It never crosses stdout/stdin or the Electron IPC
// boundary. KEEP_USERNAME + PASSWORD_ONLY_OK pins the prompt to the current
// Windows identity, while DO_NOT_PERSIST prevents Credential Manager storage.
export const WINDOWS_PASSWORD_REAUTH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class CcHahaCurrentUserPasswordVerifier
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDUI_INFO
    {
        public int cbSize;
        public IntPtr hwndParent;
        public string pszMessageText;
        public string pszCaptionText;
        public IntPtr hbmBanner;
    }

    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint CredUIPromptForCredentialsW(
        ref CREDUI_INFO pUiInfo,
        string pszTargetName,
        IntPtr Reserved,
        uint dwAuthError,
        StringBuilder pszUserName,
        int ulUserNameMaxChars,
        StringBuilder pszPassword,
        int ulPasswordMaxChars,
        ref bool pfSave,
        uint dwFlags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LogonUserW(
        string lpszUsername,
        string lpszDomain,
        StringBuilder lpszPassword,
        int dwLogonType,
        int dwLogonProvider,
        out IntPtr phToken);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    private const uint ERROR_CANCELLED = 1223;
    private const uint CREDUI_FLAGS_DO_NOT_PERSIST = 0x00002;
    private const uint CREDUI_FLAGS_EXCLUDE_CERTIFICATES = 0x00008;
    private const uint CREDUI_FLAGS_ALWAYS_SHOW_UI = 0x00080;
    private const uint CREDUI_FLAGS_PASSWORD_ONLY_OK = 0x00200;
    private const uint CREDUI_FLAGS_GENERIC_CREDENTIALS = 0x40000;
    private const uint CREDUI_FLAGS_KEEP_USERNAME = 0x100000;
    private const int LOGON32_LOGON_NETWORK = 3;
    private const int LOGON32_PROVIDER_DEFAULT = 0;

    public static string Run()
    {
        string identity = WindowsIdentity.GetCurrent().Name;
        if (String.IsNullOrWhiteSpace(identity)) return "UNAVAILABLE";

        var username = new StringBuilder(identity, 513);
        var password = new StringBuilder(256);
        bool save = false;
        IntPtr token = IntPtr.Zero;
        try
        {
            var info = new CREDUI_INFO {
                cbSize = Marshal.SizeOf(typeof(CREDUI_INFO)),
                hwndParent = IntPtr.Zero,
                pszCaptionText = "Claude Code Haha - Windows verification",
                pszMessageText = "Enter the password for the current Windows account to reveal the saved password. Windows Hello PIN is not accepted.",
                hbmBanner = IntPtr.Zero,
            };
            uint flags = CREDUI_FLAGS_DO_NOT_PERSIST
                | CREDUI_FLAGS_EXCLUDE_CERTIFICATES
                | CREDUI_FLAGS_ALWAYS_SHOW_UI
                | CREDUI_FLAGS_PASSWORD_ONLY_OK
                | CREDUI_FLAGS_GENERIC_CREDENTIALS
                | CREDUI_FLAGS_KEEP_USERNAME;
            uint prompt = CredUIPromptForCredentialsW(
                ref info,
                "Claude Code Haha credential reveal",
                IntPtr.Zero,
                0,
                username,
                username.Capacity,
                password,
                password.Capacity,
                ref save,
                flags);
            if (prompt == ERROR_CANCELLED) return "CANCELLED";
            if (prompt != 0) return "UNAVAILABLE";

            string logonUser = identity;
            string logonDomain = null;
            int slash = identity.IndexOf('\\');
            if (slash > 0 && slash < identity.Length - 1)
            {
                logonDomain = identity.Substring(0, slash);
                logonUser = identity.Substring(slash + 1);
            }
            bool ok = LogonUserW(
                logonUser,
                logonDomain,
                password,
                LOGON32_LOGON_NETWORK,
                LOGON32_PROVIDER_DEFAULT,
                out token);
            return ok ? "AUTHORIZED" : "DENIED";
        }
        catch
        {
            return "UNAVAILABLE";
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            for (int i = 0; i < password.Length; i++) password[i] = '\0';
            password.Clear();
            username.Clear();
        }
    }
}
'@
try {
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  [Console]::Out.Write([CcHahaCurrentUserPasswordVerifier]::Run())
} catch {
  [Console]::Out.Write('UNAVAILABLE')
}
`

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  const candidate = systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : ''
  return candidate && existsSync(candidate) ? candidate : 'powershell.exe'
}

function runNativePrompt(script: string): Promise<string> {
  return new Promise(resolve => {
    let settled = false
    let stdout = ''
    const finish = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    // -EncodedCommand is used only for this static helper code. The Windows
    // account password is collected later by CredUI inside the child process,
    // so no password or managed-resource secret ever appears in argv/stdin.
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
    let child
    try {
      child = spawn(
        powershellExecutable(),
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      finish('UNAVAILABLE')
      return
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdout.length < 128) stdout += String(chunk).slice(0, 128 - stdout.length)
    })
    child.once('error', () => finish('UNAVAILABLE'))
    child.once('exit', () => finish(stdout.trim()))
  })
}

export function createWindowsCredentialRevealAuthorizer(
  options: CreateWindowsCredentialRevealAuthorizerOptions = {},
): CredentialRevealAuthorizer {
  const platform = options.platform ?? process.platform
  const runPrompt = options.runPrompt ?? runNativePrompt
  return {
    async authorize(): Promise<CredentialRevealAuthorization> {
      if (platform !== 'win32') return { status: 'unavailable' }
      let result: string
      try {
        result = await runPrompt(WINDOWS_PASSWORD_REAUTH_SCRIPT)
      } catch {
        return { status: 'unavailable' }
      }
      if (result === 'AUTHORIZED') return { status: 'authorized' }
      if (result === 'CANCELLED') return { status: 'cancelled' }
      if (result === 'DENIED') return { status: 'denied' }
      return { status: 'unavailable' }
    },
  }
}

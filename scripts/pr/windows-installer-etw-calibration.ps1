param([switch]$RunCiCalibration, [switch]$DefinitionsOnly, [string]$OutputDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-CiCalibration {
  if (!$RunCiCalibration -or $PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or ![Environment]::Is64BitProcess -or
    $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:GITHUB_REPOSITORY -ne 'NanmiCoder/cc-haha' -or $env:GITHUB_JOB -ne 'windows-installer-checks' -or $env:GITHUB_RUN_ID -notmatch '^\d+$') { throw 'ETW calibration requires the explicit isolated Windows CI scope' }
}
function Safe-Error($Record, [string]$Stage) {
  $e = $Record.Exception; while ($e.InnerException) { $e = $e.InnerException }
  $code = $null; if ($e -is [ComponentModel.Win32Exception]) { $code = $e.NativeErrorCode }
  return @{ stage = $Stage; type = $e.GetType().FullName; hresult = $e.HResult; nativeCode = $code; line = $Record.InvocationInfo.ScriptLineNumber; valuePayload = ($e.Data['valuePayload'] -eq $true); toolExit = $e.Data['toolExit'] }
}
function Get-CiOutputPath([string]$Workspace, [string]$Requested) {
  $workspacePath = [IO.Path]::GetFullPath($Workspace); $allowed = Join-Path $workspacePath 'artifacts/windows-installer'; $outputPath = [IO.Path]::GetFullPath($Requested)
  if (!$outputPath.StartsWith($allowed + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Directory]::Exists($outputPath) -or [IO.File]::Exists($outputPath)) { throw 'Output must be a new bounded CI evidence directory' }
  # Check existing ancestors before creating any missing parent, including junctions.
  for ($p = [IO.Path]::GetDirectoryName($outputPath); $p.Length -ge $workspacePath.Length; $p = [IO.Path]::GetDirectoryName($p)) {
    if (([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)) -and ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Output ancestor is reparse' }
    if ($p -eq $workspacePath) { break }
  }; return $outputPath
}
function Quote-Argument([string]$Value) { return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
function Get-FileSha([string]$File) { $s = [IO.File]::OpenRead($File); $h = [Security.Cryptography.SHA256]::Create(); try { return [BitConverter]::ToString($h.ComputeHash($s)).Replace('-', '').ToLowerInvariant() } finally { $h.Dispose(); $s.Dispose() } }
function Write-NewText([string]$File, [string]$Text) { $s = [IO.File]::Open($File, 'CreateNew', 'Write', 'None'); try { $b = (New-Object Text.UTF8Encoding($false)).GetBytes($Text); $s.Write($b, 0, $b.Length); $s.Flush($true) } finally { $s.Dispose() } }
function Invoke-ReadOnlyTool([string]$Name, [string[]]$Arguments, [string]$Destination) {
  if ($Name -notin @('logman.exe', 'wevtutil.exe')) { throw 'Only fixed read-only metadata tools are allowed' }
  $file = [CcHahaCiEtw]::SystemTool($Name); $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $file; $info.Arguments = ($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $p = New-Object Diagnostics.Process; $p.StartInfo = $info
  try {
    if (!$p.Start()) { throw 'Read-only metadata tool did not start' }
    $stdout = $p.StandardOutput.ReadToEndAsync(); $stderr = $p.StandardError.ReadToEndAsync()
    if (!$p.WaitForExit(15000)) { $p.Kill(); $p.WaitForExit(); throw 'Owned metadata tool timeout' }
    $text = $stdout.Result; if ($p.ExitCode -ne 0 -or $stderr.Result.Length -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($text) -gt 2097152) { $e = New-Object IO.InvalidDataException('Metadata tool failed or exceeded its bound'); $e.Data['toolExit'] = $p.ExitCode; throw $e }
    Write-NewText $Destination $text
    return @{ tool = $Name; exit = $p.ExitCode; bytes = (Get-Item -LiteralPath $Destination).Length }
  } finally { $p.Dispose() }
}
function Complete-OwnedSession($Native, $State) {
  # StartTrace success plus the retained handle and exact GUID/path are required.
  if ($Native.Created) { $State.stopAttempted = $true; $State.stop = $Native.StopOwned() }
  elseif ($Native.StartAttempted) { $State.startReconciliation = $Native.QueryOwn(); $State.cleanup = 'unknown' }
}
function New-CalibrationFacts { return @{ decoder = 'EventLogReader-forward'; events = 0; versions = @{}; fileWrites = 0; registrySets = 0; registryTypes = @(); mapping = 'unknown' } }
function Test-ObjectId([string]$Id) { return $Id -match '^(0x)?[0-9a-fA-F]{1,16}$' -and [Convert]::ToUInt64(($Id -replace '^0x', ''), 16) -ne 0 }
function Add-CalibrationEvent($Facts, $Record, $Data, $Native, $Objects, $Keys) {
  foreach ($field in @('CapturedDataSize', 'PreviousDataCapturedSize')) { if ($Data.ContainsKey($field) -and [uint64]$Data[$field] -ne 0) { $e = New-Object IO.InvalidDataException('Unexpected value payload'); $e.Data['valuePayload'] = $true; throw $e } }
  foreach ($field in @('CapturedData', 'PreviousData')) { if ($Data.ContainsKey($field) -and ![String]::IsNullOrWhiteSpace($Data[$field])) { $e = New-Object IO.InvalidDataException('Unexpected value payload'); $e.Data['valuePayload'] = $true; throw $e } }
  $provider = $Record.ProviderId.ToString(); $Facts.versions[$provider + '/' + $Record.Id + '/' + $Record.Version] = 1
  if ($provider -eq 'edd08927-9cc4-4e65-b970-c2560fb5c289') {
    if ($Record.Id -eq 12 -and $Data.ContainsKey('FileName') -and $Data.FileName -eq $Native.FileNtPath -and $Data.ContainsKey('FileObject') -and (Test-ObjectId $Data.FileObject)) { $Objects[$Data.FileObject] = $true }
    if ($Record.Id -eq 16 -and $Data.ContainsKey('FileObject') -and $Objects.ContainsKey($Data.FileObject) -and
      $Data.ContainsKey('IssuingThreadId') -and [uint32]$Data.IssuingThreadId -eq $Native.ThreadId) { $Facts.fileWrites++ }
  }
  if ($provider -eq '70eb4f03-c1de-4f73-a051-33d13d5413bd') {
    $name = ''; if ($Data.ContainsKey('KeyName')) { $name = $Data.KeyName }
    if (!$name -and $Data.ContainsKey('BaseName') -and $Data.ContainsKey('RelativeName')) { $name = $Data.BaseName.TrimEnd('\') + '\' + $Data.RelativeName }
    if ($name -eq $Native.KeyNtPath -and $Data.ContainsKey('KeyObject') -and (Test-ObjectId $Data.KeyObject)) { $Keys[$Data.KeyObject] = $true }
    if ($Record.Id -eq 5 -and $Data.ContainsKey('KeyObject') -and $Keys.ContainsKey($Data.KeyObject) -and $Data.ContainsKey('ValueName') -and $Data.ValueName -eq 'type-canary' -and $Record.ProcessId -eq $PID -and $Data.ContainsKey('Status') -and [uint32]$Data.Status -eq 0 -and $Data.ContainsKey('Type') -and $Data.ContainsKey('DataSize') -and [uint64]$Data.DataSize -eq 0) { $Facts.registrySets++; $Facts.registryTypes += [uint32]$Data.Type }
  }
  if ($Facts.fileWrites -ge 3 -and ($Facts.registryTypes -join ',') -eq '0,3,0') { $Facts.mapping = 'canary-path-object-thread-observed' }
}
function Test-CalibrationEvidence($Header, $Stop, $Facts, [bool]$Restored, [bool]$Before, [bool]$After) {
  return $Header.EndTime -gt $Header.StartTime -and $Header.StartTime -gt 0 -and $Header.Frequency -gt 0 -and $Header.Written -gt 0 -and $Header.EventsLost -eq 0 -and $Header.BuffersLost -eq 0 -and
    $Stop.eventsLost -eq 0 -and $Stop.logBuffersLost -eq 0 -and $Stop.realTimeBuffersLost -eq 0 -and $Restored -and $Before -and $After -and $Facts.mapping -eq 'canary-path-object-thread-observed'
}
function Get-CalibrationFacts([string]$Etl, [string]$XmlFile, $Native) {
  $facts = New-CalibrationFacts
  $query = New-Object Diagnostics.Eventing.Reader.EventLogQuery($Etl, [Diagnostics.Eventing.Reader.PathType]::FilePath, '*')
  $reader = $null; $stream = $null
  $objects = @{}; $keys = @{}; $utf8 = New-Object Text.UTF8Encoding($false)
  try {
    $reader = New-Object Diagnostics.Eventing.Reader.EventLogReader($query); $stream = [IO.File]::Open($XmlFile, 'CreateNew', 'Write', 'None')
    $bytes = $utf8.GetBytes('<Events>'); $stream.Write($bytes, 0, $bytes.Length)
    while ($null -ne ($record = $reader.ReadEvent())) {
      try {
        if (++$facts.events -gt 100000) { throw 'ETW event budget' }
        $text = $record.ToXml(); if ($text.Length -gt 65536 -or $stream.Length + $utf8.GetByteCount($text) -gt 33554432) { throw 'ETW XML budget' }
        $doc = New-Object Xml.XmlDocument; $doc.XmlResolver = $null; $doc.LoadXml($text); $data = @{}
        foreach ($d in $doc.SelectNodes('//*[local-name()="EventData"]/*[local-name()="Data"]')) {
          $key = $d.GetAttribute('Name'); if (!$key -or $data.ContainsKey($key)) { throw 'Ambiguous ETW fields' }; $data[$key] = $d.InnerText
        }
        Add-CalibrationEvent $facts $record $data $Native $objects $keys
        $bytes = $utf8.GetBytes($text); $stream.Write($bytes, 0, $bytes.Length)
      } finally { $record.Dispose() }
    }
    $bytes = $utf8.GetBytes('</Events>'); $stream.Write($bytes, 0, $bytes.Length)
    return $facts
  } finally { if ($null -ne $stream) { $stream.Dispose() }; if ($null -ne $reader) { $reader.Dispose() } }
}
function Initialize-EtwNative {
  Add-Type -TypeDefinition @'
using System; using System.IO; using System.Diagnostics; using System.Runtime.InteropServices; using System.ComponentModel; using System.Text; using Microsoft.Win32; using Microsoft.Win32.SafeHandles;
public sealed class CcHahaCiEtw {
  [StructLayout(LayoutKind.Sequential)] public struct Wnode { public uint Size, Provider; public ulong Context; public long Time; public Guid Guid; public uint Clock, Flags; }
  [StructLayout(LayoutKind.Sequential)] public struct Props { public Wnode W; public uint Buffer, Min, Max, MaxFile, Mode, Flush, Enable, Age, Number, Free, Lost, Written, LogLost, RealLost; public IntPtr Thread; public uint FileOffset, NameOffset; }
  [StructLayout(LayoutKind.Sequential)] struct Filter { public ulong Ptr; public uint Size, Type; }
  [StructLayout(LayoutKind.Sequential)] struct EnableParams { public uint Version, Property, Flags; public Guid Source; public IntPtr Filter; public uint Count; }
  [StructLayout(LayoutKind.Sequential)] public struct Header { public uint Buffer, Version, ProviderVersion, CpuCount; public long EndTime; public uint Timer, MaxFile, Mode, Written, StartBuffers, PointerSize, EventsLost, CpuSpeed; public IntPtr Logger, File; [MarshalAs(UnmanagedType.ByValArray,SizeConst=172)] public byte[] Zone; public long Boot, Frequency, StartTime; public uint Flags, BuffersLost; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct LogFile { [MarshalAs(UnmanagedType.LPWStr)] public string File, Logger; public long Time; public uint Read, Mode; [MarshalAs(UnmanagedType.ByValArray,SizeConst=88)] public byte[] Current; public Header Header; public IntPtr BufferCallback; public uint BufferSize, Filled, Lost; public IntPtr EventCallback; public uint Kernel; public IntPtr Context; }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint StartTraceW(out ulong handle,string name,IntPtr properties);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint ControlTraceW(ulong handle,string name,IntPtr properties,uint control);
  [DllImport("advapi32.dll")] static extern uint EnableTraceEx2(ulong handle,ref Guid provider,uint control,byte level,ulong any,ulong all,uint timeout,ref EnableParams parameters);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern ulong OpenTraceW(ref LogFile file);
  [DllImport("advapi32.dll")] static extern uint CloseTrace(ulong handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string name,IntPtr security);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder name,uint length,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetWindowsDirectoryW(StringBuilder path,uint length);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegCreateKeyExW(IntPtr root,string path,uint reserved,string cls,uint options,uint access,IntPtr security,out IntPtr key,out uint disposition);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegOpenKeyExW(IntPtr root,string path,uint options,uint access,out IntPtr key);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegSetValueExW(IntPtr key,string name,uint reserved,uint type,IntPtr data,uint bytes);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegQueryValueExW(IntPtr key,string name,IntPtr reserved,out uint type,IntPtr data,ref uint bytes);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegDeleteValueW(IntPtr key,string name);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegDeleteKeyW(IntPtr key,string name);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  static void Check(uint code) { if(code!=0) throw new Win32Exception((int)code); }
  static void Win(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  readonly string name, file, nonce; readonly Guid guid; ulong handle; IntPtr job, parent, key; bool keyCreated, stopAttempted; FileStream canary;
  public bool Created, StartAttempted, JobBound, Restored; public uint PriorQueryCode=UInt32.MaxValue; public uint ThreadId; public string FileNtPath, KeyNtPath; public long BeforeQpc, AfterQpc; public string BeforeUtc, AfterUtc;
  public CcHahaCiEtw(string session,string trace,string id) { name=session; file=trace; nonce=id; guid=Guid.Parse(id); }
  public static void NewDirectory(string path) { Win(CreateDirectoryW(path,IntPtr.Zero)); }
  public static string SystemTool(string name) { if(name!="logman.exe" && name!="wevtutil.exe") throw new InvalidOperationException("Fixed metadata tool required"); StringBuilder w=new StringBuilder(32768); uint n=GetWindowsDirectoryW(w,(uint)w.Capacity); Win(n>0 && n<w.Capacity); string p=Path.Combine(w.ToString(),"System32",name); if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("Reparse metadata tool"); return p; }
  public static bool SameSession(Props p,ulong retained,Guid id,string actual,string expected) { return retained!=0 && p.W.Context==retained && p.W.Guid==id && String.Equals(actual,expected,StringComparison.OrdinalIgnoreCase); }
  IntPtr Properties() { int size=Marshal.SizeOf(typeof(Props)); byte[] path=Encoding.Unicode.GetBytes(file+"\0"), session=Encoding.Unicode.GetBytes(name+"\0"); IntPtr p=Marshal.AllocHGlobal(size+path.Length+session.Length); Marshal.Copy(new byte[size+path.Length+session.Length],0,p,size+path.Length+session.Length); Props v=new Props { W=new Wnode { Size=(uint)(size+path.Length+session.Length), Guid=guid, Clock=1, Flags=0x20000 }, Buffer=64, Min=16, Max=64, MaxFile=16, Mode=1, Flush=1, FileOffset=(uint)size, NameOffset=(uint)(size+path.Length) }; Marshal.StructureToPtr(v,p,false); Marshal.Copy(path,0,IntPtr.Add(p,size),path.Length); Marshal.Copy(session,0,IntPtr.Add(p,size+path.Length),session.Length); return p; }
  public object QueryOwn() { IntPtr p=Properties(); try { uint code=ControlTraceW(handle,name,p,0); Props v=(Props)Marshal.PtrToStructure(p,typeof(Props)); return new { code=code, sessionGuid=v.W.Guid, traceHandle=v.W.Context, eventsLost=v.Lost, logBuffersLost=v.LogLost, realTimeBuffersLost=v.RealLost }; } finally { Marshal.FreeHGlobal(p); } }
  public void Start() {
    IntPtr p=Properties(); try { PriorQueryCode=ControlTraceW(0,name,p,0); if(PriorQueryCode!=4201) throw new Win32Exception((int)(PriorQueryCode==0?183:PriorQueryCode)); } finally { Marshal.FreeHGlobal(p); }
    p=Properties(); try { StartAttempted=true; Check(StartTraceW(out handle,name,p)); Created=true; if(handle==0) throw new InvalidOperationException("Missing retained ETW handle"); } finally { Marshal.FreeHGlobal(p); }
    Enable(new Guid("edd08927-9cc4-4e65-b970-c2560fb5c289"),0x1fff); Enable(new Guid("70eb4f03-c1de-4f73-a051-33d13d5413bd"),0x3101); RequireOwn();
  }
  void RequireOwn() { IntPtr p=Properties(); try { Check(ControlTraceW(handle,name,p,0)); Props v=(Props)Marshal.PtrToStructure(p,typeof(Props)); if(!SameSession(v,handle,guid,Marshal.PtrToStringUni(IntPtr.Add(p,(int)v.FileOffset)),file)) throw new InvalidOperationException("ETW identity changed"); } finally { Marshal.FreeHGlobal(p); } }
  void Enable(Guid provider,ulong keywords) { IntPtr pid=Marshal.AllocHGlobal(4), f=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Filter))); try { Marshal.WriteInt32(pid,Process.GetCurrentProcess().Id); Marshal.StructureToPtr(new Filter { Ptr=(ulong)pid.ToInt64(), Size=4, Type=0x80000004 },f,false); EnableParams e=new EnableParams { Version=2, Source=guid, Filter=f, Count=1 }; Check(EnableTraceEx2(handle,ref provider,1,5,keywords,0,5000,ref e)); } finally { Marshal.FreeHGlobal(f); Marshal.FreeHGlobal(pid); } }
  public object StopOwned() { if(!Created || stopAttempted) throw new InvalidOperationException("No owned unconsumed stop"); IntPtr p=Properties(); try { Check(ControlTraceW(handle,name,p,0)); Props v=(Props)Marshal.PtrToStructure(p,typeof(Props)); string path=Marshal.PtrToStringUni(IntPtr.Add(p,(int)v.FileOffset)); if(!SameSession(v,handle,guid,path,file)) throw new InvalidOperationException("ETW identity changed"); stopAttempted=true; Check(ControlTraceW(handle,name,p,1)); v=(Props)Marshal.PtrToStructure(p,typeof(Props)); Created=false; return new { eventsLost=v.Lost, logBuffersLost=v.LogLost, realTimeBuffersLost=v.RealLost, buffersWritten=v.Written }; } finally { Marshal.FreeHGlobal(p); } }
  public static Header ReadHeader(string path) { if(Marshal.SizeOf(typeof(Header))!=280 || Marshal.SizeOf(typeof(LogFile))!=448) throw new InvalidOperationException("ETW x64 ABI mismatch"); LogFile f=new LogFile { File=path, Mode=0x10000000, Current=new byte[88], Header=new Header { Zone=new byte[172] } }; ulong h=OpenTraceW(ref f); if(h==UInt64.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error()); try { if(f.Header.PointerSize!=8) throw new InvalidOperationException("ETL pointer width mismatch"); return f.Header; } finally { Check(CloseTrace(h)); } }
  public void BindJob() { job=CreateJobObjectW(IntPtr.Zero,null); Win(job!=IntPtr.Zero); Win(AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle)); JobBound=InOwnedJob(); }
  public bool InOwnedJob() { bool b; Win(IsProcessInJob(Process.GetCurrentProcess().Handle,job,out b)); return b; }
  public void Canary(string path,string sid) { ThreadId=GetCurrentThreadId(); BeforeUtc=DateTime.UtcNow.ToString("o"); BeforeQpc=Stopwatch.GetTimestamp(); canary=new FileStream(path,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read|FileShare.Write|FileShare.Delete,4096,FileOptions.DeleteOnClose); StringBuilder nt=new StringBuilder(32768); uint n=GetFinalPathNameByHandleW(canary.SafeFileHandle.DangerousGetHandle(),nt,(uint)nt.Capacity,2); Win(n>0 && n<nt.Capacity); FileNtPath=nt.ToString(); canary.WriteByte(0); canary.Flush(true); canary.Position=0; canary.WriteByte(1); canary.Flush(true); canary.Position=0; canary.WriteByte(0); canary.Flush(true); canary.Position=0; Restored=canary.Length==1 && canary.ReadByte()==0;
    uint disposition; Check((uint)RegOpenKeyExW(new IntPtr(unchecked((int)0x80000001)),"Software",0,0x2001d,out parent)); Check((uint)RegCreateKeyExW(parent,"CcHaha-CI-Fixture-"+nonce,0,null,1,0x2001f,IntPtr.Zero,out key,out disposition)); keyCreated=disposition==1; if(!keyCreated) throw new InvalidOperationException("Canary key already existed"); KeyNtPath=@"\REGISTRY\USER\"+sid+@"\Software\CcHaha-CI-Fixture-"+nonce; Check((uint)RegSetValueExW(key,"type-canary",0,0,IntPtr.Zero,0)); Check((uint)RegSetValueExW(key,"type-canary",0,3,IntPtr.Zero,0)); Check((uint)RegSetValueExW(key,"type-canary",0,0,IntPtr.Zero,0)); uint type, bytes=0; Check((uint)RegQueryValueExW(key,"type-canary",IntPtr.Zero,out type,IntPtr.Zero,ref bytes)); Restored=Restored && type==0 && bytes==0; AfterQpc=Stopwatch.GetTimestamp(); AfterUtc=DateTime.UtcNow.ToString("o"); }
  public void CleanRegistry() {
    if(keyCreated) {
      using(RegistryKey k=RegistryKey.FromHandle(new SafeRegistryHandle(key,false))) {
        string[] names=k.GetValueNames(); if(k.SubKeyCount!=0 || names.Length>1 || (names.Length==1 && names[0]!="type-canary")) throw new InvalidOperationException("Canary key contents changed");
        if(names.Length==1) { uint type, bytes=0; Check((uint)RegQueryValueExW(key,"type-canary",IntPtr.Zero,out type,IntPtr.Zero,ref bytes)); if(type!=0 || bytes!=0) throw new InvalidOperationException("Canary key changed"); Check((uint)RegDeleteValueW(key,"type-canary")); }
      }
      Check((uint)RegCloseKey(key)); key=IntPtr.Zero; Check((uint)RegDeleteKeyW(parent,"CcHaha-CI-Fixture-"+nonce)); keyCreated=false;
    } else if(key!=IntPtr.Zero) { Check((uint)RegCloseKey(key)); key=IntPtr.Zero; }
    if(parent!=IntPtr.Zero) { Check((uint)RegCloseKey(parent)); parent=IntPtr.Zero; }
  }
  public void CloseFile() { if(canary!=null) { canary.Dispose(); canary=null; } }
  public void CloseJob() { if(job!=IntPtr.Zero) { Win(CloseHandle(job)); job=IntPtr.Zero; } }
}
'@
}
if ($DefinitionsOnly) { if ($RunCiCalibration) { throw 'Definitions and execution are exclusive' }; return }
Assert-CiCalibration
$stage = 'output-preflight'; $native = $null; $ownedOutput = $false
$result = @{ version = 1; status = 'not_proven'; F1 = 'not_proven'; accounts = 0; profiles = 0; productPe = 0; cleanup = 'unknown'; error = $null; cleanupErrors = @() }
$result.cleanupMeaning = 'Owned ETW session and canary resources only; collector job membership ends at its natural process exit'
try {
  $output = Get-CiOutputPath $env:GITHUB_WORKSPACE $OutputDirectory
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
  $output = Get-CiOutputPath $env:GITHUB_WORKSPACE $output
  Initialize-EtwNative; [CcHahaCiEtw]::NewDirectory($output); $ownedOutput = $true
  $id = [Guid]::NewGuid().ToString('D'); $session = 'CcHaha1879-calibration-' + $id; $etl = Join-Path $output 'trace.etl'
  $result.session = $session; $result.nonce = $id; $result.pid = $PID; $result.creationUtc = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o')
  $result.os = [Environment]::OSVersion.VersionString; $result.engine = $PSVersionTable.PSVersion.ToString(); $result.tools = @(); $result.ordering = 'calibration-facts-only;F1-not-admitted'; $result.sourceSha256 = Get-FileSha $PSCommandPath
  $result.pidFilter = $PID; $result.registryPayloadBytes = 0; $result.keywords = @{ file = '0x1fff'; registry = '0x3101' }
  $stage = 'provider-metadata'
  foreach ($provider in @('Microsoft-Windows-Kernel-File', 'Microsoft-Windows-Kernel-Registry')) {
    $result.tools += Invoke-ReadOnlyTool 'wevtutil.exe' @('gp', $provider, '/ge:true', '/f:xml') (Join-Path $output ($provider + '.metadata.xml'))
    $result.tools += Invoke-ReadOnlyTool 'logman.exe' @('query', 'providers', $provider) (Join-Path $output ($provider + '.keywords.txt'))
  }
  $native = New-Object CcHahaCiEtw($session, $etl, $id); $stage = 'owned-job'; $native.BindJob(); $result.ownedJobBefore = $native.JobBound
  $stage = 'start-filtered-session'; $native.Start(); $result.armed = $native.QueryOwn()
  $stage = 'zero-payload-transient-canaries'; $native.Canary((Join-Path $output ('canary-' + $id + '.bin')), [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  $result.operations = @{ beforeUtc = $native.BeforeUtc; afterUtc = $native.AfterUtc; beforeQpc = $native.BeforeQpc; afterQpc = $native.AfterQpc; threadId = $native.ThreadId; restored = $native.Restored; registryBytes = 0 }
  $result.ownedJobAfter = $native.InOwnedJob(); $stage = 'stop-owned-session'; Complete-OwnedSession $native $result
  $stage = 'finalized-etl-header'; if ((Get-Item -LiteralPath $etl).Length -ge 16777216) { throw 'ETL size budget' }
  $h = [CcHahaCiEtw]::ReadHeader($etl); $result.header = @{ endTime = $h.EndTime; startTime = $h.StartTime; frequency = $h.Frequency; eventsLost = $h.EventsLost; buffersLost = $h.BuffersLost; buffersWritten = $h.Written; pointerSize = $h.PointerSize }
  $stage = 'decode-and-map-canaries'; $result.facts = Get-CalibrationFacts $etl (Join-Path $output 'events.xml') $native
  if (Test-CalibrationEvidence $h $result.stop $result.facts $native.Restored $result.ownedJobBefore $result.ownedJobAfter) { $result.status = 'calibrationobserved' }
} catch { $result.error = Safe-Error $_ $stage }
finally {
  if ($null -ne $native) {
    $result.priorQueryCode = $native.PriorQueryCode
    if (!$result.ContainsKey('operations')) { $result.operations = @{ beforeUtc = $native.BeforeUtc; afterUtc = $native.AfterUtc; beforeQpc = $native.BeforeQpc; afterQpc = $native.AfterQpc; threadId = $native.ThreadId; restored = $native.Restored; registryBytes = 0 } }
    if ($native.Created -and !$result.ContainsKey('stopAttempted')) { try { Complete-OwnedSession $native $result } catch { $result.cleanupErrors += Safe-Error $_ 'cleanup-session' } }
    elseif ($native.StartAttempted -and !$result.ContainsKey('armed')) { try { $result.startReconciliation = $native.QueryOwn() } catch { $result.cleanupErrors += Safe-Error $_ 'reconcile-start' } }
    foreach ($method in @('CleanRegistry', 'CloseFile', 'CloseJob')) { try { $native.$method() } catch { $result.cleanupErrors += Safe-Error $_ $method } }
    if (!$native.Created -and $result.cleanupErrors.Count -eq 0 -and (!$native.StartAttempted -or $result.ContainsKey('stop'))) { $result.cleanup = 'complete' }
  }
  $result.sessionMayBeActive = $null -ne $native -and ($native.Created -or ($native.StartAttempted -and !$result.ContainsKey('stop')))
  if ($result.cleanup -ne 'complete' -or $null -ne $result.error) { $result.status = 'not_proven' }
  if ($ownedOutput) {
    # A provider violating the zero-payload contract cannot leave value bytes in artifacts.
    try {
      if ($null -ne $result.error -and $result.error.valuePayload) { $result.discarded = @(); foreach ($name in @('trace.etl', 'events.xml')) { $file = Join-Path $output $name; if ([IO.File]::Exists($file) -and ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $result.discarded += @{ name = $name; sha256 = Get-FileSha $file }; [IO.File]::Delete($file) } }; $result.payloadArtifacts = 'discarded;metadata-and-original-error-retained' }
      $result.files = @(Get-ChildItem -LiteralPath $output -File | ForEach-Object { if ($_.Length -gt 33554440 -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected artifact entry' }; @{ name = $_.Name; bytes = $_.Length; sha256 = Get-FileSha $_.FullName } })
      Write-NewText (Join-Path $output 'result.json') ($result | ConvertTo-Json -Depth 10)
    } catch { $result.cleanupErrors += Safe-Error $_ 'write-evidence'; $result.status = 'not_proven'; Write-Output ($result | ConvertTo-Json -Depth 10 -Compress) }
  }
}
if (!$ownedOutput) { Write-Output ($result | ConvertTo-Json -Depth 6 -Compress) }
Write-Output ('ETW calibration: ' + $result.status + '; F1=not_proven; cleanup=' + $result.cleanup)
if ($result.status -ne 'calibrationobserved') { exit 2 }

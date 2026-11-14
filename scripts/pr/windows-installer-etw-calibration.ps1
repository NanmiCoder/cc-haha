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
  return @{ stage = $Stage; type = $e.GetType().FullName; hresult = $e.HResult; nativeCode = $code; line = $Record.InvocationInfo.ScriptLineNumber; valuePayload = ($e.Data['valuePayload'] -eq $true); eventSchema = $e.Data['eventSchema']; unvalidatedFields = $e.Data['unvalidatedFields']; toolExit = $e.Data['toolExit'] }
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
function New-FreshCalibrationFacts {
  return @{ decoder = 'fresh-child-observed-schema'; events = 0; versions = @{}; ownProcessEvents = 0; otherProcessEvents = 0; epochRejected = 0; threadRejected = 0;
    fileCreates = 0; fileWrites = 0; fileCloses = 0; keyCloses = 0; registrySets = 0; registryTypes = @(); absoluteAnchors = 0; lifetimeGaps = 0;
    fileLifecycle = 'not_proven'; registryView = 'not_proven'; mapping = 'not_proven'; F1 = 'not_proven'; payloadScanComplete = $true; unknownRecords = 0; unknownShapes = @{}; unknownSamples = @(); xmlMeaning = 'validated-records-only;not-complete-stream' }
}
function Get-ObjectToken([string]$Value) { if (Test-ObjectId $Value) { return [Convert]::ToUInt64(($Value -replace '^0x', ''), 16).ToString('x16') }; return '' }
function Read-EventUnsigned([string]$Value) {
  [uint64]$number = 0
  if ($Value -cmatch '^(0|[1-9][0-9]{0,19})$' -and [uint64]::TryParse($Value, [ref]$number)) { return $number }
  if ($Value -cmatch '^0x[0-9a-fA-F]{1,16}$') { return [Convert]::ToUInt64($Value.Substring(2), 16) }
  return $null
}
function Assert-MetadataFields([string]$Provider, $Data) {
  $allowed = @()
  if ($Provider -eq 'edd08927-9cc4-4e65-b970-c2560fb5c289') { $allowed = @('Irp', 'FileObject', 'FileKey', 'FileName', 'IssuingThreadId', 'ByteOffset', 'IOSize', 'IOFlags', 'ExtraFlags', 'CreateOptions', 'CreateAttributes', 'ShareAccess', 'ExtraInformation', 'InfoClass', 'Status', 'Length', 'FileIndex', 'FileNameLength', 'FileAttributes') }
  elseif ($Provider -eq '70eb4f03-c1de-4f73-a051-33d13d5413bd') { $allowed = @('BaseName', 'BaseObject', 'KeyName', 'KeyObject', 'RelativeName', 'Status', 'Disposition', 'Type', 'DataSize', 'ValueName', 'CapturedData', 'CapturedDataSize', 'PreviousData', 'PreviousDataCapturedSize', 'PreviousDataSize', 'PreviousDataType') }
  elseif ($Provider -ne '68fdd900-4a3e-11d1-84f4-0000f80464e3') { $e = New-Object IO.InvalidDataException('Unknown provider body'); $e.Data['unvalidatedFields'] = @('unknown-provider'); throw $e }
  $unknown = @($Data.Keys | Where-Object { $_ -notin $allowed })
  if ($unknown.Count -gt 0) { $e = New-Object IO.InvalidDataException('Unknown metadata fields'); $e.Data['unvalidatedFields'] = $unknown; throw $e }
}
function Add-FreshCalibrationEvent($Facts, $Record, $Data, $Native, $Objects, $Keys) {
  # Check every decoded record before writing XML, including records outside the
  # requested PID filter. A successful EnableTraceEx2 does not prove ownership.
  foreach ($field in @('CapturedDataSize', 'PreviousDataCapturedSize')) { if ($Data.ContainsKey($field)) { $size = Read-EventUnsigned $Data[$field]; if ($null -eq $size) { $e = New-Object IO.InvalidDataException('Unknown captured size'); $e.Data['unvalidatedFields'] = @($field); throw $e }; if ($size -ne 0) { $e = New-Object IO.InvalidDataException('Unexpected value payload'); $e.Data['valuePayload'] = $true; throw $e } } }
  foreach ($field in @('CapturedData', 'PreviousData')) { if ($Data.ContainsKey($field) -and ![String]::IsNullOrWhiteSpace($Data[$field])) { $e = New-Object IO.InvalidDataException('Unexpected value payload'); $e.Data['valuePayload'] = $true; throw $e } }
  $provider = $Record.ProviderId.ToString(); Assert-MetadataFields $provider $Data; $Facts.versions[$provider + '/' + $Record.Id + '/' + $Record.Version] = 1
  if ($Record.ProcessId -ne $Native.ChildPid) { $Facts.otherProcessEvents++; return }
  if (!$Native.ProcessIdentityVerified -or $null -eq $Record.TimeCreated -or
    $Record.TimeCreated.ToUniversalTime() -lt [datetime]::Parse($Native.CreationUtc).ToUniversalTime() -or
    $Record.TimeCreated.ToUniversalTime() -gt [datetime]::Parse($Native.ExitUtc).ToUniversalTime()) { $Facts.epochRejected++; return }
  $Facts.ownProcessEvents++
  if ($Record.ThreadId -ne $Native.ChildThreadId) { $Facts.threadRejected++; return }
  if ($provider -eq 'edd08927-9cc4-4e65-b970-c2560fb5c289') {
    # These versions/fields are explicit; unknown versions remain raw schema.
    if ($Record.Version -eq 1 -and $Record.Id -in @(12, 30) -and $Data.ContainsKey('FileObject')) {
      $object = Get-ObjectToken $Data.FileObject
      if (!$object) { return }
      if ($Objects.ContainsKey($object) -and $Objects[$object].active) { $Facts.lifetimeGaps++; $Objects[$object].active = $false; return }
      if (!$Data.ContainsKey('FileName') -or $Data.FileName -cne $Native.FileNtPath -or !$Data.ContainsKey('Irp') -or !(Test-ObjectId $Data.Irp) -or
        !$Data.ContainsKey('IssuingThreadId') -or (Read-EventUnsigned $Data.IssuingThreadId) -ne $Native.ChildThreadId) { return }
      $generation = 1; if ($Objects.ContainsKey($object)) { $generation = $Objects[$object].generation + 1 }
      $Objects[$object] = @{ active = $true; established = $false; generation = $generation; irp = (Get-ObjectToken $Data.Irp); cleaned = $false }
      $Facts.fileCreates++; return
    }
    if ($Record.Id -eq 24 -and $Record.Version -eq 0 -and $Data.ContainsKey('Irp') -and $Data.ContainsKey('Status')) {
      $irp = Get-ObjectToken $Data.Irp
      $status = Read-EventUnsigned $Data.Status
      foreach ($entry in $Objects.Values) { if ($entry.active -and !$entry.established -and $entry.irp -eq $irp -and $irp) { $entry.established = $null -ne $status -and $status -eq 0; if (!$entry.established) { $entry.active = $false }; $entry.irp = '' } }; return
    }
    if ($Record.Version -ne 1 -or !$Data.ContainsKey('FileObject')) { return }
    $object = Get-ObjectToken $Data.FileObject
    if (!$object -or !$Objects.ContainsKey($object) -or !$Objects[$object].active -or !$Objects[$object].established) { return }
    if (!$Data.ContainsKey('IssuingThreadId') -or (Read-EventUnsigned $Data.IssuingThreadId) -ne $Native.ChildThreadId) { $Facts.threadRejected++; return }
    if ($Record.Id -eq 16) { $Facts.fileWrites++ }
    if ($Record.Id -eq 13) { $Objects[$object].cleaned = $true }
    if ($Record.Id -eq 14) { if (!$Objects[$object].cleaned) { $Facts.lifetimeGaps++ }; $Objects[$object].active = $false; $Facts.fileCloses++ }
  }
  if ($provider -eq '70eb4f03-c1de-4f73-a051-33d13d5413bd' -and $Record.Version -eq 0 -and $Data.ContainsKey('KeyObject')) {
    $object = Get-ObjectToken $Data.KeyObject
    if (!$object -or !$Data.ContainsKey('Status')) { return }; $status = Read-EventUnsigned $Data.Status; if ($null -eq $status -or $status -ne 0) { return }
    if ($Record.Id -in @(1, 2)) {
      if ($Keys.ContainsKey($object) -and $Keys[$object].active) { $Facts.lifetimeGaps++; $Keys[$object].active = $false; return }
      $name = ''; $generation = 1; if ($Keys.ContainsKey($object)) { $generation = $Keys[$object].generation + 1 }
      if ($Data.ContainsKey('RelativeName') -and $Data.RelativeName -match '^\\REGISTRY\\USER\\S-1-[0-9-]+(?:\\[^\\]+)*$') { $name = $Data.RelativeName; $Facts.absoluteAnchors++ }
      elseif ($Data.ContainsKey('RelativeName') -and $Data.RelativeName -and $Data.RelativeName -notmatch '[:\\/]' -and $Data.RelativeName -notin @('.', '..') -and $Data.ContainsKey('BaseObject')) {
        $base = Get-ObjectToken $Data.BaseObject
        if ($base -and $Keys.ContainsKey($base) -and $Keys[$base].active) { $name = $Keys[$base].name.TrimEnd('\') + '\' + $Data.RelativeName }
      }
      # BaseName, KeyName, a GUID or the child call arguments alone are not an anchor.
      if ($name) { $Keys[$object] = @{ name = $name; generation = $generation; active = $true } }; return
    }
    if (!$Keys.ContainsKey($object) -or !$Keys[$object].active) { return }
    if ($Record.Id -eq 13) { $Keys[$object].active = $false; $Facts.keyCloses++; return }
    if ($Record.Id -eq 5 -and $Keys[$object].name -eq $Native.KeyNtPath -and $Data.ContainsKey('ValueName') -and $Data.ValueName -eq 'type-canary' -and $Data.ContainsKey('Type') -and $Data.ContainsKey('DataSize')) {
      $type = Read-EventUnsigned $Data.Type; $size = Read-EventUnsigned $Data.DataSize
      if ($null -ne $type -and $type -le [uint32]::MaxValue -and $null -ne $size -and $size -eq 0) { $Facts.registrySets++; $Facts.registryTypes += [uint32]$type }
    }
  }
  # Never infer a registry view or complete rename/delete lifecycle from API
  # intent or nearby timestamps. The first fresh-child run collects that schema.
}
function New-EventBodyError([string]$Shape) { $e = New-Object IO.InvalidDataException('Unvalidated XML event body'); $e.Data['unvalidatedBody'] = $true; $e.Data['xmlShape'] = $Shape; return $e }
function Assert-EventXmlAttributes([Xml.XmlElement]$Element, [string[]]$Allowed) {
  foreach ($attribute in $Element.Attributes) {
    if ($attribute.NamespaceURI -ceq 'http://www.w3.org/2000/xmlns/' -and $attribute.Value -ceq 'http://schemas.microsoft.com/win/2004/08/events/event') { continue }
    if ($attribute.NamespaceURI -cne '' -or $attribute.LocalName -cnotin $Allowed) { throw (New-EventBodyError 'attributes') }
  }
}
function Assert-EventXmlChildren([Xml.XmlElement]$Element, [bool]$Leaf) {
  foreach ($node in $Element.ChildNodes) {
    if ($node.NodeType -in @([Xml.XmlNodeType]::Whitespace, [Xml.XmlNodeType]::SignificantWhitespace)) { continue }
    if ($Leaf -and $node.NodeType -eq [Xml.XmlNodeType]::Text) { continue }
    if (!$Leaf -and $node.NodeType -eq [Xml.XmlNodeType]::Element -and $node.NamespaceURI -ceq 'http://schemas.microsoft.com/win/2004/08/events/event') { continue }
    throw (New-EventBodyError 'child-node-shape')
  }
}
function Read-ValidatedEventData([Xml.XmlDocument]$Document, $Record) {
  $namespace = 'http://schemas.microsoft.com/win/2004/08/events/event'; $root = $Document.DocumentElement
  if ($null -ne $Document.DocumentType -or $null -eq $root -or $root.LocalName -cne 'Event' -or $root.NamespaceURI -cne $namespace) { throw (New-EventBodyError 'document-or-namespace') }
  foreach ($node in $Document.ChildNodes) { if ($node -ne $root -and $node.NodeType -notin @([Xml.XmlNodeType]::Whitespace, [Xml.XmlNodeType]::SignificantWhitespace)) { throw (New-EventBodyError 'document-node') } }
  Assert-EventXmlAttributes $root @(); Assert-EventXmlChildren $root $false
  $children = @($root.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element })
  if ($children.Count -ne 2 -or $children[0].LocalName -cne 'System' -or $children[1].LocalName -cne 'EventData') { throw (New-EventBodyError 'event-body-shape') }
  $system = $children[0]; $body = $children[1]; Assert-EventXmlAttributes $system @(); Assert-EventXmlChildren $system $false
  $headers = @{}; $attributes = @{ Provider = @('Name', 'Guid'); EventID = @('Qualifiers'); Version = @(); Level = @(); Task = @(); Opcode = @(); Keywords = @(); TimeCreated = @('SystemTime'); EventRecordID = @(); Correlation = @('ActivityID', 'RelatedActivityID'); Execution = @('ProcessID', 'ThreadID', 'ProcessorID', 'SessionID', 'ProcessorTime', 'KernelTime', 'UserTime'); Channel = @(); Computer = @(); Security = @('UserID') }
  foreach ($node in $system.ChildNodes) {
    if ($node.NodeType -ne [Xml.XmlNodeType]::Element) { continue }
    if ($node.LocalName -cnotin @($attributes.Keys) -or $headers.ContainsKey($node.LocalName)) { throw (New-EventBodyError 'system-child') }
    Assert-EventXmlAttributes $node $attributes[$node.LocalName]; Assert-EventXmlChildren $node $true; $headers[$node.LocalName] = $node
    if ($node.LocalName -cin @('Provider', 'TimeCreated', 'Correlation', 'Execution', 'Security') -and ![String]::IsNullOrWhiteSpace($node.InnerText)) { throw (New-EventBodyError 'system-content') }
  }
  [guid]$provider = [guid]::Empty
  if (!$headers.ContainsKey('Provider') -or ![guid]::TryParse($headers.Provider.GetAttribute('Guid'), [ref]$provider) -or $provider -ne $Record.ProviderId) { throw (New-EventBodyError 'provider-header') }
  Assert-EventXmlAttributes $body @(); Assert-EventXmlChildren $body $false; $data = @{}
  foreach ($node in $body.ChildNodes) {
    if ($node.NodeType -ne [Xml.XmlNodeType]::Element) { continue }
    if ($node.LocalName -cne 'Data') { throw (New-EventBodyError 'eventdata-child') }
    Assert-EventXmlAttributes $node @('Name'); Assert-EventXmlChildren $node $true
    $name = $node.GetAttribute('Name'); if (!$name -or $data.ContainsKey($name)) { throw (New-EventBodyError 'ambiguous-data') }; $data[$name] = $node.InnerText
  }
  return $data
}
function Get-CalibrationFacts([string]$Etl, [string]$XmlFile, $Native) {
  $facts = New-FreshCalibrationFacts
  $query = New-Object Diagnostics.Eventing.Reader.EventLogQuery($Etl, [Diagnostics.Eventing.Reader.PathType]::FilePath, '*')
  $reader = $null; $stream = $null
  $objects = @{}; $keys = @{}; $utf8 = New-Object Text.UTF8Encoding($false); $scannedBytes = 0
  try {
    $reader = New-Object Diagnostics.Eventing.Reader.EventLogReader($query); $stream = [IO.File]::Open($XmlFile, 'CreateNew', 'Write', 'None')
    $bytes = $utf8.GetBytes('<Events Sanitized="true" CompleteStream="false">'); $stream.Write($bytes, 0, $bytes.Length)
    while ($null -ne ($record = $reader.ReadEvent())) {
      try {
        if (++$facts.events -gt 100000) { throw 'ETW event budget' }
        $text = $record.ToXml(); $bytesInRecord = $utf8.GetByteCount($text); $scannedBytes += $bytesInRecord
        if ($text.Length -gt 65536 -or $scannedBytes -gt 33554432 -or $stream.Length + $bytesInRecord -gt 33554432) { throw 'ETW XML budget' }
        try {
          $settings = New-Object Xml.XmlReaderSettings; $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null; $settings.MaxCharactersInDocument = 65536
          $inputText = New-Object IO.StringReader($text); $xmlReader = $null
          try { $xmlReader = [Xml.XmlReader]::Create($inputText, $settings); $doc = New-Object Xml.XmlDocument; $doc.XmlResolver = $null; $doc.Load($xmlReader) }
          finally { if ($null -ne $xmlReader) { $xmlReader.Dispose() }; $inputText.Dispose() }
          $data = Read-ValidatedEventData $doc $record
          Add-FreshCalibrationEvent $facts $record $data $Native $objects $keys
        } catch {
          $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
          $schema = @{ provider = $record.ProviderId.ToString(); id = $record.Id; version = $record.Version; pid = $record.ProcessId; threadId = $record.ThreadId }
          if (!$e.Data['unvalidatedBody'] -and !$e.Data['valuePayload'] -and !$e.Data.Contains('unvalidatedFields') -and $e -isnot [Xml.XmlException]) { $e.Data['eventSchema'] = $schema; throw }
          $shape = 'metadata-fields'; if ($e.Data['unvalidatedBody']) { $shape = $e.Data['xmlShape'] } elseif ($e.Data['valuePayload']) { $shape = 'captured-data' } elseif ($e -is [Xml.XmlException]) { $shape = 'malformed-xml' }
          $facts.payloadScanComplete = $false; $facts.unknownRecords++; $facts.lifetimeGaps++; $objects.Clear(); $keys.Clear()
          if (!$facts.unknownShapes.ContainsKey($shape)) { $facts.unknownShapes[$shape] = 0 }; $facts.unknownShapes[$shape]++
          if ($facts.unknownSamples.Count -lt 32) { $facts.unknownSamples += @{ shape = $shape; schema = $schema } }
          continue # Engineering facts from later valid records; never publish this body or the raw ETL.
        }
        $bytes = $utf8.GetBytes($text); $stream.Write($bytes, 0, $bytes.Length)
      } finally { $record.Dispose() }
    }
    $bytes = $utf8.GetBytes('</Events>'); $stream.Write($bytes, 0, $bytes.Length)
    return $facts
  } finally { if ($null -ne $stream) { $stream.Dispose() }; if ($null -ne $reader) { $reader.Dispose() } }
}
function Get-OwnedCanarySource { return @'
using System; using System.IO; using System.Text; using System.Diagnostics; using System.ComponentModel; using System.Runtime.InteropServices; using System.Security.Principal; using Microsoft.Win32; using Microsoft.Win32.SafeHandles;
public static class CcHahaFreshCanary {
  [StructLayout(LayoutKind.Sequential)] public struct FileInfo { public uint Attributes,CreatedLow,CreatedHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IdHigh,IdLow; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,IntPtr security);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle,StringBuilder path,uint size,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out FileInfo info);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegOpenKeyExW(IntPtr root,string path,uint options,uint access,out IntPtr key);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegCreateKeyExW(IntPtr root,string path,uint reserved,string cls,uint options,uint access,IntPtr security,out IntPtr key,out uint disposition);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegSetValueExW(IntPtr key,string name,uint reserved,uint type,IntPtr data,uint bytes);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegQueryValueExW(IntPtr key,string name,IntPtr reserved,out uint type,IntPtr data,ref uint bytes);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegDeleteValueW(IntPtr key,string name);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  [DllImport("ntdll.dll",ExactSpelling=true)] static extern int NtDeleteKey(IntPtr key);
  static void Win(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Reg(int code) { if(code!=0) throw new Win32Exception(code); }
  static string Q(string s) { StringBuilder b=new StringBuilder("\""); foreach(char c in s??"") { if(c=='\\') b.Append("\\\\"); else if(c=='\"') b.Append("\\\""); else if(c<32) b.Append("\\u"+((int)c).ToString("x4")); else b.Append(c); } return b.Append('"').ToString(); }
  static string NtPath(FileStream f) { StringBuilder b=new StringBuilder(32768); uint n=GetFinalPathNameByHandleW(f.SafeFileHandle.DangerousGetHandle(),b,(uint)b.Capacity,2); Win(n>0 && n<b.Capacity); return b.ToString(); }
  static string Identity(FileStream f) { FileInfo i; Win(GetFileInformationByHandle(f.SafeFileHandle.DangerousGetHandle(),out i)); if((i.Attributes&0x400)!=0) throw new InvalidOperationException("reparse"); return i.Volume.ToString("x8")+":"+i.IdHigh.ToString("x8")+i.IdLow.ToString("x8"); }
  static void CheckZero(IntPtr key) { uint type,bytes=0; Reg(RegQueryValueExW(key,"type-canary",IntPtr.Zero,out type,IntPtr.Zero,ref bytes)); if(type!=0 || bytes!=0) throw new InvalidOperationException("changed canary value"); }
  public static bool ManagedAbi() { return Marshal.SizeOf(typeof(FileInfo))==52 && Marshal.OffsetOf(typeof(FileInfo),"Volume").ToInt32()==28 && Marshal.OffsetOf(typeof(FileInfo),"IdHigh").ToInt32()==44; }
  public static int Main(string[] args) {
    if(args.Length!=2 || !Environment.Is64BitProcess || !ManagedAbi()) return 2;
    string root=Path.GetFullPath(args[0]),id=Guid.Parse(args[1]).ToString("D"),leaf="CcHaha-CI-Fixture-"+id;
    if(root!=args[0] || !Directory.Exists(root) || Directory.GetFileSystemEntries(root).Length!=0 || (File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0) return 2;
    string stage="preflight",fileNt="",renamedNt="",finalNt="",keyNt="",fileId="",errorType=""; int errorCode=0; uint deleteStatus=UInt32.MaxValue; bool restored=false,registryRestored=false,registryDeleted=false,fileDeleted=false; IntPtr parent=IntPtr.Zero,owner=IntPtr.Zero,alias=IntPtr.Zero; bool created=false;
    uint tid=GetCurrentThreadId(); string creation=Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("o");
    try {
      stage="file-create-write-restore"; string path=Path.Combine(root,"canary.bin"),staging=Path.Combine(root,"stage"),renamed=Path.Combine(staging,"renamed.bin"),finalStage=Path.Combine(root,"restored-stage");
      using(FileStream f=new FileStream(path,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read|FileShare.Write|FileShare.Delete)) { fileNt=NtPath(f); fileId=Identity(f); foreach(byte b in new byte[]{0,1,0}) { f.Position=0; f.WriteByte(b); f.Flush(true); } f.Position=0; restored=f.Length==1 && f.ReadByte()==0; }
      stage="file-close-reopen"; using(FileStream f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Write|FileShare.Delete)) { if(Identity(f)!=fileId || f.ReadByte()!=0 || f.Length!=1) throw new InvalidOperationException("file changed"); }
      stage="file-rename"; Win(CreateDirectoryW(staging,IntPtr.Zero)); File.Move(path,renamed);
      using(FileStream f=new FileStream(renamed,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Write|FileShare.Delete)) { renamedNt=NtPath(f); if(Identity(f)!=fileId || f.ReadByte()!=0) throw new InvalidOperationException("renamed file changed"); }
      stage="staging-directory-rename"; Directory.Move(staging,finalStage); string final=Path.Combine(finalStage,"renamed.bin");
      using(FileStream f=new FileStream(final,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Write|FileShare.Delete)) { finalNt=NtPath(f); if(Identity(f)!=fileId || f.Length!=1 || f.ReadByte()!=0) throw new InvalidOperationException("restored file changed"); }
      stage="file-delete"; File.Delete(final); Directory.Delete(finalStage,false); fileDeleted=!File.Exists(final) && !Directory.Exists(finalStage);
      // The first HKCU open in this executable happens after the parent has
      // filtered this fresh suspended child's actual PID and resumed it.
      stage="registry-first-open"; Reg(RegOpenKeyExW(new IntPtr(unchecked((int)0x80000001)),"Software",0,0x104,out parent));
      uint disposition; Reg(RegCreateKeyExW(parent,leaf,0,null,1,0x3010b,IntPtr.Zero,out owner,out disposition)); created=disposition==1; if(!created) throw new InvalidOperationException("key existed");
      keyNt=@"\REGISTRY\USER\"+WindowsIdentity.GetCurrent().User.Value+@"\Software\"+leaf;
      stage="registry-zero-byte-type-restore"; foreach(uint t in new uint[]{0,3,0}) Reg(RegSetValueExW(owner,"type-canary",0,t,IntPtr.Zero,0)); CheckZero(owner); registryRestored=true;
      // Keep the created-new ownership handle. Close/reopen a query alias so
      // cleanup can delete the exact original object, never a pathname replacement.
      stage="registry-close-reopen"; Reg(RegOpenKeyExW(parent,leaf,0,0x101,out alias)); CheckZero(alias); Reg(RegCloseKey(alias)); alias=IntPtr.Zero; Reg(RegOpenKeyExW(parent,leaf,0,0x101,out alias)); CheckZero(alias); Reg(RegCloseKey(alias)); alias=IntPtr.Zero;
    } catch(Exception e) { errorType=e.GetType().FullName; Win32Exception w=e as Win32Exception; errorCode=w==null?e.HResult:w.NativeErrorCode; }
    finally {
      try { if(alias!=IntPtr.Zero) { Reg(RegCloseKey(alias)); alias=IntPtr.Zero; }
        if(created) { using(RegistryKey k=RegistryKey.FromHandle(new SafeRegistryHandle(owner,false))) { string[] names=k.GetValueNames(); if(k.SubKeyCount!=0 || names.Length!=1 || names[0]!="type-canary") throw new InvalidOperationException("key changed"); } CheckZero(owner); Reg(RegDeleteValueW(owner,"type-canary")); deleteStatus=unchecked((uint)NtDeleteKey(owner)); if(deleteStatus!=0) throw new InvalidOperationException("key deletion failed"); registryDeleted=true; }
      } catch(Exception e) { if(errorType.Length==0) { errorType=e.GetType().FullName; errorCode=e.HResult; } }
      try { if(owner!=IntPtr.Zero) { Reg(RegCloseKey(owner)); owner=IntPtr.Zero; } if(parent!=IntPtr.Zero) { Reg(RegCloseKey(parent)); parent=IntPtr.Zero; } } catch(Exception e) { if(errorType.Length==0) { errorType=e.GetType().FullName; errorCode=e.HResult; } }
    }
    bool ok=errorType.Length==0 && restored && registryRestored && registryDeleted && fileDeleted;
    string json="{\"version\":1,\"pid\":"+Process.GetCurrentProcess().Id+",\"threadId\":"+tid+",\"creationUtc\":"+Q(creation)+",\"nonce\":"+Q(id)+",\"root\":"+Q(root)+",\"fileNtPath\":"+Q(fileNt)+",\"renamedNtPath\":"+Q(renamedNt)+",\"finalNtPath\":"+Q(finalNt)+",\"fileIdentity\":"+Q(fileId)+",\"keyNtPath\":"+Q(keyNt)+",\"requestedRegistryView\":64,\"registryBytes\":0,\"restored\":"+(ok?"true":"false")+",\"registryDeleted\":"+(registryDeleted?"true":"false")+",\"registryDeleteNtStatus\":"+Q(deleteStatus.ToString("x8"))+",\"fileDeleted\":"+(fileDeleted?"true":"false")+",\"stage\":"+Q(stage)+",\"errorType\":"+Q(errorType)+",\"errorCode\":"+errorCode+"}";
    using(FileStream f=new FileStream(Path.Combine(root,"child.json"),FileMode.CreateNew,FileAccess.Write,FileShare.Read)) { byte[] b=new UTF8Encoding(false).GetBytes(json); f.Write(b,0,b.Length); f.Flush(true); }
    return ok?0:2;
  }
}
'@ }
function New-OwnedChildEnvironment([string]$Directory) {
  $windows = [CcHahaCiEtw]::WindowsRoot()
  $home = Join-Path $Directory 'home'; $temp = Join-Path $Directory 'tmp'; $app = Join-Path $Directory 'appdata'; $local = Join-Path $Directory 'localappdata'
  foreach ($p in @($home, $temp, $app, $local)) { [CcHahaCiEtw]::NewDirectory($p) }
  return @{ SystemRoot = $windows; WINDIR = $windows; PATH = (Join-Path $windows 'System32'); HOME = $home; USERPROFILE = $home; APPDATA = $app; LOCALAPPDATA = $local; TEMP = $temp; TMP = $temp }
}
function Build-OwnedCanary([string]$Directory, $Environment) {
  $framework = Join-Path ([CcHahaCiEtw]::WindowsRoot()) 'Microsoft.NET/Framework64/v4.0.30319'; $compiler = Join-Path $framework 'csc.exe'; $source = Join-Path $Directory 'canary.cs'; $exe = Join-Path $Directory 'canary.exe'
  foreach ($p in @($compiler, (Join-Path $framework 'mscorlib.dll'), (Join-Path $framework 'System.dll'))) { if (![IO.File]::Exists($p) -or ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Missing plain system Framework compiler/reference' } }
  Write-NewText $source (Get-OwnedCanarySource)
  Write-NewText ($exe + '.config') '<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.0"/></startup></configuration>'
  $info = New-Object Diagnostics.ProcessStartInfo; $info.FileName = $compiler; $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.WorkingDirectory = $Directory; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.Arguments = (@('/nologo', '/noconfig', '/nostdlib+', '/langversion:5', '/platform:x64', '/target:exe', ('/out:' + $exe), ('/reference:' + (Join-Path $framework 'mscorlib.dll')), ('/reference:' + (Join-Path $framework 'System.dll')), $source) | ForEach-Object { Quote-Argument $_ }) -join ' '
  $info.EnvironmentVariables.Clear(); foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[$name] = $Environment[$name] }
  $p = New-Object Diagnostics.Process; $p.StartInfo = $info
  try { if (!$p.Start()) { throw 'Owned compiler did not start' }; $stdout = $p.StandardOutput.ReadToEndAsync(); $stderr = $p.StandardError.ReadToEndAsync(); if (!$p.WaitForExit(15000)) { $p.Kill(); $p.WaitForExit(); throw 'Owned compiler timeout' }; if ($p.ExitCode -ne 0 -or $stdout.Result.Length -gt 65536 -or $stderr.Result.Length -gt 65536) { $e = New-Object IO.InvalidDataException('Owned compiler failed'); $e.Data['toolExit'] = $p.ExitCode; throw $e } }
  finally { $p.Dispose() }
  if (![IO.File]::Exists($exe) -or ([IO.File]::GetAttributes($exe) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'No owned compiler output' }
  return @{ executable = $exe; executableSha256 = Get-FileSha $exe; sourceSha256 = Get-FileSha $source; compilerSha256 = Get-FileSha $compiler; architecture = 'x64'; runtime = 'system-Framework4'; packageDownload = $false }
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
  // WinSDK x64 STARTUPINFOW=104, PROCESS_INFORMATION=24; no inherited handles.
  [StructLayout(LayoutKind.Sequential)] public struct Startup { public uint Size; public IntPtr Reserved, Desktop, Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public ushort Show,ReservedBytes; public IntPtr ReservedData,Input,Output,Error; }
  [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
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
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int information,IntPtr buffer,uint size,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exit);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exit);
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
  ProcessInfo child; long childCreation; bool childCreated, resumeAttempted; FileStream executablePin;
  public uint ChildPid,ChildThreadId,ChildExitCode; public uint ChildWaitStatus=UInt32.MaxValue,ResumePreviousCount=UInt32.MaxValue; public string CreationUtc,ExitUtc; public bool ProcessIdentityVerified,ChildJobBound,ChildFilterEnabled,ChildResumed,ChildExited,ChildTimedOut,ChildStoppedBeforeResume;
  public bool ChildMayHaveRun { get { return resumeAttempted; } }
  public bool ChildInOwnedJob() { VerifyChild(); bool member; Win(IsProcessInJob(child.Process,job,out member)); return member; }
  public CcHahaCiEtw(string session,string trace,string id) { name=session; file=trace; nonce=id; guid=Guid.Parse(id); }
  public static void NewDirectory(string path) { Win(CreateDirectoryW(path,IntPtr.Zero)); }
  public static string SystemTool(string name) { if(name!="logman.exe" && name!="wevtutil.exe") throw new InvalidOperationException("Fixed metadata tool required"); StringBuilder w=new StringBuilder(32768); uint n=GetWindowsDirectoryW(w,(uint)w.Capacity); Win(n>0 && n<w.Capacity); string p=Path.Combine(w.ToString(),"System32",name); if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("Reparse metadata tool"); return p; }
  public static string WindowsRoot() { StringBuilder w=new StringBuilder(32768); uint n=GetWindowsDirectoryW(w,(uint)w.Capacity); Win(n>0 && n<w.Capacity); return w.ToString(); }
  public static bool FreshAbi() { return IntPtr.Size==8 && Marshal.SizeOf(typeof(Startup))==104 && Marshal.OffsetOf(typeof(Startup),"Reserved").ToInt32()==8 && Marshal.OffsetOf(typeof(Startup),"ReservedData").ToInt32()==72 && Marshal.OffsetOf(typeof(Startup),"Input").ToInt32()==80 && Marshal.SizeOf(typeof(ProcessInfo))==24 && Marshal.OffsetOf(typeof(ProcessInfo),"Pid").ToInt32()==16; }
  public static bool SameSession(Props p,ulong retained,Guid id,string actual,string expected) { return retained!=0 && p.W.Context==retained && p.W.Guid==id && String.Equals(actual,expected,StringComparison.OrdinalIgnoreCase); }
  IntPtr Properties() { int size=Marshal.SizeOf(typeof(Props)); byte[] path=Encoding.Unicode.GetBytes(file+"\0"), session=Encoding.Unicode.GetBytes(name+"\0"); IntPtr p=Marshal.AllocHGlobal(size+path.Length+session.Length); Marshal.Copy(new byte[size+path.Length+session.Length],0,p,size+path.Length+session.Length); Props v=new Props { W=new Wnode { Size=(uint)(size+path.Length+session.Length), Guid=guid, Clock=1, Flags=0x20000 }, Buffer=64, Min=16, Max=64, MaxFile=16, Mode=1, Flush=1, FileOffset=(uint)size, NameOffset=(uint)(size+path.Length) }; Marshal.StructureToPtr(v,p,false); Marshal.Copy(path,0,IntPtr.Add(p,size),path.Length); Marshal.Copy(session,0,IntPtr.Add(p,size+path.Length),session.Length); return p; }
  public object QueryOwn() { IntPtr p=Properties(); try { uint code=ControlTraceW(handle,name,p,0); Props v=(Props)Marshal.PtrToStructure(p,typeof(Props)); return new { code=code, sessionGuid=v.W.Guid, traceHandle=v.W.Context, eventsLost=v.Lost, logBuffersLost=v.LogLost, realTimeBuffersLost=v.RealLost }; } finally { Marshal.FreeHGlobal(p); } }
  public void Start() {
    IntPtr p=Properties(); try { PriorQueryCode=ControlTraceW(0,name,p,0); if(PriorQueryCode!=4201) throw new Win32Exception((int)(PriorQueryCode==0?183:PriorQueryCode)); } finally { Marshal.FreeHGlobal(p); }
    p=Properties(); try { StartAttempted=true; Check(StartTraceW(out handle,name,p)); Created=true; if(handle==0) throw new InvalidOperationException("Missing retained ETW handle"); } finally { Marshal.FreeHGlobal(p); }
    Enable(new Guid("edd08927-9cc4-4e65-b970-c2560fb5c289"),0x1fff,(uint)Process.GetCurrentProcess().Id); Enable(new Guid("70eb4f03-c1de-4f73-a051-33d13d5413bd"),0x7901,(uint)Process.GetCurrentProcess().Id); RequireOwn();
  }
  void RequireOwn() { IntPtr p=Properties(); try { Check(ControlTraceW(handle,name,p,0)); Props v=(Props)Marshal.PtrToStructure(p,typeof(Props)); if(!SameSession(v,handle,guid,Marshal.PtrToStringUni(IntPtr.Add(p,(int)v.FileOffset)),file)) throw new InvalidOperationException("ETW identity changed"); } finally { Marshal.FreeHGlobal(p); } }
  void Enable(Guid provider,ulong keywords,uint target) { if(target==0) throw new InvalidOperationException("Missing exact PID"); IntPtr pid=Marshal.AllocHGlobal(4), f=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Filter))); try { Marshal.WriteInt32(pid,unchecked((int)target)); Marshal.StructureToPtr(new Filter { Ptr=(ulong)pid.ToInt64(), Size=4, Type=0x80000004 },f,false); EnableParams e=new EnableParams { Version=2, Source=guid, Filter=f, Count=1 }; Check(EnableTraceEx2(handle,ref provider,1,5,keywords,0,5000,ref e)); } finally { Marshal.FreeHGlobal(f); Marshal.FreeHGlobal(pid); } }
  void VerifyChild() { if(!childCreated || child.Process==IntPtr.Zero || GetProcessId(child.Process)!=ChildPid) throw new InvalidOperationException("Child identity unknown"); long c,x,k,u; Win(GetProcessTimes(child.Process,out c,out x,out k,out u)); if(c!=childCreation || c<=0) throw new InvalidOperationException("Child creation changed"); }
  bool OnlyChildInJob() { bool member; Win(IsProcessInJob(child.Process,job,out member)); IntPtr p=Marshal.AllocHGlobal(16); try { uint n; Win(QueryInformationJobObject(job,3,p,16,out n)); return member && n==16 && Marshal.ReadInt32(p)==1 && Marshal.ReadInt32(p,4)==1 && unchecked((ulong)Marshal.ReadInt64(p,8))==ChildPid; } finally { Marshal.FreeHGlobal(p); } }
  public void StartChildSuspended(string executable,string arena,string id,string environment) {
    if(!FreshAbi() || childCreated || !Created || Guid.Parse(id)!=guid || environment.IndexOf('\0')<0) throw new InvalidOperationException("Child preflight"); RequireOwn();
    executablePin=new FileStream(executable,FileMode.Open,FileAccess.Read,FileShare.Read); job=CreateJobObjectW(IntPtr.Zero,null); Win(job!=IntPtr.Zero);
    Startup si=new Startup { Size=104 }; IntPtr block=Marshal.StringToHGlobalUni(environment);
    try { Win(CreateProcessW(executable,new StringBuilder("\""+executable+"\" \""+arena+"\" "+id),IntPtr.Zero,IntPtr.Zero,false,0x08000404,block,arena,ref si,out child)); childCreated=true; }
    finally { Marshal.FreeHGlobal(block); }
    ChildPid=child.Pid; ChildThreadId=child.Tid; if(ChildPid==0 || ChildThreadId==0 || child.Thread==IntPtr.Zero) throw new InvalidOperationException("Missing child identity"); long x,k,u; Win(GetProcessTimes(child.Process,out childCreation,out x,out k,out u)); CreationUtc=DateTime.FromFileTimeUtc(childCreation).ToString("o"); VerifyChild(); ProcessIdentityVerified=true;
    Win(AssignProcessToJobObject(job,child.Process)); ChildJobBound=OnlyChildInJob(); if(!ChildJobBound) throw new InvalidOperationException("Child job identity unknown");
  }
  public void FilterAndResumeChild() {
    VerifyChild(); if(!ChildJobBound || !OnlyChildInJob() || resumeAttempted || WaitForSingleObject(child.Process,0)!=258) throw new InvalidOperationException("Child is not owned and suspended"); RequireOwn();
    Enable(new Guid("edd08927-9cc4-4e65-b970-c2560fb5c289"),0x1fff,ChildPid); Enable(new Guid("70eb4f03-c1de-4f73-a051-33d13d5413bd"),0x7901,ChildPid); ChildFilterEnabled=true;
    resumeAttempted=true; ResumePreviousCount=ResumeThread(child.Thread); if(ResumePreviousCount==UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error()); if(ResumePreviousCount!=1) throw new InvalidOperationException("Unexpected child suspend count"); ChildResumed=true;
  }
  public void WaitChild() {
    VerifyChild(); uint wait=WaitForSingleObject(child.Process,20000); ChildWaitStatus=wait; if(wait==UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error()); if(wait==258) { ChildTimedOut=true; VerifyChild(); if(!OnlyChildInJob()) throw new InvalidOperationException("Cannot terminate unproven job"); Win(TerminateJobObject(job,124)); Win(WaitForSingleObject(child.Process,5000)==0); } else if(wait!=0) throw new InvalidOperationException("Unexpected child wait status");
    ChildExited=true; long c,x,k,u; Win(GetProcessTimes(child.Process,out c,out x,out k,out u)); if(c!=childCreation || x<=c) throw new InvalidOperationException("Missing child lifetime"); ExitUtc=DateTime.FromFileTimeUtc(x).ToString("o"); uint exit; Win(GetExitCodeProcess(child.Process,out exit)); ChildExitCode=exit;
    if(ChildTimedOut || exit!=0) throw new InvalidOperationException("Owned canary did not finish normally");
  }
  public void CloseFreshChild() {
    if(childCreated && !ChildExited) { VerifyChild(); if(WaitForSingleObject(child.Process,0)==258) { if(ChildJobBound) { if(!OnlyChildInJob()) throw new InvalidOperationException("Cannot stop unproven job"); Win(TerminateJobObject(job,125)); } else { if(resumeAttempted || !ProcessIdentityVerified) throw new InvalidOperationException("Cannot stop unbound running child"); Win(TerminateProcess(child.Process,125)); ChildStoppedBeforeResume=true; } Win(WaitForSingleObject(child.Process,5000)==0); } ChildExited=true; }
    if(child.Thread!=IntPtr.Zero) { Win(CloseHandle(child.Thread)); child.Thread=IntPtr.Zero; } if(child.Process!=IntPtr.Zero) { Win(CloseHandle(child.Process)); child.Process=IntPtr.Zero; }
    if(executablePin!=null) { executablePin.Dispose(); executablePin=null; }
  }
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
$stage = 'output-preflight'; $native = $null; $ownedOutput = $false; $childResourcesClean = $false; $payloadScanComplete = $false; $sanitizedScanComplete = $false; $privateTraceRoot = $null
$result = @{ version = 1; status = 'not_proven'; F1 = 'not_proven'; accounts = 0; profiles = 0; productPe = 0; cleanup = 'unknown'; error = $null; cleanupErrors = @() }
$result.cleanupMeaning = 'Owned ETW session and retained child handles; canary key/files require created-new child cleanup evidence'
try {
  $output = Get-CiOutputPath $env:GITHUB_WORKSPACE $OutputDirectory
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
  $output = Get-CiOutputPath $env:GITHUB_WORKSPACE $output
  Initialize-EtwNative; [CcHahaCiEtw]::NewDirectory($output); $ownedOutput = $true
  $id = [Guid]::NewGuid().ToString('D'); $session = 'CcHaha1879-calibration-' + $id
  # Unvalidated or still-active ETLs never live below the uploaded artifact tree.
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  for ($p = $tempBase; $p; $p = [IO.Path]::GetDirectoryName($p.TrimEnd('\'))) { if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private trace ancestor is reparse' }; if ($p -eq [IO.Path]::GetPathRoot($p)) { break } }
  $privateTraceRoot = Join-Path $tempBase ('CcHaha1879-private-trace-' + $id); [CcHahaCiEtw]::NewDirectory($privateTraceRoot); $etl = Join-Path $privateTraceRoot 'trace.etl'; $result.privateTraceRoot = $privateTraceRoot
  $result.session = $session; $result.nonce = $id; $result.pid = $PID; $result.creationUtc = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o')
  $result.os = [Environment]::OSVersion.VersionString; $result.engine = $PSVersionTable.PSVersion.ToString(); $result.tools = @(); $result.ordering = 'calibration-facts-only;F1-not-admitted'; $result.sourceSha256 = Get-FileSha $PSCommandPath
  $result.pidFilter = @{ initialRequest = $PID; childRequest = $null; ownership = 'request-only;every-decoded-header-checked' }; $result.registryPayloadBytes = 0; $result.keywords = @{ file = '0x1fff'; registry = '0x7901' }
  $stage = 'provider-metadata'
  foreach ($provider in @('Microsoft-Windows-Kernel-File', 'Microsoft-Windows-Kernel-Registry')) {
    $result.tools += Invoke-ReadOnlyTool 'wevtutil.exe' @('gp', $provider, '/ge:true', '/f:xml') (Join-Path $output ($provider + '.metadata.xml'))
    $result.tools += Invoke-ReadOnlyTool 'logman.exe' @('query', 'providers', $provider) (Join-Path $output ($provider + '.keywords.txt'))
  }
  $native = New-Object CcHahaCiEtw($session, $etl, $id)
  $stage = 'start-filtered-session'; $native.Start(); $result.armed = $native.QueryOwn()
  $stage = 'compile-owned-fresh-child'; $childDirectory = Join-Path $output ('child-' + $id); [CcHahaCiEtw]::NewDirectory($childDirectory)
  $childEnvironment = New-OwnedChildEnvironment $childDirectory; $build = Build-OwnedCanary $childDirectory $childEnvironment; $result.childBuild = $build
  $arena = Join-Path $childDirectory 'arena'; [CcHahaCiEtw]::NewDirectory($arena)
  $environmentBlock = (($childEnvironment.Keys | Sort-Object | ForEach-Object { $_ + '=' + $childEnvironment[$_] + [char]0 }) -join '') + [char]0
  $stage = 'create-suspended-child-and-owned-job'; $native.StartChildSuspended($build.executable, $arena, $id, $environmentBlock)
  $result.ownedJobBefore = $native.ChildJobBound
  $stage = 'enable-exact-child-filter-before-resume'; $native.FilterAndResumeChild(); $result.pidFilter.childRequest = $native.ChildPid
  $stage = 'wait-owned-child-natural-exit'
  try { $native.WaitChild() } catch { $result.error = Safe-Error $_ $stage; if (!$native.ChildExited) { throw } }
  $result.freshChild = @{ pid = $native.ChildPid; threadId = $native.ChildThreadId; creationUtc = $native.CreationUtc; exitUtc = $native.ExitUtc; identityVerified = $native.ProcessIdentityVerified;
    filterEnabledBeforeResume = $native.ChildFilterEnabled; resumePreviousCount = $native.ResumePreviousCount; resumed = $native.ChildResumed; exited = $native.ChildExited; waitStatus = $native.ChildWaitStatus; exitCode = $native.ChildExitCode; timedOut = $native.ChildTimedOut; canary = $null; F1 = 'not_proven' }
  $stage = 'read-owned-child-report'
  try {
    $childReport = Join-Path $arena 'child.json'
    if (![IO.File]::Exists($childReport) -or (Get-Item -LiteralPath $childReport).Length -gt 32768 -or ([IO.File]::GetAttributes($childReport) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Missing plain bounded child report' }
    $canary = [IO.File]::ReadAllText($childReport) | ConvertFrom-Json
    if ($canary.version -ne 1 -or $canary.pid -ne $native.ChildPid -or $canary.threadId -ne $native.ChildThreadId -or $canary.nonce -ne $id -or $canary.root -cne $arena -or
      [datetime]::Parse($canary.creationUtc).ToUniversalTime() -ne [datetime]::Parse($native.CreationUtc).ToUniversalTime() -or $canary.registryBytes -ne 0) { throw 'Child report identity mismatch' }
    $result.freshChild.canary = $canary; $native.FileNtPath = $canary.fileNtPath; $native.KeyNtPath = $canary.keyNtPath
    $native.Restored = $canary.restored -eq $true -and $canary.registryDeleted -eq $true -and $canary.fileDeleted -eq $true -and $native.ChildExitCode -eq 0 -and !$native.ChildTimedOut
    $childResourcesClean = $native.Restored
  } catch { if ($null -eq $result.error) { $result.error = Safe-Error $_ $stage } else { $result.cleanupErrors += Safe-Error $_ $stage } }
  $result.operations = @{ source = 'fresh-child-api-report;not-an-ETW-namespace-anchor'; restored = $native.Restored; registryBytes = 0; requestedView = 64; observedView = 'not_proven' }
  $result.ownedJobAfter = $native.ChildInOwnedJob(); $stage = 'stop-owned-session'; Complete-OwnedSession $native $result
  $stage = 'finalized-etl-header'; if ((Get-Item -LiteralPath $etl).Length -ge 16777216) { throw 'ETL size budget' }
  $h = [CcHahaCiEtw]::ReadHeader($etl); $result.header = @{ endTime = $h.EndTime; startTime = $h.StartTime; frequency = $h.Frequency; eventsLost = $h.EventsLost; buffersLost = $h.BuffersLost; buffersWritten = $h.Written; pointerSize = $h.PointerSize }
  $stage = 'decode-and-map-canaries'; $result.facts = Get-CalibrationFacts $etl (Join-Path $output 'events.sanitized.xml') $native
  $sanitizedScanComplete = $true; $payloadScanComplete = $result.facts.payloadScanComplete -eq $true
  if ($payloadScanComplete) {
    $source = [IO.File]::Open($etl, 'Open', 'Read', 'Read'); $destination = $null
    try { $destination = [IO.File]::Open((Join-Path $output 'trace.etl'), 'CreateNew', 'Write', 'None'); $source.CopyTo($destination); $destination.Flush($true) } finally { if ($null -ne $destination) { $destination.Dispose() }; $source.Dispose() }
    $result.payloadArtifacts = 'complete-metadata-and-zero-captured-data-scan;filter-not-an-ownership-proof'
  } else { $result.payloadArtifacts = 'sanitized-validated-records-only;raw-ETL-ineligible-retained-private' }
  $result.sanitizedXml = @{ file = 'events.sanitized.xml'; meaning = $result.facts.xmlMeaning; unknownRecords = $result.facts.unknownRecords; rawEtlEligible = $payloadScanComplete }
  $result.freshChild.facts = $result.facts
  $result.freshChild.schemaCollected = $h.EndTime -gt $h.StartTime -and $h.StartTime -gt 0 -and $h.Frequency -gt 0 -and $h.Written -gt 0 -and $result.facts.ownProcessEvents -gt 0
  # Fresh registry view and complete file rename/delete lifecycle are deliberately
  # not inferred by this first schema collector. Mapping unknown is not a pass.
  if (Test-CalibrationEvidence $h $result.stop $result.facts $native.Restored $result.ownedJobBefore $result.ownedJobAfter) { $result.status = 'calibrationobserved' }
} catch { if ($null -eq $result.error) { $result.error = Safe-Error $_ $stage } else { $result.cleanupErrors += Safe-Error $_ $stage } }
finally {
  if ($null -ne $native) {
    $result.priorQueryCode = $native.PriorQueryCode
    if (!$result.ContainsKey('operations')) { $result.operations = @{ source = 'fresh-child'; restored = $false; registryBytes = 0 } }
    if ($native.Created -and !$result.ContainsKey('stopAttempted')) { try { Complete-OwnedSession $native $result } catch { $result.cleanupErrors += Safe-Error $_ 'cleanup-session' } }
    elseif ($native.StartAttempted -and !$result.ContainsKey('armed')) { try { $result.startReconciliation = $native.QueryOwn() } catch { $result.cleanupErrors += Safe-Error $_ 'reconcile-start' } }
    foreach ($method in @('CloseFreshChild', 'CloseJob')) { try { $native.$method() } catch { $result.cleanupErrors += Safe-Error $_ $method } }
    $result.childMayHaveRun = $native.ChildMayHaveRun; $result.childResourcesClean = $childResourcesClean; $result.childExited = $native.ChildExited; $result.childStoppedBeforeResume = $native.ChildStoppedBeforeResume
    if (!$result.ContainsKey('freshChild')) { $result.freshChild = @{ pid = $native.ChildPid; threadId = $native.ChildThreadId; creationUtc = $native.CreationUtc; identityVerified = $native.ProcessIdentityVerified; filterEnabledBeforeResume = $native.ChildFilterEnabled; resumed = $native.ChildResumed; resumePreviousCount = $native.ResumePreviousCount; waitStatus = $native.ChildWaitStatus; canary = $null; F1 = 'not_proven' } }
    if (!$native.Created -and $result.cleanupErrors.Count -eq 0 -and (!$native.StartAttempted -or $result.ContainsKey('stop')) -and (!$native.ChildMayHaveRun -or $childResourcesClean)) { $result.cleanup = 'complete' }
  }
  $result.sessionMayBeActive = $null -ne $native -and ($native.Created -or ($native.StartAttempted -and !$result.ContainsKey('stop')))
  if ($result.cleanup -ne 'complete' -or $null -ne $result.error) { $result.status = 'not_proven' }
  if ($ownedOutput) {
    # A provider violating the zero-payload contract cannot leave value bytes in artifacts.
    try {
      if (!$payloadScanComplete) { $result.discarded = @(); foreach ($name in @('trace.etl', 'events.xml')) { $file = Join-Path $output $name; if ([IO.File]::Exists($file) -and ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $result.discarded += @{ name = $name; sha256 = Get-FileSha $file }; [IO.File]::Delete($file) } }; if ($sanitizedScanComplete) { $result.payloadArtifacts = 'sanitized-validated-records-only;raw-ETL-ineligible-retained-private' } else { $result.payloadArtifacts = 'not-published;unvalidated-ETL-retained-only-in-private-temp;safe-error-retained' } }
      if (!$sanitizedScanComplete) { $partial = Join-Path $output 'events.sanitized.xml'; if ([IO.File]::Exists($partial) -and ([IO.File]::GetAttributes($partial) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { [IO.File]::Delete($partial) } }
      $result.files = @(Get-ChildItem -LiteralPath $output -File | ForEach-Object { if ($_.Length -gt 33554440 -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected artifact entry' }; @{ name = $_.Name; bytes = $_.Length; sha256 = Get-FileSha $_.FullName } })
      Write-NewText (Join-Path $output 'result.json') ($result | ConvertTo-Json -Depth 10)
    } catch { $result.cleanupErrors += Safe-Error $_ 'write-evidence'; $result.status = 'not_proven'; Write-Output ($result | ConvertTo-Json -Depth 10 -Compress) }
  }
}
if (!$ownedOutput) { Write-Output ($result | ConvertTo-Json -Depth 6 -Compress) }
Write-Output ('ETW calibration: ' + $result.status + '; F1=not_proven; cleanup=' + $result.cleanup)
if ($result.status -ne 'calibrationobserved') { exit 2 }

# Cargo test-only runner for Tauri's Windows Common Controls manifest gap.
# https://github.com/tauri-apps/tauri/issues/13419
# No production executable or application manifest is changed by this runner.
# Invoke from Cargo with pwsh -NoProfile -NonInteractive -File <this script>.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Executable,
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]] $TestArguments
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:OS -ne 'Windows_NT') { throw 'This Cargo test runner requires Windows.' }

$exe = (Resolve-Path -LiteralPath $Executable).ProviderPath
$file = Get-Item -LiteralPath $exe
$tauri = Join-Path $PSScriptRoot '../packages/client/desktop/src-tauri'
$target = if ($env:CARGO_TARGET_DIR) {
    (Resolve-Path -LiteralPath $env:CARGO_TARGET_DIR).ProviderPath
} else {
    (Resolve-Path -LiteralPath (Join-Path $tauri 'target')).ProviderPath
}
$targetPrefix = $target.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ($file.PSIsContainer -or $file.Name -notmatch '^ultrawork(?:_lib)?-[0-9a-f]+\.exe$' -or
    $file.Directory.Name -ne 'deps' -or $file.Directory.Parent.Name -ne 'debug' -or
    -not $exe.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a non-test executable. Cargo must supply an Ultrawork debug/deps test harness: $exe"
}

$mt = (Get-Command mt.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $mt) {
    $sdkRoots = @()
    $installed = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -ErrorAction SilentlyContinue
    if ($installed.KitsRoot10) { $sdkRoots += Join-Path $installed.KitsRoot10 'bin' }
    if (${env:ProgramFiles(x86)}) { $sdkRoots += Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin' }
    foreach ($sdkRoot in @($sdkRoots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $sdkRoot)) { continue }
        $candidates = Get-ChildItem -LiteralPath $sdkRoot -Directory |
            Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } |
            Sort-Object { [version] $_.Name } -Descending
        foreach ($version in $candidates) {
            $candidate = Join-Path $version.FullName 'x64/mt.exe'
            if (Test-Path -LiteralPath $candidate) { $mt = $candidate; break }
        }
        if ($mt) { break }
    }
}
if (-not $mt) { throw 'Windows SDK mt.exe is required to inspect the test manifest.' }

# Inspect resource presence as data, without loading/running executable code.
# A failed mt extraction is then an error, rather than a reason to overwrite it.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UltraworkTestResources {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool FreeLibrary(IntPtr module);
}
'@
$module = [UltraworkTestResources]::LoadLibraryExW($exe, [IntPtr]::Zero, 0x22)
if ($module -eq [IntPtr]::Zero) { throw "Cannot inspect test PE resources: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
    $resource = [UltraworkTestResources]::FindResourceW($module, [IntPtr] 1, [IntPtr] 24)
    $resourceError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    # 1812 = no resource section, 1813 = no RT_MANIFEST type, 1814 = no #1.
    # A language lookup failure (1815) is not proof the manifest is absent.
    if ($resource -eq [IntPtr]::Zero -and $resourceError -notin @(1812, 1813, 1814)) {
        throw "Cannot inspect RT_MANIFEST #1: Windows error $resourceError"
    }
    $hasManifest = $resource -ne [IntPtr]::Zero
} finally { [void] [UltraworkTestResources]::FreeLibrary($module) }

Write-Host "[windows-rust-test] Harness: $exe"
Write-Host "[windows-rust-test] Manifest tool: $mt"
$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($dumpbin) {
    Write-Host '[windows-rust-test] Common Controls imports (diagnostic only):'
    & $dumpbin.Source /nologo /imports $exe 2>&1 |
        Select-String 'comctl32|TaskDialogIndirect|SetWindowSubclass|RemoveWindowSubclass|DefSubclassProc' -Context 1
} else { Write-Host '[windows-rust-test] dumpbin is not on PATH; continuing manifest inspection.' }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('ultrawork-test-manifest-' + [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $temporary)
try {
    $manifestFile = Join-Path $temporary 'test-manifest.xml'
    $xml = [Xml.XmlDocument]::new()
    $xml.XmlResolver = $null
    if ($hasManifest) {
        & $mt -nologo "-inputresource:$exe;#1" "-out:$manifestFile"
        if ($LASTEXITCODE -ne 0) { throw "Cannot extract the existing test manifest (mt exit $LASTEXITCODE)." }
        $xml.Load($manifestFile)
        Write-Host "[windows-rust-test] Original RT_MANIFEST #1:`n$($xml.OuterXml)"
    } else {
        Write-Host '[windows-rust-test] Original RT_MANIFEST #1: absent.'
        $xml.LoadXml('<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"/>')
    }
    $namespace = 'urn:schemas-microsoft-com:asm.v1'
    if ($xml.DocumentElement.LocalName -ne 'assembly' -or $xml.DocumentElement.NamespaceURI -ne $namespace) {
        throw 'Unexpected test manifest root; refusing to replace it.'
    }
    $manager = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $manager.AddNamespace('asm', $namespace)
    $controls = @($xml.SelectNodes('/asm:assembly/asm:dependency/asm:dependentAssembly/asm:assemblyIdentity[@name="Microsoft.Windows.Common-Controls"]', $manager))
    if ($controls.Count -and @($controls | Where-Object { $_.GetAttribute('version') -ne '6.0.0.0' }).Count) {
        throw 'The existing manifest selects a different Common Controls version; refusing to replace it.'
    }
    if ($controls.Count) {
        Write-Host '[windows-rust-test] Common Controls v6 already present; executable unchanged.'
    } else {
        $dependency = $xml.CreateElement('dependency', $namespace)
        $dependent = $xml.CreateElement('dependentAssembly', $namespace)
        $identity = $xml.CreateElement('assemblyIdentity', $namespace)
        foreach ($attribute in @{ type = 'win32'; name = 'Microsoft.Windows.Common-Controls'; version = '6.0.0.0'; processorArchitecture = '*'; publicKeyToken = '6595b64144ccf1df'; language = '*' }.GetEnumerator()) {
            $identity.SetAttribute($attribute.Key, $attribute.Value)
        }
        [void] $dependent.AppendChild($identity)
        [void] $dependency.AppendChild($dependent)
        [void] $xml.DocumentElement.AppendChild($dependency)
        $xml.Save($manifestFile)
        & $mt -nologo -manifest $manifestFile "-outputresource:$exe;#1"
        if ($LASTEXITCODE -ne 0) { throw "Cannot embed Common Controls v6 for the test harness (mt exit $LASTEXITCODE)." }
        Write-Host '[windows-rust-test] Added only the Common Controls v6 dependency; existing manifest attributes preserved.'
    }
    & $exe @TestArguments
    $testExitCode = $LASTEXITCODE
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
exit $testExitCode

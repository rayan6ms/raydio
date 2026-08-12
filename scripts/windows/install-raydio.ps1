[CmdletBinding()]
param(
  [switch]$Resume,
  [switch]$NoRestart,
  [switch]$SkipOtherHostConfirmation,
  [string]$EnvironmentFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepositoryUrl = "https://github.com/rayan6ms/raydio.git"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Raydio"
$RepositoryRoot = Join-Path $InstallRoot "app"
$ToolsRoot = Join-Path $InstallRoot "tools"
$SavedInstaller = Join-Path $InstallRoot "install-raydio.ps1"
$ComposeProvider = Join-Path $ToolsRoot "docker-compose.exe"
$ComposeVersion = "5.4.0"
$ComposeUri = "https://github.com/docker/compose/releases/download/v${ComposeVersion}/docker-compose-windows-x86_64.exe"
$ComposeSha256 = "D51BC731B3FF6F062A26E8FDFD391AE98AEAB516432F097C66D39C1C9D06680E"
$TaskName = "Raydio Bot (Podman)"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
  }
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Save-Installer {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  if ([string]::IsNullOrWhiteSpace($PSCommandPath)) {
    throw "Run this installer from a downloaded .ps1 file, not directly through Invoke-Expression."
  }
  if ((Resolve-Path $PSCommandPath).Path -ne $SavedInstaller) {
    Copy-Item -LiteralPath $PSCommandPath -Destination $SavedInstaller -Force
  }
}

function Set-ResumeAfterLogon {
  $confirmationArgument = if ($SkipOtherHostConfirmation) { " -SkipOtherHostConfirmation" } else { "" }
  $environmentArgument = if ([string]::IsNullOrWhiteSpace($EnvironmentFile)) {
    ""
  } else {
    " -EnvironmentFile `"$EnvironmentFile`""
  }
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$SavedInstaller`" -Resume$confirmationArgument$environmentArgument"
  New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Force | Out-Null
  $runOnce = @{
    Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    Name = "RaydioSetup"
    Value = "powershell.exe $arguments"
  }
  Set-ItemProperty @runOnce
}

function Ensure-WinGet {
  if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
    return
  }

  Write-Host "WinGet is missing; bootstrapping Microsoft's package manager..."
  Install-PackageProvider -Name NuGet -Force | Out-Null
  Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery -Scope AllUsers | Out-Null
  Import-Module Microsoft.WinGet.Client
  Repair-WinGetPackageManager -AllUsers
  Refresh-Path
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "WinGet installation completed but winget.exe is not available. Sign out, sign in, and rerun the installer."
  }
}

function Install-WinGetPackage {
  param([Parameter(Mandatory = $true)][string]$Id)

  Invoke-Checked "winget.exe" @(
    "install", "--exact", "--id", $Id, "--source", "winget", "--silent",
    "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
  )
}

function Ensure-PodmanMachine {
  & podman.exe info *> $null
  if ($LASTEXITCODE -eq 0) {
    $rootless = ((& podman.exe info --format "{{.Host.Security.Rootless}}" 2>$null) -join "").Trim()
    if ($LASTEXITCODE -ne 0 -or $rootless -ne "true") {
      throw "The active Podman machine is not rootless. Run 'podman machine set --rootful=false'."
    }
    return
  }

  $machineJson = (& podman.exe machine list --format json 2>$null) -join "`n"
  $machines = if ([string]::IsNullOrWhiteSpace($machineJson)) {
    @()
  } else {
    @($machineJson | ConvertFrom-Json)
  }
  if ($machines.Count -eq 0) {
    Invoke-Checked "podman.exe" @(
      "machine", "init", "--rootful=false", "--cpus", "2", "--memory", "4096",
      "--disk-size", "30"
    )
  }
  & podman.exe machine start
  if ($LASTEXITCODE -ne 0) {
    & podman.exe info *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "The Podman machine could not be started."
    }
  }

  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $rootless = (& podman.exe info --format "{{.Host.Security.Rootless}}" 2>$null) -join ""
    if ($LASTEXITCODE -eq 0) {
      if ($rootless.Trim() -ne "true") {
        throw "The Podman machine is not rootless. Run 'podman machine set --rootful=false'."
      }
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "Podman did not become ready within two minutes."
}

function Ensure-Repository {
  if (-not (Test-Path -LiteralPath $RepositoryRoot)) {
    Invoke-Checked "git.exe" @("clone", "--branch", "main", "--single-branch", $RepositoryUrl, $RepositoryRoot)
    return
  }

  if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot ".git") -PathType Container)) {
    throw "$RepositoryRoot exists but is not a Git checkout. Move it aside and rerun this installer."
  }
  $origin = ((& git.exe -C $RepositoryRoot remote get-url origin) -join "").Trim()
  if ($LASTEXITCODE -ne 0 -or $origin -notin @($RepositoryUrl, "git@github.com:rayan6ms/raydio.git")) {
    throw "The existing Raydio checkout points to an unexpected Git remote: $origin"
  }
  $dirty = (& git.exe -C $RepositoryRoot status --porcelain) -join "`n"
  if (-not [string]::IsNullOrWhiteSpace($dirty)) {
    throw "The existing Raydio checkout has local changes. Preserve or remove them deliberately, then rerun."
  }
  Invoke-Checked "git.exe" @("-C", $RepositoryRoot, "fetch", "origin", "main", "--prune")
  Invoke-Checked "git.exe" @("-C", $RepositoryRoot, "checkout", "main")
  Invoke-Checked "git.exe" @("-C", $RepositoryRoot, "merge", "--ff-only", "origin/main")
}

function Ensure-ComposeProvider {
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  $valid = $false
  if (Test-Path -LiteralPath $ComposeProvider -PathType Leaf) {
    $valid = (Get-FileHash -Algorithm SHA256 -LiteralPath $ComposeProvider).Hash -eq $ComposeSha256
  }
  if ($valid) {
    return
  }

  $temporaryFile = "$ComposeProvider.download"
  Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Uri $ComposeUri -OutFile $temporaryFile
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryFile).Hash
  if ($actualHash -ne $ComposeSha256) {
    Remove-Item -LiteralPath $temporaryFile -Force
    throw "The downloaded Compose provider failed SHA-256 verification."
  }
  Move-Item -LiteralPath $temporaryFile -Destination $ComposeProvider -Force
}

function Read-SecretText {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function New-RandomHex {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Get-EnvironmentValue {
  param(
    [Parameter(Mandatory = $true)][string[]]$Lines,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $prefix = "${Name}="
  foreach ($line in $Lines) {
    if ($line.StartsWith($prefix, [StringComparison]::Ordinal)) {
      return $line.Substring($prefix.Length)
    }
  }
  return ""
}

function Set-EnvironmentValue {
  param(
    [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Lines,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $prefix = "${Name}="
  for ($index = 0; $index -lt $Lines.Count; $index += 1) {
    if ($Lines[$index].StartsWith($prefix, [StringComparison]::Ordinal)) {
      $Lines[$index] = "$prefix$Value"
      return
    }
  }
  $Lines.Add("$prefix$Value")
}

function Ensure-EnvironmentFile {
  $environmentPath = Join-Path $RepositoryRoot ".env"
  $examplePath = Join-Path $RepositoryRoot ".env.example"

  if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    if (-not [string]::IsNullOrWhiteSpace($EnvironmentFile)) {
      if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
        throw "The requested environment file does not exist: $EnvironmentFile"
      }
      Copy-Item -LiteralPath $EnvironmentFile -Destination $environmentPath
      Write-Host "Imported the existing Raydio environment file."
    } else {
      Write-Host "Migrating an existing Raydio installation? Copy its .env file to:" -ForegroundColor Cyan
      Write-Host $environmentPath -ForegroundColor Cyan
      Read-Host "After copying it, press Enter to continue; otherwise press Enter to enter the Discord token"
    }
  }

  $sourceLines = if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
    @(Get-Content -LiteralPath $environmentPath)
  } else {
    @(Get-Content -LiteralPath $examplePath)
  }
  $lines = New-Object "System.Collections.Generic.List[string]"
  $sourceLines | ForEach-Object { $lines.Add($_) }

  $discordToken = Get-EnvironmentValue $lines "DISCORD_TOKEN"
  if ([string]::IsNullOrWhiteSpace($discordToken)) {
    $discordToken = Read-SecretText "Paste the Discord bot token (input is hidden)"
  }
  if ([string]::IsNullOrWhiteSpace($discordToken) -or $discordToken -match "[\r\n]") {
    throw "The Discord token must be one non-empty line."
  }
  $lavalinkPassword = Get-EnvironmentValue $lines "LAVALINK_PASSWORD"
  if ([string]::IsNullOrWhiteSpace($lavalinkPassword)) {
    $lavalinkPassword = New-RandomHex
  }
  Set-EnvironmentValue $lines "DISCORD_TOKEN" $discordToken
  Set-EnvironmentValue $lines "LAVALINK_PASSWORD" $lavalinkPassword

  $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllLines($environmentPath, $lines, $utf8WithoutBom)
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  Invoke-Checked "icacls.exe" @(
    $environmentPath, "/inheritance:r", "/grant:r", "${currentUser}:(F)"
  )
}

function Register-StartupTask {
  $manager = Join-Path $RepositoryRoot "scripts\windows\raydio.ps1"
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$manager`" start"
  $action = New-ScheduledTaskAction -Execute "$PSHOME\powershell.exe" -Argument $arguments
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settingsArguments = @{
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    RestartCount = 3
    RestartInterval = New-TimeSpan -Minutes 1
    ExecutionTimeLimit = New-TimeSpan -Minutes 10
  }
  $settings = New-ScheduledTaskSettingsSet @settingsArguments
  $taskArguments = @{
    TaskName = $TaskName
    Action = $action
    Trigger = $trigger
    Principal = $principal
    Settings = $settings
    Force = $true
  }
  Register-ScheduledTask @taskArguments | Out-Null
}

Save-Installer

if (-not [string]::IsNullOrWhiteSpace($EnvironmentFile)) {
  if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
    throw "The requested environment file does not exist: $EnvironmentFile"
  }
  $EnvironmentFile = (Resolve-Path -LiteralPath $EnvironmentFile).Path
}

if (-not (Test-Administrator)) {
  $resumeArgument = if ($Resume) { " -Resume" } else { "" }
  $noRestartArgument = if ($NoRestart) { " -NoRestart" } else { "" }
  $confirmationArgument = if ($SkipOtherHostConfirmation) { " -SkipOtherHostConfirmation" } else { "" }
  $environmentArgument = if ([string]::IsNullOrWhiteSpace($EnvironmentFile)) {
    ""
  } else {
    " -EnvironmentFile `"$EnvironmentFile`""
  }
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$SavedInstaller`"$resumeArgument$noRestartArgument$confirmationArgument$environmentArgument"
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "The elevated Raydio installer failed with exit code $($process.ExitCode)."
  }
  return
}

$operatingSystem = Get-CimInstance Win32_OperatingSystem
$buildNumber = [int]$operatingSystem.BuildNumber
if ($buildNumber -lt 19043) {
  throw "Raydio requires Windows 10 build 19043 or newer. This system reports build $buildNumber."
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "This installer currently supports 64-bit Intel/AMD Windows only."
}
$memoryGiB = [math]::Floor([double]$operatingSystem.TotalVisibleMemorySize / 1MB)
if ($memoryGiB -lt 6) {
  throw "Podman Desktop requires at least 6 GiB of system RAM; this system reports about $memoryGiB GiB."
}

$restartRequired = $false
foreach ($featureName in @("Microsoft-Windows-Subsystem-Linux", "VirtualMachinePlatform")) {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
  if ($feature.State -ne "Enabled") {
    Write-Host "Enabling Windows feature: $featureName"
    Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart | Out-Null
    $restartRequired = $true
  }
}

if ($restartRequired) {
  Set-ResumeAfterLogon
  Write-Host "Windows must restart once to finish enabling WSL2. Setup will resume automatically after sign-in." -ForegroundColor Yellow
  if ($NoRestart) {
    Write-Host "Restart Windows when convenient; the installer will resume at the next sign-in."
    return
  }
  $answer = Read-Host "Restart now? [Y/n]"
  if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match "^[Yy]") {
    Restart-Computer
  } else {
    Write-Host "Restart Windows when convenient; the installer will resume at the next sign-in."
  }
  return
}

Ensure-WinGet
Install-WinGetPackage "Git.Git"
Install-WinGetPackage "RedHat.Podman"
Refresh-Path

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
  throw "Git was installed but is not available on PATH. Sign out, sign in, and rerun the installer."
}
if (-not (Get-Command podman.exe -ErrorAction SilentlyContinue)) {
  throw "Podman was installed but is not available on PATH. Sign out, sign in, and rerun the installer."
}

Invoke-Checked "wsl.exe" @("--update")
Ensure-PodmanMachine
Ensure-Repository
Ensure-ComposeProvider
Ensure-EnvironmentFile

if (-not $SkipOtherHostConfirmation) {
  Write-Warning "Only one Raydio deployment may use this Discord token at a time. Stop Raydio on Fedora before continuing."
  $answer = Read-Host "Confirm the Fedora deployment is stopped [y/N]"
  if ($answer -notmatch "^[Yy]") {
    throw "The Windows deployment was prepared but not started. Stop the other host, then rerun: & '$SavedInstaller' -Resume"
  }
}

Register-StartupTask
& (Join-Path $RepositoryRoot "scripts\windows\raydio.ps1") restart
if ($LASTEXITCODE -ne 0) {
  throw "Raydio was installed, but its first start failed."
}

Write-Host "Raydio is installed and running." -ForegroundColor Green
Write-Host "Management command: & '$RepositoryRoot\scripts\windows\raydio.ps1' <status|logs|update|restart|stop|doctor>"

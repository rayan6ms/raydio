[CmdletBinding()]
param(
  [ValidateSet("start", "restart", "stop", "update", "status", "logs", "doctor")]
  [string]$Action = "status"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$InstallRoot = Split-Path $RepositoryRoot -Parent
$ComposeProvider = Join-Path $InstallRoot "tools\docker-compose.exe"
$ProjectName = "raydio"

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

function Assert-Dependencies {
  Refresh-Path
  if (-not (Get-Command podman.exe -ErrorAction SilentlyContinue)) {
    throw "Podman is not installed. Run scripts\windows\install-raydio.ps1 first."
  }
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "Git is not installed. Run scripts\windows\install-raydio.ps1 first."
  }
  if (-not (Test-Path -LiteralPath $ComposeProvider -PathType Leaf)) {
    throw "The pinned Compose provider is missing. Run scripts\windows\install-raydio.ps1 first."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot ".env") -PathType Leaf)) {
    throw "Raydio's .env file is missing. Run scripts\windows\install-raydio.ps1 first."
  }
  $env:PODMAN_COMPOSE_PROVIDER = $ComposeProvider
}

function Wait-Podman {
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $rootless = ((& podman.exe info --format "{{.Host.Security.Rootless}}" 2>$null) -join "").Trim()
    if ($LASTEXITCODE -eq 0) {
      if ($rootless -ne "true") {
        throw "The active Podman machine is not rootless. Run 'podman machine set --rootful=false'."
      }
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "Podman did not become ready within two minutes."
}

function Ensure-PodmanMachine {
  & podman.exe info *> $null
  if ($LASTEXITCODE -eq 0) {
    Wait-Podman
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
  Wait-Podman
}

function Invoke-Compose {
  param([Parameter(Mandatory = $true)][string[]]$ArgumentList)

  Push-Location $RepositoryRoot
  try {
    Invoke-Checked "podman.exe" (@("compose", "--project-name", $ProjectName) + $ArgumentList)
  } finally {
    Pop-Location
  }
}

function Get-ContainerValue {
  param(
    [Parameter(Mandatory = $true)][string]$ContainerName,
    [Parameter(Mandatory = $true)][string]$Template
  )

  $value = & podman.exe inspect --format $Template $ContainerName 2>$null
  if ($LASTEXITCODE -ne 0) {
    return ""
  }
  return ($value -join "`n").Trim()
}

function Wait-Raydio {
  param([switch]$RequireFreshStartup)

  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    $lavalinkHealth = Get-ContainerValue "raydio-lavalink-1" "{{.State.Health.Status}}"
    $botRunning = Get-ContainerValue "raydio-bot-1" "{{.State.Running}}"
    if ($lavalinkHealth -eq "healthy" -and $botRunning -eq "true") {
      if (-not $RequireFreshStartup) {
        Write-Host "Raydio is running and Lavalink is healthy." -ForegroundColor Green
        return
      }

      $botLogs = (& podman.exe logs --since 3m raydio-bot-1 2>&1) -join "`n"
      $lavalinkLogs = (& podman.exe logs --since 3m raydio-lavalink-1 2>&1) -join "`n"
      if (
        $botLogs.Contains('"event":"discord_ready"') -and
        $botLogs.Contains('"event":"lavalink_ready"') -and
        $botLogs.Contains('"event":"application_commands_ready"') -and
        $lavalinkLogs.Contains("Native library dave-jvm: successfully loaded.")
      ) {
        Write-Host "Raydio is ready: Discord connected, commands synchronized, and DAVE loaded." -ForegroundColor Green
        return
      }
    }
    Start-Sleep -Seconds 2
  }

  Invoke-Compose @("ps")
  & podman.exe logs --tail 100 raydio-lavalink-1
  & podman.exe logs --tail 100 raydio-bot-1
  throw "Raydio did not pass its readiness checks within three minutes."
}

function Start-Raydio {
  param([switch]$Rebuild)

  Ensure-PodmanMachine
  if ($Rebuild) {
    Invoke-Compose @("up", "--detach", "--build", "--force-recreate")
    Wait-Raydio -RequireFreshStartup
  } else {
    Invoke-Compose @("up", "--detach")
    Wait-Raydio
  }
}

Assert-Dependencies

switch ($Action) {
  "start" {
    Start-Raydio
  }
  "restart" {
    Start-Raydio -Rebuild
  }
  "stop" {
    Ensure-PodmanMachine
    Invoke-Compose @("down")
    Write-Host "Raydio stopped."
  }
  "update" {
    Refresh-Path
    $dirty = (& git.exe -C $RepositoryRoot status --porcelain) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($dirty)) {
      throw "The Raydio checkout has local changes. Preserve or discard them deliberately before updating."
    }
    $branch = ((& git.exe -C $RepositoryRoot branch --show-current) -join "").Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
      throw "Raydio must be on the main branch before an automatic update."
    }
    Invoke-Checked "git.exe" @("-C", $RepositoryRoot, "fetch", "origin", "main", "--prune")
    Invoke-Checked "git.exe" @("-C", $RepositoryRoot, "merge", "--ff-only", "origin/main")
    Start-Raydio -Rebuild
  }
  "status" {
    Ensure-PodmanMachine
    Invoke-Compose @("ps")
    Wait-Raydio
  }
  "logs" {
    Ensure-PodmanMachine
    Invoke-Compose @("logs", "--tail", "200", "bot", "lavalink")
  }
  "doctor" {
    Ensure-PodmanMachine
    Invoke-Compose @("config", "--quiet")
    Invoke-Compose @("ps")
    Wait-Raydio
    $daveLogs = (& podman.exe logs --since 24h raydio-lavalink-1 2>&1) -join "`n"
    if (-not $daveLogs.Contains("Native library dave-jvm: successfully loaded.")) {
      throw "Lavalink is healthy, but a successful DAVE native-library load was not found in recent logs."
    }
    Write-Host "Raydio doctor passed." -ForegroundColor Green
  }
}

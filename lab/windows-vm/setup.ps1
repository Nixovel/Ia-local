# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# Configuration du labo « Windows complet » au premier démarrage (lancée par autounattend.xml depuis le CD de Lumen) :
# pilotes virtio, réglages, OpenSSH Server (clé de Lumen), PowerShell 7, LLVM-MinGW (compilation .exe ARM64 et x64),
# commande « lumen-gui » (lance un programme sur le bureau). Écrit C:\lumen\ready à la fin : la machine est prête.
# Compatible Windows PowerShell 5.1 (pas encore de PowerShell 7 au premier démarrage).
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { $Host.UI.RawUI.WindowTitle = 'Lumen : préparation du labo Windows' } catch {}
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path C:\lumen, C:\lumen\bin, C:\labo | Out-Null
Start-Transcript -Path C:\lumen\setup.log -Append | Out-Null

function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Warn([string]$text) { Write-Host "   $text" -ForegroundColor Yellow }
function Add-MachinePath([string]$dir) {
  $p = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($p -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', "$p;$dir", 'Machine') }
  $env:Path = "$env:Path;$dir"
}
function Get-LatestAsset([string]$repo, [string]$pattern) {
  $rel = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'Lumen-Labo' } "https://api.github.com/repos/$repo/releases/latest"
  $asset = $rel.assets | Where-Object { $_.name -like $pattern } | Select-Object -First 1
  if (-not $asset) { throw "aucun fichier $pattern dans $repo $($rel.tag_name)" }
  Write-Host "   $($asset.name) ($([math]::Round($asset.size / 1MB)) Mo)"
  return $asset
}
function Get-File([string]$url, [string]$out) {
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out; return } catch { Warn "essai $i : $($_.Exception.Message)"; Start-Sleep 5 }
  }
  throw "téléchargement impossible : $url"
}

Step 'Pilotes virtio (réseau, générateur aléatoire, mémoire)'
pnputil.exe /add-driver "$src\drivers\*.inf" /subdirs /install | Out-Host

Step 'Réglages de la machine'
powercfg.exe /change standby-timeout-ac 0
powercfg.exe /change monitor-timeout-ac 0
powercfg.exe /change hibernate-timeout-ac 0
powercfg.exe /hibernate off
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 3 # bouton d'alimentation = éteindre
powercfg.exe /setactive SCHEME_CURRENT
net.exe accounts /maxpwage:unlimited | Out-Null
$values = @(
  @('HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization', 'NoLockScreen', 1),
  @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System', 'LocalAccountTokenFilterPolicy', 1),
  @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System', 'ConsentPromptBehaviorAdmin', 0),
  @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System', 'PromptOnSecureDesktop', 0),
  @('HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU', 'NoAutoRebootWithLoggedOnUsers', 1),
  @('HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU', 'AUOptions', 2), # mises à jour : prévenir avant de télécharger
  @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced', 'HideFileExt', 0),
  @('HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications', 'ToastEnabled', 0)
)
foreach ($v in $values) {
  # Jamais « New-Item -Force » sur une clé existante : il la recrée vide (perte de ses autres valeurs)
  if (-not (Test-Path $v[0])) { New-Item -Path $v[0] -Force | Out-Null }
  Set-ItemProperty -Path $v[0] -Name $v[1] -Value $v[2] -Type DWord
}
try { Add-MpPreference -ExclusionPath 'C:\labo', 'C:\llvm-mingw' -ErrorAction Stop } catch { Warn "Defender : $($_.Exception.Message)" }

Step 'Attente du réseau'
$online = $false
for ($i = 0; $i -lt 90; $i++) {
  try { [void][Net.Dns]::GetHostAddresses('api.github.com'); $online = $true; break } catch { Start-Sleep 2 }
}
if ($online) { Write-Host '   connecté' } else { Warn 'pas de réseau : les outils en ligne sont ignorés' }
Get-NetConnectionProfile -ErrorAction SilentlyContinue | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue

Step 'OpenSSH Server'
# Dernière version publiée par Microsoft sur GitHub (rapide) ; la fonctionnalité facultative de Windows passe par
# Windows Update, qui peut rester occupé pendant des heures juste après l'installation : en secours seulement, 10 min au plus.
if ($online -and -not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  try {
    $a = Get-LatestAsset 'PowerShell/Win32-OpenSSH' 'OpenSSH-ARM64-*.msi'
    Get-File $a.browser_download_url "$env:TEMP\openssh.msi"
    Start-Process msiexec.exe -Wait -ArgumentList "/i `"$env:TEMP\openssh.msi`" /qn"
  } catch { Warn "OpenSSH (GitHub) : $($_.Exception.Message)" }
}
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  Warn 'installation par Windows Update (10 min au plus)'
  $job = Start-Job {
    $cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*' | Select-Object -First 1
    if ($cap -and $cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
  }
  if (-not (Wait-Job $job -Timeout 600)) { Warn 'Windows Update ne répond pas : délai dépassé' }
  Remove-Job $job -Force
}
New-Item -ItemType Directory -Force -Path C:\ProgramData\ssh | Out-Null
Copy-Item "$src\authorized_keys" C:\ProgramData\ssh\administrators_authorized_keys -Force
# Droits exigés par sshd : Administrateurs (S-1-5-32-544) et SYSTEM (S-1-5-18) seulement
icacls.exe C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
Set-Service sshd -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service sshd -ErrorAction SilentlyContinue
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
}
if (-not (Get-NetFirewallRule -Name 'Lumen-Labo-Serveurs' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'Lumen-Labo-Serveurs' -DisplayName 'Lumen Labo (ports 8000 à 8004)' -Direction Inbound -Protocol TCP -LocalPort 8000-8004 -Action Allow | Out-Null
}
Write-Host "   sshd : $((Get-Service sshd -ErrorAction SilentlyContinue).Status)"

if ($online) {
  Step 'PowerShell 7 (dernière version)'
  try {
    $a = Get-LatestAsset 'PowerShell/PowerShell' 'PowerShell-*-win-arm64.zip'
    Get-File $a.browser_download_url "$env:TEMP\pwsh.zip"
    $dir = 'C:\Program Files\PowerShell\7'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    tar.exe -xf "$env:TEMP\pwsh.zip" -C $dir
    Add-MachinePath $dir
  } catch { Warn "PowerShell 7 : $($_.Exception.Message)" }

  Step 'LLVM-MinGW (compilateur C/C++ : .exe ARM64 et x64)'
  try {
    $a = Get-LatestAsset 'mstorsjo/llvm-mingw' 'llvm-mingw-*-ucrt-aarch64.zip'
    Get-File $a.browser_download_url "$env:TEMP\llvm-mingw.zip"
    tar.exe -xf "$env:TEMP\llvm-mingw.zip" -C C:\
    $d = Get-ChildItem C:\ -Directory -Filter 'llvm-mingw-*' | Sort-Object Name -Descending | Select-Object -First 1
    if (Test-Path C:\llvm-mingw) { Remove-Item -Recurse -Force C:\llvm-mingw }
    Rename-Item $d.FullName 'llvm-mingw'
    Add-MachinePath 'C:\llvm-mingw\bin'
  } catch { Warn "LLVM-MinGW : $($_.Exception.Message)" }
  Remove-Item "$env:TEMP\*.zip", "$env:TEMP\*.msi" -Force -ErrorAction SilentlyContinue
}

Step 'Outils de Lumen'
# lumen-gui : lance un programme sur le bureau (session de l'utilisateur, visible à l'écran) depuis SSH
Set-Content -Encoding UTF8 -Path C:\lumen\bin\lumen-gui.ps1 -Value @'
# Lumen — lance un programme sur le bureau de Windows (visible à l'écran), même depuis une session SSH.
# Exemples : lumen-gui notepad.exe C:\labo\notes.txt   ·   lumen-gui C:\labo\app.exe --option
param([Parameter(Mandatory = $true, Position = 0)][string]$Program, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$exe = $Program
if (Test-Path -LiteralPath $Program) { $exe = (Resolve-Path -LiteralPath $Program).Path }
else { $cmd = Get-Command $Program -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($cmd) { $exe = $cmd.Source } }
$argLine = ($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
Get-ScheduledTask -TaskName 'LumenGui-*' -ErrorAction SilentlyContinue | Where-Object State -ne 'Running' | Unregister-ScheduledTask -Confirm:$false
$name = 'LumenGui-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$wd = (Get-Location).Path
if ($argLine) { $action = New-ScheduledTaskAction -Execute $exe -Argument $argLine -WorkingDirectory $wd } else { $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $wd }
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Lancé sur le bureau de Windows : $exe $argLine"
'@
Set-Content -Encoding ASCII -Path C:\lumen\bin\lumen-gui.cmd -Value '@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0lumen-gui.ps1" %*'
Add-MachinePath 'C:\lumen\bin'
Restart-Service sshd -ErrorAction SilentlyContinue # nouvelles sessions SSH : PATH à jour

Step 'Fin'
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue # bureau dégagé pour les captures
$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$parts = @("Windows 11 $($cv.DisplayVersion) (build $($cv.CurrentBuild).$($cv.UBR), ARM64)")
$pw = 'C:\Program Files\PowerShell\7\pwsh.exe'
if (Test-Path $pw) { $parts += 'PowerShell ' + (& $pw -NoProfile -Command '$PSVersionTable.PSVersion.ToString()') }
$sshdExe = (Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue).PathName
if ($sshdExe) { $parts += 'OpenSSH ' + (Get-Item $sshdExe.Trim('"')).VersionInfo.ProductVersion }
if (Test-Path C:\llvm-mingw\bin\clang.exe) {
  $v = (& C:\llvm-mingw\bin\clang.exe --version | Select-Object -First 1) -replace '.*version\s+([0-9.]+).*', '$1'
  $parts += "LLVM-MinGW (clang $v)"
}
[IO.File]::WriteAllText('C:\lumen\versions.txt', ($parts -join ' · '))
[IO.File]::WriteAllText('C:\lumen\ready', (Get-Date -Format o))
Write-Host ($parts -join ' · ')
Stop-Transcript | Out-Null
Write-Host ''
Write-Host 'Labo prêt. Cette fenêtre se ferme dans 15 s.' -ForegroundColor Green
Start-Sleep 15

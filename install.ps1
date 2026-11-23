# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# ──────────────────────────────────────────────────────────────────────────────
#  Installateur de Lumen — Windows 10 / 11 (macOS et Linux : install.sh)
#
#  Une commande dans PowerShell installe tout, en détectant la machine :
#    irm https://raw.githubusercontent.com/Nixovel/Ia-local/main/install.ps1 | iex
#  ou, depuis le dossier du dépôt :  powershell -ExecutionPolicy Bypass -File install.ps1
#
#  Étapes : système et processeur → Lumen → Node.js (portable, sans droits admin) → Ollama
#           → dépendances et build → modèle de départ adapté à la RAM → vérification → raccourcis → lancement.
#
#  Options (variables d'environnement, ex. $env:LUMEN_NO_MODEL = '1') :
#    LUMEN_REPO, LUMEN_BRANCH, LUMEN_HOME, LUMEN_NO_MODEL, LUMEN_NO_LAUNCH, LUMEN_NO_SHORTCUTS, LUMEN_SKIP_OLLAMA, OLLAMA_URL
# ──────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # les barres de progression ralentissent beaucoup les téléchargements
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Opt($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }
$Repo = Opt 'LUMEN_REPO' 'Nixovel/Ia-local'
$Branch = Opt 'LUMEN_BRANCH' 'main'
$LumenHome = Opt 'LUMEN_HOME' (Join-Path $env:LOCALAPPDATA 'Lumen')
$OllamaUrl = (Opt 'OLLAMA_URL' 'http://127.0.0.1:11434').TrimEnd('/')

function Step($t) { Write-Host "`n> $t" -ForegroundColor Yellow }
function Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Info($t) { Write-Host "  $t" -ForegroundColor DarkGray }
function Warn($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Die($t) { Write-Host "`n  [X] $t`n" -ForegroundColor Red; throw $t }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Up($url) { try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3 | Out-Null; $true } catch { $false } }
function Ask($q) {
  try { $a = Read-Host "  $q [O/n]" } catch { $a = '' }
  -not ($a -match '^[nN]')
}

Write-Host "`n  Lumen - installation de votre interface IA locale" -ForegroundColor Yellow
Write-Host '  par Nixovel - https://github.com/Nixovel/Ia-local - (c) 2026, tous droits réservés' -ForegroundColor DarkGray
New-Item -ItemType Directory -Force -Path $LumenHome | Out-Null

# ── 1. Machine ────────────────────────────────────────────────────────────────
Step 'Analyse de la machine'
$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } 'AMD64' { 'x64' } default { Die "Processeur non pris en charge : $env:PROCESSOR_ARCHITECTURE" } }
$osName = (Get-CimInstance Win32_OperatingSystem).Caption
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Ok "$osName - processeur $arch - $ramGB Go de RAM"

# ── 2. Lumen ──────────────────────────────────────────────────────────────────
Step 'Lumen'
$here = $PSScriptRoot
if ($here -and (Test-Path (Join-Path $here 'package.json')) -and (Select-String -Path (Join-Path $here 'package.json') -Pattern '"name": "lumen"' -Quiet)) {
  $AppDir = $here
  Ok "Dossier du dépôt : $AppDir"
} else {
  $AppDir = Join-Path $LumenHome 'app'
  if ((Has git) -and (Test-Path (Join-Path $AppDir '.git'))) {
    git -C $AppDir pull --ff-only --quiet; Ok "Mis à jour : $AppDir"
  } elseif (Has git) {
    git clone --quiet --depth 1 --branch $Branch "https://github.com/$Repo.git" $AppDir; Ok "Téléchargé dans $AppDir"
  } else {
    $zip = Join-Path $env:TEMP 'lumen.zip'; $tmp = Join-Path $env:TEMP ('lumen-' + [guid]::NewGuid())
    Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $tmp -Force
    if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
    Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $AppDir
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Ok "Téléchargé dans $AppDir"
  }
}

# ── 3. Node.js ────────────────────────────────────────────────────────────────
Step 'Node.js'
function NodeOk($exe) {
  try { & $exe -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)' 2>$null; $LASTEXITCODE -eq 0 } catch { $false }
}
$NodeDir = Join-Path $LumenHome 'node'
if ((Has node) -and (NodeOk 'node')) {
  Ok "Node.js $(node -v) déjà installé"
} elseif ((Test-Path (Join-Path $NodeDir 'node.exe')) -and (NodeOk (Join-Path $NodeDir 'node.exe'))) {
  $env:Path = "$NodeDir;$env:Path"; Ok "Node.js $(node -v) (portable, $NodeDir)"
} else {
  Info "Installation de Node.js 24 (portable, dans $NodeDir, sans droits administrateur)..."
  $base = 'https://nodejs.org/dist/latest-v24.x'
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $line = $sums | Where-Object { $_ -match "\s(node-v[\d.]+-win-$arch\.zip)$" } | Select-Object -First 1
  if (-not $line) { Die "Aucune version de Node.js pour Windows $arch." }
  $expected, $file = ($line.Trim() -split '\s+')
  $zip = Join-Path $env:TEMP $file
  Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected.ToLower()) { Die 'Empreinte SHA-256 de Node.js incorrecte : téléchargement corrompu.' }
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  Expand-Archive $zip -DestinationPath $LumenHome -Force
  Rename-Item (Join-Path $LumenHome ($file -replace '\.zip$', '')) 'node'
  Remove-Item $zip -Force
  $env:Path = "$NodeDir;$env:Path"
  Ok "Node.js $(node -v) installé (empreinte vérifiée)"
}

# ── 4. Ollama ─────────────────────────────────────────────────────────────────
Step "Ollama (fait tourner les modèles d'IA)"
$OllamaDir = Join-Path $env:LOCALAPPDATA 'Programs\Ollama'
function StartOllama {
  $app = Join-Path $OllamaDir 'ollama app.exe'
  if (Test-Path $app) { Start-Process $app }
  elseif (Has ollama) { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden }
  for ($i = 0; $i -lt 40; $i++) { if (Up "$OllamaUrl/api/version") { return $true }; Start-Sleep 1 }
  $false
}
if (Up "$OllamaUrl/api/version") {
  Ok "Ollama répond ($((Invoke-RestMethod "$OllamaUrl/api/version").version))"
} elseif ($env:LUMEN_SKIP_OLLAMA -eq '1') {
  Warn "Installation d'Ollama ignorée (LUMEN_SKIP_OLLAMA=1)"
} else {
  if (-not (Has ollama) -and -not (Test-Path (Join-Path $OllamaDir 'ollama.exe'))) {
    if (Has winget) {
      Info "Installation d'Ollama avec winget..."
      winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
    }
    if (-not (Test-Path (Join-Path $OllamaDir 'ollama.exe'))) {
      Info "Téléchargement de l'installateur officiel d'Ollama..."
      $setup = Join-Path $env:TEMP 'OllamaSetup.exe'
      Invoke-WebRequest 'https://ollama.com/download/OllamaSetup.exe' -OutFile $setup -UseBasicParsing
      Start-Process $setup -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' -Wait
      Remove-Item $setup -Force -ErrorAction SilentlyContinue
    }
    Ok 'Ollama installé'
  }
  $env:Path = "$OllamaDir;$env:Path"
  if (StartOllama) { Ok 'Ollama démarré' } else { Warn "Ollama ne répond pas encore : lancez Ollama depuis le menu Démarrer, puis Lumen." }
}

# ── 5. Dépendances et build ───────────────────────────────────────────────────
Step 'Dépendances de Lumen'
Set-Location $AppDir
Info 'npm install (quelques minutes la première fois)...'
# npm.cmd (et non npm.ps1) : fonctionne même quand Windows bloque les scripts PowerShell
npm.cmd ci --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Die 'npm ci a échoué.' }
Ok 'Dépendances installées'
Info "Construction de l'application..."
$buildLog = Join-Path $LumenHome 'build.log'
cmd /c "npm.cmd run build > `"$buildLog`" 2>&1"
if ($LASTEXITCODE -ne 0) { Die "La construction a échoué : voir $buildLog" }
Ok 'Application construite'

# ── 6. Modèle de départ ───────────────────────────────────────────────────────
if ($env:LUMEN_NO_MODEL -ne '1' -and (Up "$OllamaUrl/api/version")) {
  Step "Modèle d'IA de départ"
  $installed = @((Invoke-RestMethod "$OllamaUrl/api/tags").models).Count
  if ($ramGB -ge 15) { $model = 'qwen3:8b'; $size = '5,2 Go' } elseif ($ramGB -ge 7) { $model = 'qwen3:4b'; $size = '2,5 Go' } else { $model = 'qwen3:1.7b'; $size = '1,4 Go' }
  if ($installed -gt 0) {
    Ok "$installed modèle(s) déjà installé(s) - l'assistant de Lumen vous en proposera d'autres"
  } elseif (Ask "Télécharger $model ($size, adapté à $ramGB Go de RAM) pour commencer ?") {
    $ollamaExe = Join-Path $OllamaDir 'ollama.exe'
    if (Test-Path $ollamaExe) { & $ollamaExe pull $model } else { Invoke-RestMethod "$OllamaUrl/api/pull" -Method Post -Body (@{ model = $model; stream = $false } | ConvertTo-Json) | Out-Null }
    Ok "$model installé"
  }
}

# ── 7. Vérification ───────────────────────────────────────────────────────────
Step 'Vérification'
$env:OLLAMA_URL = $OllamaUrl
node scripts/doctor.mjs --quiet
if ($LASTEXITCODE -ne 0) { Warn 'Certaines vérifications ont échoué (détails ci-dessus).' }

# ── 8. Commande « lumen » et raccourcis ───────────────────────────────────────
$launcher = Join-Path $LumenHome 'lumen.ps1'
if ($env:LUMEN_NO_SHORTCUTS -ne '1') {
  Step 'Raccourcis'
  $nodeBin = Split-Path (Get-Command node).Source
  # Modèle sans expansion (@' '@) : les variables du lanceur restent intactes, seuls les __CHAMPS__ sont remplacés
  $tpl = @'
# Lance Lumen : démarre Ollama si besoin, le serveur local, puis ouvre le navigateur.
#   lumen          lancer       lumen update   mettre à jour       lumen doctor   tout vérifier
$env:Path = '__NODE_BIN__;__OLLAMA_DIR__;' + $env:Path
$env:OLLAMA_URL = '__OLLAMA_URL__'
Set-Location '__APP_DIR__'
if ($args[0] -eq 'update') { & powershell -NoProfile -ExecutionPolicy Bypass -File '__APP_DIR__\install.ps1'; exit }
if ($args[0] -eq 'doctor') { node scripts/doctor.mjs; exit }
function Up($u) { try { Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2 | Out-Null; $true } catch { $false } }
$url = 'http://127.0.0.1:4173'
if (-not (Up "$env:OLLAMA_URL/api/version")) {
  $app = '__OLLAMA_DIR__\ollama app.exe'
  if (Test-Path $app) { Start-Process $app } else { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden }
  for ($i = 0; $i -lt 30; $i++) { if (Up "$env:OLLAMA_URL/api/version") { break }; Start-Sleep 1 }
}
if (Up $url) { Start-Process $url; exit }
# Ouvre le navigateur dès que le serveur répond (petit processus en arrière-plan)
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "for (`$i = 0; `$i -lt 60; `$i++) { try { Invoke-WebRequest '$url' -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process '$url'; break } catch { Start-Sleep -Milliseconds 500 } }"
Write-Host "Lumen tourne sur $url - fermez cette fenêtre pour l'arrêter." -ForegroundColor Yellow
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort
'@
  function Q($s) { $s.Replace("'", "''") } # apostrophes dans les chemins (ex. C:\Users\O'Brien)
  $tpl.Replace('__NODE_BIN__', (Q $nodeBin)).Replace('__OLLAMA_DIR__', (Q $OllamaDir)).Replace('__OLLAMA_URL__', (Q $OllamaUrl)).Replace('__APP_DIR__', (Q $AppDir)) |
    Set-Content -Path $launcher -Encoding UTF8
  "@powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0lumen.ps1`" %*" | Set-Content -Path (Join-Path $LumenHome 'lumen.cmd') -Encoding ASCII
  Ok "Commande : $LumenHome\lumen.cmd"

  # « lumen » dans tous les terminaux (PATH de l'utilisateur, sans droits admin)
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $LumenHome })) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$LumenHome"), 'User')
  }

  # Raccourcis Menu Démarrer et Bureau
  $shell = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'Lumen.lnk'))
    $lnk.TargetPath = 'powershell.exe'
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
    $lnk.WorkingDirectory = $AppDir
    $lnk.WindowStyle = 7 # réduite
    $lnk.Description = "Lumen - interface pour vos modèles d'IA locaux"
    $lnk.Save()
  }
  Ok 'Raccourcis : Menu Démarrer et Bureau'
}

# ── 9. Lancement ──────────────────────────────────────────────────────────────
Write-Host "`n  Lumen est installé." -ForegroundColor Green
Info 'Lancer plus tard : raccourci « Lumen », ou « lumen » dans un nouveau terminal. Vérifier : « lumen doctor ».'
if ($env:LUMEN_NO_LAUNCH -ne '1' -and $env:LUMEN_NO_SHORTCUTS -ne '1') {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
}

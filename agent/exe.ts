// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Compilateur .exe de l'agent (outil build_exe) : transforme un programme C, C++, C#, Go, Rust ou Python en
 * exécutable Windows, le teste dans Windows et le dépose dans « ~/Lumen Labo/exe ».
 *  - C, C++, C#, Go, Rust : compilation croisée dans le labo Linux (natif, rapide) par lab/lumen-exe.sh ; les
 *    compilateurs (dernières versions) s'installent au premier besoin dans « Lumen Labo/linux/.outils ».
 *  - Python (PyInstaller ne fonctionne que sous Windows), et C/C++ sur demande : dans la vraie machine Windows
 *    (labo « Windows complet », LLVM-MinGW natif).
 *  - Test : dans la vraie machine Windows 11 si elle est installée (x64 émulé et ARM64 natif ; console : sortie et
 *    code de sortie ; fenêtre : capture d'écran) ; sinon le test est sauté (le labo « Windows complet » est requis).
 */
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { labTool, WORK_ROOT, type Emit } from './lab'
import { vmCopyOut, vmStatus } from './winvm'

type ToolResult = { ok: boolean; output: string; image?: string }
type Lang = 'c' | 'cpp' | 'csharp' | 'go' | 'rust' | 'python'
type Arch = 'x64' | 'arm64'
type Pe = { machine: 'x64' | 'arm64' | 'x86' | '?'; gui: boolean }

const noop: Emit = () => {}
const SCRIPT = fileURLToPath(new URL('../lab/lumen-exe.sh', import.meta.url))
export const EXE_DIR = path.join(WORK_ROOT, 'exe')
const LINUX_WS = path.join(WORK_ROOT, 'linux') // = /workspace du labo Linux
const BUILD_ROOT = path.join(LINUX_WS, '.exe-build')

const ALIASES: Record<string, Lang> = {
  c: 'c', cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', cc: 'cpp', csharp: 'csharp', 'c#': 'csharp', cs: 'csharp', dotnet: 'csharp', '.net': 'csharp',
  go: 'go', golang: 'go', rust: 'rust', rs: 'rust', python: 'python', py: 'python',
}
const EXT: Record<string, Lang> = { '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.cs': 'csharp', '.csproj': 'csharp', '.go': 'go', '.rs': 'rust', '.py': 'python', '.pyw': 'python' }
const MAIN: Record<Lang, string> = { c: 'main.c', cpp: 'main.cpp', csharp: 'Program.cs', go: 'main.go', rust: path.join('src', 'main.rs'), python: 'main.py' }
const LABEL: Record<Lang, string> = { c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go', rust: 'Rust', python: 'Python' }
const SKIP = new Set(['node_modules', '.git', 'target', 'bin', 'obj', 'dist', 'build', '__pycache__', '.venv', 'venv', '.exe-build', '.outils'])

const CONSOLE_HINT =
  "→ Une application à fenêtre qui s'arrête aussitôt est en général un programme console (printf, Console.WriteLine, print… sans fenêtre) : recompile-le avec gui=false pour voir sa sortie. Sinon, lis l'erreur et corrige le code."
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`
const size = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`)

/** Langage deviné à partir du code (quand le modèle ne le précise pas). */
function guessLang(code: string): Lang | null {
  if (/^\s*package\s+main\b/m.test(code)) return 'go'
  if (/\bfn\s+main\s*\(/.test(code)) return 'rust'
  if (/\busing\s+System\b|\bstatic\s+void\s+Main\s*\(|Console\.Write/.test(code)) return 'csharp'
  if (/#include\s*<(iostream|vector|string|map|memory)>|\bstd::|\bclass\s+\w+\s*\{/.test(code)) return 'cpp'
  if (/#include\s*[<"]/.test(code)) return 'c'
  if (/^\s*(def |import |from \S+ import |print\()/m.test(code)) return 'python'
  return null
}

/** Langage le plus représenté parmi les fichiers d'un dossier. */
async function langOfDir(dir: string): Promise<Lang | null> {
  if (existsSync(path.join(dir, 'Cargo.toml'))) return 'rust'
  if (existsSync(path.join(dir, 'go.mod'))) return 'go'
  const count = new Map<Lang, number>()
  const walk = async (d: string, depth: number) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      if (e.isDirectory()) {
        if (depth < 4) await walk(path.join(d, e.name), depth + 1)
      } else {
        const l = EXT[path.extname(e.name).toLowerCase()]
        if (l) count.set(l, (count.get(l) ?? 0) + (e.name.endsWith('.csproj') ? 10 : 1))
      }
    }
  }
  await walk(dir, 0)
  // C++ l'emporte sur C dans un projet mixte
  if (count.get('cpp') && count.get('c')) count.set('cpp', (count.get('cpp') ?? 0) + (count.get('c') ?? 0))
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** Architecture et type (console / fenêtre) d'un exécutable Windows, lus dans son en-tête PE. */
function peInfo(b: Buffer): Pe | null {
  if (b.length < 0x40 || b.toString('ascii', 0, 2) !== 'MZ') return null
  const pe = b.readUInt32LE(0x3c)
  if (pe + 24 + 70 > b.length || b.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null
  const m = b.readUInt16LE(pe + 4)
  return { machine: m === 0x8664 ? 'x64' : m === 0xaa64 ? 'arm64' : m === 0x14c ? 'x86' : '?', gui: b.readUInt16LE(pe + 24 + 68) === 2 }
}

/** Fichier ou dossier source sur l'ordinateur : chemins des labos (/workspace…, C:\labo…) ou de « Lumen Labo ». */
function hostSource(from: string, raw: string): string | null {
  let p = raw.trim().replace(/^["']|["']$/g, '')
  if (!p) return null
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2))
  if (path.isAbsolute(p) && !p.startsWith('/workspace')) return p.startsWith(WORK_ROOT + path.sep) ? p : null
  p = p.replace(/\\/g, '/').replace(/^\/workspace\/?/, '')
  const root = path.join(WORK_ROOT, from)
  const abs = path.resolve(root, p)
  return abs === root || abs.startsWith(root + path.sep) ? abs : null
}

async function copyTree(src: string, dest: string) {
  await fs.cp(src, dest, { recursive: true, filter: (s) => s === src || !SKIP.has(path.basename(s)) })
}

// ---------- Python pour Windows (PyInstaller) ----------
let pyVersions: { at: number; list: string[] } | null = null
/** Les dernières versions de Python (la plus récente, puis la dernière de la version précédente, en secours). */
async function latestPythons(): Promise<string[]> {
  if (pyVersions && Date.now() - pyVersions.at < 6 * 3600_000) return pyVersions.list
  try {
    const r = await fetch('https://www.python.org/api/v2/downloads/release/?is_published=true&pre_release=false', { signal: AbortSignal.timeout(20_000) })
    const names = ((await r.json()) as { name: string }[]).map((x) => x.name.match(/^Python (3\.\d+\.\d+)$/)?.[1]).filter((v): v is string => !!v)
    const sorted = [...new Set(names)].sort((a, b) => {
      const x = a.split('.').map(Number)
      const y = b.split('.').map(Number)
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
    })
    const byMinor: string[] = []
    for (const v of sorted) if (!byMinor.some((w) => w.split('.')[1] === v.split('.')[1])) byMinor.push(v)
    pyVersions = { at: Date.now(), list: byMinor.slice(0, 2) }
  } catch {
    pyVersions = { at: Date.now(), list: ['3.14.0'] }
  }
  return pyVersions.list
}

function pythonScript(name: string, arch: Arch, ver: string, entry: string, gui: boolean): string {
  const suffix = arch === 'arm64' ? 'arm64' : 'amd64'
  const dir = `C:\\lumen\\python-${ver}-${arch}`
  return [
    "$ErrorActionPreference='Stop'",
    `$py=${psq(`${dir}\\python.exe`)}`,
    'if(-not(Test-Path $py)){',
    `  Write-Output ${psq(`› Installation de Python ${ver} (${arch})…`)}`,
    `  $inst=Join-Path $env:TEMP ${psq(`python-${ver}-${suffix}.exe`)}`,
    `  Invoke-WebRequest ${psq(`https://www.python.org/ftp/python/${ver}/python-${ver}-${suffix}.exe`)} -OutFile $inst -UseBasicParsing`,
    `  $p=Start-Process -FilePath $inst -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=0','Include_launcher=0','Include_test=0','Include_doc=0','Shortcuts=0','AssociateFiles=0',${psq(`TargetDir=${dir}`)} -Wait -PassThru`,
    '  Remove-Item $inst -Force -ErrorAction SilentlyContinue',
    "  if(-not(Test-Path $py)){throw \"Installation de Python impossible (code $($p.ExitCode))\"}",
    '}',
    '& $py -m pip install --disable-pip-version-check -q --upgrade pip pyinstaller 2>&1|Select-Object -Last 6',
    "if($LASTEXITCODE){throw 'Installation de PyInstaller impossible'}",
    "if(Test-Path requirements.txt){& $py -m pip install --disable-pip-version-check -q -r requirements.txt 2>&1|Select-Object -Last 6;if($LASTEXITCODE){throw 'Installation des dépendances (requirements.txt) impossible'}}",
    "Write-Output ('› '+(& $py --version)+' · PyInstaller '+(& $py -m PyInstaller --version))",
    `$w=Join-Path $env:TEMP ${psq(`pyi-${name}`)}`,
    `$o=@('--noconfirm','--clean','--onefile','--log-level','WARN','--name',${psq(name)},'--distpath',${psq(`C:\\labo\\.exe-build\\${name}`)},'--workpath',$w,'--specpath',$w)`,
    gui ? "$o+='--windowed'" : '',
    `& $py -m PyInstaller @o ${psq(entry)} 2>&1|Select-Object -Last 25`,
    'if($LASTEXITCODE){exit $LASTEXITCODE}',
  ].filter(Boolean).join('\n')
}

function clangScript(lang: 'c' | 'cpp', name: string, arch: Arch, gui: boolean): string {
  const triple = arch === 'arm64' ? 'aarch64-w64-mingw32' : 'x86_64-w64-mingw32'
  const cc = `${triple}-${lang === 'c' ? 'clang' : 'clang++'}`
  const inc = lang === 'c' ? "'*.c'" : "'*.cpp','*.cc','*.cxx','*.c'"
  return [
    "$ErrorActionPreference='Stop'",
    `$f=@(Get-ChildItem -Path . -Recurse -File -Include ${inc}|ForEach-Object FullName)`,
    "if(-not $f){throw 'Aucun fichier source dans le dossier.'}",
    `$fl=@('-O2','-s','-static','-I.')${gui ? ";$fl+='-mwindows'" : ''}`,
    "if(Select-String -Path $f -Pattern '\\b(wmain|wWinMain)\\b' -Quiet){$fl+='-municode'}",
    `Write-Output ('› '+(& ${cc} --version|Select-Object -First 1)+' → ${triple}')`,
    `& ${cc} @fl @f -o ${psq(`C:\\labo\\.exe-build\\${name}\\${name}.exe`)} -luser32 -lgdi32 -lcomctl32 -lcomdlg32 -lshell32 -lole32 -loleaut32 -luuid -lws2_32 -ladvapi32 -lwinmm`,
    'if($LASTEXITCODE){exit $LASTEXITCODE}',
  ].join('\n')
}

/** Fichier principal d'un programme Python : main.py, sinon celui qui contient « __main__ », sinon le premier. */
async function pythonEntry(dir: string, wanted: string): Promise<string | null> {
  if (wanted) return wanted.replace(/\//g, '\\')
  if (existsSync(path.join(dir, 'main.py'))) return 'main.py'
  const files = (await fs.readdir(dir)).filter((f) => /\.pyw?$/i.test(f)).sort()
  for (const f of files) if ((await fs.readFile(path.join(dir, f), 'utf8').catch(() => '')).includes('__main__')) return f
  return files[0] ?? null
}

// ---------- Outil build_exe ----------
export async function buildExe(a: Record<string, unknown>, emit: Emit = noop): Promise<ToolResult> {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  const run = (lab: string, command: string, cwd: string, timeout: number) => labTool('lab_run', { lab, command, cwd, timeout }, os.homedir(), emit)

  const name = str('name').replace(/\.exe$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'programme'
  const arch: Arch = /arm/i.test(str('arch')) ? 'arm64' : 'x64'
  const gui = a.gui === true || a.gui === 'true'
  const code = str('code')
  const source = str('source')
  if (!code.trim() && !source.trim()) return { ok: false, output: 'Donnez le code (paramètre « code ») ou un fichier / dossier du labo (paramètre « source »).' }

  // 1. Sources dans un dossier de travail (sur l'ordinateur, visible du labo Linux)
  const work = path.join(BUILD_ROOT, name)
  const src = path.join(work, 'src')
  await fs.rm(work, { recursive: true, force: true })
  await fs.mkdir(src, { recursive: true })
  let lang: Lang | null = ALIASES[str('language').toLowerCase().trim()] ?? null
  if (code.trim()) {
    lang ??= guessLang(code)
    if (!lang) return { ok: false, output: 'Langage inconnu : précisez « language » (c, cpp, csharp, go, rust, python).' }
    const f = path.join(src, MAIN[lang])
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, code)
  } else {
    const from = (str('from') || 'linux').toLowerCase()
    if (from === 'windows-vm') {
      const tmp = path.join(work, 'in')
      const r = await vmCopyOut(source, tmp)
      if (!r.ok || !existsSync(tmp)) return { ok: false, output: `Copie depuis Windows (VM) impossible : ${source}\n${r.output}` }
      if ((await fs.stat(tmp)).isDirectory()) await copyTree(tmp, src)
      else await fs.copyFile(tmp, path.join(src, path.win32.basename(source)))
      await fs.rm(tmp, { recursive: true, force: true })
    } else {
      const host = hostSource(from, source)
      if (!host) return { ok: false, output: `Source refusée : ${source}. Elle doit être dans un labo (/workspace…) ; un projet de l'ordinateur se copie d'abord avec lab_copy_in.` }
      const st = await fs.stat(host).catch(() => null)
      if (!st) return { ok: false, output: `Source introuvable : ${source} (labo ${from}).` }
      if (st.isDirectory()) await copyTree(host, src)
      else await fs.copyFile(host, path.join(src, path.basename(host)))
      if (!lang && st.isFile()) lang = EXT[path.extname(host).toLowerCase()] ?? null
    }
    lang ??= await langOfDir(src)
    if (!lang) return { ok: false, output: 'Langage inconnu : précisez « language » (c, cpp, csharp, go, rust, python).' }
  }

  // 2. Où compiler : Python → Windows (VM) ; le reste → labo Linux, ou la VM si demandé (C/C++)
  const vm = await vmStatus().catch(() => null)
  const vmReady = vm?.phase === 'ready'
  const wantVm = /vm|windows/i.test(str('where'))
  const where: 'linux' | 'windows-vm' = lang === 'python' || (wantVm && (lang === 'c' || lang === 'cpp')) ? 'windows-vm' : 'linux'
  if (where === 'windows-vm' && !vmReady)
    return {
      ok: false,
      output:
        lang === 'python'
          ? 'Un .exe Python se fabrique sous Windows (PyInstaller) : il faut le labo « Windows complet » (Réglages → Labos → Windows complet → Préparer). En attendant, proposez une version en C, C++, C#, Go ou Rust.'
          : "Le labo « Windows complet » n'est pas installé (Réglages → Labos) : compilez dans le labo Linux (where « linux »).",
    }
  const outHost = path.join(work, `${name}.exe`)
  let log = ''
  if (where === 'linux') {
    await fs.mkdir(path.join(LINUX_WS, '.outils'), { recursive: true })
    await fs.copyFile(SCRIPT, path.join(LINUX_WS, '.outils', 'lumen-exe.sh'))
    const cmd = `bash /workspace/.outils/lumen-exe.sh ${lang} ${shq(name)} ${arch} ${gui ? 'gui' : 'console'} ${shq(`/workspace/.exe-build/${name}/src`)} ${shq(`/workspace/.exe-build/${name}/${name}.exe`)}`
    const r = await run('linux', cmd, '/workspace', 1800)
    log = r.output
    if (!r.ok || !existsSync(outHost)) return { ok: false, output: `Échec de la compilation (${LABEL[lang]}, labo Linux) :\n${log}` }
  } else {
    const cp = await labTool('lab_copy_in', { lab: 'windows-vm', source: src, dest: `.exe-build\\${name}\\src` }, os.homedir(), emit)
    if (!cp.ok) return { ok: false, output: `Envoi des sources dans Windows (VM) impossible :\n${cp.output}` }
    const wd = `C:\\labo\\.exe-build\\${name}\\src`
    if (lang === 'python') {
      const entry = await pythonEntry(src, str('entry'))
      if (!entry) return { ok: false, output: 'Aucun fichier .py à compiler.' }
      let r: ToolResult = { ok: false, output: '' }
      for (const ver of await latestPythons()) {
        r = await run('windows-vm', pythonScript(name, arch, ver, entry, gui), wd, 1800)
        // Version trop récente pour PyInstaller (ou installeur absent) : on essaie la précédente
        if (r.ok || !/PyInstaller impossible|Installation de Python impossible/.test(r.output)) break
      }
      log = r.output
      if (!r.ok) return { ok: false, output: `Échec de la compilation (Python, Windows VM) :\n${log}` }
    } else {
      const r = await run('windows-vm', clangScript(lang as 'c' | 'cpp', name, arch, gui), wd, 1800)
      log = r.output
      if (!r.ok) return { ok: false, output: `Échec de la compilation (${LABEL[lang]}, Windows VM) :\n${log}` }
    }
    const back = await vmCopyOut(`C:\\labo\\.exe-build\\${name}\\${name}.exe`, outHost)
    if (!back.ok || !existsSync(outHost)) return { ok: false, output: `L'exe a été compilé mais n'a pas pu être récupéré de Windows (VM).\n${back.output}\n${log}` }
  }

  // 3. L'exe dans « Lumen Labo/exe », avec son identité (architecture, type, taille, empreinte)
  const exe = path.join(EXE_DIR, `${name}.exe`)
  await fs.mkdir(EXE_DIR, { recursive: true })
  await fs.copyFile(outHost, exe)
  const buf = await fs.readFile(exe)
  const pe = peInfo(buf.subarray(0, 4096))
  const sha = createHash('sha256').update(buf).digest('hex')
  const steps = log.split('\n').filter((l) => l.startsWith('›')).map((l) => l.slice(2).trim())
  const lines = [
    `✓ ${name}.exe — Windows ${pe?.machine ?? '?'}, ${pe?.gui ? 'application à fenêtre' : 'console'}, ${size(buf.length)}`,
    `Langage : ${LABEL[lang]} · compilé dans ${where === 'linux' ? 'le labo Linux' : 'Windows (VM)'}${steps.length ? ` (${steps.join(' ; ')})` : ''}`,
    `Sur l'ordinateur : ${exe}`,
    `SHA-256 : ${sha}`,
  ]

  // 4. Test dans le vrai Windows 11 (machine virtuelle), s'il est installé
  const testWanted = (str('test') || 'auto').toLowerCase()
  const isGui = !!pe?.gui || gui
  let ok = true
  let image: string | undefined
  if (testWanted !== 'none' && testWanted !== 'non') {
    const args = str('args')
    const input = str('input')
    if (!vmReady) {
      lines.push('Test : non fait (le labo « Windows complet » n’est pas installé : Réglages → Labos → Windows complet).')
    } else {
      const winExe = `C:\\labo\\.exe-test\\${name}.exe`
      const cp = await labTool('lab_copy_in', { lab: 'windows-vm', source: exe, dest: `.exe-test\\${name}.exe` }, os.homedir(), emit)
      if (!cp.ok) {
        ok = false
        lines.push(`Test dans Windows (VM) impossible : ${cp.output}`)
      } else if (isGui) {
        // Au premier plan pour la capture (d'autres fenêtres peuvent être ouvertes sur le bureau) : depuis SSH, seul un
        // programme lancé sur le bureau (lumen-gui) peut agir sur les fenêtres ; réduire puis restaurer passe devant.
        const front = Buffer.from(
          [
            "Add-Type 'using System;using System.Runtime.InteropServices;public static class LumenW{[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport(\"user32.dll\")]public static extern void SwitchToThisWindow(IntPtr h,bool a);}'",
            `$p=Get-Process -Name ${psq(name)} -ErrorAction SilentlyContinue|Where-Object MainWindowHandle -ne 0|Select-Object -First 1`,
            'if($p){$h=$p.MainWindowHandle;[void][LumenW]::ShowWindow($h,6);[void][LumenW]::ShowWindow($h,9);[LumenW]::SwitchToThisWindow($h,$true);[void][LumenW]::SetForegroundWindow($h)}',
            "Start-Sleep -Milliseconds 700;Set-Content -LiteralPath 'C:\\labo\\.exe-test\\front.ok' -Value 1",
          ].join(';'),
          'utf16le',
        ).toString('base64')
        const r = await run(
          'windows-vm',
          [
            "Remove-Item -LiteralPath 'C:\\labo\\.exe-test\\front.ok' -ErrorAction SilentlyContinue",
            `lumen-gui ${psq(winExe)} ${args}`,
            'Start-Sleep -Seconds 4',
            `lumen-gui powershell.exe -NoProfile -WindowStyle Hidden -EncodedCommand ${front} | Out-Null`,
            // La fenêtre passe devant quand le petit script a fini (compilation de son code C# comprise)
            "for($i=0;$i -lt 40 -and -not(Test-Path -LiteralPath 'C:\\labo\\.exe-test\\front.ok');$i++){Start-Sleep -Milliseconds 500}",
            `$p=Get-Process -Name ${psq(name)} -ErrorAction SilentlyContinue|Select-Object -First 1`,
            "if($p){'Programme lancé'+$(if($p.MainWindowTitle){' : fenêtre « '+$p.MainWindowTitle+' »'})}else{'Le programme s''est arrêté tout seul.'}",
          ].join('\n'),
          'C:\\labo',
          90,
        )
        const shot = await labTool('lab_screenshot', { lab: 'windows-vm' }, os.homedir(), emit)
        image = shot.image
        await run('windows-vm', `Stop-Process -Name ${psq(name)} -Force -ErrorAction SilentlyContinue`, 'C:\\labo', 30)
        ok = r.ok && !/arrêté tout seul/.test(r.output)
        lines.push(`Test dans Windows 11 (VM) : ${r.output.replace(/\n?\[Windows \(VM\)[^\]]*\]$/, '')}${image ? ' — capture de l’écran jointe.' : ''}`)
        if (!ok) lines.push(CONSOLE_HINT)
      } else {
        const r = await run('windows-vm', `${input ? `${psq(input)} | ` : ''}& ${psq(winExe)} ${args}`, 'C:\\labo\\.exe-test', 90)
        ok = r.ok
        lines.push(`Test dans Windows 11 (VM)${args ? ` avec « ${args} »` : ''} :\n${r.output}`)
      }
    }
  }
  return { ok, output: lines.join('\n'), ...(image ? { image } : {}) }
}

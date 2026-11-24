// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Lancement de processus pour les labos (Docker, émulateur Android, QEMU, SSH) : sortie texte limitée, octets bruts,
// délai maximal. Partagé par agent/lab.ts et agent/winvm.ts.
import { spawn } from 'node:child_process'

export const MAX_OUT = 20_000
export type Out = { code: number | null; out: string; stdout: Buffer; timedOut: boolean }
export type ExecOptions = { input?: string | Buffer; timeout?: number; onData?: (s: string) => void; maxText?: number; env?: NodeJS.ProcessEnv }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const clip = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (${s.length - MAX_OUT} caractères tronqués)` : s)

export function exec(cmd: string, args: string[], o: ExecOptions = {}): Promise<Out> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, DOCKER_CLI_HINTS: 'false', ...o.env } })
    const max = o.maxText ?? MAX_OUT * 2
    let out = ''
    const bufs: Buffer[] = []
    let size = 0
    let timedOut = false
    const text = (d: Buffer) => {
      const s = d.toString()
      o.onData?.(s)
      if (out.length < max) out += s
    }
    child.stdout.on('data', (d: Buffer) => {
      if (size < 48 * 2 ** 20) {
        bufs.push(d)
        size += d.length
      }
      text(d)
    })
    child.stderr.on('data', text)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, o.timeout ?? 60_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(e), stdout: Buffer.concat(bufs), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, stdout: Buffer.concat(bufs), timedOut })
    })
    child.stdin.on('error', () => {}) // processus déjà terminé : on ignore
    child.stdin.end(o.input)
  })
}

import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  appendFileSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

/**
 * run_watch — ejecuta un script "fire-and-forget" y DESPIERTA al agente con
 * promptAsync cuando termina. No bloquea el turno, no hace polling.
 *
 * Dos modos:
 *  - pty  (detach:false, por defecto)  → client.pty.create. Cómodo para minutos.
 *      ⚠ LO MATA el addFinalizer de opencode si se cierra el server.
 *  - detached (detach:true)            → spawn({detached:true}) = setsid → nueva
 *      sesión POSIX → escapa del process-group kill del server y sobrevive a
 *      reinicios. Para varios minutos / horas.
 *
 * Señal universal de terminación = archivo `<id>.marker` con `exit=N` (ambos modos).
 * El log completo va a `<id>.log`. Todo bajo `<directory>/.run-watch/`.
 *
 * Ledger en DISCO (`ledger.json`) → obligatorio porque `pty.exited` NO trae sessionID,
 * y porque así podemos RECONCILIAR al arrancar tras un cierre.
 */

type Mode = "pty" | "detached"
type Entry = {
  id: string
  sessionID: string
  agent: string
  name: string
  cmd: string
  mode: Mode
  log: string
  marker: string
  startedAt: number
  notified: boolean
  ptyId?: string
  pid?: number
  exitCode?: number
  doneAt?: number
  reason?: string
  notifyUrl?: string
}

const TAIL_LINES = 40

export default (async (input: any) => {
  const client = input.client
  const BASE: string = input.directory || input.worktree || tmpdir()
  const RW_DIR = join(BASE, ".run-watch")
  const LEDGER = join(RW_DIR, "ledger.json")

  const ensureDir = () => {
    try {
      mkdirSync(RW_DIR, { recursive: true })
    } catch {}
  }
  const load = (): Entry[] => {
    try {
      return JSON.parse(readFileSync(LEDGER, "utf8")) as Entry[]
    } catch {
      return []
    }
  }
  const save = (rows: Entry[]) => {
    ensureDir()
    try {
      writeFileSync(LEDGER, JSON.stringify(rows, null, 2))
    } catch (e) {
      /* best effort */
    }
  }
  const shortId = () =>
    Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-4)

  const tail = (file: string, n = TAIL_LINES): string => {
    try {
      const txt = readFileSync(file, "utf8")
      const lines = txt.split("\n")
      return lines.slice(Math.max(0, lines.length - n)).join("\n")
    } catch {
      return "(sin log)"
    }
  }

  const inFlight = new Set<string>()

  const tryWake = async (
    e: Entry,
    opts: { exitCode?: number; reason?: string } = {},
  ) => {
    if (e.notified || inFlight.has(e.id)) return
    inFlight.add(e.id)
    try {
      let exitCode = opts.exitCode
      let reason = opts.reason
      // El marker manda: tiene el exit code real del script.
      if (existsSync(e.marker)) {
        try {
          const m = readFileSync(e.marker, "utf8")
          const mm = m.match(/exit=(-?\d+)/)
          if (mm) exitCode = Number(mm[1])
        } catch {}
      }
      const body = tail(e.log)
      const label = e.name || e.id
      const codeStr =
        exitCode === undefined ? "?" : String(exitCode)
      const msg =
        `⏱ [run_watch] Terminó el script "${label}" (id=${e.id}, modo=${e.mode}, exit=${codeStr})` +
        (reason ? `\n⚠ ${reason}` : "") +
        `\n\n— Últimas ${TAIL_LINES} líneas del log (${e.log}) —\n${body}\n\n` +
        `Analiza los datos recopilados y dime qué hacer a continuación.`
      await client.session.promptAsync({
        path: { id: e.sessionID },
        body: { parts: [{ type: "text", text: msg }] },
      })
      // marcar notified
      const rows = load()
      const row = rows.find((r) => r.id === e.id)
      if (row) {
        row.notified = true
        row.doneAt = Date.now()
        if (exitCode !== undefined) row.exitCode = exitCode
        if (reason) row.reason = reason
        save(rows)
      }
    } catch (err: any) {
      // promptAsync puede fallar si la sesión ya no existe → no reintentar infinito
      try {
        appendFileSync(
          join(RW_DIR, "errors.log"),
          `${new Date().toISOString()} wake ${e.id} failed: ${err?.message || err}\n`,
        )
      } catch {}
    } finally {
      inFlight.delete(e.id)
    }
  }

  // ── FIX A3: servidor HTTP localhost de notify ─────────────────────────
  // El wrapper detached hace curl a esta URL al terminar → wake EN VIVO sin
  // depender del watcher de opencode (que no entregó el evento del marker).
  // Aleatorio + token → nadie más puede fakear un wake. Si el server está
  // caído, el callback falla y lo cubre el reconcile-on-boot (hook config).
  const token = shortId() + shortId()
  const server = createServer(async (req: any, res: any) => {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1")
      if (u.pathname !== "/notify") {
        res.writeHead(404)
        res.end("not found")
        return
      }
      if (u.searchParams.get("token") !== token) {
        res.writeHead(403)
        res.end("denied")
        return
      }
      const jid = u.searchParams.get("id")
      const rows = load()
      const e = rows.find((x) => x.id === jid)
      if (!e) {
        res.writeHead(404)
        res.end("unknown id")
        return
      }
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(e.notified ? "already" : "accepted")
      if (!e.notified) await tryWake(e, {})
    } catch {
      try {
        res.writeHead(500)
        res.end("err")
      } catch {}
    }
  })
  // NUNCA puede colgar el boot: si listen no dispara callback o emite 'error',
  // caemos a port=0 (fallback: marker + reconcile-on-boot, sin wake live).
  const port = await Promise.race([
    new Promise<number>((r) => {
      server.once("error", () => r(0))
      server.listen(0, "127.0.0.1", () => {
        const a: any = server.address()
        r(a && typeof a === "object" ? a.port : 0)
      })
    }),
    new Promise<number>((r) => setTimeout(() => r(0), 500)),
  ]).catch(() => 0)

  const run_watch = tool({
    description:
      "Lanza un script en segundo plano y DESPIERTA a esta sesión (promptAsync) cuando termine, con el exit code + tail del log. NO bloquea: termina tu turno normal. Usa detach=true para scripts de varios minutos/horas que deben sobrevivir a un cierre de opencode.",
    args: {
      cmd: tool.schema
        .string()
        .describe("Comando/script a ejecutar (bash -lc)."),
      name: tool.schema
        .string()
        .optional()
        .describe("Etiqueta legible para el aviso."),
      detach: tool.schema
        .boolean()
        .optional()
        .describe(
          "true = proceso setsid detached (sobrevive al reinicio de opencode, para horas). false/omit = pty (solo minutos).",
        ),
    },
    async execute(args: any, ctx: any) {
      ensureDir()
      const id = shortId()
      const mode: Mode = args.detach ? "detached" : "pty"
      const name = args.name || String(args.cmd).slice(0, 40)
      const log = join(RW_DIR, `${id}.log`)
      const marker = join(RW_DIR, `${id}.marker`)
      const entry: Entry = {
        id,
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        name,
        cmd: args.cmd,
        mode,
        log,
        marker,
        startedAt: Date.now(),
        notified: false,
        notifyUrl: port
          ? `http://127.0.0.1:${port}/notify?id=${id}&token=${token}`
          : "",
      }
      // script universal: escribe salida a log y exit code a marker
      const script =
        `{\n${args.cmd}\n}\nrc=$?\nprintf 'exit=%s\\n' "$rc" > ${marker}` +
        // FIX A3: callback HTTP al plugin al terminar (wake en vivo, sin watcher).
        // url entre comillas dobles → & seguro. rc NO se ve afectado (curl va AFTER printf).
        (entry.notifyUrl
          ? `\ncurl -sS -m 5 "${entry.notifyUrl}" >/dev/null 2>&1 || true`
          : "")

      // 1) LEDGER ANTES de lanzar (crash-safe: si peta el launch queda constancia)
      {
        const rows = load()
        rows.push(entry)
        save(rows)
      }

      // 2) LAUNCH
      if (mode === "detached") {
        const fd = openSync(log, "a")
        const child = spawn("bash", ["-lc", script], {
          detached: true,
          cwd: BASE,
          stdio: ["ignore", fd, fd],
        })
        child.unref()
        closeSync(fd)
        entry.pid = child.pid
        const rows = load()
        const r = rows.find((x) => x.id === id)
        if (r) r.pid = child.pid
        save(rows)
      } else {
        // pty vía SDK. El log/marker igual se escriben (el script redirige).
        try {
          const r = await client.pty.create({
            body: { command: "bash", args: ["-lc", script], cwd: BASE, title: name },
          })
          const ptyId = r?.data?.id
          const rows = load()
          const row = rows.find((x) => x.id === id)
          if (row && ptyId) row.ptyId = ptyId
          save(rows)
        } catch (err: any) {
          // si pty.create falla, limpia el entry y avisa
          const rows = load().filter((x) => x.id !== id)
          save(rows)
          return {
            title: `run_watch error`,
            output: `No se pudo crear la PTY: ${err?.message || err}`,
            metadata: { id, mode },
          }
        }
      }

      return {
        title: `run_watch ${name}`,
        output:
          `Lanzado (id=${id}, modo=${mode}). NO esperes: termina tu turno. ` +
          `Te avisaré con un promptAsync cuando acabe (exit code + tail del log). ` +
          (mode === "detached"
            ? `Sobrevive a reinicios de opencode.`
            : `⚠ modo pty: se matará si se cierra el server de opencode.`) +
          `\nLog: ${log}`,
        metadata: { id, mode, log, marker, pid: entry.pid },
      }
    },
  })

  return {
    tool: { run_watch },

    async event({ event }: any) {
      const t = event?.type
      if (t === "pty.exited") {
        const pidEv = event?.properties?.id
        const code = event?.properties?.exitCode
        const rows = load()
        const e = rows.find((x) => x.ptyId === pidEv)
        if (e) await tryWake(e, { exitCode: code })
        return
      }
      if (t === "file.watcher.updated") {
        const ev = event?.properties?.event
        const file = event?.properties?.file
        if (ev !== "add" || !file) return
        const abs = resolve(BASE, file)
        const rows = load()
        const e = rows.find(
          (x) => !x.notified && (x.marker === file || x.marker === abs),
        )
        if (e) await tryWake(e, {})
        return
      }
    },

    // RECONCILE-ON-BOOT: corre una vez al iniciar el plugin (con el Config fusionado).
    // Recupera trabajos que terminaron MIENTRAS el server estaba caído, o que se
    // quedaron huérfanos. Las sesiones persisten en disco → promptAsync revive.
    async config(_cfg: any) {
      const rows = load()
      const pending = rows.filter((x) => !x.notified)
      if (pending.length === 0) return
      let ptyIds: Set<string> | null = null
      for (const e of pending) {
        if (existsSync(e.marker)) {
          await tryWake(e, { reason: "terminó mientras opencode estaba cerrado" })
          continue
        }
        // ¿sigue vivo?
        let alive: boolean | null = null
        if (e.mode === "detached" && e.pid) {
          try {
            process.kill(e.pid, 0)
            alive = true
          } catch {
            alive = false
          }
        } else if (e.mode === "pty" && e.ptyId) {
          if (ptyIds === null) {
            try {
              const r = await client.pty.list()
              ptyIds = new Set((r?.data || []).map((p: any) => p.id))
            } catch {
              ptyIds = new Set()
            }
          }
          alive = ptyIds.has(e.ptyId)
        }
        if (alive === false) {
          await tryWake(e, {
            reason:
              "el proceso murió sin dejar marker (posible cierre de opencode / kill). Revisa el log parcial.",
          })
        }
        // alive true → sigue corriendo, se avisará luego por marker/pty.exited
      }
    },
  }
}) satisfies Plugin

import { Plugin } from "@opencode/plugin"
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  appendFileSync,
  watch,
  type FSWatcher,
} from "node:fs"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * run_watch — ejecuta un script "fire-and-forget" y DESPIERTA al agente con
 * un prompt (ctx.session.prompt, delivery:"queue") cuando termina. No bloquea
 * el turno, no hace polling.
 *
 * Port V1 → V2 (opencode >= 2.0.18: `Plugin.define` + `ctx.tool.transform`).
 *
 * Dos modos, ambos sobre node:child_process (V2 no expone terminal gestionada
 * por el SDK; el modo en proceso sustituye a lo que en V1 era la vía rápida):
 *  - quick    (detach:false, por defecto) → spawn con pipes: stdout/stderr se
 *      vierten a <id>.log y el evento `close` da el exit code → wake inmediato.
 *      ⚠ Muere si se cierra el server de opencode. SIN pseudo-terminal: se
 *      pierden colores ANSI del script.
 *  - detached (detach:true) → spawn({detached:true}) = setsid → nueva sesión
 *      POSIX → escapa del process-group kill del server y sobrevive a
 *      reinicios. Para varios minutos / horas. Invariable respecto a V1.
 *
 * Señal universal de terminación = archivo `<id>.marker` con `exit=N` (ambos
 * modos). El log completo va a `<id>.log`. Todo bajo `<directory>/.run-watch/`.
 *
 * Ledger en DISCO (`ledger.json`) → invariable: el wrapper detached escribe
 * archivos FUERA del runtime del plugin, así que el disco es la única fuente
 * de verdad. `notified` evita dobles avisos.
 *
 * Detección de finalización: callback HTTP localhost (FIX A3 de V1,
 * conservado) + fs.watch sobre .run-watch/ (sustituye al evento de watcher
 * del host en V1; no dependemos de eventos de fichero del host) +
 * reconciliación al arrancar (sustituye al hook `config` de V1) de red de
 * seguridad.
 */

type Mode = "quick" | "detached"
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
  pid?: number
  exitCode?: number
  doneAt?: number
  reason?: string
  notifyUrl?: string
}

type RunWatchArgs = {
  cmd: string
  name?: string
  detach?: boolean
}

const TAIL_LINES = 40

export default Plugin.define({
  id: "run-watch",
  async setup(ctx) {
    const BASE: string = ctx.location.directory || tmpdir()
    const RW_DIR = join(BASE, ".run-watch")
    const LEDGER = join(RW_DIR, "ledger.json")

    const ensureDir = (): void => {
      try {
        mkdirSync(RW_DIR, { recursive: true })
      } catch {
        /* ya existe o sin permisos: los reads posteriores fallarán con gracia */
      }
    }
    const load = (): Entry[] => {
      try {
        return JSON.parse(readFileSync(LEDGER, "utf8")) as Entry[]
      } catch {
        return []
      }
    }
    const save = (rows: Entry[]): void => {
      ensureDir()
      try {
        writeFileSync(LEDGER, JSON.stringify(rows, null, 2))
      } catch {
        /* best effort */
      }
    }
    const shortId = (): string =>
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
    ): Promise<void> => {
      // Estado FRESCO del ledger: la copia en memoria puede estar obsoleta
      // (varias rutas de wake compiten: close/fs.watch/callback HTTP/reconcile).
      // El check + inFlight.add es atómico (sync) → solo una ruta pasa.
      const cur = load().find((r) => r.id === e.id)
      const target = cur ?? e
      if (target.notified || inFlight.has(target.id)) return
      inFlight.add(target.id)
      try {
        let exitCode = opts.exitCode
        let reason = opts.reason
        // El marker manda: tiene el exit code real del script.
        if (existsSync(target.marker)) {
          try {
            const m = readFileSync(target.marker, "utf8")
            const mm = m.match(/exit=(-?\d+)/)
            if (mm) exitCode = Number(mm[1])
          } catch {
            /* marker ilegible → seguimos con lo que traigamos */
          }
        }
        const body = tail(target.log)
        const label = target.name || target.id
        const codeStr = exitCode === undefined ? "?" : String(exitCode)
        const msg =
          `⏱ [run_watch] Terminó el script "${label}" (id=${target.id}, modo=${target.mode}, exit=${codeStr})` +
          (reason ? `\n⚠ ${reason}` : "") +
          `\n\n— Últimas ${TAIL_LINES} líneas del log (${target.log}) —\n${body}\n\n` +
          `Analiza los datos recopilados y dime qué hacer a continuación.`
        // V1 usaba el prompt "fire and forget" del SDK; V2: inbox durable.
        await ctx.session.prompt({
          sessionID: target.sessionID,
          text: msg,
          delivery: "queue",
        })
        // marcar notified
        const rows = load()
        const row = rows.find((r) => r.id === target.id)
        if (row) {
          row.notified = true
          row.doneAt = Date.now()
          if (exitCode !== undefined) row.exitCode = exitCode
          if (reason) row.reason = reason
          save(rows)
        }
      } catch (err) {
        // prompt puede fallar si la sesión ya no existe → no reintentar infinito
        try {
          appendFileSync(
            join(RW_DIR, "errors.log"),
            `${new Date().toISOString()} wake ${target.id} failed: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        } catch {
          /* sin disco, sin aviso: nada que hacer */
        }
      } finally {
        inFlight.delete(target.id)
      }
    }

    // ── FIX A3 (CONSERVADO): servidor HTTP localhost de notify ───────────
    // El wrapper detached hace curl a esta URL al terminar → wake EN VIVO sin
    // depender del fs.watch (que puede perder eventos). Aleatorio + token →
    // nadie más puede fakear un wake. Si el server está caído, el callback
    // falla y lo cubren fs.watch / reconcile-on-boot.
    const token = shortId() + shortId()
    const server: Server = createServer(async (req, res) => {
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
        } catch {
          /* header ya enviado */
        }
      }
    })
    // NUNCA puede colgar el boot: si listen no dispara callback o emite 'error',
    // caemos a port=0 (fallback: marker + fs.watch + reconcile, sin wake live).
    const port = await Promise.race([
      new Promise<number>((r) => {
        server.once("error", () => r(0))
        server.listen(0, "127.0.0.1", () => {
          const a = server.address()
          r(a && typeof a === "object" ? a.port : 0)
        })
      }),
      new Promise<number>((r) => setTimeout(() => r(0), 500)),
    ]).catch(() => 0)
    if (port === 0) {
      // Gotcha: nunca gatear en silencio — deja rastro (lección de ports previos).
      console.warn(
        "[run-watch] notify HTTP server OFFLINE (port=0) → wake live vía curl no disponible; fs.watch + reconcile-on-boot siguen activos",
      )
    }

    ensureDir()

    // ── fs.watch sobre .run-watch/ → detecta markers (sustituye al evento de
    //    watcher de ficheros de V1; NO dependemos de eventos del host).
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(RW_DIR, (_eventType, filename) => {
        if (!filename || !filename.endsWith(".marker")) return
        const rows = load()
        const e = rows.find((x) => !x.notified && x.marker === join(RW_DIR, filename))
        if (e) void tryWake(e, {})
      })
      watcher.on("error", (err) => {
        // Sin watcher seguimos vivos: el callback HTTP y el reconcile cubren.
        console.warn(
          `[run-watch] fs.watch caído (${err instanceof Error ? err.message : String(err)}) → wake live por callback HTTP + reconcile-on-boot`,
        )
        watcher = null
      })
    } catch (err) {
      console.warn(
        `[run-watch] no se pudo vigilar ${RW_DIR} (${err instanceof Error ? err.message : String(err)}) → callback HTTP + reconcile-on-boot`,
      )
      watcher = null
    }

    // ── RECONCILE-ON-BOOT (V2: corre al inicio de setup; V1 usaba hook config).
    //    Recupera trabajos que terminaron MIENTRAS el server estaba caído, o que
    //    se quedaron huérfanos. Las sesiones persisten en disco → prompt revive.
    const reconcile = async (): Promise<void> => {
      const rows = load()
      const pending = rows.filter((x) => !x.notified)
      if (pending.length === 0) return
      console.log(
        `[run-watch] reconcile: ${pending.length} tarea(s) pendiente(s) al arrancar`,
      )
      for (const e of pending) {
        if (existsSync(e.marker)) {
          await tryWake(e, { reason: "terminó mientras opencode estaba cerrado" })
          continue
        }
        // ¿sigue vivo? Solo los detached con pid registrado tienen proceso
        // propio que podamos sondear: el resto (quick sin supervisor tras un
        // reinicio, y filas legacy escritas por V1 con modos ya inexistentes)
        // murió con el server anterior.
        let alive: boolean | null = null
        if (e.mode === "detached" && e.pid) {
          try {
            process.kill(e.pid, 0)
            alive = true
          } catch {
            alive = false
          }
        } else {
          alive = false
        }
        if (alive === false) {
          await tryWake(e, {
            reason:
              "el proceso murió sin dejar marker (posible cierre de opencode / kill). Revisa el log parcial.",
          })
        }
        // alive true → sigue corriendo, se avisará luego por marker/callback
      }
    }
    void reconcile().catch((err) => {
      console.warn(
        `[run-watch] reconcile falló: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

    // ── HERRAMIENTA (V1: return {tool:{run_watch}} → V2: ctx.tool.transform)
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "run_watch",
        description:
          "Lanza un script en segundo plano y DESPIERTA a esta sesión (nuevo turno con exit code + tail del log) cuando termine. NO bloquea: termina tu turno normal. Usa detach=true para scripts de varios minutos/horas que deben sobrevivir a un cierre de opencode.",
        input: {
          type: "object",
          properties: {
            cmd: {
              type: "string",
              description: "Comando/script a ejecutar (bash -lc).",
            },
            name: {
              type: "string",
              description: "Etiqueta legible para el aviso.",
            },
            detach: {
              type: "boolean",
              description:
                "true = proceso setsid detached (sobrevive al reinicio de opencode, para horas). false/omit = quick (pipes en proceso, solo minutos; muere con el server).",
            },
          },
          required: ["cmd"],
          additionalProperties: false,
        },
        execute: async (raw, tctx) => {
          const args = raw as RunWatchArgs
          ensureDir()
          const id = shortId()
          const mode: Mode = args.detach ? "detached" : "quick"
          const name = args.name || String(args.cmd).slice(0, 40)
          const log = join(RW_DIR, `${id}.log`)
          const marker = join(RW_DIR, `${id}.marker`)
          const notifyUrl = port
            ? `http://127.0.0.1:${port}/notify?id=${id}&token=${token}`
            : ""
          const entry: Entry = {
            id,
            sessionID: String(tctx.sessionID),
            agent: String(tctx.agent ?? ""),
            name,
            cmd: args.cmd,
            mode,
            log,
            marker,
            startedAt: Date.now(),
            notified: false,
            notifyUrl,
          }
          // script universal: escribe exit code a marker; en detached además
          // callback HTTP al plugin (wake en vivo, sin depender del watcher).
          // url entre comillas dobles → & seguro. rc NO se ve afectado
          // (curl va AFTER printf). En quick el `close` del spawn ya despierta.
          const script =
            `{\n${args.cmd}\n}\nrc=$?\nprintf 'exit=%s\\n' "$rc" > ${marker}` +
            (mode === "detached" && entry.notifyUrl
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
            // quick: pipes → vertemos stdout/stderr al log; `close` = wake.
            try {
              const child = spawn("bash", ["-lc", script], {
                cwd: BASE,
                stdio: ["ignore", "pipe", "pipe"],
              })
              entry.pid = child.pid
              {
                const rows = load()
                const r = rows.find((x) => x.id === id)
                if (r) r.pid = child.pid
                save(rows)
              }
              const append = (chunk: Buffer | string): void => {
                try {
                  appendFileSync(log, chunk)
                } catch {
                  /* best effort */
                }
              }
              child.stdout?.on("data", append)
              child.stderr?.on("data", append)
              child.on("error", (err) => {
                void tryWake(entry, {
                  reason: `fallo al lanzar el proceso: ${err.message}`,
                })
              })
              child.on("close", (code, signal) => {
                void tryWake(entry, {
                  exitCode: code ?? undefined,
                  reason:
                    code === null && signal
                      ? `el proceso fue terminado por la señal ${signal}`
                      : undefined,
                })
              })
            } catch (err) {
              // si el spawn peta, limpia el entry y avisa (paridad con V1)
              const rows = load().filter((x) => x.id !== id)
              save(rows)
              return {
                content: [
                  {
                    type: "text",
                    text: `No se pudo lanzar el proceso: ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
                metadata: { id, mode },
              }
            }
          }

          return {
            content: [
              {
                type: "text",
                text:
                  `Lanzado (id=${id}, modo=${mode}). NO esperes: termina tu turno. ` +
                  `Te avisaré con un mensaje cuando acabe (exit code + tail del log). ` +
                  (mode === "detached"
                    ? `Sobrevive a reinicios de opencode.`
                    : `⚠ modo quick: se matará si se cierra el server de opencode.`) +
                  `\nLog: ${log}`,
              },
            ],
            metadata: { id, mode, log, marker, pid: entry.pid },
          }
        },
      })
    })

    console.log(
      `[run-watch] cargado (dir=${BASE}, notify=${port ? `127.0.0.1:${port}` : "offline"}, fs.watch=${watcher ? "on" : "off"})`,
    )

    // ── CLEANUP (V2: setup devuelve un disposer)
    return () => {
      try {
        watcher?.close()
      } catch {
        /* idempotent */
      }
      try {
        server.close()
      } catch {
        /* si nunca llegó a escuchar, close() lanza: da igual */
      }
      // Los hijos "quick" NO se matan aquí: si el plugin se recarga sin cerrar
      // el server, los close handlers viejos siguen vivos (attach a los pipes
      // del server) y despiertan igual; si no, el marker + fs.watch (o el
      // reconcile del siguiente arranque) cubren. Los "detached" sobreviven a
      // propósito (esa es su razón de ser).
    }
  },
})

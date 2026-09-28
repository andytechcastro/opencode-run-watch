// Harness de integración del plugin run_watch SIN opencode.
// Usa un client falso + spawn REAL (bash sleep) para probar el bucle reactivo:
//   launch detached → termina → marker → event(file.watcher.updated) → promptAsync.
// Run: node --experimental-strip-types scripts/test.mjs
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Plugin from "../index.ts"

const base = mkdtempSync(join(tmpdir(), "rwtest-"))
const wakes = []
const created = []

const client = {
  session: {
    promptAsync: async (d) => {
      wakes.push(d)
      return { data: null, response: { status: 204 } }
    },
  },
  pty: {
    create: async (d) => {
      created.push(d)
      return { data: { id: "pty-fake-1", status: "running", pid: 999999 } }
    },
    list: async () => ({ data: [] }),
  },
}

const hooks = await Plugin({ client, directory: base, worktree: base })
const toolDef = hooks.tool.run_watch
const ctx = { sessionID: "ses_TEST", agent: "commander", directory: base, worktree: base }

function sleepMs(ms) {
  const i32 = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(i32, 0, 0, ms)
}

let pass = true
const check = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`)
  if (!cond) pass = false
}

// ── TEST 1: modo detached real, bucle de wake completo ─────────────
{
  const res = await toolDef.execute(
    { cmd: `echo hola-desde-detached; sleep 1; echo fin-coleccion`, detach: true, name: "recoger-datos" },
    ctx,
  )
  const meta = res.metadata
  check("T1 execute devuelve id+mode detached", !!meta.id && meta.mode === "detached")
  // ledger escrito
  const ledgerPath = join(base, ".run-watch", "ledger.json")
  check("T1 ledger.json escrito antes de lanzar", existsSync(ledgerPath))
  // esperar a que el spawn termine y escriba marker
  sleepMs(2500)
  check("T1 marker escrito por el script", existsSync(meta.marker))
  check("T1 log contiene la salida", /fin-coleccion/.test(readFileSync(meta.log, "utf8")))
  // ahora DISPARA el evento como haría opencode (marker añadido)
  await hooks.event({ event: { type: "file.watcher.updated", properties: { event: "add", file: meta.marker } } })
  // dar tiempo al await del wake
  await new Promise((r) => setTimeout(r, 200))
  const w = wakes.find((x) => x.path.id === "ses_TEST")
  check("T1 promptAsync invocado a la sesión correcta", !!w)
  check("T1 mensaje lleva exit=0 + tail del log", !!w && /exit=0/.test(w.body.parts[0].text) && /fin-coleccion/.test(w.body.parts[0].text))
  const after = JSON.parse(readFileSync(ledgerPath, "utf8"))
  check("T1 entry marcada notified=true", after.find((e) => e.id === meta.id)?.notified === true)
  // idempotencia: segundo evento NO vuelve a despertar
  const before = wakes.length
  await hooks.event({ event: { type: "file.watcher.updated", properties: { event: "add", file: meta.marker } } })
  await new Promise((r) => setTimeout(r, 100))
  check("T1 idempotente (no double-wake)", wakes.length === before)
}

// ── TEST 2: modo pty (client.pty.create llamado, ledger guarda ptyId) ─
{
  const res = await toolDef.execute({ cmd: `echo x`, name: "job-pty" }, ctx)
  const meta = res.metadata
  check("T2 mode pty por defecto", meta.mode === "pty")
  check("T2 client.pty.create invocado", created.length === 1)
  const after = JSON.parse(readFileSync(join(base, ".run-watch", "ledger.json"), "utf8"))
  const e = after.find((x) => x.id === meta.id)
  check("T2 ptyId persistido en ledger", e?.ptyId === "pty-fake-1")
  // pty.exited → wake (aunque no hay marker real, exitCode viene del evento)
  await hooks.event({ event: { type: "pty.exited", properties: { id: "pty-fake-1", exitCode: 3 } } })
  await new Promise((r) => setTimeout(r, 200))
  const w = wakes.find((x) => /id=\S+.*exit=3|exit=3/.test(x.body?.parts?.[0]?.text || "") && x.path.id === "ses_TEST")
  check("T2 pty.exited dispara wake con exitCode=3", !!w)
}

// ── TEST 3: reconcile-on-boot (marker presente pero no notificado) ────
{
  // crear entrada 'a mano' que terminó pero nunca se avisó (simula cierre del server)
  const dir = join(base, ".run-watch")
  const id = "orphan1"
  const marker = join(dir, id + ".marker")
  const log = join(dir, id + ".log")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(log, "datos-huerfanos-xyz")
  writeFileSync(marker, "exit=0")
  const rows = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"))
  rows.push({ id, sessionID: "ses_orphan", agent: "commander", name: "job-caido", cmd: "x", mode: "detached", log, marker, startedAt: Date.now(), notified: false })
  writeFileSync(join(dir, "ledger.json"), JSON.stringify(rows))
  await hooks.config({})
  await new Promise((r) => setTimeout(r, 200))
  const w = wakes.find((x) => x.path.id === "ses_orphan")
  check("T3 reconcile despierta sesión huérfana", !!w && /datos-huerfanos-xyz/.test(w.body.parts[0].text))
}

// ── TEST 4: A3 LIVE e2e — el curl del wrapper despierta sin eventos manuales ──
{
  const wBefore = wakes.length
  const res = await toolDef.execute(
    { cmd: `echo datos-test4; sleep 1`, detach: true, name: "a3-live" },
    ctx,
  )
  const meta = res.metadata
  check("T4 lanzado detached con notifyUrl", !!meta.id)
  // POLL no-bloqueante: sleepMs (Atomics.wait) congelaría el event loop
  // e impediría que el servidor node:http procese el curl del hijo.
  for (let i = 0; i < 60; i++) {
    const led = JSON.parse(readFileSync(join(base, ".run-watch", "ledger.json"), "utf8"))
    if (led.find((x) => x.id === meta.id)?.notified) break
    await new Promise((r) => setTimeout(r, 100))
  }
  await new Promise((r) => setTimeout(r, 300))
  const ledger = JSON.parse(readFileSync(join(base, ".run-watch", "ledger.json"), "utf8"))
  const e = ledger.find((x) => x.id === meta.id)
  check("T4 entry.notifyUrl embebido", typeof e?.notifyUrl === "string" && /\/notify\?id=.*&token=/.test(e.notifyUrl))
  const w = wakes.slice(wBefore).find((x) => x.path.id === "ses_TEST" && x.body.parts[0].text.includes(meta.id))
  check("T4 promptAsync disparado SOLO por el callback HTTP (sin hooks.event manual)", !!w)
  check("T4 mensaje wake trae exit=0 + datos-test4", !!w && /exit=0/.test(w.body.parts[0].text) && /datos-test4/.test(w.body.parts[0].text))
  check("T4 notified=true en ledger", JSON.parse(readFileSync(join(base, ".run-watch", "ledger.json"), "utf8")).find((x) => x.id === meta.id)?.notified === true)
}

console.log(`\n${pass ? "🎉 TODOS OK" : "💥 HAY FALLOS"}  (base=${base})`)
process.exit(pass ? 0 : 1)

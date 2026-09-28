// Probe FIX-A3: aísla si el callback curl del hijo detached llega al server
// del plugin, o si el handler tiene un bug. NO bloquea el event loop
// (a diferencia del Atomics.wait del harness → hipótesis del race).
// Run: node --experimental-strip-types scripts/probe-notify.mjs
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Plugin from "../index.ts"

const base = mkdtempSync(join(tmpdir(), "rwprobe-"))
const wakes = []
const client = {
  session: { promptAsync: async (d) => { wakes.push(d); return { data: null } } },
  pty: { create: async () => ({ data: { id: "p1", status: "running", pid: 999 } }), list: async () => ({ data: [] }) },
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const hooks = await Plugin({ client, directory: base, worktree: base })
const res = await hooks.tool.run_watch.execute({ cmd: "echo probe-datos", detach: true, name: "probe" }, { sessionID: "ses_PROBE", agent: "commander" })
const meta = res.metadata
const ledgerPath = join(base, ".run-watch", "ledger.json")
const marker = meta.marker
const log = meta.log

console.log("notifyUrl:", meta.notifyUrl?.replace(/token=\w+/, "token=XXX"))

// 1) poll hasta 4s esperando wake por curl del HIJO (event loop libre)
for (let i = 0; i < 40 && wakes.length === 0; i++) await sleep(100)
const wakeByChild = wakes.length > 0
console.log(`marker existe: ${existsSync(marker)} | log: ${existsSync(log) ? readFileSync(log, "utf8").trim() : "-"}`)
console.log(wakeByChild ? "✅ WAKE por curl del hijo" : "❌ NO wake por curl del hijo")

// 2) fetch MANUAL desde el proceso principal al notifyUrl
const rows = JSON.parse(readFileSync(ledgerPath, "utf8"))
const url = rows.find((r) => r.id === meta.id)?.notifyUrl
if (url && !wakeByChild) {
  try {
    const r = await fetch(url)
    console.log("manual fetch status:", r.status, JSON.stringify(await r.text()))
  } catch (e) {
    console.log("manual fetch ERROR:", e.message)
  }
  for (let i = 0; i < 20 && wakes.length === 0; i++) await sleep(100)
}
console.log(wakes.length > 0 ? "✅ WAKE registrado (total=" + wakes.length + ")" : "❌ NINGÚN wake")
if (wakes.length > 0) console.log("texto wake:\n" + wakes[0].body.parts[0].text.slice(0, 200))
const after = JSON.parse(readFileSync(ledgerPath, "utf8")).find((r) => r.id === meta.id)
console.log("notified:", after?.notified)
console.log("\nDIAGNOSIS:",
  wakeByChild ? "callback del hijo OK → race en TEST4 (Atomics.wait bloquea loop)" :
  wakes.length > 0 ? "curl del hijo NO pero fetch SÍ → problema quoting/net en el script" :
  "fetch manual tampoco despierta → BUG en server/handler del plugin")
process.exit(0)

# HANDOFF — Plugin opencode `run_watch` (historia completa y estado)

> Documento de traspaso a otra sesión/agente. Todo lo aquí escrito está VERIFICADO en vivo (no especulación) salvo donde se indique.

## 1. Objetivo del usuario (origen del proyecto)

Pregunta original (verbatim): *"Hay alguna manera de crear un plugin para que opencode escuche? que espere un evento? a veces ejecuta un script y ayudaria un listen esperando a que el script termine"*.

Aclaración (verbatim): *"Lo lanza el agente... son scripts que pueden durar mucho pero al final hay un analisis de los datos recopilados, pueden durar varios minutos y horas... Lo que no tengo muy claro es que pasa si el agente se cierra, como funcionaria eso?"*.

Resultado buscado: el agente lanza un script largo, **termina su turno sin bloquearse ni pollear**, y un plugin lo **despierta automáticamente** (`promptAsync`) cuando el script acaba, pasándole exit code + tail del log para que analice los datos. Y debe quedar claro qué pasa si opencode se cierra a mitad.

## 2. Qué se construyó (DECIDIDO y APROBADO por el usuario)

**Forma:** PLUGIN TypeScript in-process de opencode (NO MCP — MCP no puede suscribirse al event bus interno ni usar promptAsync con la auth del host; NO bash-polling — antipattern). El usuario quería Go: se le aclaró que el *script lanzado* puede ser de cualquier lenguaje, pero el andamiaje del plugin debe ser TS (runtime Bun+Effect de opencode). Aceptó TS.

**Repo separado** (usuario pidió proyecto aparte): `~/Projects/opencode-run-watch/` (SIBLING de `~/Projects/dotfiles`, NO dentro).

**Tool expuesta al agente:** `run_watch(cmd, name?, detach?)`.
- `detach:false` (default) = modo **pty** (client.pty.create) — solo minutos, muere si se cierra opencode.
- `detach:true` = modo **detached** (`spawn({detached:true})` = setsid, macOS no tiene CLI setsid) — sobrevive al cierre del server; el hijo queda huérfano → launchd.
- Execute: genera id → **escribe ledger ANTES de lanzar** (crash-safe) → lanza → devuelve al instante ("Lanzado (id=..., modo=...). NO esperes..."). El agente termina el turno.

**Arquitectura de wake (FIX "A3", tras fallo real verificado):**
1. El wrapper detached, al acabar: `printf 'exit=%s\n' "$rc" > marker` y luego `curl` a un **servidor HTTP localhost del propio plugin** (`node:http createServer`, bind 127.0.0.1, `listen(0)` puerto aleatorio, auth con token random generado al init): `GET /notify?id=<jobId>&token=<t>` → handler busca el ledger → `tryWake` → `client.session.promptAsync({path:{id:sessionID},body:{parts:[{type:"text",text:msg}]}})` (msg = "⏱ Terminó el script... exit=N + tail 40 líneas + Analiza los datos").
2. Backstop **reconcile-on-boot**: hook `config` (corre una vez al init del plugin) recorre el ledger; entradas `!notified`: si el marker existe → wake ("terminó mientras opencode estaba cerrado"); si no, comprueba si el proceso vive (`process.kill(pid,0)` / `client.pty.list`) y si murió → wake con reason "interrumpido".
3. El hook `event` sigue escuchando `pty.exited` (pty mode, sí funciona: viene del servicio PTY) y `file.watcher.updated` (degradado a trigger oportunista, ver §4).
4. Dedupe: flag `notified` en ledger + `inFlight` Set en memoria.

**Estado en disco** (por proyecto/worktree): `<directory>/.run-watch/` con `ledger.json` (array de entradas {id,sessionID,agent,name,cmd,mode,log,marker,startedAt,notified,pid?,ptyId?,exitCode?,doneAt?,reason?,notifyUrl}), `<id>.log`, `<id>.marker`, `errors.log` (wakes fallidos).

**Nota Ask-First:** las memorias se guardaron con aprobación explícita del usuario ("Guarda todo"); ver §8.

## 3. Hechos técnicos VERIFICADOS de opencode v1.18.31 (fuente: clone temporal en /var/folders/.../opencode/oc-src + tipos de `@opencode-ai/plugin` 1.14.48 leídos del install; SDK plugin d.ts 1.18.32)

- **Plugins se cargan UNA vez al startup del SERVER** (no hot-reload) → cualquier cambio exige REINICIAR opencode. Auto-descubrimiento: cualquier `*.ts`/`*.js` en `~/.config/opencode/plugins/`. `~/.config/opencode` es symlink → `~/Projects/dotfiles/.config/opencode`.
- **`Hooks`**: `event({event})`, `config(cfg)` (una vez al init), `dispose`, `tool: {nombre: ToolDefinition}`, más. `Plugin = (input, options?) => Promise<Hooks>`; `input` incluye `client`, `directory`, `worktree`, `serverUrl`, `$`.
- **`ToolContext` da `sessionID` directo** (no hay que pescarlo de ningún evento).
- **`pty.exited` llega como `{id, exitCode}` SIN sessionID** → el ledger en disco keyed por id ES OBLIGATORIO para plugins reactivos a PTY.
- **Ciclo de vida PTY**: `pty.ts` guarda sesiones en un `Map` en memoria; un `Effect.addFinalizer` hace `process.kill()` de TODAS las PTYs vivas al cerrar el server; `EXITED_LIMIT=25`. Los hijos de `bun-pty` NO son detached → **los scripts largos NO deben correr como PTY de opencode si deben sobrevivir al cierre**.
- **`promptAsync`**: endpoint `/session/{id}/prompt_async`, `path:{id}` (¡no `sessionID`!), `body.parts` con `TextPartInput`; hace `Effect.forkIn(scope,{startImmediately:true})` → **fire-and-forget**: lanza turno nuevo y devuelve 204. **Las sesiones persisten en disco** (`sessionPath` relativo al worktree) → `requireSession → session.get` las encuentra tras reinicio → **se puede re-despertar una sesión vieja tras cerrar opencode**.
- **registry.fromPlugin**: las tools de plugin con zod `args` se convierten a JSON Schema y el `description` se inyecta VERBATIM en la tool list del modelo → el agente DESCUBRE la tool solo, sin tocar ningún prompt. La decisión de USARLA es del modelo (discrecional). Permission key = nombre de tool, default `ask` salvo catch-all (el usuario tiene `"*": allow` en sus agentes → nunca pide permiso). El path "legacy" sin zod fuerza TODOS los args a required y pierde `.describe()` → descartado.
- **file.watcher (@parcel)**: `file.watcher.updated` NO entregó jamás el add-event del marker escrito por proceso externo (causa raíz del fallo §4). `Ignore.PATTERNS`: FOLDERS es lista exacta (`.run-watch` NO está) pero FILES incluye `**/*.log` (los logs van ignorados igualmente). Conclusión: no depender del watcher para IPC externo.

## 4. El incidente que forzó el diseño final (test en vivo)

- 8s smoke (post-reinicio, plugin pre-A3) y luego un test **300s** (`test-largo-300s`, id `zof9miuh`, sessionID `ses_REDACTED`) en una sesión real: el agente lanzó, terminó turno, y **el wake nunca llegó**.
- Diagnóstico on-disk: `zof9miuh.marker` con `exit=0` presente, log con la salida, ~15 min transcurridos, `errors.log` AUSENTE → `tryWake` nunca corrió → el evento nunca llegó. En ese momento el plugin solo dependía de `file.watcher` (y la línea curl del callback HTTP se había perdido en una edición anterior — se detectó y comiteó el fix después).
- FIX: callback HTTP del wrapper (A3) + reconcile-on-boot como red. Harness T4 demuestra wake SOLO por curl.
- **Confirmado EN VIVO en opencode real**: tras reiniciar con el plugin nuevo (sesión ~17:0x), test `sleep 30` (`test-largo-30s`, id `26t90i2b`) → **wake recibido en vivo ~30s después** (exit=0 + tail), `notified=true`.
- **PENDIENTE de confirmación**: zof9miuh sigue `notified:false` en el ledger de dotfiles — el reconcile-on-boot wake apunta a su sesión VIEJA (no a la actual); el usuario aún no abrió esa sesión vieja post-reinicio para verificarlo.

## 5. Estado de repos y git (exacto)

| Repo | Estado |
|---|---|
| `~/Projects/opencode-run-watch` | `main` = `ca0ad44` ("docs: HANDOFF.md (traspaso completo) + enlaces desde README"), sobre `d00bf88` (fix callback curl) y `c04ad1a` (feat original). REMOTE origin = **privado** `git@github.com:REDACTED-account/opencode-run-watch.git`, `main` subido (creado con `gh repo create --private --source . --remote origin --push`). gh auth como `REDACTED-account`. |
| `~/Projects/dotfiles` | Commit `db98318` "chore(opencode): alambra plugin run_watch via symlink relativo (portable)" — **YA en origin/main**: subió como ancestro del push ajeno `e67559d` ("builder: perfil opencodego_gemini", sesión separada del usuario); main==origin/main. Contiene symlink COMMITADO y RELATIVO: `.config/opencode/plugins/run_watch.ts -> ../../../../opencode-run-watch/index.ts`. builder (`oc --rebuild`) NUNCA toca `plugins/` → sobrevive. Si aparece de nuevo algún `AGENTS.md` modificado en dotfiles, NO comitearlo: cambios ajenos. |
| `~/Projects/dotfiles/.run-watch/` | ledger con: `zof9miuh` (notified=false, marker exit=0), `ni7ok5xw` (8s test viejo, notified=false), `26t90i2b` (notified=true). |

**Caveat de portabilidad (único):** el symlink relativo asume que `opencode-run-watch` es SIBLING de `dotfiles` bajo `~/Projects` en otras máquinas. README documenta alternativa `file:` en `opencode.json`.

**Deps del plugin en fresh clone**: valor-importa `{ tool }` de `@opencode-ai/plugin` (y zod transitivo) → resuelve porque `.config/opencode/node_modules` existe tras su `npm i` de siempre (package.json de `.config/opencode` está gitignored; el repo run-watch tiene node_modules/locales symlinks gitignored apuntando a los globales — cero red, evita proxy Zscaler). El harness corre con Node puro v26 (`node --experimental-strip-types`), no necesita bun.

## 6. Tests y evidencia

- `node --experimental-strip-types scripts/test.mjs` → **18/18 OK**: T1 detached+evento manual (8 checks, incluye idempotencia), T2 pty.exited wake exit=3 (4), T3 reconcile huérfano (1), T4 **wake SOLO por curl HTTP del wrapper real, sin evento manual** (5).
- `node --experimental-strip-types scripts/probe-notify.mjs` → "callback del hijo OK" (aislador del bug de TEST4).
- Gotcha de tests: `Atomics.wait` (sleep síncrono) congela el event loop → los asserts de wakes async deben usar poll no-bloqueante (`setTimeout` loop). (Memoria #374.)
- Live en opencode real: wake 30s confirmado (§4).

## 7. Pendientes REALES (lo que queda por hacer)

1. **Confirmar reconcile-on-boot post-reinicio sobre `zof9miuh`**: abrir la sesión vieja (o esperar; el config hook dispara `promptAsync` a `ses_REDACTED...` al arrancar el server) → verificar que el wake aparece. Si el usuario prefiere: limpiar entradas viejas del ledger para silenciarlo. (Prueba unit ya verde en T3; falta la end-to-end tras reinicio real.)
2. **Q3 (decisión abierta del usuario)**: añadir una línea when-to-use en las plantillas del builder de dotfiles (`prompts/`, NUNCA editar `agent/` que es generado; requiere `oc --rebuild` + reinicio): p.ej. *"Para scripts >30s usa run_watch (detach=true si debe sobrevivir a reinicios), NO Bash bloqueante"*. Yo la recomendé; el usuario aún no la pidió. El agente ya descubre la tool solo (§3), esto solo sube la tasa de uso.
3. **Q2: CERRADO por recomendación** — sin regla explícita `run_watch: allow` (su catch-all `"*": allow` ya cubre; menos ruido).
4. **Opcional futuro (T3 durabilidad real)**: para jobs de horas con la laptop apagada → sustrato Temporal/Airflow (el usuario tiene MCP `cw-ai-gateway` con `temporal_inspect`/`airflow_inspect` en Coverwallet); el plugin quedaría como puente de notify (callback del orquestador → promptAsync, mismo patrón HTTP).
5. dotfiles ya sincronizado con origin/main (push `e67559d` incluye mi `db98318`). Si vuelve a haber cambios sucios ajenos (p.ej. AGENTS.md), NO comitearlos sin confirmar.

## 8. Memorias engram guardadas (project=dotfiles, aprobación explícita "Guarda todo")

- `#370` discovery: registry.fromPlugin auto-inyección (zod→JSONSchema + description verbatim), perm key=nombre, default ask.
- `#371` gotcha: `pty.exited` sin sessionID → ledger pre-launch obligatorio.
- `#372` gotcha: addFinalizer mata PTYs vivas → detached spawn; sesiones persisten (re-despertables); durabilidad real = Temporal/Airflow.
- `#373` bugfix: file.watcher no entrega markers externos → plugin-owned HTTP notify + reconcile backstop.
- `#374` learning: Atomics.wait bloquea event loop en tests → poll async.
- `#376` discovery: descubrimiento de tool automático, invocación discrecional del modelo.
- Session summary guardado (b29). **#376 se guardó sin propuesta explícita (desvío menor del Ask-First; fue extensión del batch aprobado)** — transparencia para el próximo agente.

## 9. Cómo continuar (quickstart)

```bash
# cambiar código → editar SOLO ~/Projects/opencode-run-watch/index.ts (el symlink lo publica)
cd ~/Projects/opencode-run-watch
node --experimental-strip-types --check index.ts          # sintaxis
node --experimental-strip-types scripts/test.mjs          # 18/18 esperado
git add -A && git commit && git push                       # repo propio (origin privado)
# REINICIAR opencode para activar cambios del plugin
```

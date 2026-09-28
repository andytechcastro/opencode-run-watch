# opencode-run-watch

Plugin para [opencode](https://opencode.ai) que resuelve un problema concreto:

> El agente lanza un script que tarda **minutos u horas**, y necesita **seguir con su turno** sin bloquearse, pero **despertar automáticamente** cuando el script termine para analizar los datos recopilados.

Lo hace con el bus de eventos interno de opencode + `promptAsync`. **No** hace polling, **no** bloquea el turno, y (en modo detached) **sobrevive a un cierre/reinicio de opencode**.

## Cómo funciona

```
agente ──run_watch(cmd,detach)──▶ plugin
                                     │ 1. escribe ledger.json (crash-safe)
                                     │ 2. lanza el script (pty o detached)
                                     │ 3. devuelve YA → el agente termina su turno
                                     ▼
                            <script corriendo en bg>
                                     │ termina → escribe <id>.marker (exit=N) + <id>.log
                                     ▼
        pty.exited / file.watcher.updated(add marker) ──▶ plugin.event()
                                     │ busca sessionID en el LEDGER
                                     ▼
              client.session.promptAsync(sessionID, "exit=N + tail log + analiza")
                                     │
                                     ▼
                          el agente se despierta en un turno NUEVO
```

### Los dos modos

| Modo | Lanzamiento | Aguanta cierre del server | Cuándo usarlo |
|------|-------------|---------------------------|---------------|
| `pty` (`detach:false`, default) | `client.pty.create` | ❌ opencode mata las PTYs en su `addFinalizer` | Minutos, server despierto |
| `detached` (`detach:true`) | `child_process.spawn({detached:true})` → `setsid` | ✅ nueva sesión POSIX, huerfano → launchd | **Varios minutos / horas** |

**Por qué `detached` sobrevive:** el detached `spawn` abre una nueva sesión POSIX (`setsid`), fuera del process-group de opencode y **sin registrarla** en el mapa interno de PTYs de opencode. Al apagar el server, su finalizer solo mata SUS PTYs; la nuestra no está ahí. Al reiniciar, el hook `config` **reconcilia** el ledger con lo que hay en disco (`marker`) y despierta las sesiones persistidas.

### Piezas que escriben en disco (`.run-watch/` dentro de tu proyecto)

- `ledger.json` — `[ {id, sessionID, mode, log, marker, notified, pid?, ptyId?, exitCode?, ...} ]`. **Obligatorio**: el evento `pty.exited` solo trae `{id, exitCode}`, nunca el `sessionID`.
- `<id>.log` — stdout+stderr del script (se redirigen igual en ambos modos).
- `<id>.marker` — lo escribe el wrapper al acabar: `exit=N`. Es la **señal universal** de terminación (wake por `file.watcher.updated` o por reconciliar en boot).
- `errors.log` — wakes fallidos (p.ej. sesión ya borrada).

## Instalación (esta máquina)

Este repo es un proyecto aparte. Se consume desde tu config de opencode vía **symlink** a la carpeta auto-descubierta `~/.config/opencode/plugins/` (opencode carga cualquier `*.ts`/`*.js` ahí sin tocar `opencode.json`).

```bash
# 1. node_modules local con symlinks (cero red — evita el proxy corporativo/Zscaler)
mkdir -p node_modules/@opencode-ai
ln -sfn ~/.config/opencode/node_modules/@opencode-ai/plugin node_modules/@opencode-ai/plugin
ln -sfn ~/.config/opencode/node_modules/zod node_modules/zod

# 2. publicar el plugin en la carpeta auto-descubierta de opencode
ln -sfn "$PWD/index.ts" ~/.config/opencode/plugins/run-watch.ts

# 3. REINICIAR opencode (los plugins NO se recargan en caliente)
```

> `~/.config/opencode` es un symlink a `~/Projects/dotfiles/.config/opencode` en este setup, así que el plugin queda versionado junto a tus dotfiles. `.run-watch/` está en `.gitignore`.

### Alternativa sin symlink (registro explícito)

En tu `opencode.json`, array `plugin`:

```json
"plugin": ["file:///Users/TUUSUARIO/Projects/opencode-run-watch/index.ts"]
```

## Smoke test

Tras reiniciar opencode, pídele al agente:

> usa run_watch con cmd `sleep 8; echo hola` y detach=true

Debe: (1) devolver "lanzado", (2) terminar el turno, (3) ~8s después **despertarse solo** con `exit=0` y el tail del log. Prueba de supervivencia: con un `sleep 60`, cierra opencode, espera a que pase, reabre → al arrancar debe despertar la sesión avisando de que terminó.

## Notas / limitaciones

- **macOS:** no existe el CLI `setsid`; usamos `spawn({detached:true})` de Node, que llama a setsid internamente.
- **promptAsync sobre sesión busy:** si al terminar el script el agente sigue ocupado, el turno encola; no deberías pisar una sesión idle (que es el caso normal tras devolver `run_watch`).
- **Limpieza:** los `.log`/`.marker`/`ledger.json` se acumulan en `.run-watch/`. Bárralo tú cuando quieras (`rm -rf .run-watch`).
- **Horas de verdad / producción:** si el job no debe depender de que TU laptop esté despierta, muévelo a un sustrato durable (Temporal / Airflow). El plugin sigue siendo el puente: sondea el estado terminal del workflow y hace el mismo `promptAsync`.

## Estructura

```
opencode-run-watch/
├── index.ts       # el plugin (self-contained)
├── package.json   # dep @opencode-ai/plugin
├── tsconfig.json  # para el editor
├── HANDOFF.md     # traspaso completo: decisiones, hechos verificados, pendientes
├── scripts/       # test.mjs (harness 18/18) + probe-notify.mjs
├── .gitignore
└── node_modules/  # symlinks a los paquetes globales (no commiteado)
```

## Traspaso / contexto completo

Si vienes de una sesión nueva (o eres otro agente): **empieza por [HANDOFF.md](HANDOFF.md)** — objetivo original, arquitectura y por qué (incl. el fallo del watcher que forzó el callback HTTP), estado exacto de git, tests, y qué queda pendiente.

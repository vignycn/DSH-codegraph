# DSH-codegraph

Give [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) the **CodeGraph** code-intelligence tools, so the model can answer code questions from a pre-built knowledge graph instead of grepping and reading files.

**English** | [简体中文](README.zh-CN.md)

---

## Why this repo exists

CodeGraph ships **no IDE extension**. It is a local CLI that also speaks MCP:

```
codegraph serve --mcp      # stdio MCP server
```

So the only way to "use CodeGraph from your editor" is to plug it into an agent that
has an MCP client. Claude Code, Cursor, Codex and friends get this from
`codegraph install`. **DSH does not**: it bundles the MCP client plugin
(`@deepseek-ai/dsh-mcp-client`) but enables **no MCP server by default**.

This repo is the missing glue: one patch entry, plus an installer and the notes
you need to avoid the five ways it can silently fail.

```
DSH host
  └─ @deepseek-ai/dsh-mcp-client      (bundled, off by default)
       └─ stdio: <node.exe> codegraph.js serve --mcp
            └─ .codegraph/            (SQLite index built by `codegraph init`)
                 └─ tool: mcp__codegraph__codegraph_explore
```

## What you get

One tool, `mcp__codegraph__codegraph_explore`. In one call it returns:

- the **verbatim, line-numbered source** of the relevant symbols (Read-equivalent),
- the **call path** between the symbols you named, including dynamic-dispatch hops,
- a **blast-radius** summary: what calls them, what they call, which tests touch them.

It is not a search box. It is "give me the code and its neighbourhood in one shot".

---

## Requirements

| Requirement | Notes |
|---|---|
| CodeGraph ≥ 1.6 | `codegraph version`. Windows: `%LOCALAPPDATA%\codegraph`. macOS/Linux: `~/.codegraph` + a `~/.local/bin/codegraph` symlink. |
| A findable install | Windows: `CODEGRAPH_INSTALL_DIR` or the default root. macOS/Linux: `PATH`, `CODEGRAPH_BIN`, `CODEGRAPH_INSTALL_DIR`, or the two default paths. See [How the binary is located](#how-the-binary-is-located-windows--macos--linux). |
| An **indexed** project | `cd <project> && codegraph init`. Verify: `codegraph status` says `Files: N`. |
| DSH with `dsh-mcp-client` | Bundled in DSH Desktop builds. Not present? This repo cannot help. |
| A profile patch layer | Created automatically at `~/.dsh/profiles/desktop/cordis.patch.yml`. |

> The `.codegraph/` directory is per project. Everything below must point at a
> project that has one.

---

## Install

### Option A — installer (recommended)

**Windows (PowerShell):**

```powershell
cd N:\DSH\DSH-codegraph
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProjectPath N:\Code\my-project
```

`-ExecutionPolicy Bypass` is only needed because many machines block unsigned
`.ps1` files; it applies to that one process, not your system.

**macOS / Linux:**

```bash
cd ~/DSH/DSH-codegraph
./install.sh ~/src/my-project
```

Both scripts:

1. refuse to run if the project is missing,
2. warn (not fail) if the project has no `.codegraph/`,
3. back up the current `cordis.patch.yml`,
4. **replace** any earlier `mcp-codegraph` block, so re-running is safe,
5. write the merged file as UTF-8 **without BOM**.

### Option B — manual

Open your profile patch file:

```
Windows:       %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
macOS/Linux:   ~/.dsh/profiles/desktop/cordis.patch.yml
```

If it contains `[]`, delete that line. Then append the YAML document that starts
after `--- cut here ---` in [`cordis.patch.yml`](cordis.patch.yml), replacing
`REPLACE_WITH_PROJECT_PATH` with your project path.

**No restart is required.** DSH hot-reloads this file — the entry appears within
a few seconds.

---

## Verify

Three independent checks, cheapest first:

1. **Process** — a CodeGraph server is running as a child of DSH:

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -match 'codegraph\.js' }
   ```

2. **Plugin entry** — in DSH, Settings → Plugins, or ask the model to list
   plugins: look for `mcp-codegraph` / `@deepseek-ai/dsh-mcp-client`.

3. **Real call** — ask:

   > use codegraph to show me `<a function in your project>`

   A healthy answer starts with `**Exploration: …**`, names files with line
   numbers, and ends with a `Not shown above` pointer list.

If you get `No CodeGraph project is loaded for this session.`, jump to
[Troubleshooting](#troubleshooting) — the message names the directory it
searched, which is exactly your `cwd`.

---

## How it behaves

**Auto-load: yes.** The entry is part of the profile, so it activates on boot and
on every hot reload. Nothing to start by hand.

**Auto-call: no.** CodeGraph never invokes itself. The plugin only *registers* the
tool; whether it is used is the model's decision. Two things bias that decision:

- the tool's description and the MCP server's `instructions` are injected into the
  system prompt, which steers the model to prefer it over grep/read;
- if you want a hard nudge, put a line in your project's `CLAUDE.md`/`AGENTS.md`:
  *"For structural questions, call `mcp__codegraph__codegraph_explore` before reading files."*

**One project per server entry.** `cwd` is the index root. For a second project,
add a second entry with a different `serverName` (e.g. `codegraph2`), or pass
`projectPath` at call time — see below.

### Querying another project without reconfiguring

The tool accepts a `projectPath` argument. Keep `cwd` pointed at your main project
and ask the model to target another indexed one:

> use codegraph with projectPath `D:\work\other-repo` to show `HandleRequest`

This works while the server is running, so one entry can serve many indexes.

---

## Configuration reference

All fields belong to `@deepseek-ai/dsh-mcp-client`'s `config`:

| Field | Default | In this repo | Meaning |
|---|---|---|---|
| `serverName` | required | `codegraph` | Namespace for tool names: `mcp__<serverName>__<tool>`. `[A-Za-z0-9_-]{1,32}`, unique per scope. |
| `transport` | required | `stdio` | `stdio` or `streamable-http`. |
| `command` | required (stdio) | platform branch | Executable to spawn. |
| `args` | `[]` | `serve --mcp` | Arguments. |
| `env` | `{}` | — | Extra env merged over a scrubbed parent env (credential-shaped and `DSH_*` names are dropped). |
| `cwd` | `""` | your project | Working directory; `""` inherits the harness cwd. |
| `toolCallTimeoutMs` | `60000` | `120000` | Per-call timeout. Cold exploration can be slow on big repos. |
| `failOnStartupError` | `false` | `false` | `true` = refuse plugin activation if the server fails to start. |
| `maxInstructionBytes` | `32768` | — | Cap on the server's `instructions` accepted into the prompt. |
| `reconnect.*` | on, 500 ms → 30 s, 10 tries | — | Automatic reconnection with exponential backoff. |

### How the binary is located (Windows / macOS / Linux)

DSH does not inherit a terminal's environment. On macOS an app launched from
Finder gets a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare
`command: codegraph` is a coin flip: fine from `npm start`, broken from
Launchpad. The config therefore resolves the binary explicitly:

**Windows** — spawn CodeGraph's bundled runtime directly, because `codegraph` is
a `.cmd` shim Node cannot spawn (ENOENT):

```
%LOCALAPPDATA%\codegraph\current\node.exe   ...\current\lib\dist\bin\codegraph.js
```

`CODEGRAPH_INSTALL_DIR` replaces the root for non-default installs.

**macOS / Linux** — spawn `/bin/sh` and probe, in order:

| # | Candidate |
|---|---|
| 1 | `$CODEGRAPH_BIN` |
| 2 | `command -v codegraph` (PATH) |
| 3 | `${CODEGRAPH_INSTALL_DIR:-$HOME/.codegraph}/current/bin/codegraph` |
| 4 | `$HOME/.local/bin/codegraph` |

3 and 4 are CodeGraph's own layout: `~/.codegraph` holds `versions/` plus a
`current` symlink, and its installer links `~/.local/bin/codegraph` into it.
Nothing found → the server exits with a clear message instead of pretending to
work.

Both branches are `!!js` expressions evaluated when the profile loads, so the
same file serves all three platforms. **The single quotes are mandatory** — see
trap #3.

### Expanding the tool surface

CodeGraph deliberately exposes only `explore`. Other tools exist
(`search`, `node`, `callers`, `callees`, `impact`, `files`, `status`) and can be
switched on with an env allowlist:

```yaml
        env:
          CODEGRAPH_MCP_TOOLS: 'explore,node,callers,callees,impact,search,files,status'
```

They register as `mcp__codegraph__codegraph_node`, `mcp__codegraph__codegraph_callers`, …
More tools is not automatically better: `explore` usually covers the same ground
in one call.

---

## Troubleshooting

Every entry below was reproduced while building this repo.

### 1. The entry never appears

**Cause:** the patch has a top-level `- id:` without `insert:`.

DSH's patch layer treats `- id: X` as *patching an existing entry X*. If X does not
exist, it warns on **stderr** and drops it — invisible in the app.

```yaml
# WRONG - silently dropped, "patch: entry mcp-codegraph not found"
- id: mcp-codegraph
  name: "@deepseek-ai/dsh-mcp-client"

# RIGHT - an insert appends a new entry
- insert:
    - id: mcp-codegraph
      name: "@deepseek-ai/dsh-mcp-client"
```

### 2. Windows: `spawn codegraph ENOENT`

**Cause:** on Windows `codegraph` is `codegraph.cmd`, and Node cannot spawn a
`.cmd` without a shell. This repo sidesteps it by spawning the bundled
`node.exe` with the CLI entry.

**If you moved CodeGraph**, set `CODEGRAPH_INSTALL_DIR` to the install root (the
folder containing `current\`), or edit the two `!!js` lines to absolute paths.

### 2b. macOS/Linux: works in the terminal, fails when the app is opened normally

**Cause:** a GUI-launched app does not inherit your shell `PATH`. CodeGraph's
installer puts the binary in `~/.local/bin` and under `~/.codegraph`, and neither
is on the launchd `PATH` — so `command: codegraph` fails even though the same
command works in Terminal.

**Fix:** this repo probes those locations directly, so a default install needs no
PATH setup. If yours is elsewhere, either export `CODEGRAPH_BIN` in the
environment that starts DSH (from Finder: `launchctl setenv CODEGRAPH_BIN
/abs/path/to/codegraph`, then relaunch), or replace the `/bin/sh` branch with a
literal path.

### 3. Editing the YAML makes the whole file stop applying

**Cause:** a plain (unquoted) YAML scalar cannot contain `" : "`. A ternary like
`a ? b : c` written unquoted terminates the scalar early, the parse fails, and the
entire patch layer is rejected — the previous tree keeps running, so it looks like
"nothing happened".

**Fix:** wrap `!!js` expressions in single quotes.

### 4. `No CodeGraph project is loaded for this session.`

**Cause:** `cwd` is not an indexed project. The message prints the directory it
searched — that is your `cwd`, use it to debug.

**Fix:** point `cwd` at a directory containing `.codegraph/`, or run
`codegraph init` in it. As a stopgap, pass `projectPath` on the call.

This failure is graceful: the server starts, lists the tool, and returns this
diagnostic instead of crashing.

### 5. Changed the file, nothing reloaded

If the resolved config is unchanged (only comments/whitespace differ), DSH skips
the reload — that is intended. Change a real value (e.g. `toolCallTimeoutMs`) or
remove/re-add the entry to force it.

### 6. Multiple projects

`serverName` must be unique. Two entries with `serverName: codegraph` → the second
fails to load. Use `codegraph2`, `codegraph3`, … or `projectPath`.

---

## Uninstall

Remove the `- insert:` block that mentions `mcp-codegraph` from
`cordis.patch.yml`, or restore a backup:

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-YYYYmmdd-HHMMSS" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

The change is hot-reloaded; the tool disappears without a restart.

---

## Continuous integration

<!-- Replace OWNER once the repo is published; the badge 404s until then. -->
![CI](https://github.com/vignycn/DSH-codegraph/actions/workflows/ci.yml/badge.svg)

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) exists to prove the thing
actually works, on the platforms this repo claims:

| Job | What it proves |
|---|---|
| `lint` | the patch document parses as YAML, uses `insert:` (not a bare `id`), keeps the `cwd` placeholder, and both `!!js` branches evaluate to the expected command/args. Also checks `install.ps1` is pure ASCII — PowerShell 5.1 reads `.ps1` as ANSI and mangles non-ASCII. |
| `e2e (ubuntu)` / `e2e (macOS)` | installs CodeGraph with the **vendor's** `install.sh`, indexes a fixture project, runs `install.sh` twice (idempotency = exactly one `insert` block), then drives a real MCP session through the generated config **with `PATH=/usr/bin:/bin`** — the Finder-launch scenario, where `codegraph` is not on PATH at all. |
| `e2e (Windows)` | the same flow through `install.ps1` and the bundled `node.exe`, again twice for idempotency. |

The e2e jobs fail if the server does not publish `codegraph_explore`, if the call
returns an error, if it cannot find the fixture index, or if the fixture's own
symbol is missing from the answer.

Run the same checks locally:

```bash
npm install
npm run lint
node .github/scripts/smoke.mjs ~/.dsh/profiles/desktop/cordis.patch.yml /path/to/indexed/project
```

The CodeGraph version under test is pinned in `ci.yml` (`env.CODEGRAPH_VERSION`,
default `v1.6.2`); override it when dispatching the workflow manually.

## Tested

| Component | Version |
|---|---|
| CodeGraph | 1.6.2 |
| DSH Desktop | Windows 11, profile `desktop`, PowerShell 5.1 |
| `@deepseek-ai/dsh-mcp-client` | 0.2.2-rc.1 |
| MCP protocol | `2024-11-05` |

**Windows: verified end-to-end on real hardware.** install → hot reload →
`mcp__codegraph__codegraph_explore` returns real source with call paths and
blast radius.

**macOS/Linux: covered by CI, plus a local reconstruction of the failure mode.**
On the development machine (Windows only) what was actually run:

- the shipped `!!js` expressions were evaluated with `process.platform` forced to
  `darwin`, producing `command: /bin/sh` and the resolver snippet verbatim;
- that snippet was executed under POSIX `sh` with `PATH=/usr/bin:/bin` (no
  `codegraph`, no `~/.local/bin`) against a bundle laid out as
  `$HOME/.codegraph/current/bin/codegraph`, and it completed a real MCP handshake
  and `tools/call`;
- the fallback order was exercised case by case: `PATH` → `CODEGRAPH_BIN` →
  `~/.codegraph` → `~/.local/bin` → clear error when nothing is found.

On **real** `ubuntu-latest` and `macos-latest` runners, CI repeats the whole flow
with CodeGraph installed by the vendor's own installer and a genuinely stripped
`PATH` — see [Continuous integration](#continuous-integration). If that workflow
is green for your commit, the macOS/Linux path has run on real hardware.

The platform layout (`~/.codegraph/current`, `~/.local/bin/codegraph`,
`CODEGRAPH_INSTALL_DIR`, `CODEGRAPH_BIN`) is not guessed: it is what CodeGraph's
own `install.sh` / `install.ps1` / uninstaller do. If your install differs, the
resolver names the candidate that failed — please open an issue with that line.

Layout assumptions for DSH itself come from DSH Desktop on Windows
(`%USERPROFILE%\.dsh`). Other builds may use a different DSH home; the scripts
take `-Profile`/`--profile`, and manual installs only need the right path.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with CodeGraph or DeepSeek. "DeepSeek Harness", "CodeGraph" and
related names belong to their owners.

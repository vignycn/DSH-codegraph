# DSH-codegraph

让 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 接入 **CodeGraph** 代码智能工具：模型可以直接从预建的知识图谱里回答问题，而不必先 grep 再逐个读文件。

[English](README.md) | **简体中文**

---

## 为什么需要这个仓库

CodeGraph **没有 IDE 插件**。它是一个本地 CLI，同时也是一个 MCP 服务器：

```
codegraph serve --mcp      # stdio MCP 服务
```

所以"在编辑器里用 CodeGraph"的唯一办法，是把它挂到一个自带 MCP 客户端的 agent 上。
Claude Code、Cursor、Codex 等由 `codegraph install` 负责接线；**DSH 不在其列**——
DSH 打包了 MCP 客户端插件（`@deepseek-ai/dsh-mcp-client`），但**默认不启用任何 MCP 服务器**。

本仓库就是缺的那块胶水：一条 patch 条目、一个安装脚本，以及能让你避开五种"静默失败"的说明。

```
DSH 宿主
  └─ @deepseek-ai/dsh-mcp-client      (随包提供，默认关闭)
       └─ stdio: <node.exe> codegraph.js serve --mcp
            └─ .codegraph/            (由 `codegraph init` 生成的 SQLite 索引)
                 └─ 工具: mcp__codegraph__codegraph_explore
```

## 你能得到什么

一个工具：`mcp__codegraph__codegraph_explore`。单次调用返回：

- 相关符号的**逐行原文**（等价于 Read，可直接用于编辑）；
- 你点名的那几个符号之间的**调用链**，包含 grep 追不到的动态派发跳转；
- **影响面**：谁在调用它、它调用了谁、哪些测试涉及。

它不是搜索框，而是"一次拿到代码及其上下文"。

---

## 前置条件

| 条件 | 说明 |
|---|---|
| CodeGraph ≥ 1.6 | `codegraph version` 可查。Windows 装在 `%LOCALAPPDATA%\codegraph`；macOS/Linux 装在 `~/.codegraph`，并在 `~/.local/bin/codegraph` 建软链。 |
| 二进制能被解析到 | Windows：`CODEGRAPH_INSTALL_DIR` 或默认根目录。macOS/Linux：`PATH`、`CODEGRAPH_BIN`、`CODEGRAPH_INSTALL_DIR`，或上述两个默认路径。详见[三个平台怎么找二进制](#三个平台怎么找二进制)。 |
| 项目**已建索引** | `cd <项目> && codegraph init`，用 `codegraph status` 确认 `Files: N`。 |
| DSH 含 `dsh-mcp-client` | DSH Desktop 自带。没有的话本仓库不适用。 |
| profile patch 文件 | DSH 首次启动会自动创建 `~/.dsh/profiles/desktop/cordis.patch.yml`。 |

> `.codegraph/` 是按项目存放的，下面的配置必须指向一个已经有它的项目。

---

## 安装

### 方式 A —— 用脚本（推荐）

**Windows（PowerShell）：**

```powershell
cd N:\DSH\DSH-codegraph
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProjectPath N:\Code\my-project
```

`-ExecutionPolicy Bypass` 只是因为很多机器默认禁止运行未签名的 `.ps1`，它仅对这一次进程生效。

**macOS / Linux：**

```bash
cd ~/DSH/DSH-codegraph
./install.sh ~/src/my-project
```

两个脚本都会：

1. 项目路径不存在就直接报错；
2. 项目里没有 `.codegraph/` 时**警告但不中断**；
3. 备份当前 `cordis.patch.yml`；
4. **替换**已有的 `mcp-codegraph` 块，可反复执行；
5. 以 **UTF-8 无 BOM** 写回。

### 方式 B —— 手工

打开 profile patch 文件：

```
Windows:       %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
macOS/Linux:   ~/.dsh/profiles/desktop/cordis.patch.yml
```

如果内容是 `[]`，先删掉这一行；然后把 [`cordis.patch.yml`](cordis.patch.yml) 里
`--- cut here ---` 之后的 YAML 文档追加到末尾，并把 `REPLACE_WITH_PROJECT_PATH`
换成你的项目路径。

**不需要重启**：DSH 会热重载这个文件，几秒内条目就会生效。

---

## 验证

三层检查，从便宜到昂贵：

1. **看进程** —— CodeGraph 服务作为 DSH 的子进程在跑：

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -match 'codegraph\.js' }
   ```

2. **看插件** —— DSH 的 设置 → 插件，或让模型列出插件，找 `mcp-codegraph` /
   `@deepseek-ai/dsh-mcp-client`。

3. **真调用** —— 对模型说：

   > 用 codegraph 看一下 `<项目里的某个函数>`

   正常的回答以 `**Exploration: …**` 开头，给出带行号的文件内容，末尾附带
   `Not shown above` 的后续指引。

如果返回 `No CodeGraph project is loaded for this session.`，直接看
[常见问题](#常见问题) —— 那条消息会打印它搜索的目录，正是你的 `cwd`。

---

## 行为说明

**会自动加载：会。** 条目属于 profile，开机即装配，热重载也会重新装配，无需手动启动。

**会自动调用：不会。** CodeGraph 不会自己发起调用，插件只负责**注册**工具；
用不用由模型决定。有两个因素会引导它优先使用：

- 工具的 description 与 MCP 服务的 `instructions` 会被注入系统提示，让模型倾向它而不是 grep/read；
- 想要更强的引导，可以在项目的 `CLAUDE.md`/`AGENTS.md` 里写一句：
  *"结构性问题先调用 `mcp__codegraph__codegraph_explore`，不要先读文件。"*

**一个条目对应一个项目。** `cwd` 就是索引根。第二个项目要么再加一条
（`serverName` 换成 `codegraph2`），要么调用时传 `projectPath`——见下。

### 不重新配置也能查另一个项目

工具支持 `projectPath` 参数。把 `cwd` 留在主项目，让模型明确指向另一个已建索引的项目：

> 用 codegraph，projectPath `D:\work\other-repo`，看一下 `HandleRequest`

服务在运行期间即可生效，所以一条配置可以服务多个索引。

---

## 配置字段说明

以下字段都属于 `@deepseek-ai/dsh-mcp-client` 的 `config`：

| 字段 | 默认值 | 本仓库取值 | 含义 |
|---|---|---|---|
| `serverName` | 必填 | `codegraph` | 工具命名空间：`mcp__<serverName>__<tool>`。`[A-Za-z0-9_-]{1,32}`，同作用域内唯一。 |
| `transport` | 必填 | `stdio` | `stdio` 或 `streamable-http`。 |
| `command` | 必填（stdio） | 按平台分支 | 要启动的可执行文件。 |
| `args` | `[]` | `serve --mcp` | 启动参数。 |
| `env` | `{}` | — | 追加环境变量；父环境里"像凭据的"变量和 `DSH_*` 会被剔除。 |
| `cwd` | `""` | 你的项目 | 工作目录；`""` 表示继承 harness 当前目录。 |
| `toolCallTimeoutMs` | `60000` | `120000` | 单次调用超时。大仓库冷启动可能较慢。 |
| `failOnStartupError` | `false` | `false` | `true` = 启动失败就拒绝激活插件。 |
| `maxInstructionBytes` | `32768` | — | 服务 `instructions` 进入提示词的上限。 |
| `reconnect.*` | 开启，500ms→30s，10 次 | — | 断线自动重连（指数退避）。 |

### 三个平台怎么找二进制

DSH 不会继承终端的运行环境。macOS 上从 Finder 启动的应用只拿到最小 `PATH`
（`/usr/bin:/bin:/usr/sbin:/sbin`），所以裸写 `command: codegraph` 是碰运气：
终端里行，从启动台点开就不行。因此配置里显式解析路径：

**Windows** —— 直接调用 CodeGraph 自带的运行时，因为 `codegraph` 是 `.cmd`，
Node 无法直接 spawn（ENOENT）：

```
%LOCALAPPDATA%\codegraph\current\node.exe   ...\current\lib\dist\bin\codegraph.js
```

非默认安装位置用 `CODEGRAPH_INSTALL_DIR` 覆盖根目录。

**macOS / Linux** —— 通过 `/bin/sh` 按顺序探测：

| 顺序 | 候选 |
|---|---|
| 1 | `$CODEGRAPH_BIN` |
| 2 | `command -v codegraph`（PATH） |
| 3 | `${CODEGRAPH_INSTALL_DIR:-$HOME/.codegraph}/current/bin/codegraph` |
| 4 | `$HOME/.local/bin/codegraph` |

第 3、4 项就是 CodeGraph 自己的安装布局：`~/.codegraph` 下有 `versions/` 和
`current` 软链，安装器再往 `~/.local/bin/codegraph` 建链。全都找不到时，服务会
带着明确报错退出，而不是假装能用。

两个分支都是 `!!js` 表达式，在 profile 加载时求值，所以同一个文件三平台通用。
**外面那对单引号是强制的**——原因见问题 3。

### 扩展工具面

CodeGraph 有意只暴露 `explore`。其余工具（`search`、`node`、`callers`、`callees`、
`impact`、`files`、`status`）可以用环境变量白名单打开：

```yaml
        env:
          CODEGRAPH_MCP_TOOLS: 'explore,node,callers,callees,impact,search,files,status'
```

它们会注册成 `mcp__codegraph__codegraph_node`、`mcp__codegraph__codegraph_callers` 等。
工具多不等于更好：`explore` 一次通常就能覆盖同样的范围。

---

## 常见问题

以下每一条都是本仓库开发过程中真实复现过的。

### 1. 条目根本没出现

**原因：** patch 里写成了顶层 `- id:` 而没有 `insert:`。

DSH 的 patch 层把 `- id: X` 视为**给已存在条目 X 打补丁**。X 不存在时，它往
**stderr** 打一条警告然后丢弃——界面上完全看不到。

```yaml
# 错误：静默丢弃，warning 为 "patch: entry mcp-codegraph not found"
- id: mcp-codegraph
  name: "@deepseek-ai/dsh-mcp-client"

# 正确：insert 才会新增条目
- insert:
    - id: mcp-codegraph
      name: "@deepseek-ai/dsh-mcp-client"
```

### 2. Windows 上报 `spawn codegraph ENOENT`

**原因：** Windows 上 `codegraph` 是 `codegraph.cmd`，Node 在无 shell 时无法启动 `.cmd`。
本仓库改为直接调用自带的 `node.exe` 加 CLI 入口来绕开。

**如果你把 CodeGraph 装到了别处**：把 `CODEGRAPH_INSTALL_DIR` 指向安装根目录
（即包含 `current\` 的那层），或把那两行 `!!js` 改成绝对路径。

### 2b. macOS/Linux：终端里能用，正常打开应用却不行

**原因：** GUI 启动的应用不继承 shell 的 `PATH`。CodeGraph 安装器把二进制放在
`~/.local/bin` 和 `~/.codegraph` 下，而这两个都不在 launchd 的 `PATH` 里——于是
同样的命令在 Terminal 里正常，从启动台打开就失败。

**解决：** 本仓库直接探测这些位置，默认安装无需任何 PATH 配置。如果你的位置比较特殊，
在启动 DSH 的环境里导出 `CODEGRAPH_BIN`（从 Finder 启动时用
`launchctl setenv CODEGRAPH_BIN /绝对路径/codegraph` 再重启应用），或把 `/bin/sh`
那一支换成字面量路径。

### 3. 改完 YAML 整个文件不再生效

**原因：** YAML 的 plain（不加引号）标量不能包含 `" : "`。像 `a ? b : c` 这样的三元表达式
不加引号会提前结束标量，解析失败后**整个 patch 层被拒绝**；旧配置继续运行，
于是看起来"什么都没发生"。

**解决：** 给 `!!js` 表达式套单引号。

### 4. 返回 `No CodeGraph project is loaded for this session.`

**原因：** `cwd` 不是已建索引的项目。消息里会打印它搜索的目录，那就是你的 `cwd`。

**解决：** 把 `cwd` 指向含 `.codegraph/` 的目录，或在那个目录跑 `codegraph init`。
临时可用：调用时传 `projectPath`。

这个失败是"优雅"的：服务照常启动、工具照常列出，只是返回这条诊断而不是崩溃。

### 5. 改了文件却没重载

如果解析后的配置没有实质变化（只改了注释/空白），DSH 会跳过重载——这是预期行为。
改一个真实取值（例如 `toolCallTimeoutMs`）或删掉再加回条目即可强制触发。

### 6. 多个项目

`serverName` 必须唯一。两条都用 `serverName: codegraph` 时，第二条会加载失败。
用 `codegraph2`、`codegraph3`……或者用 `projectPath`。

---

## 卸载

从 `cordis.patch.yml` 里删掉包含 `mcp-codegraph` 的 `- insert:` 块，或恢复备份：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-YYYYmmdd-HHMMSS" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

改动会热重载，工具随即消失，无需重启。

---

## 持续集成

<!-- 发布后把 OWNER 换成你的账号，否则徽章会 404。 -->
![CI](https://github.com/vignycn/DSH-codegraph/actions/workflows/ci.yml/badge.svg)

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 的意义是**证明它真的能用**：

| 任务 | 证明了什么 |
|---|---|
| `lint` | patch 文档能按 YAML 解析、用的是 `insert:`（而非裸 `id:`）、`cwd` 仍是占位符、两个 `!!js` 分支求值结果符合预期；另外检查 `install.ps1` 是纯 ASCII——PowerShell 5.1 按 ANSI 读 `.ps1`，非 ASCII 会直接解析失败 |
| `e2e (ubuntu)` / `e2e (macOS)` | 用**厂商官方** `install.sh` 装 CodeGraph、建索引、把 `install.sh` 连跑两次（幂等 = 只有一个 `insert` 块），再用生成的配置跑真实 MCP 会话，且 `PATH=/usr/bin:/bin`——正是从 Finder 启动、根本没有 `codegraph` 的场景 |
| `e2e (Windows)` | 同样流程走 `install.ps1` + 自带 `node.exe`，同样跑两次验证幂等 |

e2e 会在以下情况失败：服务没有发布 `codegraph_explore`、调用报错、找不到索引、
答案里缺少 fixture 的符号。

本地跑同样的检查：

```bash
npm install
npm run lint
node .github/scripts/smoke.mjs ~/.dsh/profiles/desktop/cordis.patch.yml /你的/已建索引/项目
```

被测的 CodeGraph 版本在 `ci.yml` 里固定（`env.CODEGRAPH_VERSION`，默认 `v1.6.2`），
手动触发 workflow 时可覆盖。

## 已验证环境

| 组件 | 版本 |
|---|---|
| CodeGraph | 1.6.2 |
| DSH Desktop | Windows 11，profile `desktop`，PowerShell 5.1 |
| `@deepseek-ai/dsh-mcp-client` | 0.2.2-rc.1 |
| MCP 协议 | `2024-11-05` |

**Windows：在真实机器上端到端验证过。** 安装 → 热重载 → `mcp__codegraph__codegraph_explore`
返回真实源码、调用链与影响面。

**macOS/Linux：由 CI 覆盖，外加对故障场景的本地复现。** 在开发机（只有 Windows）上实际跑过的是：

- 把仓库里的 `!!js` 表达式以 `process.platform = "darwin"` 求值，得到
  `command: /bin/sh` 与原样的解析片段；
- 该片段在 POSIX `sh` 下、`PATH=/usr/bin:/bin`（没有 `codegraph`、没有 `~/.local/bin`）
  的环境中执行，目录按 `$HOME/.codegraph/current/bin/codegraph` 布局，成功完成真实
  MCP 握手与 `tools/call`；
- 回退顺序逐条验证：`PATH` → `CODEGRAPH_BIN` → `~/.codegraph` → `~/.local/bin`
  → 全都没有时给出明确报错。

在**真实的** `ubuntu-latest` 与 `macos-latest` runner 上，CI 会用厂商安装器装好 CodeGraph、
并真正剥掉 `PATH`，把整套流程再跑一遍——见[持续集成](#持续集成)。只要那次 workflow
对你这个 commit 是绿的，macOS/Linux 路径就已在真实硬件上跑过。

平台布局（`~/.codegraph/current`、`~/.local/bin/codegraph`、`CODEGRAPH_INSTALL_DIR`、
`CODEGRAPH_BIN`）不是猜的，而是 CodeGraph 自己的 `install.sh` / `install.ps1` / 卸载器的
实际行为。若你的安装方式不同，解析器会点名失败的那一环——请把那一行贴在 issue 里。

DSH 本身的路径约定来自 Windows 上的 DSH Desktop（`%USERPROFILE%\.dsh`）。其他发行版可能用
不同的 DSH home；脚本支持 `-Profile`/`--profile`，手工安装只需替换对应路径。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

本项目与 CodeGraph、DeepSeek 官方无关。"DeepSeek Harness"、"CodeGraph" 等名称归其所有者。

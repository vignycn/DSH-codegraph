// Static checks on the shipped patch document and installers.
//
// These assertions encode the traps documented in the README, so a future edit
// cannot silently reintroduce them:
//   - a bare `- id:` entry (patches instead of inserting)
//   - an unquoted `!!js` scalar (dies on " : ")
//   - a Windows branch that tries to spawn the .cmd shim
//   - a macOS/Linux branch that trusts PATH only
//   - a non-ASCII install.ps1 (Windows PowerShell 5.1 reads .ps1 as ANSI)
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = path.resolve(process.argv[2] ?? '.');
let failures = 0;

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const section = (m) => console.log(`\n${m}`);

// ---------------------------------------------------------------- template
section('patch template');

const tplPath = path.join(root, 'cordis.patch.yml');
if (!fs.existsSync(tplPath)) {
  bad('cordis.patch.yml is missing');
  process.exit(1);
}
const tpl = fs.readFileSync(tplPath, 'utf8');

const marker = tpl.match(/^--- cut here ---[ \t]*\r?\n/m);
check(!!marker, 'template has a "--- cut here ---" line of its own');
if (!marker) process.exit(1);

// The loader accepts `!!js`; the tag itself is not standard YAML.
const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (v) => ({ __js: String(v) }) };

let doc;
try {
  doc = YAML.parse(tpl.slice(marker.index + marker[0].length), { customTags: [jsTag] });
  ok('template document parses as YAML');
} catch (e) {
  bad(`template does not parse: ${e.message.split('\n')[0]}`);
  process.exit(1);
}

check(Array.isArray(doc) && doc.length === 1, 'template is exactly one top-level patch item');

const patch = doc?.[0] ?? {};
check(Array.isArray(patch.insert) && patch.insert.length === 1, 'patch uses `insert:` (an insert appends)');
check(!Object.hasOwn(patch, 'id'), 'patch has no top-level `id` (a bare id patches an existing entry and is dropped)');

const entry = patch.insert?.[0] ?? {};
const cfg = entry.config ?? {};

check(entry.id === 'mcp-codegraph', 'entry id is mcp-codegraph');
check(entry.name === '@deepseek-ai/dsh-mcp-client', 'entry names the MCP client plugin');

// ---------------------------------------------------------------- plugin config
section('plugin config');

check(cfg.serverName === 'codegraph', 'serverName is codegraph');
check(/^[A-Za-z0-9_-]{1,32}$/.test(cfg.serverName ?? ''), 'serverName satisfies the plugin pattern');
check(cfg.transport === 'stdio', 'transport is stdio');
check(cfg.cwd === 'REPLACE_WITH_PROJECT_PATH', 'cwd is still the placeholder (installers substitute it)');
check(typeof cfg.toolCallTimeoutMs === 'number', 'toolCallTimeoutMs is a number');
check(cfg.failOnStartupError === false, 'failOnStartupError is false (never block harness boot)');

// ------------------------------------------------------------------ expressions
section('platform expressions');

const isJs = (v) => v !== null && typeof v === 'object' && typeof v.__js === 'string';
check(isJs(cfg.command), 'command is a !!js expression (single-quoted)');
check(isJs(cfg.args), 'args is a !!js expression (single-quoted)');

const evalWith = (value, platform, env) =>
  // eslint-disable-next-line no-new-func
  new Function('process', `return (${value.__js});`)({ platform, env, cwd: '/' });

if (isJs(cfg.command) && isJs(cfg.args)) {
  const winEnv = { LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local' };
  const winCmd = evalWith(cfg.command, 'win32', winEnv);
  const winArgs = evalWith(cfg.args, 'win32', winEnv);

  check(/node\.exe$/i.test(winCmd), 'win32 spawns the bundled node.exe, not the .cmd shim');
  check(Array.isArray(winArgs) && winArgs.includes('serve') && winArgs.includes('--mcp'), 'win32 passes `serve --mcp`');
  check(typeof winArgs[0] === 'string' && winArgs[0].endsWith('codegraph.js'), 'win32 runs the CodeGraph CLI entry');

  const custom = evalWith(cfg.command, 'win32', { ...winEnv, CODEGRAPH_INSTALL_DIR: 'D:\\tools\\codegraph' });
  check(String(custom).startsWith('D:\\tools\\codegraph'), 'win32 honours CODEGRAPH_INSTALL_DIR');

  for (const platform of ['darwin', 'linux']) {
    const cmd = evalWith(cfg.command, platform, {});
    const args = evalWith(cfg.args, platform, {});
    const snippet = Array.isArray(args) ? args[1] : '';

    check(cmd === '/bin/sh', `${platform} goes through /bin/sh (GUI apps miss the shell PATH)`);
    check(Array.isArray(args) && args[0] === '-c', `${platform} passes the resolver via -c`);
    check(typeof snippet === 'string' && snippet.includes('CODEGRAPH_BIN'), `${platform} resolver honours CODEGRAPH_BIN`);
    check(typeof snippet === 'string' && /\.codegraph\}?\/current\/bin\/codegraph/.test(snippet), `${platform} resolver probes ~/.codegraph`);
    check(typeof snippet === 'string' && snippet.includes('.local/bin/codegraph'), `${platform} resolver probes ~/.local/bin`);
    check(typeof snippet === 'string' && snippet.includes('exec'), `${platform} resolver execs the binary`);
    check(typeof snippet === 'string' && !snippet.includes('\n'), `${platform} resolver stays on one line`);
  }
}

// ---------------------------------------------------------------------- installers
section('installers');

for (const file of ['install.ps1', 'install.sh']) {
  check(fs.existsSync(path.join(root, file)), `${file} exists`);
}

const ps1Path = path.join(root, 'install.ps1');
if (fs.existsSync(ps1Path)) {
  const bytes = fs.readFileSync(ps1Path);
  check(!bytes.some((b) => b > 0x7f), 'install.ps1 is pure ASCII (PowerShell 5.1 reads .ps1 as ANSI)');
}

const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
check(sh.startsWith('#!/usr/bin/env bash'), 'install.sh has a bash shebang');
check(sh.includes('REPLACE_WITH_PROJECT_PATH'), 'install.sh substitutes the cwd placeholder');

const ps1 = fs.readFileSync(ps1Path, 'utf8');
check(ps1.includes('REPLACE_WITH_PROJECT_PATH'), 'install.ps1 substitutes the cwd placeholder');
check(ps1.includes('mcp-codegraph'), 'install.ps1 replaces a previous block (idempotent)');

// ------------------------------------------------------------------ CI workflow
section('CI workflow');

const ciPath = path.join(root, '.github', 'workflows', 'ci.yml');
check(fs.existsSync(ciPath), 'ci.yml exists');
if (fs.existsSync(ciPath)) {
  let ci = null;
  try {
    ci = YAML.parse(fs.readFileSync(ciPath, 'utf8'));
    ok('ci.yml parses as YAML');
  } catch (e) {
    bad(`ci.yml does not parse: ${e.message.split('\n')[0]}`);
  }
  const jobs = ci?.jobs ?? {};
  check(!!jobs.lint, 'workflow has the lint job');
  check(!!jobs['e2e-posix'], `workflow has the e2e-posix job`);
  check(!!jobs['e2e-windows'], 'workflow has the e2e-windows job');

  const matrix = jobs['e2e-posix']?.strategy?.matrix?.os ?? [];
  check(matrix.includes('ubuntu-latest') && matrix.includes('macos-latest'), 'e2e-posix covers ubuntu + macos');
  check(!!ci?.env?.CODEGRAPH_VERSION, 'workflow pins a CodeGraph version');
}

// ------------------------------------------------------------------------- docs
section('docs');

for (const file of ['README.md', 'README.zh-CN.md', 'LICENSE']) {
  check(fs.existsSync(path.join(root, file)), `${file} exists`);
}
for (const file of ['README.md', 'README.zh-CN.md']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  check(text.includes('mcp__codegraph__codegraph_explore'), `${file} names the registered tool`);
}

// ------------------------------------------------------------------------ result
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

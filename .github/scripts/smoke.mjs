// End-to-end smoke test: take the patch file an installer just wrote, resolve
// the two `!!js` expressions exactly like the DSH loader does, spawn CodeGraph
// and drive a real MCP session through it.
//
//   node .github/scripts/smoke.mjs <patch-file> <indexed-project> [query]
//
// On POSIX the child gets a deliberately minimal PATH, mimicking an app
// launched from Finder / the desktop: no ~/.local/bin, nothing named
// `codegraph`. That is the case the resolver exists for.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const [patchPath, projectPath, query = 'greet farewell'] = process.argv.slice(2);
if (!patchPath || !projectPath) {
  console.error('usage: node .github/scripts/smoke.mjs <patch-file> <indexed-project> [query]');
  process.exit(2);
}

const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (v) => ({ __js: String(v) }) };

function fail(message, extra = '') {
  console.error(`FAIL: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

// ---------------------------------------------------------------- read config
const patchText = fs.readFileSync(patchPath, 'utf8');
let doc;
try {
  doc = YAML.parse(patchText, { customTags: [jsTag] });
} catch (e) {
  fail(`cannot parse ${patchPath}: ${e.message.split('\n')[0]}`);
}

const entry = (doc ?? [])
  .flatMap((item) => item?.insert ?? [])
  .find((e) => e?.id === 'mcp-codegraph');
if (!entry) fail(`no "insert" entry with id mcp-codegraph in ${patchPath}`);
const cfg = entry.config ?? {};

const resolveValue = (value, name) => {
  if (typeof value === 'string') return value;
  if (value && typeof value.__js === 'string') {
    // eslint-disable-next-line no-new-func
    return new Function('process', `return (${value.__js});`)(process);
  }
  fail(`${name} is neither a literal nor a !!js expression`);
};

const command = resolveValue(cfg.command, 'command');
const args = resolveValue(cfg.args, 'args');
const cwd = cfg.cwd === 'REPLACE_WITH_PROJECT_PATH' ? projectPath : (cfg.cwd || projectPath);

if (cfg.cwd === 'REPLACE_WITH_PROJECT_PATH') {
  fail('cwd is still the template placeholder — run the installer, do not feed it the template');
}
if (!Array.isArray(args)) fail('args did not resolve to an array');

const posix = process.platform !== 'win32';
const env = { ...process.env };
if (posix) {
  // The scenario this repo is built for: a GUI-launched app with a bare PATH.
  env.PATH = '/usr/bin:/bin';
  delete env.CODEGRAPH_BIN;
  delete env.CODEGRAPH_INSTALL_DIR;
}

console.log('resolved config');
console.log(`  platform : ${process.platform}`);
console.log(`  command  : ${command}`);
console.log(`  args     : ${JSON.stringify(args).slice(0, 200)}`);
console.log(`  cwd      : ${cwd}`);
console.log(`  PATH     : ${posix ? env.PATH : '(inherited)'}`);

// ------------------------------------------------------------------- MCP client
const proc = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
let stdoutBuf = '';
let stderrBuf = '';
const pending = new Map();
let nextId = 1;

const finish = (code, message) => {
  if (message) (code === 0 ? console.log : console.error)(message);
  try { proc.stdin.end(); } catch {}
  try { proc.kill(); } catch {}
  setTimeout(() => process.exit(code), 150);
};

proc.on('error', (e) => finish(1, `FAIL: cannot spawn ${command}: ${e.code || e.message}`));
proc.stdout.on('data', (d) => { stdoutBuf += d.toString('utf8'); pump(); });
proc.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

function pump() {
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  }
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out after 120s`)), 120_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const stderrTail = () => stderrBuf.trim().split('\n').slice(-5).join('\n');

(async () => {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-codegraph-ci', version: '1.0.0' },
  });
  if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`, stderrTail());
  console.log(`initialized : ${init.result.serverInfo.name} ${init.result.serverInfo.version} (protocol ${init.result.protocolVersion})`);

  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await request('tools/list', {});
  if (list.error) fail(`tools/list failed: ${JSON.stringify(list.error)}`, stderrTail());
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  console.log(`tools       : ${names.join(', ') || '(none)'}`);
  if (!names.includes('codegraph_explore')) {
    fail(`codegraph_explore not published (got: ${names.join(', ') || 'none'})`, stderrTail());
  }

  const call = await request('tools/call', {
    name: 'codegraph_explore',
    arguments: { query },
  });
  if (call.error) fail(`tools/call failed: ${JSON.stringify(call.error)}`, stderrTail());

  const text = (call.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const head = text.replace(/\s+/g, ' ').slice(0, 200);
  console.log(`tools/call  : isError=${!!call.result?.isError} chars=${text.length}`);
  console.log(`head        : ${head}`);

  if (call.result?.isError) fail('codegraph_explore reported an error', head);
  if (text.length < 200) fail('codegraph_explore returned too little text', head);
  if (/No CodeGraph project is loaded/i.test(text)) fail('the server did not find the project index', head);
  if (!/greet/.test(text)) fail('the fixture symbol is missing from the answer', head);

  finish(0, '\nSMOKE TEST PASSED');
})().catch((e) => finish(1, `FAIL: ${e.message}\n${stderrTail()}`));

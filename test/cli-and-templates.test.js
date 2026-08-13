'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const test = require('node:test');
const {
  parseArguments,
  openSession,
  resolveRunDirectory: resolveLauncherRunDirectory,
  resolveSessionTargetUrl,
  DEFAULT_URL,
} = require('../run');
const {
  buildRequest: buildBrowserRequest,
  discoverConnection,
  parseArguments: parseBrowserArguments,
  resolveRunDirectory: resolveBrowserRunDirectory,
} = require('../browserctl');
const { listTemplateFiles } = require('../lib/terminal-ui');

const execFileAsync = promisify(execFile);

test('parses production CLI options and validates conflicts', () => {
  const options = parseArguments([
    '--open',
    '2026-07-26',
    '--agent',
    'codex',
    '--headless',
    '--verbose',
    '--memory',
    'ephemeral',
  ]);
  assert.equal(options.open, '2026-07-26');
  assert.equal(options.agent, 'codex');
  assert.equal(options.headless, true);
  assert.equal(options.verbose, true);
  assert.equal(options.memoryMode, 'ephemeral');
  assert.equal(options.targetUrl, DEFAULT_URL);
  assert.equal(options.targetUrlExplicit, false);
  assert.equal(parseArguments(['--url', 'https://example.test/']).targetUrlExplicit, true);
  assert.throws(() => parseArguments(['--new', '--list']), /only one/);
  assert.throws(() => parseArguments(['--agent', 'unknown']), /Unknown agent/);
  assert.throws(() => parseArguments(['--url', 'file:///tmp/page']), /http/);
  assert.throws(() => parseArguments(['--inline', '[]']), /requires --new or --open/);
  assert.throws(() => parseArguments(['--memory', 'unknown']), /managed or ephemeral/);
  assert.equal(
    parseArguments(['--open', '2026-07-26', '--inline', '[]']).inlineSource,
    '[]',
  );
});

test('launcher and browser client resolve mutable data from the caller run directory', () => {
  const cwd = '/tmp/example-run-directory';
  assert.equal(resolveLauncherRunDirectory({}, cwd), cwd);
  assert.equal(resolveBrowserRunDirectory({}, cwd), cwd);
  assert.equal(
    resolveLauncherRunDirectory({ BROWSERCTL_RUN_DIR: '/tmp/explicit-run' }, cwd),
    '/tmp/explicit-run',
  );
  assert.equal(
    resolveLauncherRunDirectory(
      { npm_lifecycle_event: 'start', INIT_CWD: '/tmp/npm-invocation' },
      cwd,
    ),
    '/tmp/npm-invocation',
  );
});

test('opening latest uses the newest saved console session', async () => {
  const opened = [];
  const store = {
    list: async () => [{ id: '2026-08-02' }, { id: '2026-08-01' }],
    open: async (id) => {
      opened.push(id);
      return { id };
    },
  };
  assert.deepEqual(await openSession(store, 'latest'), { id: '2026-08-02' });
  assert.deepEqual(opened, ['2026-08-02']);
  await assert.rejects(
    () => openSession({ list: async () => [], open: async () => null }, 'latest'),
    /No saved session exists/,
  );
});

test('reopening preserves the manifest target unless --url is explicit', () => {
  const session = { manifest: { targetUrl: 'https://saved.example/app' } };
  assert.equal(
    resolveSessionTargetUrl(parseArguments([]), session),
    'https://saved.example/app',
  );
  assert.equal(
    resolveSessionTargetUrl(parseArguments(['--url', 'https://override.example/']), session),
    'https://override.example/',
  );
});

test('running the packaged launcher initializes templates and weekly logs beside the caller', async (t) => {
  const runDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-run-dir-test-'));
  t.after(() => fsp.rm(runDirectory, { recursive: true, force: true }));
  const environment = { ...process.env };
  delete environment.BROWSERCTL_RUN_DIR;
  delete environment.npm_lifecycle_event;
  delete environment.INIT_CWD;
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(__dirname, '..', 'run.js'), '--list'],
    { cwd: runDirectory, env: environment },
  );
  assert.match(stdout, /No session folders/);
  await fsp.access(path.join(runDirectory, 'templates', 'README.md'));
  await fsp.access(path.join(runDirectory, 'weekly-logs', 'README.md'));
  assert.equal(
    await fsp.stat(path.join(runDirectory, 'browserctl')).catch(() => null),
    null,
  );
});

test('template discovery is recursive, sorted, and excludes README files', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-template-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'nested'));
  await fsp.writeFile(path.join(root, 'README.md'), 'documentation');
  await fsp.writeFile(path.join(root, 'z-last.md'), 'last');
  await fsp.writeFile(path.join(root, 'nested', 'a-first.txt'), 'first');

  const files = await listTemplateFiles(root);
  assert.deepEqual(
    files.map((filename) => path.relative(root, filename)),
    ['nested/a-first.txt', 'z-last.md'],
  );
});

test('browser gateway parses a service-owned launch request', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-launch-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const tokenPath = path.join(root, 'bridge.token');
  await fsp.writeFile(tokenPath, 'test-token\n');
  const options = parseBrowserArguments([
    '--host',
    '127.0.0.1',
    '--port',
    '9444',
    '--token-file',
    tokenPath,
    'launch',
  ]);
  assert.deepEqual(await buildBrowserRequest(options), {
    token: 'test-token',
    action: 'launch',
  });
});

test('browser gateway parses a generic extension hook request', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-hook-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const tokenPath = path.join(root, 'bridge.token');
  await fsp.writeFile(tokenPath, 'test-token\n');
  const options = parseBrowserArguments([
    '--host', '127.0.0.1', '--port', '9444', '--token-file', tokenPath,
    'invoke', 'example.archive', '{"scope":"current"}',
  ]);
  assert.deepEqual(await buildBrowserRequest(options), {
    token: 'test-token',
    action: 'invoke',
    name: 'example.archive',
    payload: { scope: 'current' },
  });
});

test('browser gateway parses application-neutral workflow state updates', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-workflow-request-'));
  t.after(() => fsp.rm(root, {recursive: true, force: true}));
  const tokenPath = path.join(root, 'bridge.token');
  await fsp.writeFile(tokenPath, 'test-token\n');
  const options = parseBrowserArguments([
    '--host', '127.0.0.1', '--port', '9444', '--token-file', tokenPath,
    'workflow', 'update', '{"stepId":"inspect","status":"completed","note":"Verified live state."}',
  ]);
  assert.deepEqual(await buildBrowserRequest(options), {
    token: 'test-token',
    action: 'workflow',
    operation: 'update',
    payload: {stepId:'inspect', status:'completed', note:'Verified live state.'},
  });
});

async function fakeActiveSession(root, id, port) {
  const directory = path.join(root, id);
  const logs = path.join(directory, 'logs');
  const tokenPath = path.join(logs, 'bridge.token');
  await fsp.mkdir(logs, { recursive: true });
  await fsp.writeFile(tokenPath, `${id}-token\n`, { mode: 0o600 });
  await fsp.writeFile(
    path.join(logs, 'service.lock'),
    JSON.stringify({ pid: process.pid, sessionId: id }),
  );
  await fsp.writeFile(
    path.join(directory, 'session.json'),
    JSON.stringify({
      id,
      browser: {
        bridgeHost: '127.0.0.1',
        bridgePort: port,
        bridgeTokenPath: tokenPath,
      },
    }),
  );
  return { directory, tokenPath };
}

test('browser gateway safely discovers one active console from a normal shell', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-discovery-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const session = await fakeActiveSession(root, '2026-07-27', 9444);
  const discovered = await discoverConnection({ session: null }, root);
  assert.equal(discovered.sessionId, '2026-07-27');
  assert.equal(discovered.port, 9444);
  assert.equal(discovered.tokenPath, session.tokenPath);
  assert.equal(discovered.servicePid, process.pid);
});

test('browser gateway requires an explicit session when several consoles are active', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-discovery-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fakeActiveSession(root, '2026-07-27', 9444);
  const selected = await fakeActiveSession(root, '2026-07-27-02', 9555);
  await assert.rejects(
    () => discoverConnection({ session: null }, root),
    /Multiple session consoles.*--session/,
  );
  const discovered = await discoverConnection({ session: '2026-07-27-02' }, root);
  assert.equal(discovered.tokenPath, selected.tokenPath);
});

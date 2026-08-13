'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const {validateExtension} = require('../lib/extension-loader');
const {
  createExtension,
  normalizeLabel,
} = require('../examples/page-label/page-label-extension');
const {
  EXTENSION_ENTRY,
  forwardedArguments,
  selectSession,
} = require('../examples/page-label/run');

test('page-label example is a valid semantic Playwright extension', async () => {
  const extension = validateExtension(await createExtension(), 'page-label-example');
  assert.equal(extension.id, EXTENSION_ENTRY.id);
  assert.equal(extension.semanticCapabilities[0].hook, extension.browserHooks[0].name);
  assert.equal(extension.semanticCapabilities[0].preparePayload({label: '  Ready  '}).label, 'Ready');
  assert.equal(extension.browserLifecycle.context.constructor.name, 'AsyncFunction');
});

test('page-label example rejects unsafe labels and delegates session selection', () => {
  assert.throws(() => normalizeLabel('   '), /nonempty/);
  assert.throws(() => normalizeLabel('x'.repeat(121)), /120/);
  assert.deepEqual(
    forwardedArguments(['--new', '--agent', 'codex', '--headless'], '2026-08-12'),
    ['--open', '2026-08-12', '--agent', 'codex', '--headless'],
  );
  assert.deepEqual(
    forwardedArguments(['--open', 'latest', '--verbose'], '2026-08-12'),
    ['--open', '2026-08-12', '--verbose'],
  );
});

test('page-label launcher delegates informational modes without creating a session', async () => {
  const unusedStore = {
    create: async () => assert.fail('help must not create a session'),
    list: async () => assert.fail('help must not list sessions'),
  };
  assert.equal(await selectSession(unusedStore, ['--help']), null);
  assert.equal(await selectSession(unusedStore, ['--version']), null);
  await assert.rejects(() => selectSession(unusedStore, ['--open']), /requires/);
});

test('example documentation explains Playwright, natural language, and reopen', async () => {
  const readme = await fsp.readFile(
    path.join(__dirname, '..', 'examples', 'page-label', 'README.md'),
    'utf8',
  );
  for (const expected of ['Playwright', 'speak naturally', '--open latest', 'page-label-extension.js']) {
    assert.match(readme, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('root documentation gives a complete install, first-run, and continuation path', async () => {
  const readme = await fsp.readFile(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const expected of [
    '## Install',
    'git clone https://github.com/PhilipZhu/browserctl.git',
    'npm ci',
    'playwright-core',
    './run.js --new --url https://example.com/',
    '--agent codex',
    '/quit',
    '## Continue later',
    './run.js --open latest',
    'node examples/page-label/run.js --new',
  ]) {
    assert.ok(readme.includes(expected), `README is missing: ${expected}`);
  }
});

test('GitHub homepage cannot be shadowed by a higher-priority README', async () => {
  const shadowReadme = path.join(__dirname, '..', '.github', 'README.md');
  await assert.rejects(() => fsp.access(shadowReadme), {code: 'ENOENT'});
  const automation = await fsp.readFile(
    path.join(__dirname, '..', '.github', 'AUTOMATION.md'),
    'utf8',
  );
  assert.match(automation, /Repository Automation/);
});

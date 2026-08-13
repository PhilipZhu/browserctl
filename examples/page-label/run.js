#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {upsertExtensionEntry} = require('../../lib/extension-loader');
const {SessionStore} = require('../../lib/session-store');

const EXAMPLE_DIRECTORY = __dirname;
const BROWSERCTL_RUNNER = path.resolve(__dirname, '../..', 'run.js');
const DEFAULT_URL = 'https://example.com/';
const EXTENSION_ENTRY = {
  id: 'page-label-example',
  module: 'page-label-extension.js',
};

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function forwardedArguments(argv, sessionId) {
  const output = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--new') continue;
    if (argv[index] === '--open') {
      index += 1;
      continue;
    }
    output.push(argv[index]);
  }
  return ['--open', sessionId, ...output];
}

async function selectSession(store, argv) {
  const wantsNew = argv.includes('--new');
  const wantsOpen = argv.includes('--open');
  const requested = optionValue(argv, '--open');
  if (wantsOpen && !requested) throw new Error('--open requires a session id or latest.');
  if (wantsNew && requested) throw new Error('Use only one of --new or --open.');
  if (argv.some((argument) => ['--list', '--help', '-h', '--version', '-v'].includes(argument))) {
    return null;
  }
  if (requested) {
    if (requested !== 'latest') return store.open(requested);
    const latest = (await store.list())[0];
    if (!latest) throw new Error('No example session exists yet; start with --new.');
    return store.open(latest.id);
  }
  const targetUrl = optionValue(argv, '--url') || DEFAULT_URL;
  const agent = optionValue(argv, '--agent') || 'pi';
  return store.create({targetUrl, agent});
}

async function main(argv = process.argv.slice(2)) {
  const store = new SessionStore(path.join(EXAMPLE_DIRECTORY, 'weekly-logs'), {
    targetUrl: DEFAULT_URL,
  });
  const session = await selectSession(store, argv);
  const childArguments = session ? forwardedArguments(argv, session.id) : argv;
  if (session) {
    const extensions = upsertExtensionEntry(session.manifest.extensions, EXTENSION_ENTRY);
    await store.update(session, {extensions});
  }
  const result = spawnSync(process.execPath, [BROWSERCTL_RUNNER, ...childArguments], {
    cwd: EXAMPLE_DIRECTORY,
    env: {...process.env, BROWSERCTL_RUN_DIR: EXAMPLE_DIRECTORY},
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {EXTENSION_ENTRY, forwardedArguments, selectSession};

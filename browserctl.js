#!/usr/bin/env node
'use strict';

const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

function resolveRunDirectory(environment = process.env, cwd = process.cwd()) {
  const configured = environment.BROWSERCTL_RUN_DIR;
  const npmInvocation = environment.npm_lifecycle_event && environment.INIT_CWD;
  return path.resolve(configured || npmInvocation || cwd);
}

const DEFAULT_SESSIONS_ROOT = path.join(resolveRunDirectory(), 'weekly-logs');

function usage() {
  return `Service-owned Playwright bridge client

Usage:
  ./browserctl.js launch
  ./browserctl.js state
  ./browserctl.js eval '<JavaScript body with page/context>'
  ./browserctl.js run <script-file>
  ./browserctl.js screenshot [label]
  ./browserctl.js save [label]
  ./browserctl.js reload
  ./browserctl.js open <url>
  ./browserctl.js invoke <extension-hook> [JSON|@file]
  ./browserctl.js workflow state
  ./browserctl.js workflow update <JSON|@file>
  ./browserctl.js workflow status <JSON|@file>

Run the session console first:
  ./run.js

From a normal shell, the client automatically discovers the bridge when exactly
one session console is active. Use --session if more than one is running.
Discovery uses BROWSERCTL_RUN_DIR when set, otherwise the caller directory.

Connection options default to environment injected by the session console:
  --session <session-id-or-path>
  --host <loopback-host>
  --port <port>
  --token-file <path>

Code sent by eval/run executes inside the launcher's existing Playwright client.
It receives: page, context, playwrightBrowser, session, and paths.
Return a JSON-serializable value. Never close the service-owned page, context, or browser.
`;
}

function parseArguments(argv) {
  const options = {
    host: process.env.BROWSERCTL_BROWSER_HOST || '127.0.0.1',
    port: Number(process.env.BROWSERCTL_BROWSER_PORT) || null,
    tokenPath: process.env.BROWSERCTL_BROWSER_TOKEN_FILE || null,
    session: null,
    action: null,
    values: [],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--host') {
      options.host = argv[++index];
      if (!options.host) throw new Error('--host requires a value.');
    } else if (value === '--port') {
      options.port = Number(argv[++index]);
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Error('--port requires a valid TCP port.');
      }
    } else if (value === '--token-file') {
      options.tokenPath = argv[++index];
      if (!options.tokenPath) throw new Error('--token-file requires a path.');
    } else if (value === '--session') {
      options.session = argv[++index];
      if (!options.session) throw new Error('--session requires a value.');
    } else if (value === '--help' || value === '-h') {
      options.help = true;
    } else if (!options.action) {
      options.action = value;
    } else {
      options.values.push(value);
    }
  }
  return options;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function childDirectory(root, requested) {
  const directory = path.resolve(
    path.isAbsolute(requested) ? requested : path.join(root, requested),
  );
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`--session must select a child folder of ${root}.`);
  }
  return directory;
}

async function activeConnection(directory) {
  try {
    const [manifest, lease] = await Promise.all([
      fsp.readFile(path.join(directory, 'session.json'), 'utf8').then(JSON.parse),
      fsp.readFile(path.join(directory, 'logs', 'service.lock'), 'utf8').then(JSON.parse),
    ]);
    if (!processIsAlive(Number(lease.pid))) return null;
    const browser = manifest.browser || {};
    const port = Number(browser.bridgePort);
    const tokenPath = browser.bridgeTokenPath
      ? path.resolve(browser.bridgeTokenPath)
      : null;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !tokenPath) return null;
    const relativeToken = path.relative(directory, tokenPath);
    if (
      !relativeToken ||
      relativeToken.startsWith('..') ||
      path.isAbsolute(relativeToken)
    ) {
      return null;
    }
    await fsp.access(tokenPath);
    return {
      sessionId: manifest.id || path.basename(directory),
      sessionPath: directory,
      host: browser.bridgeHost || '127.0.0.1',
      port,
      tokenPath,
      servicePid: Number(lease.pid),
    };
  } catch {
    return null;
  }
}

async function discoverConnection(options, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  const root = path.resolve(sessionsRoot);
  let directories;
  if (options.session) {
    directories = [childDirectory(root, options.session)];
  } else {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(root, entry.name));
  }
  const discovered = (
    await Promise.all(directories.map((directory) => activeConnection(directory)))
  ).filter(Boolean);
  if (discovered.length === 1) return discovered[0];
  if (discovered.length > 1) {
    throw new Error(
      `Multiple session consoles are active (${discovered.map((item) => item.sessionId).join(', ')}). Pass --session <id-or-path>.`,
    );
  }
  if (options.session) {
    throw new Error(
      `Session ${options.session} has no active browser service. Start it with ./run.js --open ${options.session}.`,
    );
  }
  throw new Error(
    'No active browser service was found. Start ./run.js, then run browserctl again.',
  );
}

async function resolveConnection(options, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  if (options.port && options.tokenPath) {
    return {
      host: options.host,
      port: options.port,
      tokenPath: options.tokenPath,
    };
  }
  const discovered = await discoverConnection(options, sessionsRoot);
  return {
    ...discovered,
    host: options.host || discovered.host,
  };
}

async function buildRequest(options) {
  if (!options.host || !options.port || !options.tokenPath) {
    throw new Error(
      'Browser bridge connection is missing. Run this command from an agent turn or pass --host, --port, and --token-file.',
    );
  }
  const token = (await fsp.readFile(options.tokenPath, 'utf8')).trim();
  if (options.action === 'launch') return { token, action: 'launch' };
  if (options.action === 'state') return { token, action: 'state' };
  if (options.action === 'eval') {
    return { token, action: 'evaluate', code: options.values.join(' ') };
  }
  if (options.action === 'run') {
    if (options.values.length !== 1) throw new Error('Usage: browserctl.js run <script-file>');
    return {
      token,
      action: 'evaluate',
      code: await fsp.readFile(options.values[0], 'utf8'),
    };
  }
  if (options.action === 'screenshot') {
    return { token, action: 'screenshot', label: options.values.join(' ') || 'agent' };
  }
  if (options.action === 'save') {
    return { token, action: 'save', label: options.values.join(' ') || 'agent' };
  }
  if (options.action === 'reload') return { token, action: 'reload' };
  if (options.action === 'open') {
    if (options.values.length !== 1) throw new Error('Usage: browserctl.js open <url>');
    const url = new URL(options.values[0]);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Only http:// and https:// URLs are supported.');
    }
    return { token, action: 'open', url: url.toString() };
  }
  if (options.action === 'invoke') {
    if (options.values.length < 1 || options.values.length > 2) {
      throw new Error('Usage: browserctl.js invoke <extension-hook> [JSON|@file]');
    }
    const [name, source = '{}'] = options.values;
    const text = source.startsWith('@')
      ? await fsp.readFile(source.slice(1), 'utf8')
      : source;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Extension hook input must be a JSON object or @file containing one.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Extension hook input must be a JSON object.');
    }
    return { token, action: 'invoke', name, payload };
  }
  if (options.action === 'workflow') {
    const [operation, source] = options.values;
    if (operation === 'state' && options.values.length === 1) {
      return {token, action: 'workflow', operation};
    }
    if (!['update', 'status'].includes(operation) || options.values.length !== 2) {
      throw new Error('Usage: browserctl.js workflow state|update <JSON|@file>|status <JSON|@file>');
    }
    const text = source.startsWith('@')
      ? await fsp.readFile(source.slice(1), 'utf8')
      : source;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Workflow input must be a JSON object or @file containing one.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Workflow input must be a JSON object.');
    }
    return {token, action: 'workflow', operation, payload};
  }
  throw new Error(`Unknown browser bridge command: ${options.action || '(none)'}`);
}

async function sendRequest(connection, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection);
    socket.setEncoding('utf8');
    let response = '';
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        resolve(JSON.parse(response));
      } catch {
        reject(new Error('Browser bridge returned an invalid response.'));
      }
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help || !options.action) {
    process.stdout.write(usage());
    return;
  }
  const connection = await resolveConnection(options);
  const request = await buildRequest({ ...options, ...connection });
  const response = await sendRequest(connection, request);
  if (!response.ok) throw new Error(response.error || 'Browser bridge request failed.');
  if (typeof response.result === 'string') process.stdout.write(`${response.result}\n`);
  else if (response.result !== undefined) {
    process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRequest,
  discoverConnection,
  main,
  parseArguments,
  resolveConnection,
  resolveRunDirectory,
  sendRequest,
  usage,
};

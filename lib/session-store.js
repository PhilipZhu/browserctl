'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  deepMerge,
  localDate,
  timestamp,
  writeJsonAtomic,
} = require('./utils');

const MANIFEST_NAME = 'session.json';
const ARTIFACT_DIRECTORIES = {
  browserProfile: 'browser-profile',
  conversations: 'conversations',
  downloads: 'downloads',
  drafts: 'drafts',
  logs: 'logs',
  saves: 'saves',
  screenshots: 'screenshots',
};

const DIRECTORY_READMES = {
  'browser-profile': '# Browser Profile\n\nPersistent Chrome profile for this session. Do not edit while Chrome is running. Chrome generates and owns all nested directories; they intentionally do not receive launcher README files because extra files can interfere with browser databases, caches, components, and extensions.\n',
  conversations: '# Service-Managed Conversations\n\nOwner-only prompt/final continuity managed by this launcher. Native Pi, Codex, and Claude session persistence remains disabled. Files contain successful user requests, final answers, small usage metadata, and optional compact checkpoints—never raw tool events, reasoning, stderr, or process logs.\n',
  downloads: '# Downloads\n\nFiles downloaded from the session’s controlled Chrome tab.\n',
  drafts: '# Drafts\n\nEditable prompt drafts created by `/fill` and `/edit`.\n',
  logs: '# Logs\n\nService-owned browser events and Chrome output. Agent prompts, answers, tool events, reasoning, process output, and CLI session identifiers are intentionally not stored.\n',
  saves: '# Saves\n\nExplicit browser storage-state snapshots and application-extension state.\n',
  screenshots: '# Screenshots\n\nScreenshots captured with the `/screenshot` chat command.\n',
};

const ROOT_README = `# Browser Sessions

Each child directory is one recoverable browser-control session. Session folders and artifacts resolve relative to the directory from which the tool is run.
`;

function sessionReadme(id) {
  return `# Browser Session ${id}

## Reopen this session

From the run directory:

\`\`\`bash
./run.js --open ${id}
\`\`\`

This restores the saved browser/profile and any application extension listed in
\`session.json\`. It does not rerun an application's build pipeline.

## What is in this folder

- \`session.json\` records recoverable session metadata.
- Application extensions may add task-specific instructions, hooks, and state.
- \`browser-profile/\` preserves cookies and local browser data.
- \`conversations/\` contains successful managed prompts/final answers.
- \`downloads/\`, \`screenshots/\`, and \`saves/\` contain browser artifacts.
- \`logs/\` contains browser-service events and Chrome output.
- \`drafts/\` contains editable prompt drafts.

## Important

- Do not start Chrome directly with \`browser-profile/\`.
- Do not edit/delete the session while its service is running.
- Native agent session persistence stays disabled. Managed mode stores only
  successful prompts/final answers; ephemeral mode stores no conversation.
`;
}

class SessionStore {
  constructor(rootDirectory, options = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.targetUrl = options.targetUrl;
  }

  paths(sessionDirectory) {
    const result = {
      root: sessionDirectory,
      manifest: path.join(sessionDirectory, MANIFEST_NAME),
      readme: path.join(sessionDirectory, 'README.md'),
    };
    for (const [key, directory] of Object.entries(ARTIFACT_DIRECTORIES)) {
      result[key] = path.join(sessionDirectory, directory);
    }
    return result;
  }

  async initializeRoot() {
    await fsp.mkdir(this.rootDirectory, { recursive: true });
    await this.writeIfMissing(path.join(this.rootDirectory, 'README.md'), ROOT_README);
  }

  async ensureLayout(sessionDirectory, id = path.basename(sessionDirectory)) {
    const paths = this.paths(sessionDirectory);
    await fsp.mkdir(sessionDirectory, { recursive: true });
    await this.writeIfMissing(paths.readme, sessionReadme(id));
    for (const directory of Object.values(ARTIFACT_DIRECTORIES)) {
      const directoryPath = path.join(sessionDirectory, directory);
      await fsp.mkdir(directoryPath, { recursive: true });
      await this.writeIfMissing(
        path.join(directoryPath, 'README.md'),
        DIRECTORY_READMES[directory],
      );
    }
    return paths;
  }

  async writeIfMissing(filename, content) {
    try {
      await fsp.writeFile(filename, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  async create(options = {}) {
    await this.initializeRoot();
    const base = localDate(options.now || new Date());
    let sequence = 1;
    let id;
    let directory;

    while (true) {
      id = sequence === 1 ? base : `${base}-${String(sequence).padStart(2, '0')}`;
      directory = path.join(this.rootDirectory, id);
      try {
        await fsp.mkdir(directory);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        sequence += 1;
      }
    }

    const paths = await this.ensureLayout(directory, id);
    const now = timestamp();
    const manifest = {
      version: 1,
      id,
      path: directory,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      targetUrl: options.targetUrl || this.targetUrl,
      selectedAgent: options.agent || 'pi',
      browser: {
        cdpUrl: null,
        lastPid: null,
        lastPort: null,
        lastUrl: null,
        recovered: false,
      },
    };
    await writeJsonAtomic(paths.manifest, manifest);
    return { id, directory, manifest, paths, openedExisting: false };
  }

  async list() {
    await this.initializeRoot();
    const entries = await fsp.readdir(this.rootDirectory, { withFileTypes: true });
    const sessions = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = path.join(this.rootDirectory, entry.name);
      const stat = await fsp.stat(directory);
      let manifest = null;
      try {
        manifest = JSON.parse(
          await fsp.readFile(path.join(directory, MANIFEST_NAME), 'utf8'),
        );
      } catch (error) {
        if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      }
      const sortDate =
        manifest?.lastOpenedAt ||
        manifest?.updatedAt ||
        manifest?.createdAt ||
        stat.mtime.toISOString();
      sessions.push({
        id: manifest?.id || entry.name,
        directory,
        manifest,
        legacy: !manifest,
        sortDate,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    sessions.sort((left, right) => {
      const byDate = new Date(right.sortDate).getTime() - new Date(left.sortDate).getTime();
      return byDate || right.id.localeCompare(left.id);
    });
    return sessions;
  }

  async open(idOrPath) {
    if (!idOrPath) throw new Error('A session id or path is required.');
    await this.initializeRoot();
    const directory = path.resolve(
      path.isAbsolute(idOrPath) ? idOrPath : path.join(this.rootDirectory, idOrPath),
    );
    const relative = path.relative(this.rootDirectory, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
      throw new Error(`Session must be a child folder of ${this.rootDirectory}`);
    }
    const stat = await fsp.stat(directory).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Session does not exist: ${directory}`);

    const id = path.basename(directory);
    const paths = await this.ensureLayout(directory, id);
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(paths.manifest, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      const now = stat.birthtime?.toISOString?.() || stat.mtime.toISOString();
      manifest = {
        version: 1,
        id,
        path: directory,
        createdAt: now,
        updatedAt: timestamp(),
        lastOpenedAt: timestamp(),
        targetUrl: this.targetUrl,
        selectedAgent: 'pi',
        browser: {},
        migratedFromLegacyFolder: true,
      };
    }
    manifest = deepMerge(manifest, {
      version: 1,
      id,
      path: directory,
      updatedAt: timestamp(),
      lastOpenedAt: timestamp(),
    });
    await writeJsonAtomic(paths.manifest, manifest);
    return { id, directory, manifest, paths, openedExisting: true };
  }

  async update(session, patch) {
    const current = JSON.parse(await fsp.readFile(session.paths.manifest, 'utf8'));
    const manifest = deepMerge(current, {
      ...patch,
      updatedAt: timestamp(),
    });
    await writeJsonAtomic(session.paths.manifest, manifest);
    session.manifest = manifest;
    return manifest;
  }

  async acquireLease(session) {
    const filename = path.join(session.paths.logs, 'service.lock');
    const token = crypto.randomUUID();
    const payload = {
      pid: process.pid,
      token,
      startedAt: timestamp(),
      sessionId: session.id,
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fsp.writeFile(filename, `${JSON.stringify(payload, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        return { filename, token };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let existing = null;
        try {
          existing = JSON.parse(await fsp.readFile(filename, 'utf8'));
        } catch {
          existing = null;
        }
        const pid = Number(existing?.pid);
        let active = false;
        if (Number.isInteger(pid) && pid > 1) {
          try {
            process.kill(pid, 0);
            active = true;
          } catch (processError) {
            active = processError.code === 'EPERM';
          }
        }
        if (active) {
          throw new Error(
            `Session ${session.id} is already active in service process ${pid}.`,
          );
        }
        await fsp.unlink(filename).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new Error(`Could not acquire the service lease for session ${session.id}.`);
  }

  async releaseLease(lease) {
    if (!lease) return;
    try {
      const existing = JSON.parse(await fsp.readFile(lease.filename, 'utf8'));
      if (existing.token === lease.token) await fsp.unlink(lease.filename);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
    }
  }
}

module.exports = {
  ARTIFACT_DIRECTORIES,
  MANIFEST_NAME,
  SessionStore,
};

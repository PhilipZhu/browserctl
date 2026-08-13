'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SessionStore, ARTIFACT_DIRECTORIES } = require('../lib/session-store');

async function temporaryStore(t) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-session-test-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'weekly-logs');
  return new SessionStore(root, { targetUrl: 'http://127.0.0.1/example/' });
}

test('creates collision-safe date folders and complete documented layouts', async (t) => {
  const store = await temporaryStore(t);
  const now = new Date(2026, 6, 26, 12, 0, 0);
  const first = await store.create({ now });
  const second = await store.create({ now });

  assert.equal(first.id, '2026-07-26');
  assert.equal(second.id, '2026-07-26-02');
  assert.equal(first.manifest.selectedAgent, 'pi');
  await fsp.access(path.join(store.rootDirectory, 'README.md'));

  for (const session of [first, second]) {
    await fsp.access(session.paths.manifest);
    await fsp.access(session.paths.readme);
    for (const directory of Object.values(ARTIFACT_DIRECTORIES)) {
      await fsp.access(path.join(session.directory, directory, 'README.md'));
    }
  }
});

test('lists session folders newest first and ignores flat legacy artifacts', async (t) => {
  const store = await temporaryStore(t);
  await store.initializeRoot();
  await fsp.writeFile(path.join(store.rootDirectory, 'old-screenshot.png'), 'flat artifact');
  const first = await store.create({ now: new Date(2026, 6, 25) });
  const second = await store.create({ now: new Date(2026, 6, 26) });
  await store.update(first, { lastOpenedAt: '2026-07-25T12:00:00.000Z' });
  await store.update(second, { lastOpenedAt: '2026-07-26T12:00:00.000Z' });

  const sessions = await store.list();
  assert.deepEqual(
    sessions.map((session) => session.id),
    ['2026-07-26', '2026-07-25'],
  );
});

test('opens and migrates a legacy session directory', async (t) => {
  const store = await temporaryStore(t);
  const legacy = path.join(store.rootDirectory, '2026-06-01');
  await fsp.mkdir(legacy, { recursive: true });
  await fsp.writeFile(path.join(legacy, 'old.txt'), 'preserve me');

  const session = await store.open('2026-06-01');
  assert.equal(session.manifest.migratedFromLegacyFolder, true);
  assert.equal(await fsp.readFile(path.join(legacy, 'old.txt'), 'utf8'), 'preserve me');
  await fsp.access(session.paths.browserProfile);
  await fsp.access(session.paths.manifest);
});

test('refuses paths outside the weekly-log root', async (t) => {
  const store = await temporaryStore(t);
  await assert.rejects(() => store.open(os.tmpdir()), /must be a child folder/);
});

test('deep-merges browser manifest updates without losing sibling state', async (t) => {
  const store = await temporaryStore(t);
  const session = await store.create({ now: new Date(2026, 6, 26) });
  await store.update(session, { browser: { lastPid: 1234 } });
  await store.update(session, { browser: { lastPort: 9222 } });

  assert.equal(session.manifest.browser.lastPid, 1234);
  assert.equal(session.manifest.browser.lastPort, 9222);
  assert.equal('agents' in session.manifest, false);
});

test('service lease prevents concurrent launchers and is released by its owner', async (t) => {
  const store = await temporaryStore(t);
  const session = await store.create({ now: new Date(2026, 6, 26) });
  const lease = await store.acquireLease(session);
  await assert.rejects(
    () => store.acquireLease(session),
    /already active in service process/,
  );
  await store.releaseLease(lease);
  const replacement = await store.acquireLease(session);
  await store.releaseLease(replacement);
});

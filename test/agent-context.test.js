'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  browserContextPrompt,
  formatTurnPrompt,
} = require('../lib/agent-runner');

function liveState() {
  return {
    connected: true,
    connectedAt: '2026-07-26T20:00:00.000Z',
    cdpUrl: 'http://127.0.0.1:9333',
    port: 9333,
    pid: 4321,
    recovered: true,
    recoveredSession: true,
    reusedRunningChrome: false,
    headless: false,
    browserVersion: 'Chrome/149',
    contextCount: 1,
    pageCount: 1,
    activePageIndex: 0,
    activePageTargetId: 'TARGET123',
    activePageUrl: 'http://127.0.0.1/app/',
    activePageTitle: 'Example App',
    pages: [
      {
        index: 0,
        active: true,
        title: 'Example App',
        url: 'http://127.0.0.1/app/',
      },
    ],
    sessionId: '2026-07-26',
    sessionPath: '/workspace/weekly-logs/2026-07-26',
    targetUrl: 'http://127.0.0.1/app/',
    browserProfilePath: '/workspace/weekly-logs/2026-07-26/browser-profile',
    downloadsPath: '/workspace/weekly-logs/2026-07-26/downloads',
    draftsPath: '/workspace/weekly-logs/2026-07-26/drafts',
    screenshotsPath: '/workspace/weekly-logs/2026-07-26/screenshots',
    savesPath: '/workspace/weekly-logs/2026-07-26/saves',
    browserEventLogPath: '/workspace/weekly-logs/2026-07-26/logs/browser.jsonl',
    downloadPolicyEnforced: true,
    browserAccessMode: 'service-owned-playwright-bridge',
    browserBridgeHost: '127.0.0.1',
    browserBridgePort: 9444,
    browserBridgeTokenPath: '/workspace/weekly-logs/2026-07-26/logs/browser.token',
    browserControlCommand: '/workspace/browserctl/browserctl.js',
    storageStatePath: '/workspace/weekly-logs/2026-07-26/saves/latest.json',
    storageStateSaved: true,
    playwrightPackage: 'playwright-core',
    workingDirectory: '/workspace',
  };
}

test('every formatted turn contains complete fresh browser identity and ownership rules', () => {
  const prompt = formatTurnPrompt(liveState(), 'Submit the form');
  for (const expected of [
    'refreshed immediately before this turn',
    'Session id: 2026-07-26',
    'Chrome PID: 4321',
    'Headed: true',
    'Reopened an existing saved session/profile: true',
    'Reconnected to a Chrome process that was already running: false',
    'CDP URL: http://127.0.0.1:9333',
    'CDP port: 9333',
    'Active page target id: TARGET123',
    'playwright-core',
    'connectOverCDP',
    'service-owned-playwright-bridge',
    '/workspace/browserctl/browserctl.js',
    'Bridge port: 9444',
    'Never close the service-owned browser or context',
    'Submit the form',
  ]) {
    assert.match(prompt, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.ok(prompt.indexOf('LIVE PLAYWRIGHT CONTEXT') < prompt.indexOf('USER REQUEST'));
});

test('disconnected context gives the exact service-owned recovery gateway', () => {
  const prompt = browserContextPrompt({
    connected: false,
    sessionId: 'test-session',
    sessionPath: '/workspace/weekly-logs/test-session',
    targetUrl: 'http://127.0.0.1/app/',
    headless: false,
    lastKnownPid: 1234,
    lastKnownPort: 9333,
    browserControlCommand: '/workspace/browserctl/browserctl.js',
    browserBridgeHost: '127.0.0.1',
    browserBridgePort: 9444,
    browserBridgeTokenPath: '/workspace/weekly-logs/test-session/logs/browser.token',
  });
  assert.match(prompt, /no connected browser/i);
  assert.match(prompt, /\/workspace\/browserctl\/browserctl\.js launch/);
  assert.match(prompt, /Do not launch Chrome directly/);
  assert.match(prompt, /do not call connectOverCDP/);
  assert.doesNotMatch(prompt, /CDP URL: http/);
});

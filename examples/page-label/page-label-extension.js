'use strict';

const EXTENSION_ID = 'page-label-example';
const HOOK_NAME = 'example.page-label.set';
const STORAGE_KEY = 'browserctl.example.pageLabel';
const BANNER_ID = 'browserctl-page-label-example';

function normalizeLabel(value) {
  const label = String(value || '').trim();
  if (!label) throw new Error('A nonempty label is required.');
  if (label.length > 120) throw new Error('The label must be 120 characters or fewer.');
  return label;
}

async function readLabel(page) {
  if (!page || page.isClosed()) return null;
  return page.evaluate(({storageKey, bannerId}) => {
    const visible = document.getElementById(bannerId)?.textContent?.trim() || null;
    let stored = null;
    try {
      stored = localStorage.getItem(storageKey);
    } catch {
      // Some origins disable local storage; the visible DOM remains authoritative.
    }
    return visible || stored || null;
  }, {storageKey: STORAGE_KEY, bannerId: BANNER_ID});
}

async function displayLabel(page, label) {
  return page.evaluate(({storageKey, bannerId, value}) => {
    let banner = document.getElementById(bannerId);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = bannerId;
      Object.assign(banner.style, {
        background: '#172554',
        color: '#ffffff',
        font: '600 16px/1.4 system-ui, sans-serif',
        left: '0',
        padding: '12px 18px',
        position: 'fixed',
        right: '0',
        textAlign: 'center',
        top: '0',
        zIndex: '2147483647',
      });
      document.documentElement.appendChild(banner);
    }
    banner.textContent = value;
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // Verification below still proves the visible mutation.
    }
    return banner.textContent;
  }, {storageKey: STORAGE_KEY, bannerId: BANNER_ID, value: label});
}

async function restoreLabel(page) {
  if (!page || page.isClosed()) return null;
  const stored = await page.evaluate((storageKey) => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }, STORAGE_KEY);
  if (!stored) return null;
  await displayLabel(page, stored);
  return stored;
}

async function createExtension() {
  return {
    id: EXTENSION_ID,

    agentInstructions(turn) {
      const state = turn.browserState?.extensionContext?.[EXTENSION_ID];
      return `Architecture: this example owns a visible page label rendered in the managed tab.
The application module changes it through a verified Playwright hook and persists it in the page origin's local storage.
Current label: ${state?.label || '(none)'}.
Infer the user's desired outcome from meaning and live context; do not require special command wording.`;
    },

    semanticCapabilities: [{
      id: 'example.page-label.set',
      label: 'Set the visible page label',
      description: 'Add or change the short label displayed across the top of the managed page.',
      effect: 'Mutates the live page, verifies the displayed text, and saves browser state.',
      hook: HOOK_NAME,
      statePath: `browserState.extensionContext.${EXTENSION_ID}`,
      inputHint: '{"label":"nonempty text, at most 120 characters"}',
      preparePayload(payload) {
        return {label: normalizeLabel(payload.label)};
      },
      formatResult(result) {
        return `The visible page label is now “${result.label}”.`;
      },
    }],

    browserHooks: [{
      name: HOOK_NAME,
      description: 'Set and verify the visible page label.',
      inputHint: '{"label":"short text"}',
      async handler({browserManager, page, payload}) {
        if (!page || page.isClosed()) throw new Error('The managed page is unavailable.');
        const label = normalizeLabel(payload.label);
        await displayLabel(page, label);
        const verified = await readLabel(page);
        if (verified !== label) throw new Error('The visible page label could not be verified.');
        await browserManager.saveState('page-label');
        return {label, url: page.url(), verified: true};
      },
    }],

    browserLifecycle: {
      async pageReady({page}) {
        return {restoredLabel: await restoreLabel(page)};
      },
      async context({page}) {
        return {
          available: Boolean(page && !page.isClosed()),
          label: await readLabel(page),
        };
      },
    },
  };
}

module.exports = {
  BANNER_ID,
  EXTENSION_ID,
  HOOK_NAME,
  STORAGE_KEY,
  createExtension,
  normalizeLabel,
};

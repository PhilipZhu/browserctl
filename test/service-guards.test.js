'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerServiceGuards } = require('../run');

test('a floating rejected promise is logged and does not kill the service', async () => {
  const lines = [];
  const unregister = registerServiceGuards({ write: (text) => lines.push(text) });
  try {
    const listeners = process.listeners('unhandledRejection');
    assert.equal(listeners.length >= 1, true);
    // Deliver a rejection to the registered listener the same way Node does.
    listeners[listeners.length - 1](new Error('floating bridge promise'), Promise.resolve());
    assert.equal(lines.length, 1);
    assert.match(lines[0], /service continues/);
    assert.match(lines[0], /floating bridge promise/);
    // Non-Error rejection reasons must not crash the guard itself.
    listeners[listeners.length - 1]('plain string reason', Promise.resolve());
    assert.match(lines[1], /plain string reason/);
  } finally {
    unregister();
  }
});

test('unregistering removes the guard listener', () => {
  const before = process.listeners('unhandledRejection').length;
  const unregister = registerServiceGuards({ write: () => {} });
  assert.equal(process.listeners('unhandledRejection').length, before + 1);
  unregister();
  assert.equal(process.listeners('unhandledRejection').length, before);
});

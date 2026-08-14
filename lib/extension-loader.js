'use strict';

const path = require('node:path');
const {validateWorkflowTemplate} = require('./workflow-store');

function extensionEntries(manifest = {}) {
  return Array.isArray(manifest.extensions) ? manifest.extensions : [];
}

function extensionModulePath(entry, workingDirectory) {
  const requested = typeof entry === 'string' ? entry : entry?.module;
  if (!requested || typeof requested !== 'string') {
    throw new Error('Every service extension requires a module path.');
  }
  const resolved = path.resolve(workingDirectory, requested);
  const relative = path.relative(workingDirectory, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Extension modules must stay under ${workingDirectory}: ${requested}`);
  }
  return resolved;
}

function validateExtension(extension, source) {
  if (!extension || typeof extension !== 'object') {
    throw new Error(`Extension ${source} did not return an extension object.`);
  }
  if (!extension.id || typeof extension.id !== 'string') {
    throw new Error(`Extension ${source} requires a stable string id.`);
  }
  if (extension.agentInstructions !== undefined &&
      typeof extension.agentInstructions !== 'string' &&
      typeof extension.agentInstructions !== 'function') {
    throw new Error(`Extension ${extension.id} has invalid agentInstructions.`);
  }
  if (extension.browserHooks !== undefined && !Array.isArray(extension.browserHooks)) {
    throw new Error(`Extension ${extension.id} browserHooks must be an array.`);
  }
  if (extension.browserLifecycle !== undefined &&
      (!extension.browserLifecycle || typeof extension.browserLifecycle !== 'object')) {
    throw new Error(`Extension ${extension.id} browserLifecycle must be an object.`);
  }
  for (const hookName of ['beforeTurn', 'afterTurn', 'canHandleTurn', 'handleTurn', 'recoverTurn']) {
    if (extension[hookName] !== undefined && typeof extension[hookName] !== 'function') {
      throw new Error(`Extension ${extension.id} ${hookName} must be a function.`);
    }
  }
  for (const hook of extension.browserHooks || []) {
    if (!hook?.name || typeof hook.name !== 'string' || typeof hook.handler !== 'function') {
      throw new Error(`Extension ${extension.id} has an invalid browser hook.`);
    }
  }
  if (extension.semanticCapabilities !== undefined && !Array.isArray(extension.semanticCapabilities)) {
    throw new Error(`Extension ${extension.id} semanticCapabilities must be an array.`);
  }
  if (extension.workflows !== undefined && !Array.isArray(extension.workflows)) {
    throw new Error(`Extension ${extension.id} workflows must be an array.`);
  }
  if (extension.quickActions !== undefined && !Array.isArray(extension.quickActions)) {
    throw new Error(`Extension ${extension.id} quickActions must be an array.`);
  }
  for (const workflow of extension.workflows || []) {
    validateWorkflowTemplate(workflow, extension.id);
  }
  for (const capability of extension.semanticCapabilities || []) {
    if (!capability?.id || typeof capability.id !== 'string' ||
        !capability.label || typeof capability.label !== 'string' ||
        !capability.description || typeof capability.description !== 'string' ||
        !capability.effect || typeof capability.effect !== 'string' ||
        !capability.hook || typeof capability.hook !== 'string' ||
        (capability.targets !== undefined &&
          (!Array.isArray(capability.targets) || !capability.targets.length))) {
      throw new Error(`Extension ${extension.id} has an invalid semantic capability.`);
    }
    for (const callback of ['formatResult', 'preparePayload', 'continuationPrompt']) {
      if (capability[callback] !== undefined && typeof capability[callback] !== 'function') {
        if (callback !== 'continuationPrompt' || typeof capability[callback] !== 'string') {
          throw new Error(`Extension ${extension.id} semantic capability ${capability.id} has invalid ${callback}.`);
        }
      }
    }
    if (capability.continueAfterHook !== undefined &&
        typeof capability.continueAfterHook !== 'boolean') {
      throw new Error(`Extension ${extension.id} semantic capability ${capability.id} has invalid continueAfterHook.`);
    }
    for (const target of capability.targets || []) {
      if (!target?.id || typeof target.id !== 'string' ||
          !target.label || typeof target.label !== 'string' ||
          !target.description || typeof target.description !== 'string' ||
          !Array.isArray(target.accepts) ||
          !target.bind || typeof target.bind !== 'object' ||
          !Array.isArray(target.operations) || !target.operations.length ||
          (target.resourceMode !== undefined && !['one', 'many'].includes(target.resourceMode))) {
        throw new Error(`Extension ${extension.id} semantic capability ${capability.id} has an invalid target.`);
      }
    }
    if (!(extension.browserHooks || []).some((hook) => hook.name === capability.hook)) {
      throw new Error(`Extension ${extension.id} semantic capability ${capability.id} references an unregistered hook.`);
    }
  }
  for (const [name, handler] of Object.entries(extension.browserLifecycle || {})) {
    if (!['pageReady', 'beforeSave', 'context', 'beforeStop'].includes(name) ||
        typeof handler !== 'function') {
      throw new Error(`Extension ${extension.id} has an invalid browser lifecycle handler: ${name}.`);
    }
  }
  return extension;
}

async function loadExtensions(entries, options = {}) {
  const workingDirectory = path.resolve(options.workingDirectory || process.cwd());
  const loaded = [];
  const ids = new Set();
  const capabilityIds = new Set();
  const workflowIds = new Set();
  for (const entry of entries || []) {
    const modulePath = extensionModulePath(entry, workingDirectory);
    const moduleValue = require(modulePath);
    const factory = moduleValue.createExtension || moduleValue.default || moduleValue;
    if (typeof factory !== 'function') {
      throw new Error(`Extension module ${modulePath} must export createExtension().`);
    }
    const extension = validateExtension(
      await factory({
        entry,
        session: options.session,
        config: options.config || null,
        workingDirectory,
      }),
      modulePath,
    );
    if (ids.has(extension.id)) throw new Error(`Duplicate extension id: ${extension.id}`);
    ids.add(extension.id);
    for (const capability of extension.semanticCapabilities || []) {
      if (capabilityIds.has(capability.id)) {
        throw new Error(`Duplicate semantic capability id: ${capability.id}`);
      }
      capabilityIds.add(capability.id);
    }
    for (const workflow of extension.workflows || []) {
      if (workflowIds.has(workflow.id)) {
        throw new Error(`Duplicate workflow template id: ${workflow.id}`);
      }
      workflowIds.add(workflow.id);
    }
    loaded.push(extension);
  }
  return loaded;
}

function upsertExtensionEntry(entries, nextEntry) {
  const current = Array.isArray(entries) ? entries : [];
  const nextId = typeof nextEntry === 'string' ? nextEntry : nextEntry.id;
  return [
    ...current.filter((entry) =>
      (typeof entry === 'string' ? entry : entry?.id) !== nextId,
    ),
    nextEntry,
  ];
}

module.exports = {
  extensionEntries,
  extensionModulePath,
  loadExtensions,
  upsertExtensionEntry,
  validateExtension,
};

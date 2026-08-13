'use strict';

const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/i;
const PI_SEMANTIC_TOOL = 'browserctl_propose_action';

function valueAt(root, path) {
  const parts = Array.isArray(path) ? path : String(path || '').split('.').filter(Boolean);
  return parts.reduce((value, key) => value?.[key], root);
}

function resourceForUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  return {
    type: IMAGE_EXTENSIONS.test(parsed.href) ? 'image-url' : 'url',
    url: parsed.href,
  };
}

function bindResource(binding, resource) {
  const values = {};
  for (const [field, expression] of Object.entries(binding || {})) {
    if (expression === '$url') values[field] = resource.url;
    else if (expression === '$type') values[field] = resource.type;
    else values[field] = expression;
  }
  return values;
}

function resolvedOperation(requested, state, target, position) {
  if (requested === 'remove' || requested === 'list') return requested;
  if (position || requested === 'replace') return 'replace';
  const count = Number(state?.count) || 0;
  const capacity = Number(state?.capacity ?? target.capacity);
  const hasRoom = !Number.isFinite(capacity) || count < capacity;
  if (requested === 'add') {
    return hasRoom ? 'add' : target.whenFull === 'replace-last' ? 'replace' : 'add';
  }
  if (requested === 'upsert') {
    if (hasRoom) return 'add';
    return target.whenFull === 'replace-last' ? 'replace' : 'upsert';
  }
  return requested;
}

function parseJsonObject(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced || source;
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseSemanticAction(text) {
  const parsed = parseJsonObject(text);
  const action = parsed?.browserctlAction;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  if (typeof action.capability !== 'string' || !action.capability.trim()) {
    throw new Error('Semantic action proposal requires a capability id.');
  }
  return action;
}

function semanticProposalFromToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Semantic action tool requires an object proposal.');
  }
  const proposal = {...args};
  if (typeof proposal.capability !== 'string' || !proposal.capability.trim()) {
    throw new Error('Semantic action proposal requires a capability id.');
  }
  if (proposal.payloadJson !== undefined) {
    if (typeof proposal.payloadJson !== 'string') {
      throw new Error('Semantic action payloadJson must be a JSON string.');
    }
    const payload = parseJsonObject(proposal.payloadJson);
    if (!payload) throw new Error('Semantic action payloadJson must encode an object.');
    proposal.payload = payload;
    delete proposal.payloadJson;
  }
  return proposal;
}

function descriptorCatalog(extension, descriptor, context) {
  const state = descriptor.statePath ? valueAt(context, descriptor.statePath) : undefined;
  return {
    extension: extension.id,
    id: descriptor.id,
    label: descriptor.label,
    purpose: descriptor.description,
    effect: descriptor.effect,
    execution: descriptor.continueAfterHook
      ? 'The host activates/resumes a tracked workflow, then the agent continues with live browser tools.'
      : 'The host validates and runs the declared application hook.',
    inputMode: descriptor.targets ? 'target-resources' : 'typed-payload',
    ...(descriptor.targets ? {
      targets: descriptor.targets.map((target) => ({
        id: target.id,
        label: target.label,
        meaning: target.description,
        operations: target.operations || [],
        resources: target.accepts || [],
        resourceCardinality: target.resourceMode === 'many' ? 'one-or-more' : 'exactly-one',
        resourceFreeOperations: ['list', 'remove'].filter((operation) =>
          (target.operations || []).includes(operation),
        ),
        capacityPolicy: target.whenFull || null,
        currentState: state?.[target.id] || null,
      })),
    } : {
      input: descriptor.inputHint || '{}',
      currentState: state === undefined ? null : state,
    }),
  };
}

function semanticCapabilityPrompt(extensions, context) {
  const capabilities = (extensions || []).flatMap((extension) =>
    (extension.semanticCapabilities || []).map((descriptor) =>
      descriptorCatalog(extension, descriptor, context),
    ),
  );
  if (!capabilities.length) return '';
  const piToolProtocol = context?.runner?.selected === 'pi';
  return `## Semantic application capabilities

Decide intent from the human's meaning, conversation, application architecture, and current state—not from exact words or keyword matching. The same concept may be phrased in a completely different way.

${piToolProtocol
    ? `If exactly one capability safely expresses the requested outcome, do not invoke its hook through a shell command and do not mutate first. Call \`${PI_SEMANTIC_TOOL}\` exactly once as your final action. Include a brief natural-language \`interpretation\` and contextual \`rationale\` so the human can see what you understood. For a typed-payload capability, encode its input object in \`payloadJson\`. Browserctl will validate and execute the proposal, then report the verified result. Do not emit proposal JSON or another assistant response after the tool call.`
    : `If exactly one capability safely expresses the requested outcome, do not invoke its hook through a shell command and do not mutate first. Return only this JSON proposal as your final response:

\`\`\`json
{"browserctlAction":{"capability":"capability-id","target":"target-id when required","operation":"allowed operation when required","resources":[{"type":"url|image-url","url":"https://…"}],"payload":{"typed":"fields for typed-payload capabilities"}}}
\`\`\``}

For target-resources capabilities, omit typed payload data; use an empty \`resources\` array for a resource-free operation. ${piToolProtocol ? 'For typed-payload capabilities, omit target/resource fields and use `payloadJson`.' : 'For typed-payload capabilities, include only `capability` and `payload`.'} If no capability fits, work normally with the browser or answer normally; never propose an action merely because some words look similar.

Capability catalog and authoritative current state:

\`\`\`json
${JSON.stringify(capabilities, null, 2)}
\`\`\``;
}

function findCapability(extensions, id) {
  const matches = (extensions || []).flatMap((extension) =>
    (extension.semanticCapabilities || [])
      .filter((descriptor) => descriptor.id === id)
      .map((descriptor) => ({extension, descriptor})),
  );
  if (matches.length !== 1) {
    throw new Error(`Unknown or ambiguous semantic capability: ${id}.`);
  }
  return matches[0];
}

function describeSemanticProposal(extensions, proposal) {
  const {extension, descriptor} = findCapability(extensions, proposal.capability);
  const target = descriptor.targets
    ? descriptor.targets.find((candidate) => candidate.id === proposal.target)
    : null;
  return {
    extension,
    descriptor,
    target,
    interpretation: typeof proposal.interpretation === 'string'
      ? proposal.interpretation.trim()
      : '',
    rationale: typeof proposal.rationale === 'string'
      ? proposal.rationale.trim()
      : '',
  };
}

function validatePosition(value) {
  if (value === undefined) return undefined;
  if (value === 'last') return value;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('Semantic action position must be a positive integer or "last".');
  }
  return number;
}

async function prepareSemanticAction(extensions, proposal, context) {
  const {extension, descriptor} = findCapability(extensions, proposal.capability);
  if (!descriptor.targets) {
    const source = proposal.payload === undefined ? {} : proposal.payload;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`Semantic capability ${descriptor.id} requires an object payload.`);
    }
    const payload = descriptor.preparePayload
      ? await descriptor.preparePayload(source, context)
      : source;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`Semantic capability ${descriptor.id} produced an invalid payload.`);
    }
    return {extension, descriptor, payload, proposal};
  }

  const target = descriptor.targets.find((candidate) => candidate.id === proposal.target);
  if (!target) throw new Error(`Capability ${descriptor.id} does not declare target ${proposal.target || '(none)'}.`);
  const requestedOperation = String(proposal.operation || '');
  if (!target.operations?.includes(requestedOperation)) {
    throw new Error(`Target ${target.id} does not support operation ${requestedOperation || '(none)'}.`);
  }
  if (!Array.isArray(proposal.resources)) {
    throw new Error(`Capability ${descriptor.id} requires a resources array.`);
  }
  const resources = proposal.resources.map((resource, index) => {
    const normalized = resourceForUrl(resource?.url);
    if (!normalized) throw new Error(`Semantic action resource ${index + 1} is not an HTTP(S) URL.`);
    if (resource?.type !== normalized.type) {
      throw new Error(`Semantic action resource ${index + 1} type does not match its URL.`);
    }
    if (!target.accepts.includes(normalized.type)) {
      throw new Error(`Target ${target.id} does not accept ${normalized.type} resources.`);
    }
    return normalized;
  });
  const resourceFree = ['list', 'remove'].includes(requestedOperation);
  if (resourceFree && resources.length) {
    throw new Error(`${requestedOperation} does not accept URL resources.`);
  }
  if (!resourceFree && target.resourceMode === 'many' && !resources.length) {
    throw new Error(`${target.id} requires one or more URL resources.`);
  }
  if (!resourceFree && target.resourceMode !== 'many' && resources.length !== 1) {
    throw new Error(`${target.id} requires exactly one URL resource.`);
  }
  const position = validatePosition(proposal.position);
  const stateRoot = valueAt(context, descriptor.statePath);
  const targetState = stateRoot?.[target.id] || null;
  const operation = resolvedOperation(requestedOperation, targetState, target, position);
  const binding = resources[0] && target.resourceMode !== 'many'
    ? target.bind?.[resources[0].type]
    : null;
  if (resources[0] && target.resourceMode !== 'many' && !binding) {
    throw new Error(`Target ${target.id} has no binding for ${resources[0].type}.`);
  }
  const payload = {
    actionVersion: 1,
    action: descriptor.id,
    target: target.id,
    operation,
    requestedOperation,
    ...(target.resourceMode === 'many'
      ? {resources}
      : {values: resources[0] ? bindResource(binding, resources[0]) : {}}),
    ...(position ? {position} : {}),
  };
  return {extension, descriptor, target, targetState, payload, proposal};
}

module.exports = {
  PI_SEMANTIC_TOOL,
  describeSemanticProposal,
  parseSemanticAction,
  prepareSemanticAction,
  resourceForUrl,
  semanticProposalFromToolArgs,
  semanticCapabilityPrompt,
  valueAt,
};

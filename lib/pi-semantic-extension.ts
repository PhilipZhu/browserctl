/**
 * Browserctl's Pi transport boundary.
 *
 * The action tool sends each model-selected application capability to the
 * browserctl service over its authenticated loopback bridge. Browserctl
 * validates the proposal against the active module catalog, performs the
 * registered hook in its own process, and the verified result (or the
 * validation/execution error) returns here as the tool result, so the agent
 * can keep working — fix an error, take the next step — until the human's
 * whole request is addressed.
 */
import net from 'node:net';
import {readFile} from 'node:fs/promises';

const BRIDGE_TIMEOUT_MS = 10 * 60 * 1000;

async function bridgeRequest(payload: Record<string, unknown>): Promise<any> {
  const host = process.env.BROWSERCTL_BROWSER_HOST || '127.0.0.1';
  const port = Number(process.env.BROWSERCTL_BROWSER_PORT);
  const tokenFile = process.env.BROWSERCTL_BROWSER_TOKEN_FILE;
  if (!Number.isInteger(port) || port < 1 || !tokenFile) {
    throw new Error(
      'The browserctl bridge is not available in this environment; launch the managed browser first.',
    );
  }
  const token = (await readFile(tokenFile, 'utf8')).trim();
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({host, port});
    socket.setEncoding('utf8');
    socket.setTimeout(BRIDGE_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error('The browserctl bridge did not answer before the timeout.'));
    });
    let response = '';
    socket.once('connect', () => socket.write(`${JSON.stringify({...payload, token})}\n`));
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        resolve(JSON.parse(response));
      } catch {
        reject(new Error('The browserctl bridge returned an invalid response.'));
      }
    });
  });
}

export default function browserctlSemanticExtension(pi: any) {
  pi.registerTool({
    name: 'browserctl_propose_action',
    label: 'Perform application action',
    description:
      'Send one application capability from the browserctl catalog for immediate host validation and execution; the verified result returns as this tool result.',
    promptSnippet: 'Perform typed browserctl application actions with host validation',
    promptGuidelines: [
      'Call browserctl_propose_action whenever a supplied semantic application capability expresses the next needed outcome; browserctl validates, executes, verifies, and returns the outcome to you.',
      'Do not call an application hook through bash when a capability covers it; browserctl owns validation, execution, verification, and reporting.',
      'Call it as many times as the request needs — after each result, continue with the remaining parts of the request or correct course on an error, and finish with a summary of what was verifiably done.',
    ],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['capability'],
      properties: {
        capability: {
          type: 'string',
          description: 'Exact capability id from the supplied catalog.',
        },
        target: {
          type: 'string',
          description: 'Exact target id when the selected capability declares targets.',
        },
        operation: {
          type: 'string',
          description: 'Exact allowed operation for the selected target.',
        },
        resources: {
          type: 'array',
          description: 'Typed HTTP(S) resources; use an empty array for resource-free operations.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'url'],
            properties: {
              type: {
                type: 'string',
                description: 'The catalog resource type, normally url or image-url.',
              },
              url: {type: 'string', description: 'Absolute HTTP(S) URL.'},
            },
          },
        },
        position: {
          type: 'string',
          description: 'Optional 1-based position written as a string, or last.',
        },
        payloadJson: {
          type: 'string',
          description: 'For typed-payload capabilities only: the exact input object encoded as JSON.',
        },
        interpretation: {
          type: 'string',
          description: 'Brief natural-language statement of what the human wants accomplished.',
        },
        rationale: {
          type: 'string',
          description: 'Brief contextual reason this capability and target fit the request and current state.',
        },
      },
    },
    async execute(_toolCallId: string, params: unknown) {
      let response;
      try {
        response = await bridgeRequest({action: 'semantic', proposal: params});
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `The application action could not reach browserctl: ${error?.message || error}. ` +
              'If the managed browser is offline, launch it; otherwise adjust and retry.',
          }],
          details: {proposal: params, executed: false},
        };
      }
      if (!response?.ok) {
        return {
          content: [{
            type: 'text',
            text: `Browserctl rejected or failed the action: ${response?.error || 'unknown error'}. ` +
              'Inspect current state, adjust the proposal or approach, and continue.',
          }],
          details: {proposal: params, executed: false, failed: true},
        };
      }
      const output = typeof response.result?.output === 'string'
        ? response.result.output
        : JSON.stringify(response.result ?? null);
      return {
        content: [{
          type: 'text',
          text: `${output || 'The action completed with no output.'}\n\n` +
            'This outcome is validated and verified by browserctl. Continue with any remaining parts of the request, or summarize what was verifiably done if everything is complete.',
        }],
        details: {proposal: params, executed: true, output},
      };
    },
  });

  pi.registerTool({
    name: 'browserctl_update_workflow',
    label: 'Update tracked workflow',
    description:
      'Record one evidence-based status update for a step in the active browserctl workflow. Browserctl validates and persists it after the turn.',
    promptSnippet: 'Update active browserctl workflow steps after live inspection or verified action',
    promptGuidelines: [
      'When an active workflow is supplied, call browserctl_update_workflow after observing or acting on a step; do not merely claim a tracker update in prose.',
      'Use waiting with the exact human action or confirmation needed, skipped when live evidence makes a branch unnecessary, and completed only with a concise verification note.',
      'This tool records progress only. Continue browser work or provide the human-facing explanation after it returns.',
    ],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['stepId', 'status', 'note'],
      properties: {
        workflowId: {
          type: 'string',
          description: 'Optional exact active workflow id; omit to use the active workflow.',
        },
        stepId: {
          type: 'string',
          description: 'Exact step id from the active workflow.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'waiting', 'completed', 'skipped', 'failed'],
          description: 'Observed status after this turn.',
        },
        note: {
          type: 'string',
          description: 'Concise observed evidence, verification, or human action needed.',
        },
      },
    },
    async execute(_toolCallId: string, params: unknown) {
      return {
        content: [{
          type: 'text',
          text: 'Workflow update recorded for host validation and persistence.',
        }],
        details: {workflowUpdate: params},
      };
    },
  });
}

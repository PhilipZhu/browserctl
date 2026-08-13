/**
 * Browserctl's Pi transport boundary.
 *
 * This tool records a model-selected application capability. It deliberately
 * does not mutate the browser: browserctl validates the proposal against the
 * active module catalog and performs the registered hook in its own process.
 */
export default function browserctlSemanticExtension(pi: any) {
  pi.registerTool({
    name: 'browserctl_propose_action',
    label: 'Propose application action',
    description:
      'Select one application capability from the browserctl catalog. This records intent only; browserctl validates and executes it.',
    promptSnippet: 'Propose one typed browserctl application action for host validation',
    promptGuidelines: [
      'Use browserctl_propose_action as the final action when exactly one supplied semantic application capability safely matches the human request.',
      'Do not call an application hook through bash before browserctl_propose_action; browserctl owns validation, execution, verification, and reporting.',
      'After browserctl_propose_action, do not emit another assistant response in the same turn.',
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
      return {
        content: [{
          type: 'text',
          text: 'Application proposal recorded. Browserctl will validate, execute, verify, and report the outcome.',
        }],
        details: {proposal: params},
        terminate: true,
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

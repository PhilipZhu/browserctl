'use strict';

const {EventEmitter} = require('node:events');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {timestamp, writeJsonAtomic} = require('./utils');

const WORKFLOW_STATE_VERSION = 1;
const WORKFLOW_STATE_NAME = 'workflow-state.json';
const STEP_STATUSES = new Set([
  'pending',
  'in_progress',
  'waiting',
  'completed',
  'skipped',
  'failed',
]);
const WORKFLOW_STATUSES = new Set(['active', 'waiting', 'completed', 'cancelled']);
const MAX_HISTORY = 240;
const MAX_NOTE_CHARACTERS = 4000;

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} requires non-empty text.`);
  return text;
}

function validateWorkflowTemplate(template, source = 'extension') {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error(`Workflow template from ${source} must be an object.`);
  }
  const id = requiredText(template.id, 'Workflow template id');
  requiredText(template.title, `Workflow ${id} title`);
  requiredText(template.objective, `Workflow ${id} objective`);
  if (!Array.isArray(template.steps) || !template.steps.length) {
    throw new Error(`Workflow ${id} requires at least one step.`);
  }
  const ids = new Set();
  for (const step of template.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`Workflow ${id} has an invalid step.`);
    }
    const stepId = requiredText(step.id, `Workflow ${id} step id`);
    if (ids.has(stepId)) throw new Error(`Workflow ${id} has duplicate step ${stepId}.`);
    ids.add(stepId);
    requiredText(step.title, `Workflow ${id} step ${stepId} title`);
    requiredText(step.instructions, `Workflow ${id} step ${stepId} instructions`);
    requiredText(step.completion, `Workflow ${id} step ${stepId} completion criteria`);
    if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) {
      throw new Error(`Workflow ${id} step ${stepId} dependsOn must be an array.`);
    }
  }
  for (const step of template.steps) {
    for (const dependency of step.dependsOn || []) {
      if (!ids.has(dependency) || dependency === step.id) {
        throw new Error(`Workflow ${id} step ${step.id} has invalid dependency ${dependency}.`);
      }
    }
  }
  return template;
}

function workflowTemplates(extensions = []) {
  const templates = new Map();
  for (const extension of extensions) {
    for (const template of extension.workflows || []) {
      validateWorkflowTemplate(template, extension.id);
      if (templates.has(template.id)) {
        throw new Error(`Duplicate workflow template id: ${template.id}`);
      }
      templates.set(template.id, {...template, extensionId: extension.id});
    }
  }
  return templates;
}

function cleanNote(value, label = 'Workflow note') {
  if (value === undefined || value === null) return '';
  const note = String(value).trim();
  if (note.length > MAX_NOTE_CHARACTERS) {
    throw new Error(`${label} exceeds ${MAX_NOTE_CHARACTERS} characters.`);
  }
  return note;
}

function publicStep(step) {
  return {
    id: step.id,
    title: step.title,
    status: step.status,
    instructions: step.instructions,
    completion: step.completion,
    dependsOn: step.dependsOn || [],
    note: step.note || '',
    attempts: step.attempts || 0,
    updatedAt: step.updatedAt || null,
  };
}

function publicWorkflow(workflow) {
  if (!workflow) return null;
  return {
    id: workflow.id,
    templateId: workflow.templateId,
    title: workflow.title,
    objective: workflow.objective,
    status: workflow.status,
    startedAt: workflow.startedAt,
    updatedAt: workflow.updatedAt,
    completedAt: workflow.completedAt || null,
    activationReason: workflow.activationReason || '',
    metadata: workflow.metadata || {},
    steps: (workflow.steps || []).map(publicStep),
  };
}

function overlayScript(bindingName, renderName, actionToken) {
  return `(() => {
    if (window.top !== window || window[${JSON.stringify(renderName)}]) return;
    const bindingName = ${JSON.stringify(bindingName)};
    const statusSymbols = {pending:'○',in_progress:'◉',waiting:'◇',completed:'✓',skipped:'—',failed:'!'};
    const actionToken = ${JSON.stringify(actionToken)};
    let current = null;
    let ui = null;
    const mount = () => {
      if (!document.documentElement || ui) return;
      document.querySelector('[data-browserctl-workflow-panel]')?.remove();
      const host = document.createElement('div');
      host.dataset.browserctlWorkflowPanel = 'true';
      host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#172033';
      const shadow = host.attachShadow({mode:'closed'});
      shadow.innerHTML = '<style>*{box-sizing:border-box}.panel{width:360px;max-height:72vh;overflow:auto;background:#fff;border:1px solid #ccd3df;border-radius:14px;box-shadow:0 16px 44px rgba(19,30,55,.24);font-size:13px}.head{position:sticky;top:0;background:#172033;color:#fff;padding:11px 13px;border-radius:13px 13px 0 0;z-index:2}.eyebrow{font-size:10px;letter-spacing:.1em;text-transform:uppercase;opacity:.72}.title{font-weight:750;margin-top:3px}.summary{font-size:11px;margin-top:3px;opacity:.8}.steps{padding:7px}.step{border:1px solid #e1e5ed;border-radius:10px;margin:6px 0;padding:8px;background:#fff}.row{display:flex;gap:8px;align-items:flex-start}.symbol{font-size:16px;width:18px}.name{font-weight:650;flex:1}.note{font-size:11px;color:#5c667a;margin:5px 0 0 26px;white-space:pre-wrap}.actions{display:flex;gap:6px;margin:7px 0 0 26px}button{border:1px solid #c9d0dc;background:#f7f8fa;border-radius:7px;padding:4px 8px;font:inherit;cursor:pointer;color:#263044}button:hover{background:#eaf0ff}.completed{border-color:#b9dec8}.in_progress{border-color:#7fa6ff;background:#f7faff}.waiting{border-color:#e8c46a}.failed{border-color:#e58f8f}.skipped{opacity:.67}.empty{padding:12px;color:#687286}</style><div class="panel" hidden><div class="head"><div class="eyebrow">Browserctl workflow</div><div class="title"></div><div class="summary"></div></div><div class="steps"></div></div>';
      document.documentElement.appendChild(host);
      const panel = shadow.querySelector('.panel');
      shadow.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button || !current) return;
        const step = current.steps.find((item) => item.id === button.dataset.step);
        if (!step) return;
        const action = button.dataset.action;
        let note = '';
        if (action === 'prompt') {
          note = window.prompt('What should the agent change or pay attention to for this step?', step.note || '') || '';
          if (!note.trim()) return;
        }
        button.disabled = true;
        button.textContent = 'Queued';
        try { await window[bindingName]({token:actionToken,workflowId:current.id,stepId:step.id,action,note}); }
        finally { setTimeout(() => { button.disabled=false; button.textContent=action === 'retry' ? 'Retry' : 'Prompt agent'; }, 900); }
      });
      ui = {host,shadow,panel};
    };
    window[${JSON.stringify(renderName)}] = (state) => {
      current = state && state.active ? state.active : null;
      mount();
      if (!ui) return;
      ui.panel.hidden = !current;
      if (!current) return;
      ui.shadow.querySelector('.title').textContent = current.title;
      const done = current.steps.filter((step) => ['completed','skipped'].includes(step.status)).length;
      ui.shadow.querySelector('.summary').textContent = done + '/' + current.steps.length + ' resolved • ' + current.status;
      const steps = ui.shadow.querySelector('.steps');
      steps.textContent = '';
      for (const step of current.steps) {
        const item = document.createElement('div'); item.className = 'step ' + step.status;
        const row = document.createElement('div'); row.className='row';
        const symbol = document.createElement('span'); symbol.className='symbol'; symbol.textContent=statusSymbols[step.status] || '○';
        const name = document.createElement('span'); name.className='name'; name.textContent=step.title;
        row.append(symbol,name); item.append(row);
        if (step.note) { const note=document.createElement('div'); note.className='note'; note.textContent=step.note; item.append(note); }
        const actions=document.createElement('div'); actions.className='actions';
        for (const [action,label] of [['retry','Retry'],['prompt','Prompt agent']]) { const button=document.createElement('button'); button.dataset.action=action; button.dataset.step=step.id; button.textContent=label; actions.append(button); }
        item.append(actions); steps.append(item);
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true}); else mount();
  })();`;
}

class WorkflowStore extends EventEmitter {
  constructor(session, extensions = []) {
    super();
    this.session = session;
    this.templates = workflowTemplates(extensions);
    this.filename = path.join(session.paths.saves, WORKFLOW_STATE_NAME);
    this.state = null;
    this.context = null;
    this.bindingName = '__browserctlWorkflowAction';
    this.actionToken = crypto.randomBytes(24).toString('hex');
    this.renderName = `__browserctlWorkflowRender_${crypto.randomBytes(8).toString('hex')}`;
    this.overlaySource = overlayScript(this.bindingName, this.renderName, this.actionToken);
  }

  async initialize() {
    let saved = null;
    try {
      saved = JSON.parse(await fsp.readFile(this.filename, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
    }
    this.state = saved?.version === WORKFLOW_STATE_VERSION
      ? saved
      : {
        version: WORKFLOW_STATE_VERSION,
        updatedAt: timestamp(),
        activeWorkflowId: null,
        workflows: {},
        pendingActions: [],
        history: [],
      };
    this.state.workflows ||= {};
    this.state.pendingActions = Array.isArray(this.state.pendingActions)
      ? this.state.pendingActions
      : [];
    this.state.history = Array.isArray(this.state.history) ? this.state.history : [];
    await this.persist();
    return this;
  }

  catalog() {
    return [...this.templates.values()].map((template) => ({
      id: template.id,
      title: template.title,
      objective: template.objective,
      extensionId: template.extensionId,
      stepCount: template.steps.length,
    }));
  }

  active() {
    return publicWorkflow(this.state?.workflows?.[this.state?.activeWorkflowId]);
  }

  snapshot() {
    return {
      version: WORKFLOW_STATE_VERSION,
      statePath: this.filename,
      available: this.catalog(),
      active: this.active(),
      pendingHumanActions: this.state?.pendingActions?.length || 0,
    };
  }

  async persist(event = null) {
    this.state.updatedAt = timestamp();
    if (event) {
      this.state.history.push({at: this.state.updatedAt, ...event});
      this.state.history = this.state.history.slice(-MAX_HISTORY);
    }
    await writeJsonAtomic(this.filename, this.state);
    await fsp.chmod(this.filename, 0o600);
    await this.render();
    this.emit('changed', this.snapshot());
  }

  async activate(templateId, options = {}) {
    const template = this.templates.get(String(templateId || ''));
    if (!template) throw new Error(`Unknown workflow template: ${templateId || '(none)'}.`);
    const existing = this.state.workflows[template.id];
    if (existing && ['active', 'waiting'].includes(existing.status) && options.restart !== true) {
      this.state.activeWorkflowId = existing.id;
      existing.updatedAt = timestamp();
      if (options.activationReason) existing.activationReason = cleanNote(options.activationReason);
      existing.metadata = {...existing.metadata, ...(options.metadata || {})};
      await this.persist({type: 'workflow-resumed', workflowId: existing.id});
      return publicWorkflow(existing);
    }
    const now = timestamp();
    const workflow = {
      id: template.id,
      templateId: template.id,
      extensionId: template.extensionId,
      title: template.title,
      objective: template.objective,
      status: 'active',
      startedAt: now,
      updatedAt: now,
      activationReason: cleanNote(options.activationReason),
      metadata: options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
        ? options.metadata
        : {},
      steps: template.steps.map((step) => ({
        id: step.id,
        title: step.title,
        instructions: step.instructions,
        completion: step.completion,
        dependsOn: [...(step.dependsOn || [])],
        status: 'pending',
        note: '',
        attempts: 0,
        updatedAt: now,
      })),
    };
    this.state.workflows[workflow.id] = workflow;
    this.state.activeWorkflowId = workflow.id;
    await this.persist({type: 'workflow-activated', workflowId: workflow.id});
    return publicWorkflow(workflow);
  }

  async update(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Workflow update requires an object.');
    }
    const workflowId = String(payload.workflowId || this.state.activeWorkflowId || '');
    const workflow = this.state.workflows[workflowId];
    if (!workflow) throw new Error(`Workflow is not active: ${workflowId || '(none)'}.`);
    const stepId = requiredText(payload.stepId, 'Workflow update stepId');
    const step = workflow.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`Workflow ${workflow.id} has no step ${stepId}.`);
    const status = String(payload.status || '');
    if (!STEP_STATUSES.has(status)) throw new Error(`Invalid workflow step status: ${status || '(none)'}.`);
    const note = cleanNote(payload.note);
    if (status === 'completed' && !note) {
      throw new Error('A completed workflow step requires a short verification note.');
    }
    if (status === 'waiting' && !note) {
      throw new Error('A waiting workflow step requires the reason or human action needed.');
    }
    if (status === 'in_progress' && step.status !== 'in_progress') step.attempts += 1;
    step.status = status;
    if (note || payload.clearNote === true) step.note = note;
    step.updatedAt = timestamp();
    const unresolved = workflow.steps.filter((candidate) =>
      !['completed', 'skipped'].includes(candidate.status),
    );
    if (!unresolved.length) {
      workflow.status = 'completed';
      workflow.completedAt = timestamp();
    } else if (unresolved.some((candidate) => candidate.status === 'waiting')) {
      workflow.status = 'waiting';
      delete workflow.completedAt;
    } else {
      workflow.status = 'active';
      delete workflow.completedAt;
    }
    workflow.updatedAt = timestamp();
    await this.persist({
      type: 'step-updated',
      workflowId: workflow.id,
      stepId,
      status,
      note,
    });
    return publicWorkflow(workflow);
  }

  async setWorkflowStatus(payload = {}) {
    const workflowId = String(payload.workflowId || this.state.activeWorkflowId || '');
    const workflow = this.state.workflows[workflowId];
    if (!workflow) throw new Error(`Workflow is not active: ${workflowId || '(none)'}.`);
    const status = String(payload.status || '');
    if (!WORKFLOW_STATUSES.has(status)) throw new Error(`Invalid workflow status: ${status || '(none)'}.`);
    workflow.status = status;
    workflow.updatedAt = timestamp();
    if (status === 'completed') workflow.completedAt = timestamp();
    else delete workflow.completedAt;
    await this.persist({type: 'workflow-status', workflowId, status, note: cleanNote(payload.note)});
    return publicWorkflow(workflow);
  }

  async queueAction(payload = {}) {
    const workflowId = String(payload.workflowId || this.state.activeWorkflowId || '');
    const workflow = this.state.workflows[workflowId];
    if (!workflow) throw new Error(`Workflow is unavailable: ${workflowId || '(none)'}.`);
    const stepId = requiredText(payload.stepId, 'Workflow action stepId');
    if (!workflow.steps.some((step) => step.id === stepId)) {
      throw new Error(`Workflow ${workflow.id} has no step ${stepId}.`);
    }
    const action = String(payload.action || '');
    if (!['retry', 'prompt'].includes(action)) throw new Error(`Invalid workflow action: ${action || '(none)'}.`);
    const queued = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      workflowId,
      stepId,
      action,
      note: cleanNote(payload.note),
      queuedAt: timestamp(),
    };
    if (action === 'prompt' && !queued.note) throw new Error('A workflow correction prompt cannot be empty.');
    this.state.pendingActions.push(queued);
    await this.persist({type: 'human-action-queued', ...queued});
    this.emit('action-queued', queued);
    return queued;
  }

  async consumeAction() {
    const action = this.state.pendingActions.shift() || null;
    if (action) await this.persist({type: 'human-action-consumed', actionId: action.id});
    return action;
  }

  promptForAction(action) {
    if (!action) return null;
    const workflow = this.state.workflows[action.workflowId];
    const step = workflow?.steps.find((candidate) => candidate.id === action.stepId);
    if (!workflow || !step) return null;
    if (action.action === 'prompt') {
      return `For the active workflow “${workflow.title}”, revisit step “${step.title}”. The human says: ${action.note}\nInspect the live browser and current plan, navigate as needed, make only the requested correction, verify it, and update the workflow step with observed evidence.`;
    }
    return `Retry active workflow step “${step.title}” in “${workflow.title}”. Inspect the live browser first because the page may have changed. Reopen or navigate to the relevant page as needed, perform the step safely, verify the result, and update the workflow tracker with evidence.`;
  }

  async attachBrowser(context) {
    if (!context || this.context === context) {
      await this.render();
      return;
    }
    this.context = context;
    await context.exposeBinding(this.bindingName, async (_source, payload) => {
      if (!payload || payload.token !== this.actionToken) {
        throw new Error('Workflow panel action authentication failed.');
      }
      const clean = {...payload};
      delete clean.token;
      return this.queueAction(clean);
    });
    await context.addInitScript({content: this.overlaySource});
    for (const page of context.pages()) {
      await page.evaluate(this.overlaySource).catch(() => {});
    }
    await this.render();
  }

  async render() {
    if (!this.context) return;
    const state = this.snapshot();
    await Promise.all(this.context.pages().map(async (page) => {
      if (page.isClosed()) return;
      await page.evaluate(this.overlaySource).catch(() => {});
      await page.evaluate(({name, value}) => window[name]?.(value), {
        name: this.renderName,
        value: state,
      }).catch(() => {});
    }));
  }
}

module.exports = {
  STEP_STATUSES,
  WORKFLOW_STATE_NAME,
  WORKFLOW_STATE_VERSION,
  WorkflowStore,
  publicWorkflow,
  validateWorkflowTemplate,
  workflowTemplates,
};

'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// The bar is a memory aid, not a menu of everything: extensions register only
// the few actions a returning human needs but tends to forget. The cap keeps
// that contract honest.
const MAX_QUICK_ACTIONS = 8;
const MAX_LABEL_LENGTH = 48;
const MAX_HINT_LENGTH = 140;
const MAX_PROMPT_LENGTH = 1000;

function requiredText(value, label, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) {
    throw new Error(`${label} must stay under ${maxLength} characters; got ${text.length}.`);
  }
  return text;
}

function normalizeQuickAction(action, extensionId) {
  if (!action || typeof action !== 'object') {
    throw new Error(`Extension ${extensionId} has an invalid quick action.`);
  }
  const context = `Extension ${extensionId} quick action`;
  const id = requiredText(action.id, `${context} id`, MAX_LABEL_LENGTH);
  return Object.freeze({
    id: `${extensionId}:${id}`,
    label: requiredText(action.label, `${context} ${id} label`, MAX_LABEL_LENGTH),
    hint: action.hint === undefined
      ? ''
      : requiredText(action.hint, `${context} ${id} hint`, MAX_HINT_LENGTH),
    prompt: requiredText(action.prompt, `${context} ${id} prompt`, MAX_PROMPT_LENGTH),
  });
}

function collectQuickActions(extensions) {
  const actions = [];
  const seen = new Set();
  for (const extension of extensions || []) {
    for (const action of extension.quickActions || []) {
      const normalized = normalizeQuickAction(action, extension.id);
      if (seen.has(normalized.id)) {
        throw new Error(`Duplicate quick action id: ${normalized.id}.`);
      }
      seen.add(normalized.id);
      actions.push(normalized);
    }
  }
  if (actions.length > MAX_QUICK_ACTIONS) {
    throw new Error(
      `Quick actions are limited to ${MAX_QUICK_ACTIONS} so the bar stays scannable; got ${actions.length}.`,
    );
  }
  return Object.freeze(actions);
}

function barScript(bindingName, actionToken, actions) {
  const items = actions.map(({ id, label, hint }) => ({ id, label, hint }));
  return `(() => {
    if (window.top !== window || window.__browserctlActionBarMounted) return;
    window.__browserctlActionBarMounted = true;
    const bindingName = ${JSON.stringify(bindingName)};
    const actionToken = ${JSON.stringify(actionToken)};
    const items = ${JSON.stringify(items)};
    const mount = () => {
      if (!document.documentElement) return;
      document.querySelector('[data-browserctl-action-bar]')?.remove();
      const host = document.createElement('div');
      host.dataset.browserctlActionBar = 'true';
      host.style.cssText = 'all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483646;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#172033';
      const shadow = host.attachShadow({mode:'closed'});
      shadow.innerHTML = '<style>*{box-sizing:border-box}.toggle{border:1px solid #ccd3df;background:#fff;border-radius:999px;padding:7px 14px;font:600 12px ui-sans-serif,system-ui,sans-serif;color:#263044;cursor:pointer;box-shadow:0 6px 20px rgba(19,30,55,.16)}.toggle:hover{background:#eaf0ff}.card{width:320px;max-height:60vh;overflow:auto;background:#fff;border:1px solid #ccd3df;border-radius:14px;box-shadow:0 16px 44px rgba(19,30,55,.24);margin-bottom:8px;font-size:13px}.head{position:sticky;top:0;background:#172033;color:#fff;padding:10px 13px;border-radius:13px 13px 0 0}.eyebrow{font-size:10px;letter-spacing:.1em;text-transform:uppercase;opacity:.72}.list{padding:7px}.item{display:block;width:100%;text-align:left;border:1px solid #e1e5ed;border-radius:10px;margin:6px 0;padding:9px 10px;background:#fff;font:inherit;cursor:pointer;color:inherit}.item:hover{border-color:#7fa6ff;background:#f7faff}.item[disabled]{cursor:default;border-color:#b9dec8;background:#f4faf6}.label{font-weight:650}.hint{font-size:11px;color:#5c667a;margin-top:3px;line-height:1.45}.foot{font-size:10.5px;color:#687286;padding:2px 13px 11px;line-height:1.5}</style><div class="card" hidden><div class="head"><div class="eyebrow">Quick actions</div></div><div class="list"></div><div class="foot">Clicking sends the request to the console agent — or just type your own version there.</div></div><button class="toggle" type="button">✦ Quick actions</button>';
      const card = shadow.querySelector('.card');
      const list = shadow.querySelector('.list');
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'item';
        button.dataset.id = item.id;
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = item.label;
        button.append(label);
        if (item.hint) {
          const hint = document.createElement('div');
          hint.className = 'hint';
          hint.textContent = item.hint;
          button.append(hint);
        }
        list.append(button);
      }
      shadow.querySelector('.toggle').addEventListener('click', () => {
        card.hidden = !card.hidden;
      });
      list.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-id]');
        if (!button || button.disabled) return;
        button.disabled = true;
        const label = button.querySelector('.label');
        const original = label.textContent;
        try {
          await window[bindingName]({token: actionToken, actionId: button.dataset.id});
          label.textContent = original + '  ✓ sent to agent';
        } catch {
          label.textContent = original + '  — failed, use the console';
        }
        setTimeout(() => { label.textContent = original; button.disabled = false; card.hidden = true; }, 1400);
      });
      document.documentElement.appendChild(host);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true}); else mount();
  })();`;
}

class ActionBar extends EventEmitter {
  constructor(extensions = []) {
    super();
    this.actions = collectQuickActions(extensions);
    this.bindingName = '__browserctlQuickAction';
    this.actionToken = crypto.randomBytes(24).toString('hex');
    this.overlaySource = barScript(this.bindingName, this.actionToken, this.actions);
    this.pendingPrompts = [];
    this.context = null;
  }

  async attachBrowser(context) {
    if (!this.actions.length || !context || this.context === context) return;
    this.context = context;
    await context.exposeBinding(this.bindingName, async (_source, payload) => {
      if (!payload || payload.token !== this.actionToken) {
        throw new Error('Quick action authentication failed.');
      }
      return this.queuePrompt(payload.actionId);
    });
    await context.addInitScript({ content: this.overlaySource });
    for (const page of context.pages()) {
      await page.evaluate(this.overlaySource).catch(() => {});
    }
  }

  queuePrompt(actionId) {
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new Error(`Unknown quick action: ${actionId || '(none)'}.`);
    const queued = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      actionId: action.id,
      prompt: `The human clicked the “${action.label}” quick action in the browser. ${action.prompt}`,
      queuedAt: new Date().toISOString(),
    };
    this.pendingPrompts.push(queued);
    this.emit('prompt-queued', queued);
    return { queued: true, actionId: action.id };
  }

  consumePrompt() {
    const queued = this.pendingPrompts.shift() || null;
    return queued ? queued.prompt : null;
  }

  get pendingCount() {
    return this.pendingPrompts.length;
  }
}

module.exports = { ActionBar, collectQuickActions, MAX_QUICK_ACTIONS };

// Background service worker for the AI Writer Assistant bubble extension.
// Supports two providers:
//   • Gemini (default) — same prompts/schemas as the web app's services/geminiService.ts
//   • OpenAI-compatible — any endpoint speaking /v1/chat/completions
//     (OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, …)
// Also implements auto model fetching (/v1/models · Gemini ListModels) and
// injects "smart context" (page title/domain/language + nearby text) into prompts.

'use strict';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Optional local-only default key: create config.local.js next to this file
// (git-ignored) with:  self.AIWA_DEFAULT_KEY = 'AIza…';
// Keeps personal keys out of the repository. Without it, users set their key
// in the extension Options.
let DEFAULT_API_KEY = '';
try {
  importScripts('config.local.js');
  if (typeof AIWA_DEFAULT_KEY === 'string') DEFAULT_API_KEY = AIWA_DEFAULT_KEY;
} catch (_) { /* config.local.js is optional */ }

// Same models as the web app, with stable aliases as fallbacks in case a
// preview model is retired.
const DEFAULT_FLASH_MODEL = 'gemini-3-flash-preview';
const DEFAULT_PRO_MODEL = 'gemini-3-pro-preview';
const FALLBACK_FLASH = 'gemini-flash-latest';
const FALLBACK_PRO = 'gemini-pro-latest';

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings() {
  return chrome.storage.sync.get({
    provider: 'gemini',        // 'gemini' | 'openai'
    apiKey: '',                // Gemini key
    model: '',                 // Gemini model override (utility/translate)
    coachModel: '',            // Gemini model override (coach)
    openaiBaseUrl: DEFAULT_OPENAI_BASE,
    openaiApiKey: '',
    openaiModel: '',
    openaiCoachModel: ''
  });
}

// ---------------------------------------------------------------------------
// Response schemas (Gemini REST format: uppercase type names)
// ---------------------------------------------------------------------------

const S_OPTIONS_NUANCE = {
  type: 'OBJECT',
  properties: {
    sourceLanguage: { type: 'STRING', description: 'Detected source language name. Only include when asked.' },
    options: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          nuance: { type: 'STRING', description: 'The tone or style (e.g., Formal, Casual).' }
        },
        required: ['text', 'nuance']
      }
    }
  },
  required: ['options']
};

const S_OPTIONS_EXPLANATIONS = {
  type: 'OBJECT',
  properties: {
    options: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING', description: 'The corrected text.' },
          explanations: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'List of reasons for the corrections.'
          }
        },
        required: ['text', 'explanations']
      }
    }
  },
  required: ['options']
};

const S_DICTIONARY = {
  type: 'OBJECT',
  properties: {
    word: { type: 'STRING' },
    definition: { type: 'STRING' },
    synonyms: { type: 'ARRAY', items: { type: 'STRING' } },
    usageExample: { type: 'STRING' }
  },
  required: ['word', 'definition', 'synonyms', 'usageExample']
};

const S_COACH = {
  type: 'OBJECT',
  properties: {
    score: { type: 'NUMBER' },
    tone: { type: 'STRING' },
    strengths: { type: 'ARRAY', items: { type: 'STRING' } },
    suggestions: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['score', 'tone', 'strengths', 'suggestions']
};

// Compact JSON-shape description for providers without structured output.
function schemaToText(s) {
  if (!s || !s.type) return 'value';
  switch (s.type) {
    case 'OBJECT': {
      const fields = Object.entries(s.properties || {})
        .map(([k, v]) => `"${k}": ${schemaToText(v)}`);
      const req = (s.required || []).join(', ');
      return `{ ${fields.join(', ')} }${req ? ` (required: ${req})` : ''}`;
    }
    case 'ARRAY':
      return `array of ${schemaToText(s.items)}`;
    case 'STRING':
      return `"string"${s.description ? ` — ${s.description}` : ''}`;
    case 'NUMBER':
      return 'number';
    default:
      return 'value';
  }
}

// ---------------------------------------------------------------------------
// Smart context
// ---------------------------------------------------------------------------

function sanitizeContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const out = {
    pageTitle: str(ctx.pageTitle, 120),
    domain: str(ctx.domain, 100),
    pageLang: str(ctx.pageLang, 12),
    surrounding: str(ctx.surrounding, 500).replace(/\s+/g, ' ').trim()
  };
  return (out.pageTitle || out.domain || out.pageLang || out.surrounding) ? out : null;
}

// Builds the context preamble injected into prompts. withNearby=false keeps
// long-text tasks (coach, grammar) light with just page metadata.
function contextBlock(ctx, withNearby) {
  const c = sanitizeContext(ctx);
  if (!c) return '';
  const bits = [];
  if (c.pageTitle) bits.push(`page title: "${c.pageTitle}"`);
  if (c.domain) bits.push(`site: ${c.domain}`);
  if (c.pageLang) bits.push(`page language hint: ${c.pageLang}`);
  if (withNearby && c.surrounding) bits.push(`nearby text on the page: "${c.surrounding}"`);
  if (!bits.length) return '';
  return `
    [Context — use it to disambiguate meaning, tone, idioms and audience. Never include or translate the context itself in your answer.]
    ${bits.join(' · ')}
`;
}

// ---------------------------------------------------------------------------
// Task definitions — prompts match services/geminiService.ts, plus context
// ---------------------------------------------------------------------------

const TASKS = {
  translate: {
    schema: S_OPTIONS_NUANCE,
    flash: true,
    prompt: (p) => {
      const ctx = contextBlock(p.pageContext, true);
      const from = p.sourceLang && p.sourceLang !== 'Auto-detect'
        ? `from ${p.sourceLang} into ${p.targetLang}`
        : `into ${p.targetLang} (detect the source language automatically; also include a top-level "sourceLanguage" field naming the detected language)`;
      return `
    Translate the following text ${from}.
    Provide 3 distinct translations:
    1. Standard/Natural
    2. Formal/Professional
    3. Casual/Conversational (if applicable, otherwise an alternative phrasing)

    Return a JSON object with 'options', where each option has 'text' and 'nuance'.
${ctx}
    Text: "${p.text}"
  `;
    }
  },

  grammar: {
    schema: S_OPTIONS_EXPLANATIONS,
    flash: true,
    prompt: (p) => `
    Act as a professional editor. Review the following text for grammar, spelling, punctuation, and style errors.
${contextBlock(p.pageContext, false)}    Return a JSON object with an array of 'options'.
    - The first option should be the standard grammatical correction.
    - If there are valid stylistic alternatives (e.g., more formal or more concise), provide up to 2 additional options.
    - Include brief explanations for the changes in each option.

    Text to check:
    "${p.text}"
  `
  },

  reword: {
    schema: S_OPTIONS_EXPLANATIONS,
    flash: true,
    prompt: (p) => `
    Rephrase the following sentence/text to be more ${p.tone}.
${contextBlock(p.pageContext, false)}    Provide 3 distinct variations that convey the meaning well but differ in structure or vocabulary.
    Return a JSON object with 'options'.

    Text: "${p.text}"
  `
  },

  define: {
    schema: S_DICTIONARY,
    flash: true,
    prompt: (p) => `
    Provide a definition, synonyms, and a usage example for the word "${p.word}".
    The word is used in this context: "${p.context}".
${contextBlock(p.pageContext, true)}    Return the result as JSON.
  `
  },

  coach: {
    schema: S_COACH,
    flash: false, // deeper analysis → Pro-tier model, like the web app
    prompt: (p) => `
    Act as a writing coach. Analyze the text below.
${contextBlock(p.pageContext, false)}    Give it a score from 1-100 based on clarity and engagement.
    Identify the tone.
    List strengths.
    List specific suggestions for improvement.

    Text: "${p.text}"
  `
  }
};

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (_) { /* fall through */ }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) { /* fall through */ }
  }
  throw new Error('Could not parse the model response as JSON.');
}

function friendlyError(status, message) {
  const msg = message || `HTTP ${status}`;
  if (status === 400 && /api key not valid/i.test(msg)) {
    return 'Invalid Gemini API key. Set a valid key on the extension Options page.';
  }
  if (status === 401 || status === 403) {
    return 'API key was rejected (permission denied). Check your API key in the extension Options.';
  }
  if (status === 429) {
    return 'Rate limit reached. Wait a moment and try again.';
  }
  if (status === 404 || /not found|not supported/i.test(msg)) {
    return msg; // likely a model-name issue; caller decides whether to fall back
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

async function callGemini(model, prompt, schema, apiKey) {
  const gen = { temperature: 0.7 };
  if (schema) {
    gen.responseMimeType = 'application/json';
    gen.responseSchema = schema;
  }
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: gen
  };

  const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) message = j.error.message;
    } catch (_) { /* keep default */ }
    const err = new Error(friendlyError(res.status, message));
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const cand = data && data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map((p) => p.text || '').join('')
    : '';

  if (!text) {
    const reason = (cand && cand.finishReason) ||
      (data && data.promptFeedback && data.promptFeedback.blockReason) ||
      'unknown';
    throw new Error(`Model returned no text (${reason}). Try rephrasing the input.`);
  }

  return parseJsonLoose(text);
}

function isModelError(err) {
  return err && (err.status === 404 || /not found|not supported/i.test(String(err.message)));
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

function joinUrl(baseUrl, path) {
  return String(baseUrl || DEFAULT_OPENAI_BASE).replace(/\/+$/, '') + path;
}

async function callOpenAI(baseUrl, apiKey, model, taskName, prompt) {
  const schema = TASKS[taskName].schema;
  const system =
    'You are the AI engine of a browser writing-assistant extension. ' +
    'Respond with a single valid JSON object only — no markdown, no code fences, no commentary. ' +
    `JSON shape: ${schemaToText(schema)}`;

  const makeBody = (withJsonMode) => ({
    model,
    temperature: 0.7,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    ...(withJsonMode ? { response_format: { type: 'json_object' } } : {})
  });

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };

  let res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
    method: 'POST', headers, body: JSON.stringify(makeBody(true))
  });

  // Some compatible providers reject response_format — retry once without it.
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) message = j.error.message;
      else if (typeof (j && j.error) === 'string') message = j.error;
    } catch (_) { /* keep default */ }
    if (res.status === 400 || res.status === 422 || /response_format/i.test(message)) {
      res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
        method: 'POST', headers, body: JSON.stringify(makeBody(false))
      });
    } else {
      throw new Error(friendlyError(res.status, message));
    }
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) message = j.error.message;
      else if (typeof (j && j.error) === 'string') message = j.error;
    } catch (_) { /* keep default */ }
    throw new Error(friendlyError(res.status, message));
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;

  if (!content) {
    const reason = (choice && choice.finish_reason) || 'unknown';
    throw new Error(`Model returned no text (${reason}). Try rephrasing the input.`);
  }

  return parseJsonLoose(content);
}

// ---------------------------------------------------------------------------
// Auto model fetching
// ---------------------------------------------------------------------------

async function fetchModels({ provider, apiKey, baseUrl }) {
  if (provider === 'openai') {
    const key = (apiKey || '').trim();
    if (!key) throw new Error('Enter the API key first (a dummy key like "ollama" works for local servers).');
    const res = await fetch(joinUrl(baseUrl, '/models'), {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) message = j.error.message;
        else if (typeof (j && j.error) === 'string') message = j.error;
      } catch (_) { /* keep default */ }
      throw new Error(friendlyError(res.status, message));
    }
    const j = await res.json();
    const list = Array.isArray(j) ? j : (j.data || j.models || []);
    const ids = [...new Set(
      list.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
        .filter((id) => typeof id === 'string' && id)
    )].sort();
    if (!ids.length) throw new Error('The endpoint returned no models.');
    return ids.slice(0, 400);
  }

  // Gemini ListModels
  const key = (apiKey || '').trim() || DEFAULT_API_KEY;
  const res = await fetch(`${GEMINI_BASE}?pageSize=100&key=${encodeURIComponent(key)}`);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) message = j.error.message;
    } catch (_) { /* keep default */ }
    throw new Error(friendlyError(res.status, message));
  }
  const j = await res.json();
  const list = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((name) => name && !/embedding|imagen|tts|veo|aqa|image|robotic/i.test(name))
    .sort();
  if (!list.length) throw new Error('No text models found for this key.');
  return list;
}

// ---------------------------------------------------------------------------
// Task runner (provider routing)
// ---------------------------------------------------------------------------

function buildFinalPrompt(taskName, payload) {
  return TASKS[taskName].prompt(payload);
}

async function runTask(taskName, payload) {
  const task = TASKS[taskName];
  if (!task) throw new Error(`Unknown task: ${taskName}`);
  if (!payload || (!payload.text && !payload.word)) {
    throw new Error('Nothing to process — select some text first.');
  }

  const s = await getSettings();
  const prompt = buildFinalPrompt(taskName, payload);

  // ----- OpenAI-compatible -----
  if (s.provider === 'openai') {
    const apiKey = (s.openaiApiKey || '').trim();
    if (!apiKey) throw new Error('No API key set. Open the extension Options → Provider and add one.');
    const model = task.flash
      ? (s.openaiModel || '').trim()
      : ((s.openaiCoachModel || '').trim() || (s.openaiModel || '').trim());
    if (!model) throw new Error('No model selected. Open Options → Provider and click "Fetch models".');
    return callOpenAI(s.openaiBaseUrl, apiKey, model, taskName, prompt);
  }

  // ----- Gemini -----
  const apiKey = (s.apiKey && s.apiKey.trim()) || DEFAULT_API_KEY;
  if (!apiKey) {
    throw new Error('No Gemini API key set. Open the extension Options → Google Gemini and add one (free at aistudio.google.com/app/apikey).');
  }
  const customModel = (s.model || '').trim();

  const primary = task.flash
    ? (customModel || DEFAULT_FLASH_MODEL)
    : ((s.coachModel || '').trim() || customModel || DEFAULT_PRO_MODEL);
  const fallback = task.flash ? FALLBACK_FLASH : FALLBACK_PRO;

  const models = primary === fallback ? [primary] : [primary, fallback];

  let lastErr;
  for (const model of models) {
    try {
      return await callGemini(model, prompt, task.schema, apiKey);
    } catch (err) {
      lastErr = err;
      if (!isModelError(err)) throw err;
    }
  }
  throw lastErr || new Error('Request failed.');
}

// Quick connectivity/auth check used by the Options page.
async function testKey({ provider, apiKey, baseUrl }) {
  if (provider === 'openai') {
    const key = (apiKey || '').trim();
    if (!key) return { ok: false, error: 'Enter the API key first.' };
    try {
      const res = await fetch(joinUrl(baseUrl, '/models'), {
        headers: { Authorization: `Bearer ${key}` }
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const n = Array.isArray(j) ? j.length : (j.data || j.models || []).length;
        return { ok: true, info: `connected — ${n} models available` };
      }
      let message = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) message = j.error.message;
        else if (typeof (j && j.error) === 'string') message = j.error;
      } catch (_) { /* keep default */ }
      return { ok: false, error: friendlyError(res.status, message) };
    } catch (e) {
      return { ok: false, error: `Could not reach ${joinUrl(baseUrl, '/models')} — ${(e && e.message) || e}` };
    }
  }

  // Gemini
  const key = (apiKey || '').trim() || DEFAULT_API_KEY;
  try {
    const res = await fetch(`${GEMINI_BASE}/${FALLBACK_FLASH}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }] })
    });
    if (res.ok) return { ok: true, info: 'connected' };
    let message = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error && j.error.message) message = j.error.message; } catch (_) {}
    return { ok: false, error: friendlyError(res.status, message) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;

  if (msg.type === 'GEMINI_TASK') {
    runTask(msg.task, msg.payload || {})
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // async response
  }

  if (msg.type === 'FETCH_MODELS') {
    fetchModels(msg)
      .then((models) => sendResponse({ ok: true, models }))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  if (msg.type === 'TEST_KEY') {
    testKey(msg)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return undefined;
  }

  return undefined;
});

// Toolbar icon click → toggle the bubble panel on the current tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (_) {
    // No content script here (chrome://, Web Store, PDFs…) → open settings instead.
    chrome.runtime.openOptionsPage();
  }
});

// ---------------------------------------------------------------------------
// Toolbar icon theme (icons/<theme>/icon*.png, generated by tools/gen-icons.cjs)
// ---------------------------------------------------------------------------

const ICON_THEMES = ['indigo', 'black', 'white', 'sky', 'emerald', 'rose', 'amber'];

function applyIconTheme(theme) {
  if (!ICON_THEMES.includes(theme)) theme = 'black';
  if (theme === 'indigo') {
    chrome.action.setIcon({
      path: { 16: 'icons/icon16.png', 24: 'icons/icon24.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png' }
    });
    return;
  }
  const p = {};
  for (const s of [16, 24, 32, 48]) p[s] = `icons/${theme}/icon${s}.png`;
  chrome.action.setIcon({ path: p });
}

chrome.storage.sync.get({ iconTheme: 'black' }).then((s) => applyIconTheme(s.iconTheme));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.iconTheme) applyIconTheme(changes.iconTheme.newValue);
});

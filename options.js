// Options page: provider selection (Gemini / OpenAI-compatible), auto model
// fetching, key testing, languages, bubble + smart-context toggles.

'use strict';

const LANGS = ['English', 'Nepali', 'Hindi', 'Spanish', 'French', 'German', 'Chinese', 'Japanese'];

// Must match BUBBLE_THEMES in content.js and THEMES in tools/gen-icons.cjs
const ICON_THEMES = [
  { id: 'black',   label: 'Black',   css: 'linear-gradient(135deg,#2E2A23,#0A0908)', fg: '#F6F0E3' },
  { id: 'white',   label: 'White',   css: 'linear-gradient(135deg,#FFFFFF,#E7DFD0)', fg: '#171512' },
  { id: 'indigo',  label: 'Indigo',  css: 'linear-gradient(135deg,#818CF8,#4F46E5)', fg: '#FFFFFF' },
  { id: 'sky',     label: 'Sky',     css: 'linear-gradient(135deg,#38BDF8,#0284C7)', fg: '#FFFFFF' },
  { id: 'emerald', label: 'Emerald', css: 'linear-gradient(135deg,#34D399,#059669)', fg: '#FFFFFF' },
  { id: 'rose',    label: 'Rose',    css: 'linear-gradient(135deg,#FB7185,#E11D48)', fg: '#FFFFFF' },
  { id: 'amber',   label: 'Amber',   css: 'linear-gradient(135deg,#FBBF24,#D97706)', fg: '#FFFFFF' }
];

const BUBBLE_SIZE_DEFAULT = 48;
const BUBBLE_SIZE_MIN = 36;
const BUBBLE_SIZE_MAX = 64;

let selectedTheme = 'black';

const $ = (id) => document.getElementById(id);

function clampBubbleSize(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(BUBBLE_SIZE_MAX, Math.max(BUBBLE_SIZE_MIN, Math.round(numeric)))
    : BUBBLE_SIZE_DEFAULT;
}

function renderSizePreview() {
  const range = $('bubbleSize');
  if (!range) return;
  const size = clampBubbleSize(range.value);
  const pct = ((size - BUBBLE_SIZE_MIN) / (BUBBLE_SIZE_MAX - BUBBLE_SIZE_MIN)) * 100;
  $('bubbleSizeValue').textContent = size + ' px';
  range.style.setProperty('--p', pct.toFixed(1) + '%');

  const theme = ICON_THEMES.find((t) => t.id === selectedTheme) || ICON_THEMES[0];
  const preview = $('sizePreview');
  preview.style.width = size + 'px';
  preview.style.height = size + 'px';
  preview.style.background = theme.css;
  preview.style.color = theme.fg || '#fff';
  const icon = preview.querySelector('svg');
  const iconSize = Math.round(size * 0.48);
  icon.style.width = iconSize + 'px';
  icon.style.height = iconSize + 'px';
}

function renderSwatches() {
  $('swatches').innerHTML = ICON_THEMES.map((t) => `
    <button class="swatch ${t.id === selectedTheme ? 'on' : ''}" data-theme="${t.id}" type="button"
      aria-pressed="${t.id === selectedTheme}" title="${t.label} theme">
      <div class="chip" style="background:${t.css}"></div>
      <span>${t.label}</span>
    </button>`).join('');
  $('swatches').querySelectorAll('.swatch').forEach((b) =>
    b.addEventListener('click', () => {
      selectedTheme = b.dataset.theme;
      renderSwatches();
      renderSizePreview();
    }));
}

function fillSelect(sel, values, selected) {
  sel.innerHTML = values.map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`).join('');
}

// Populates a model dropdown: defaults + fetched list + whatever is saved.
function fillModels(sel, models, saved, defaultLabel) {
  const opts = [];
  if (defaultLabel) opts.push({ v: '', label: defaultLabel });
  if (saved) opts.push({ v: saved, label: saved }); // keep saved value even if not in the fetched list
  for (const m of models || []) {
    if (m !== saved) opts.push({ v: m, label: m });
  }
  sel.innerHTML = opts.map((o) => `<option value="${o.v}" ${o.v === (saved || '') ? 'selected' : ''}>${o.label}</option>`).join('');
}

function currentProvider() {
  return document.querySelector('.prov-tab.on').dataset.prov;
}

function setProvider(prov) {
  document.querySelectorAll('.prov-tab').forEach((t) => t.classList.toggle('on', t.dataset.prov === prov));
  $('geminiSection').style.display = prov === 'gemini' ? '' : 'none';
  $('openaiSection').style.display = prov === 'openai' ? '' : 'none';
}

async function load() {
  const s = await chrome.storage.sync.get({
    provider: 'gemini',
    apiKey: '',
    model: '',
    coachModel: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: '',
    openaiModel: '',
    openaiCoachModel: '',
    sourceLang: 'Auto-detect',
    targetLang: 'Nepali',
    showBubble: true,
    smartContext: true,
    iconTheme: 'black',
    bubbleSize: BUBBLE_SIZE_DEFAULT
  });

  setProvider(s.provider);
  $('apiKey').value = s.apiKey || '';
  fillModels($('model'), null, s.model, 'Default (gemini-3-flash-preview)');
  fillModels($('coachModel'), null, s.coachModel, 'Default (gemini-3-pro-preview)');
  $('openaiBaseUrl').value = s.openaiBaseUrl || '';
  $('openaiApiKey').value = s.openaiApiKey || '';
  fillModels($('openaiModel'), null, s.openaiModel, '— fetch models —');
  fillModels($('openaiCoachModel'), null, s.openaiCoachModel, 'Same as above');

  fillSelect($('sourceLang'), ['Auto-detect', ...LANGS], s.sourceLang);
  fillSelect($('targetLang'), LANGS, s.targetLang);
  $('showBubble').checked = s.showBubble !== false;
  $('smartContext').checked = s.smartContext !== false;
  selectedTheme = ICON_THEMES.some((t) => t.id === s.iconTheme) ? s.iconTheme : 'black';
  renderSwatches();
  $('bubbleSize').value = String(clampBubbleSize(s.bubbleSize));
  renderSizePreview();

  // Best-effort auto-fetch so dropdowns are populated on first open.
  if (s.provider === 'gemini') fetchGeminiModels(true);
  else if (s.openaiApiKey) fetchOpenaiModels(true);
}

async function save() {
  await chrome.storage.sync.set({
    provider: currentProvider(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    coachModel: $('coachModel').value,
    openaiBaseUrl: $('openaiBaseUrl').value.trim() || 'https://api.openai.com/v1',
    openaiApiKey: $('openaiApiKey').value.trim(),
    openaiModel: $('openaiModel').value,
    openaiCoachModel: $('openaiCoachModel').value,
    sourceLang: $('sourceLang').value,
    targetLang: $('targetLang').value,
    showBubble: $('showBubble').checked,
    smartContext: $('smartContext').checked,
    iconTheme: selectedTheme,
    bubbleSize: clampBubbleSize($('bubbleSize').value)
  });
  const note = $('saveNote');
  note.classList.add('show');
  setTimeout(() => note.classList.remove('show'), 1600);
}

// ---------------------------------------------------------------- key tests

async function testKey(provider) {
  const status = provider === 'gemini' ? $('geminiStatus') : $('openaiStatus');
  const btn = provider === 'gemini' ? $('testGeminiBtn') : $('testOpenaiBtn');
  status.className = 'status busy';
  status.textContent = 'Testing…';
  btn.disabled = true;
  try {
    const msg = { type: 'TEST_KEY', provider };
    if (provider === 'gemini') msg.apiKey = $('apiKey').value;
    else { msg.apiKey = $('openaiApiKey').value; msg.baseUrl = $('openaiBaseUrl').value.trim(); }
    const res = await chrome.runtime.sendMessage(msg);
    if (res && res.ok) {
      status.className = 'status ok';
      status.textContent = `✓ ${res.info || 'Key works.'}`;
    } else {
      status.className = 'status err';
      status.textContent = '✗ ' + ((res && res.error) || 'Failed');
    }
  } catch (e) {
    status.className = 'status err';
    status.textContent = '✗ ' + ((e && e.message) || String(e));
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------- model fetching

async function fetchGeminiModels(silent) {
  const status = $('geminiStatus');
  if (!silent) { status.className = 'status busy'; status.textContent = 'Fetching models…'; }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'FETCH_MODELS', provider: 'gemini', apiKey: $('apiKey').value
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Failed');
    const savedModel = $('model').value;
    const savedCoach = $('coachModel').value;
    fillModels($('model'), res.models, savedModel, 'Default (gemini-3-flash-preview)');
    fillModels($('coachModel'), res.models, savedCoach, 'Default (gemini-3-pro-preview)');
    status.className = 'status ok';
    status.textContent = `✓ ${res.models.length} models fetched`;
  } catch (e) {
    status.className = 'status err';
    status.textContent = '✗ ' + ((e && e.message) || String(e));
  }
}

async function fetchOpenaiModels(silent) {
  const status = $('openaiStatus');
  if (!silent) { status.className = 'status busy'; status.textContent = 'Fetching models…'; }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'FETCH_MODELS', provider: 'openai',
      apiKey: $('openaiApiKey').value,
      baseUrl: $('openaiBaseUrl').value.trim() || 'https://api.openai.com/v1'
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Failed');
    const savedModel = $('openaiModel').value;
    const savedCoach = $('openaiCoachModel').value;
    fillModels($('openaiModel'), res.models, savedModel, '');
    fillModels($('openaiCoachModel'), res.models, savedCoach, 'Same as above');
    status.className = 'status ok';
    status.textContent = `✓ ${res.models.length} models fetched`;
  } catch (e) {
    status.className = 'status err';
    status.textContent = '✗ ' + ((e && e.message) || String(e));
  }
}

// ---------------------------------------------------------------------- misc

async function resetPos() {
  await chrome.storage.local.remove('bubblePos');
  const btn = $('resetPosBtn');
  const old = btn.textContent;
  btn.textContent = 'Position reset ✓';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

document.addEventListener('DOMContentLoaded', () => {
  load();

  document.querySelectorAll('.prov-tab').forEach((t) =>
    t.addEventListener('click', () => {
      setProvider(t.dataset.prov);
      if (t.dataset.prov === 'gemini' && $('model').options.length <= 1) fetchGeminiModels(true);
      if (t.dataset.prov === 'openai' && $('openaiModel').options.length <= 1) fetchOpenaiModels(true);
    }));

  document.querySelectorAll('.preset').forEach((b) =>
    b.addEventListener('click', () => { $('openaiBaseUrl').value = b.dataset.url; }));

  document.querySelectorAll('.eye').forEach((btn) =>
    btn.addEventListener('click', () => {
      const field = $(btn.dataset.for);
      if (!field) return;
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
    }));

  $('saveBtn').addEventListener('click', save);
  $('testGeminiBtn').addEventListener('click', () => testKey('gemini'));
  $('testOpenaiBtn').addEventListener('click', () => testKey('openai'));
  $('fetchGeminiBtn').addEventListener('click', () => fetchGeminiModels(false));
  $('fetchOpenaiBtn').addEventListener('click', () => fetchOpenaiModels(false));
  $('resetPosBtn').addEventListener('click', resetPos);
  $('bubbleSize').addEventListener('input', renderSizePreview);
  $('apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') testKey('gemini'); });
  $('openaiApiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') testKey('openai'); });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });
});

// Content script: injects a Google-Translate-style floating bubble on every page.
// Click = open the AI panel (auto-fills with the page selection and translates).
// Drag = reposition (persisted). Right-click = hide bubble (with undo toast).
// Smart context: captures page title/domain/language + text surrounding the
// selection and sends it with each AI request (toggle in the panel header).
// All UI lives inside a Shadow DOM so host-page CSS cannot break it.

(() => {
  'use strict';

  if (window !== window.top) return; // top frame only
  if (window.__AIWA_BUBBLE__) return;
  window.__AIWA_BUBBLE__ = true;

  // ------------------------------------------------------------------ config

  const LANGS = ['English', 'Nepali', 'Hindi', 'Spanish', 'French', 'German', 'Chinese', 'Japanese'];
  const BCP47 = {
    English: 'en-US', Nepali: 'ne-NP', Hindi: 'hi-IN', Spanish: 'es-ES',
    French: 'fr-FR', German: 'de-DE', Chinese: 'zh-CN', Japanese: 'ja-JP'
  };
  const TONES = ['Professional', 'Creative', 'Diplomatic', 'Concise', 'Casual', 'Friendly', 'Humorous', 'Sarcasm', 'Ancient'];

  const TABS = [
    { id: 'translate', label: 'Translate', btn: 'Translate' },
    { id: 'grammar', label: 'Fix', btn: 'Fix Grammar' },
    { id: 'reword', label: 'Reword', btn: 'Reword' },
    { id: 'define', label: 'Define', btn: 'Define' },
    { id: 'coach', label: 'Coach', btn: 'Analyze' }
  ];

  const Z = '2147483647';
  const BUBBLE = 48;
  const MAX_SEL = 8000;
  const HOST_ID = 'aiwa-bubble-host';

  // In-page bubble + panel-logo colors per icon theme (matches tools/gen-icons.cjs)
  const BUBBLE_THEMES = {
    indigo:  { bg: 'linear-gradient(135deg,#818CF8,#4F46E5)', shadow: 'rgba(79,70,229,.45)' },
    black:   { bg: 'linear-gradient(135deg,#2E2A23,#0A0908)', shadow: 'rgba(17,15,11,.6)', fg: '#F6F0E3' },
    white:   { bg: 'linear-gradient(135deg,#FFFFFF,#E7DFD0)', shadow: 'rgba(35,30,22,.25)', ring: true, fg: '#171512' },
    sky:     { bg: 'linear-gradient(135deg,#38BDF8,#0284C7)', shadow: 'rgba(2,132,199,.45)' },
    emerald: { bg: 'linear-gradient(135deg,#34D399,#059669)', shadow: 'rgba(5,150,105,.45)' },
    rose:    { bg: 'linear-gradient(135deg,#FB7185,#E11D48)', shadow: 'rgba(225,29,72,.45)' },
    amber:   { bg: 'linear-gradient(135deg,#FBBF24,#D97706)', shadow: 'rgba(217,119,6,.45)' }
  };

  // ------------------------------------------------------------------- state

  let settings = {
    sourceLang: 'Auto-detect', targetLang: 'Nepali', showBubble: true,
    smartContext: true, provider: 'gemini', openaiBaseUrl: 'https://api.openai.com/v1',
    iconTheme: 'black'
  };
  let host = null, root = null, bubble = null, panel = null, input = null;
  let controlsEl = null, resultsEl = null, tabsEl = null, primaryBtn = null, ctxBtn = null;
  let toastEl = null, toastTimer = null;

  let panelOpen = false;
  let activeTab = 'translate';
  let lastSelection = '';
  let lastCtx = null; // smart context for the current selection
  let lastAutoKey = '';
  let curX = 0, curY = 0;
  let curSource = 'Auto-detect';
  let curTarget = 'Nepali';
  let curTone = 'Professional';

  const results = {}; // per-task: { data } | { error }
  const busy = {};    // per-task: boolean
  let speakBtn = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // ------------------------------------------------------------------- style

  const CSS = `
    :host {
      all: initial;
      --font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --ink: #171512;
      --ink-2: #5B5549;
      --ink-3: #958D7E;
      --line: #ECE5D6;
      --line-2: #DFD6C4;
      --surface: #FFFDF8;
      --surface-2: #F8F3E9;
      --surface-3: #F0EADD;
      --accent: #1A1814;
      --accent-2: #8F8574;
      --accent-soft: #F4EEE2;
      --accent-ink: #2A261F;
      --focus: #33302A;
      --cream: #F6F0E3;
      --ring: 0 0 0 3px rgba(26, 24, 20, .09);
      --shadow-panel: 0 0 0 1px rgba(26, 24, 20, .07), 0 2px 4px rgba(26, 24, 20, .05), 0 18px 44px -14px rgba(35, 30, 22, .30), 0 44px 88px -32px rgba(35, 30, 22, .22);
      --shadow-card: 0 1px 2px rgba(26, 24, 20, .04);
    }
    * {
      box-sizing: border-box; margin: 0; padding: 0; font-family: var(--font);
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    }

    .bubble {
      position: fixed; z-index: ${Z}; width: ${BUBBLE}px; height: ${BUBBLE}px;
      border-radius: 50%; cursor: grab; user-select: none; -webkit-user-select: none; color: var(--cream);
      background: var(--bbg, linear-gradient(135deg, #2E2A23 0%, #0A0908 100%));
      box-shadow:
        0 1px 0 rgba(255, 255, 255, .16) inset,
        0 12px 26px -10px var(--bsh, rgba(17, 15, 11, .6)),
        0 4px 10px -3px rgba(17, 15, 11, .22);
      display: flex; align-items: center; justify-content: center;
      transition: transform .2s cubic-bezier(.2, .8, .2, 1), box-shadow .2s cubic-bezier(.2, .8, .2, 1);
      touch-action: none;
    }
    .bubble::before {
      content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
      background: radial-gradient(120% 90% at 30% 10%, rgba(255, 255, 255, .30), rgba(255, 255, 255, 0) 58%);
    }
    .bubble::after {
      content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14);
    }
    .bubble:hover {
      transform: scale(1.06);
      box-shadow:
        0 1px 0 rgba(255, 255, 255, .16) inset,
        0 16px 32px -10px var(--bsh, rgba(17, 15, 11, .65)),
        0 6px 14px -4px rgba(17, 15, 11, .24);
    }
    .bubble:active { cursor: grabbing; transform: scale(.94); }
    .bubble.is-open { transform: scale(.94); }
    .bubble.is-open:hover { transform: scale(1.02); }
    .bubble.dragging { transition: none; }
    .bubble:focus-visible { outline: 3px solid rgba(26, 24, 20, .35); outline-offset: 3px; }
    .bubble.has-ring {
      box-shadow:
        0 1px 0 rgba(255, 255, 255, .38) inset,
        0 12px 26px -10px var(--bsh, rgba(15, 23, 42, .35)),
        0 0 0 1px rgba(15, 23, 42, .14);
    }
    .bubble svg {
      position: relative; z-index: 1; width: 23px; height: 23px; color: currentColor;
      pointer-events: none; filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .18));
    }

    .panel {
      position: fixed; z-index: ${Z}; width: 392px; max-width: calc(100vw - 16px);
      max-height: min(640px, calc(100vh - 16px));
      background: var(--surface); border-radius: 20px; overflow: hidden;
      box-shadow: var(--shadow-panel); color: var(--ink);
      display: none; flex-direction: column;
      animation: panelIn .2s cubic-bezier(.2, .8, .2, 1);
    }
    @keyframes panelIn { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }

    .head { display: flex; align-items: center; gap: 10px; padding: 13px 12px 11px 14px; flex: none; }
    .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .logo {
      width: 30px; height: 30px; border-radius: 9px; flex: none; position: relative; color: var(--cream);
      background: linear-gradient(135deg, #2E2A23, #0A0908);
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 1px 0 rgba(255, 255, 255, .16) inset, 0 6px 12px -6px rgba(17, 15, 11, .55);
    }
    .logo svg { width: 16px; height: 16px; color: currentColor; }
    .title { font-size: 13px; font-weight: 650; letter-spacing: -.01em; color: var(--ink); line-height: 1.2; }
    .title small {
      display: flex; align-items: center; gap: 5px; margin-top: 2px;
      font-size: 10px; font-weight: 500; letter-spacing: .01em; color: var(--ink-3);
    }
    .title small::before {
      content: ''; width: 5px; height: 5px; border-radius: 50%; flex: none;
      background: var(--accent);
    }
    .head-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
    .hbtn {
      width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent;
      color: var(--ink-3); cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: background .15s, color .15s;
    }
    .hbtn:hover { background: var(--surface-3); color: var(--ink-2); }
    .hbtn:active { transform: scale(.95); }
    .hbtn svg { width: 15px; height: 15px; pointer-events: none; }
    .ctxbtn.on, .ctxbtn.on:hover { background: var(--accent-soft); color: var(--accent-ink); }

    .tabs {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; flex: none;
      margin: 0 12px; padding: 3px; border-radius: 11px;
      background: var(--surface-2); border: 1px solid var(--line);
    }
    .tab {
      border: none; background: transparent; border-radius: 8px; cursor: pointer;
      padding: 6px 2px; font-size: 11px; font-weight: 600; letter-spacing: .005em;
      color: var(--ink-3); transition: color .15s, background .15s, box-shadow .15s;
    }
    .tab:hover { color: var(--ink-2); }
    .tab.on {
      background: var(--surface); color: var(--ink);
      box-shadow: 0 1px 2px rgba(26, 24, 20, .07), 0 0 0 1px rgba(26, 24, 20, .05);
    }

    .body { display: flex; flex-direction: column; overflow: hidden; flex: 1; min-height: 0; padding-top: 10px; }
    .input {
      flex: none; margin: 0 12px; padding: 11px 13px; min-height: 70px; max-height: 160px;
      border: 1px solid var(--line-2); border-radius: 12px; background: var(--surface);
      font-family: var(--font); font-size: 13px; line-height: 1.6; color: var(--ink);
      resize: none; outline: none; overflow-y: auto;
      transition: border-color .15s, box-shadow .15s;
    }
    .input::placeholder { color: var(--ink-3); }
    .input:focus { border-color: var(--focus); box-shadow: var(--ring); }
    .input.shake { animation: shake .4s cubic-bezier(.36, .07, .19, .97); }
    @keyframes shake { 20%, 60% { transform: translateX(-3px); } 40%, 80% { transform: translateX(3px); } }

    .controls { display: flex; align-items: center; gap: 6px; padding: 9px 12px 0; flex: none; }
    .controls:empty { display: none; }
    .sel {
      flex: 1; min-width: 0; padding: 7px 26px 7px 10px; border: 1px solid var(--line-2); border-radius: 9px;
      background-color: var(--surface); color: var(--ink-2);
      font-family: var(--font); font-size: 11.5px; font-weight: 550;
      outline: none; cursor: pointer; appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23958D7E' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 9px center;
      transition: border-color .15s, box-shadow .15s, background-color .15s;
    }
    .sel:hover { background-color: var(--surface-2); }
    .sel:focus { border-color: var(--focus); box-shadow: var(--ring); }
    .swap {
      flex: none; width: 30px; height: 30px; border: 1px solid var(--line-2); border-radius: 9px;
      background: var(--surface); color: var(--ink-3); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background .15s, color .15s, border-color .15s, transform .12s;
    }
    .swap:hover { color: var(--accent-ink); border-color: var(--line-2); background: var(--accent-soft); }
    .swap:active { transform: scale(.94); }
    .swap svg { width: 13px; height: 13px; }

    .go {
      flex: none; margin: 10px 12px 0; padding: 11px 14px; border: none; border-radius: 11px;
      background: linear-gradient(135deg, #2B2720 0%, #100E0B 100%); color: var(--cream);
      font-family: var(--font); font-size: 12.5px; font-weight: 650; letter-spacing: .005em;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      cursor: pointer; position: relative;
      box-shadow: 0 1px 0 rgba(255, 255, 255, .14) inset, 0 10px 20px -10px rgba(17, 15, 11, .55);
      transition: filter .15s, transform .12s, box-shadow .15s;
    }
    .go:hover:not(:disabled) {
      filter: brightness(1.18);
      box-shadow: 0 1px 0 rgba(255, 255, 255, .14) inset, 0 12px 24px -10px rgba(17, 15, 11, .65);
    }
    .go:active:not(:disabled) { transform: translateY(.5px) scale(.996); }
    .go:disabled { opacity: .55; cursor: default; box-shadow: none; }
    .go-kbd {
      position: absolute; right: 10px; padding: 2px 5px; border-radius: 5px;
      border: 1px solid rgba(246, 240, 227, .16); background: rgba(246, 240, 227, .12);
      font-family: var(--font); font-size: 9.5px; font-weight: 600; letter-spacing: .02em;
      color: rgba(246, 240, 227, .75);
    }

    .results {
      flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px 14px;
      scrollbar-width: thin; scrollbar-color: #DED5C4 transparent;
    }
    .results::-webkit-scrollbar { width: 8px; }
    .results::-webkit-scrollbar-thumb {
      background: #E5DCCB; border-radius: 99px;
      border: 2px solid transparent; background-clip: content-box;
    }
    .results::-webkit-scrollbar-thumb:hover { background: #D6CBB6; border: 2px solid transparent; background-clip: content-box; }

    .detected {
      display: inline-flex; align-items: center; gap: 6px; margin: 0 2px 10px;
      padding: 4px 10px 4px 8px; border-radius: 99px; border: 1px solid var(--line);
      background: var(--surface-2); font-size: 10.5px; color: var(--ink-2);
    }
    .detected b { color: var(--accent-ink); font-weight: 650; }
    .detected svg { width: 12px; height: 12px; color: var(--accent-2); flex: none; }

    .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 22px 16px 26px; }
    .empty-ico {
      width: 46px; height: 46px; border-radius: 15px; display: grid; place-items: center; margin-bottom: 12px;
      background: linear-gradient(145deg, #F9F4E8, #F0E8D8); border: 1px solid #E9E0CE; color: #3A352C;
      box-shadow: 0 1px 0 rgba(255, 255, 255, .9) inset, 0 8px 16px -10px rgba(35, 30, 22, .28);
    }
    .empty-ico svg { width: 20px; height: 20px; }
    .empty b { font-size: 12.5px; font-weight: 650; letter-spacing: -.005em; color: var(--ink-2); }
    .empty p { margin-top: 5px; max-width: 252px; font-size: 11.5px; line-height: 1.6; color: var(--ink-3); }

    .loading { padding: 2px 2px 0; }
    .load-line {
      display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
      font-size: 10.5px; font-weight: 600; letter-spacing: .01em; color: var(--ink-3);
    }
    .spinner {
      width: 13px; height: 13px; border-radius: 50%;
      border: 2px solid #EDE5D5; border-top-color: var(--accent);
      animation: rot .7s linear infinite;
    }
    @keyframes rot { to { transform: rotate(360deg); } }
    .sk-card {
      border: 1px solid var(--line); border-radius: 13px; padding: 13px 14px;
      margin-bottom: 8px; background: var(--surface);
    }
    .sk {
      height: 9px; border-radius: 5px;
      background: linear-gradient(90deg, #F1EADB 25%, #FBF6EC 50%, #F1EADB 75%);
      background-size: 200% 100%; animation: shimmer 1.4s ease-in-out infinite;
    }
    @keyframes shimmer { from { background-position: 180% 0; } to { background-position: -80% 0; } }

    .err {
      padding: 13px 14px; border-radius: 13px; border: 1px solid #EFD9D2;
      background: #FBF4F1; color: #93433A; font-size: 12px; line-height: 1.6;
    }
    .err b { font-weight: 650; }
    .err button {
      margin-top: 9px; padding: 6px 11px; border: 1px solid #E5C9C1; border-radius: 8px;
      background: #FFFDF8; color: #93433A; font-family: var(--font); font-size: 11px;
      font-weight: 600; cursor: pointer; transition: background .15s;
    }
    .err button:hover { background: #F7E9E5; }

    .card {
      background: var(--surface); border: 1px solid var(--line); border-radius: 13px;
      padding: 12px 13px; margin-bottom: 8px; box-shadow: var(--shadow-card);
      transition: border-color .15s, box-shadow .15s;
    }
    .card:hover { border-color: #DCD2C1; box-shadow: 0 10px 24px -14px rgba(35, 30, 22, .35); }
    .card:last-child { margin-bottom: 0; }
    .chip {
      display: inline-flex; align-items: center; padding: 3px 7px; border-radius: 6px;
      background: var(--accent-soft); color: var(--accent-ink);
      font-size: 8.5px; font-weight: 700; letter-spacing: .075em; text-transform: uppercase;
    }
    .card p.txt {
      margin-top: 8px; font-size: 13px; line-height: 1.65; color: var(--ink);
      white-space: pre-wrap; word-wrap: break-word;
    }
    .exps { margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--line); list-style: none; }
    .exps li { display: flex; gap: 7px; align-items: flex-start; margin-top: 5px; font-size: 11px; line-height: 1.55; color: var(--ink-2); }
    .exps li:first-child { margin-top: 0; }
    .exps li::before {
      content: ''; flex: none; width: 4px; height: 4px; border-radius: 50%;
      background: var(--accent-2); margin-top: 6px;
    }

    .acts { display: flex; gap: 2px; justify-content: flex-end; margin-top: 7px; }
    .ic {
      width: 27px; height: 27px; border: none; border-radius: 7px; background: transparent;
      color: var(--ink-3); cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: background .15s, color .15s, opacity .15s;
    }
    .card .acts .ic { opacity: .75; }
    .card:hover .acts .ic, .card .acts .ic:focus-visible { opacity: 1; }
    .ic:hover { background: var(--accent-soft); color: var(--accent-ink); }
    .ic.speaking { background: var(--accent-soft); color: var(--accent-ink); }
    .ic svg { width: 14px; height: 14px; pointer-events: none; }

    .def-word { font-size: 21px; font-weight: 650; letter-spacing: -.02em; color: var(--ink); }
    .def-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .def-p { margin-top: 7px; font-size: 12.5px; line-height: 1.65; color: var(--ink-2); }
    .lbl {
      display: flex; align-items: center; gap: 6px; margin: 14px 0 7px;
      font-size: 8.5px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; color: var(--ink-3);
    }
    .syns { display: flex; flex-wrap: wrap; gap: 5px; }
    .syn {
      padding: 4px 10px; border: 1px solid var(--line-2); border-radius: 99px;
      background: var(--surface); color: var(--ink-2); font-family: var(--font);
      font-size: 11px; cursor: pointer; transition: background .15s, color .15s, border-color .15s;
    }
    .syn:hover { border-color: #C9BEA9; color: var(--accent-ink); background: var(--accent-soft); }
    .usage {
      margin-top: 3px; padding: 10px 12px; border-radius: 10px;
      border: 1px solid var(--line); border-left: 2px solid #C2B59E; background: var(--surface-2);
    }
    .usage p { font-size: 12px; font-style: italic; line-height: 1.6; color: var(--ink-2); }

    .coach-top { display: grid; grid-template-columns: 122px 1fr; gap: 8px; margin-bottom: 8px; }
    .score-card {
      border: 1px solid var(--line); border-radius: 13px; background: var(--surface);
      padding: 12px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px;
      box-shadow: var(--shadow-card);
    }
    .score-card .lbl { margin: 0; }
    .ring { position: relative; width: 76px; height: 76px; }
    .ring svg { width: 76px; height: 76px; transform: rotate(-90deg); }
    .ring circle { fill: none; stroke-width: 6.5; stroke-linecap: round; }
    .ring .bg { stroke: #EFE7D8; }
    .ring .fg { transition: stroke-dashoffset .9s cubic-bezier(.2, .8, .2, 1); }
    .ring span {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 21px; font-weight: 650; letter-spacing: -.02em; color: var(--ink);
    }
    .tone-card {
      position: relative; overflow: hidden; display: flex; flex-direction: column;
      justify-content: space-between; padding: 12px 13px; border-radius: 13px; color: var(--cream);
      background: linear-gradient(135deg, #2C2821 0%, #17140F 58%, #0B0A08 100%);
      box-shadow: 0 10px 22px -12px rgba(17, 15, 11, .75);
    }
    .tone-card::before, .tone-card::after { content: ''; position: absolute; border-radius: 50%; background: rgba(246, 240, 227, .10); }
    .tone-card::before { width: 120px; height: 120px; top: -56px; right: -40px; }
    .tone-card::after { width: 64px; height: 64px; bottom: -30px; left: -18px; background: rgba(246, 240, 227, .07); }
    .tone-card .lbl { position: relative; margin: 0; color: rgba(246, 240, 227, .62); }
    .tone-card strong {
      position: relative; font-size: 16px; font-weight: 600;
      letter-spacing: -.01em; text-transform: capitalize;
    }
    .sec {
      border: 1px solid var(--line); border-radius: 13px; background: var(--surface);
      padding: 12px 13px; margin-bottom: 8px; box-shadow: var(--shadow-card);
    }
    .sec:last-child { margin-bottom: 0; }
    .sec .lbl { margin: 0 0 9px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
    .item { display: flex; gap: 8px; align-items: flex-start; margin-top: 7px; }
    .item:first-of-type { margin-top: 0; }
    .badge {
      flex: none; width: 17px; height: 17px; border-radius: 6px; margin-top: 1px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 800;
    }
    .badge svg { width: 10px; height: 10px; }
    .badge.g { background: #EDF1E4; color: #5E7150; }
    .badge.a { background: #F8EFDC; color: #9C7429; }
    .item p { font-size: 12px; line-height: 1.6; color: var(--ink-2); }

    .toast {
      position: fixed; z-index: ${Z}; left: 50%; bottom: 24px;
      transform: translateX(-50%) translateY(10px); opacity: 0; pointer-events: none;
      display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px);
      padding: 9px 10px 9px 14px; border-radius: 11px;
      background: #16130F; color: var(--cream); font-size: 12px; line-height: 1.45;
      box-shadow: 0 16px 40px -12px rgba(17, 15, 11, .6), 0 0 0 1px rgba(246, 240, 227, .10);
      transition: opacity .2s ease, transform .2s cubic-bezier(.2, .8, .2, 1);
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }
    .toast span { flex: 1; }
    .toast button {
      flex: none; border: none; border-radius: 7px; padding: 5px 11px; cursor: pointer;
      background: var(--cream); color: #171512; font-family: var(--font); font-size: 11px;
      font-weight: 650; transition: background .15s;
    }
    .toast button:hover { background: #FFFDF8; }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
    }
  `;


  const ICON_LOGO = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.6c.3 0 .57.2.65.49l1.5 5.06a2 2 0 0 0 1.35 1.35l5.06 1.5a.68.68 0 0 1 0 1.3l-5.06 1.5a2 2 0 0 0-1.35 1.35l-1.5 5.06a.68.68 0 0 1-1.3 0l-1.5-5.06a2 2 0 0 0-1.35-1.35l-5.06-1.5a.68.68 0 0 1 0-1.3l5.06-1.5a2 2 0 0 0 1.35-1.35l1.5-5.06a.68.68 0 0 1 .65-.49Z"/><path d="M18.5 16.2c.14 0 .27.09.31.23l.5 1.7c.07.25.27.45.52.52l1.7.5a.32.32 0 0 1 0 .62l-1.7.5a.8.8 0 0 0-.52.52l-.5 1.7a.32.32 0 0 1-.62 0l-.5-1.7a.8.8 0 0 0-.52-.52l-1.7-.5a.32.32 0 0 1 0-.62l1.7-.5a.8.8 0 0 0 .52-.52l.5-1.7a.32.32 0 0 1 .31-.23Z" opacity=".85"/></svg>`;
  const ICON_GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const ICON_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  const ICON_CONTEXT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>`;
  const ICON_GLOBE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
  const ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
  const ICON_SPEAK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
  const ICON_SWAP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>`;
  const ICON_SPARK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>`;
  const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  // ------------------------------------------------------------------- boot

  chrome.storage.sync.get({
    sourceLang: 'Auto-detect', targetLang: 'Nepali', showBubble: true,
    smartContext: true, provider: 'gemini', openaiBaseUrl: 'https://api.openai.com/v1',
    iconTheme: 'black'
  }, (s) => {
    Object.assign(settings, s);
    curSource = settings.sourceLang;
    curTarget = settings.targetLang;
    updateCtxBtn();
    updateProviderLabel();
    if (settings.showBubble) mount();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.sourceLang) { settings.sourceLang = changes.sourceLang.newValue; curSource = settings.sourceLang; }
      if (changes.targetLang) { settings.targetLang = changes.targetLang.newValue; curTarget = settings.targetLang; }
      if (changes.smartContext) { settings.smartContext = changes.smartContext.newValue; updateCtxBtn(); }
      if (changes.provider) { settings.provider = changes.provider.newValue; updateProviderLabel(); }
      if (changes.openaiBaseUrl) { settings.openaiBaseUrl = changes.openaiBaseUrl.newValue; updateProviderLabel(); }
      if (changes.iconTheme) { settings.iconTheme = changes.iconTheme.newValue; applyBubbleTheme(); }
      if (changes.showBubble) {
        settings.showBubble = changes.showBubble.newValue;
        if (settings.showBubble) mount(); else unmountBubble();
      }
      syncSelects();
    } else if (area === 'local' && changes.bubblePos && host) {
      applyPos(changes.bubblePos.newValue);
    }
  });

  // ------------------------------------------------------------ mount/unmount

  function mount() {
    if (host) {
      if (settings.showBubble) bubble.style.display = 'flex'; // re-enabled after being hidden
      return;
    }
    host = document.createElement('div');
    host.id = HOST_ID;
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.title = 'AI Writer Assistant\n\nClick: open panel\nDrag: move\nRight-click: hide';
    bubble.setAttribute('role', 'button');
    bubble.setAttribute('aria-label', 'Open AI Writer Assistant');
    bubble.setAttribute('aria-expanded', 'false');
    bubble.tabIndex = 0;
    bubble.innerHTML = ICON_LOGO;
    root.appendChild(bubble);

    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    root.appendChild(toastEl);

    document.documentElement.appendChild(host);
    wireBubble();
    applyBubbleTheme();
    if (!settings.showBubble) bubble.style.display = 'none'; // host mounted for the panel only

    chrome.storage.local.get({ bubblePos: null }, (s) => {
      applyPos(s.bubblePos);
    });
  }

  // Applies the selected color theme to the in-page bubble and panel logo.
  function applyBubbleTheme() {
    if (!bubble) return;
    const t = BUBBLE_THEMES[settings.iconTheme] || BUBBLE_THEMES.black;
    bubble.style.setProperty('--bbg', t.bg);
    bubble.style.setProperty('--bsh', t.shadow);
    bubble.style.color = t.fg || '#fff';
    bubble.classList.toggle('has-ring', !!t.ring);
    const logo = panel && panel.querySelector('.logo');
    if (logo) {
      logo.style.background = t.bg;
      logo.style.color = t.fg || '#fff';
    }
  }

  function unmountBubble() {
    if (bubble) bubble.style.display = 'none';
    closePanel();
  }

  function applyPos(pos) {
    if (!bubble) return;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      curX = pos.x; curY = pos.y;
    } else {
      curX = Math.max(8, window.innerWidth - BUBBLE - 24);
      curY = Math.max(8, Math.round(window.innerHeight * 0.7));
    }
    clampPos();
    bubble.style.left = curX + 'px';
    bubble.style.top = curY + 'px';
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
  }

  function clampPos() {
    curX = Math.min(Math.max(4, curX), Math.max(4, window.innerWidth - BUBBLE - 4));
    curY = Math.min(Math.max(4, curY), Math.max(4, window.innerHeight - BUBBLE - 4));
  }

  // ------------------------------------------------------------------ bubble

  function wireBubble() {
    let drag = null;

    bubble.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = bubble.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      bubble.classList.add('dragging');
      try { bubble.setPointerCapture(e.pointerId); } catch (_) {}
    });

    bubble.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
      if (drag.moved) {
        curX = drag.ox + dx; curY = drag.oy + dy;
        clampPos();
        bubble.style.left = curX + 'px';
        bubble.style.top = curY + 'px';
        if (panelOpen) positionPanel();
      }
    });

    bubble.addEventListener('pointerup', (e) => {
      const d = drag; drag = null;
      bubble.classList.remove('dragging');
      try { bubble.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!d) return;
      if (d.moved) {
        chrome.storage.local.set({ bubblePos: { x: curX, y: curY } });
      } else if (panelOpen) {
        closePanel();
      } else {
        openPanel({ autoTranslate: true });
      }
    });

    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      settings.showBubble = false;
      chrome.storage.sync.set({ showBubble: false }); // onChanged → unmounts bubble
      showToast('Bubble hidden. Enable it again in the extension options.', {
        undo: () => { settings.showBubble = true; chrome.storage.sync.set({ showBubble: true }); }
      });
    });

    bubble.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (panelOpen) closePanel();
        else openPanel({ autoTranslate: true });
      }
    });
  }

  // ------------------------------------------------------------------- panel

  function buildPanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="head">
        <div class="brand">
          <div class="logo">${ICON_LOGO}</div>
          <div class="title">AI Writer<small id="aiwa-provider">Gemini</small></div>
        </div>
        <div class="head-actions">
          <button class="hbtn ctxbtn on" title="Smart context: include page title, site and nearby text for better results">${ICON_CONTEXT}</button>
          <button class="hbtn gear" title="Settings" aria-label="Settings">${ICON_GEAR}</button>
          <button class="hbtn close" title="Close (Esc)" aria-label="Close">${ICON_X}</button>
        </div>
      </div>
      <div class="tabs" role="tablist">${TABS.map((t) => `<button class="tab" role="tab" aria-selected="false" data-tab="${t.id}">${t.label}</button>`).join('')}</div>
      <div class="body">
        <textarea class="input" aria-label="Text to process" placeholder="Select text on the page or paste it here…" spellcheck="false" rows="3"></textarea>
        <div class="controls"></div>
        <button class="go"><span class="go-label">Translate</span><kbd class="go-kbd"></kbd></button>
        <div class="results" id="aiwa-results" role="tabpanel" aria-live="polite"></div>
      </div>
    `;
    root.appendChild(panel);

    input = panel.querySelector('.input');
    controlsEl = panel.querySelector('.controls');
    resultsEl = panel.querySelector('.results');
    primaryBtn = panel.querySelector('.go');
    tabsEl = panel.querySelectorAll('.tab');
    ctxBtn = panel.querySelector('.ctxbtn');

    panel.querySelector('.go-kbd').textContent =
      /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘ ↵' : 'Ctrl ↵';
    panel.querySelector('.close').addEventListener('click', closePanel);
    panel.querySelector('.gear').addEventListener('click', openOptions);
    ctxBtn.addEventListener('click', () => {
      settings.smartContext = !settings.smartContext;
      chrome.storage.sync.set({ smartContext: settings.smartContext }); // storage change updates UI
    });
    primaryBtn.addEventListener('click', () => runTask(activeTab));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runTask(activeTab); }
    });
    input.addEventListener('input', autoGrow);

    tabsEl.forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
    resultsEl.addEventListener('click', onResultsClick);

    updateCtxBtn();
    updateProviderLabel();
    applyBubbleTheme();
    setTab(activeTab);
  }

  function autoGrow() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(160, Math.max(70, input.scrollHeight)) + 'px';
  }

  function setTab(id) {
    activeTab = id;
    tabsEl.forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    const tab = TABS.find((t) => t.id === id);

    primaryBtn.querySelector('.go-label').textContent = tab.btn;
    controlsEl.innerHTML = '';
    syncSelects();
    renderResults();
  }

  function syncSelects() {
    if (!controlsEl) return;
    if (activeTab === 'translate') {
      controlsEl.innerHTML = `
        <select class="sel" id="aiwa-src" title="Source language">
          ${['Auto-detect', ...LANGS].map((l) => `<option value="${l}" ${l === curSource ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="swap" title="Swap languages">${ICON_SWAP}</button>
        <select class="sel" id="aiwa-tgt" title="Target language">
          ${LANGS.map((l) => `<option value="${l}" ${l === curTarget ? 'selected' : ''}>${l}</option>`).join('')}
        </select>`;
      controlsEl.querySelector('#aiwa-src').addEventListener('change', (e) => { curSource = e.target.value; });
      controlsEl.querySelector('#aiwa-tgt').addEventListener('change', (e) => { curTarget = e.target.value; });
      controlsEl.querySelector('.swap').addEventListener('click', () => {
        const a = curSource === 'Auto-detect' ? 'English' : curSource; // best guess when auto
        curSource = curTarget;
        curTarget = a;
        syncSelects();
      });
    } else if (activeTab === 'reword') {
      controlsEl.innerHTML = `
        <select class="sel" id="aiwa-tone" title="Tone">
          ${TONES.map((t) => `<option value="${t}" ${t === curTone ? 'selected' : ''}>${t} tone</option>`).join('')}
        </select>`;
      controlsEl.querySelector('#aiwa-tone').addEventListener('change', (e) => { curTone = e.target.value; });
    }
  }

  // ----------------------------------------------------------- smart context

  // Captures page metadata plus the text surrounding the active selection.
  function captureContext(sel) {
    let surrounding = '';
    try {
      const s = window.getSelection();
      if (s && s.rangeCount && s.anchorNode && sel) {
        let block = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
        while (block && block !== document.body &&
               !/^(P|DIV|LI|BLOCKQUOTE|TD|TH|H[1-6]|SECTION|ARTICLE|MAIN|ASIDE|FIGCAPTION|PRE)$/i.test(block.tagName)) {
          block = block.parentElement;
        }
        if (block) {
          const full = (block.textContent || '').replace(/\s+/g, ' ').trim();
          if (full && full !== sel) {
            const probe = sel.slice(0, 40);
            const idx = full.indexOf(probe);
            if (idx !== -1) {
              const before = full.slice(Math.max(0, idx - 220), idx);
              const after = full.slice(idx + sel.length, idx + sel.length + 220);
              surrounding = (before ? before + ' … ' : '') + (after ? '… ' + after : '');
            } else {
              surrounding = full.slice(0, 440);
            }
          }
        }
      }
    } catch (_) { /* context is best-effort */ }
    return {
      pageTitle: (document.title || '').slice(0, 120),
      domain: location.hostname || '',
      pageLang: ((document.documentElement && document.documentElement.lang) || '').slice(0, 12),
      surrounding: surrounding.slice(0, 500)
    };
  }

  // Unambiguous script detection (used only to avoid no-op translations such
  // as Japanese→Japanese; Latin/Devanagari are too ambiguous to guess).
  function detectScriptLang(t) {
    if (!t) return null;
    if (/[\u3040-\u30ff]/.test(t)) return 'Japanese';   // kana
    if (/[\u4e00-\u9fff]/.test(t)) return 'Chinese';    // han only
    return null;
  }

  function updateCtxBtn() {
    if (!ctxBtn) return;
    ctxBtn.classList.toggle('on', !!settings.smartContext);
    ctxBtn.title = settings.smartContext
      ? 'Smart context ON — page title, site and nearby text are sent for better results. Click to disable.'
      : 'Smart context OFF — only the selected text is sent. Click to enable.';
  }

  function updateProviderLabel() {
    if (!panel) return;
    const small = panel.querySelector('#aiwa-provider');
    if (!small) return;
    if (settings.provider === 'openai') {
      let host = 'OpenAI-compatible';
      try { host = new URL(settings.openaiBaseUrl || 'https://api.openai.com/v1').hostname; } catch (_) {}
      small.textContent = host;
    } else {
      small.textContent = 'Gemini';
    }
  }

  function positionPanel() {    if (!panel || !bubble) return;
    panel.style.visibility = 'hidden';
    panel.style.display = 'flex';

    const b = bubble.getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    let x, y;

    if (b.left + b.width + 12 + pw < window.innerWidth - 8) x = b.right + 12;
    else x = b.left - 12 - pw;
    if (x < 8) x = Math.max(8, Math.min(window.innerWidth - pw - 8, b.left));

    y = b.top;
    y = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - ph - 8));

    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.visibility = 'visible';
  }

  function openPanel(opts) {
    opts = opts || {};
    if (!host) mount();
    if (!panel) buildPanel();

    panelOpen = true;
    updateBubbleState();
    if (lastSelection) input.value = lastSelection;
    autoGrow();
    positionPanel();
    requestAnimationFrame(positionPanel);
    if (opts.autoTranslate && activeTab === 'translate' && input.value.trim() && lastSelection && lastSelection !== lastAutoKey) {
      // Smart flip: avoid translating a language into itself (unambiguous scripts only)
      const dsl = detectScriptLang(input.value);
      if (dsl && dsl === curTarget) {
        curTarget = 'English';
        syncSelects();
      }
      lastAutoKey = lastSelection;
      runTask('translate');
    }
    try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
  }

  function closePanel() {
    const wasOpen = panelOpen;
    panelOpen = false;
    updateBubbleState();
    if (panel) panel.style.display = 'none';
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    clearSpeakState();
    if (wasOpen && bubble && settings.showBubble) {
      try { bubble.focus({ preventScroll: true }); } catch (_) { /* focus is best-effort */ }
    }
  }

  function updateBubbleState() {
    if (!bubble) return;
    bubble.classList.toggle('is-open', panelOpen);
    bubble.setAttribute('aria-expanded', String(panelOpen));
    bubble.setAttribute('aria-label', panelOpen ? 'Close AI Writer Assistant' : 'Open AI Writer Assistant');
    bubble.title = panelOpen
      ? 'AI Writer Assistant\n\nClick: close panel\nDrag: move\nRight-click: hide'
      : 'AI Writer Assistant\n\nClick: open panel\nDrag: move\nRight-click: hide';
  }

  // ------------------------------------------------------------------- tasks

  function buildPayload(task, text) {
    const ctx = settings.smartContext && lastCtx ? lastCtx : null;
    if (task === 'translate') return { text, sourceLang: curSource, targetLang: curTarget, pageContext: ctx };
    if (task === 'reword') return { text, tone: curTone, pageContext: ctx };
    if (task === 'define') {
      const words = text.trim().split(/\s+/);
      const word = words.length <= 4 ? text.trim() : words[0];
      const context = (ctx && ctx.surrounding) || lastSelection || text;
      return { word, context, pageContext: ctx };
    }
    return { text, pageContext: ctx };
  }

  function runTask(task) {
    const text = (input.value || '').trim();
    if (!text) {
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
      input.focus();
      return;
    }
    busy[task] = true;
    if (task === activeTab) renderResults();

    chrome.runtime.sendMessage({ type: 'GEMINI_TASK', task, payload: buildPayload(task, text) })
      .then((res) => {
        busy[task] = false;
        if (!res) results[task] = { error: 'No response from the extension. Try reloading the page.' };
        else if (!res.ok) results[task] = { error: res.error || 'Request failed.' };
        else results[task] = { data: res.data };
        if (task === activeTab) renderResults();
      })
      .catch((err) => {
        busy[task] = false;
        results[task] = { error: (err && err.message) || String(err) };
        if (task === activeTab) renderResults();
      });
  }

  // ----------------------------------------------------------------- results

  function renderResults() {
    if (!resultsEl) return;
    renderResultsInner();
    if (panelOpen) requestAnimationFrame(() => { if (panelOpen) positionPanel(); });
  }

  function renderResultsInner() {
    const task = activeTab;
    const state = results[task];

    if (busy[task]) {
      const labels = { translate: 'Translating…', grammar: 'Fixing…', reword: 'Rewording…', define: 'Looking up…', coach: 'Analyzing…' };
      resultsEl.innerHTML = `
        <div class="loading">
          <div class="load-line"><span class="spinner"></span>${labels[task] || 'Working…'}</div>
          <div class="sk-card">
            <div class="sk" style="width:24%"></div>
            <div class="sk" style="width:94%;margin-top:10px"></div>
            <div class="sk" style="width:62%;margin-top:7px"></div>
          </div>
          <div class="sk-card">
            <div class="sk" style="width:18%"></div>
            <div class="sk" style="width:88%;margin-top:10px"></div>
            <div class="sk" style="width:48%;margin-top:7px"></div>
          </div>
        </div>`;
      return;
    }

    if (!state) {
      const hints = {
        translate: { t: 'Ready to translate', d: 'Select text on any page and tap the bubble — it translates instantly.' },
        grammar: { t: 'Polish your writing', d: 'Select or paste text, then run Fix Grammar for corrections with explanations.' },
        reword: { t: 'Find the right tone', d: 'Pick a tone and get three fresh ways to say the same thing.' },
        define: { t: 'Look up a word', d: 'Select a word on the page and run Define for meaning, synonyms and usage.' },
        coach: { t: 'Get writing feedback', d: 'Run Analyze for a clarity score, detected tone, strengths and fixes.' }
      };
      const h = hints[task] || { t: 'Ready', d: '' };
      resultsEl.innerHTML = `
        <div class="empty">
          <div class="empty-ico">${ICON_SPARK}</div>
          <b>${h.t}</b>
          <p>${h.d}</p>
        </div>`;
      return;
    }

    if (state.error) {
      resultsEl.innerHTML = `<div class="err"><b>Something went wrong.</b><br>${esc(state.error)}<button data-act="settings">Open settings</button></div>`;
      return;
    }

    if (task === 'translate') resultsEl.innerHTML = renderTranslate(state.data);
    else if (task === 'grammar' || task === 'reword') resultsEl.innerHTML = renderOptions(state.data);
    else if (task === 'define') resultsEl.innerHTML = renderDefine(state.data);
    else if (task === 'coach') resultsEl.innerHTML = renderCoach(state.data);
  }

  function renderTranslate(data) {
    const options = (data && data.options) || [];
    if (!options.length) return `<div class="empty"><div class="empty-ico">${ICON_SPARK}</div><b>No translation returned</b><p>Try a different selection or run it again.</p></div>`;
    const det = (curSource === 'Auto-detect' && data.sourceLanguage)
      ? `<div class="detected">${ICON_GLOBE}Detected <b>${esc(data.sourceLanguage)}</b></div>`
      : '';
    return det + options.map((o, i) => `
      <div class="card">
        <span class="chip">${esc(o.nuance || 'Option ' + (i + 1))}</span>
        <p class="txt">${esc(o.text)}</p>
        <div class="acts">
          <button class="ic" data-act="speak" data-i="${i}" data-task="translate" title="Listen">${ICON_SPEAK}</button>
          <button class="ic" data-act="copy" data-i="${i}" data-task="translate" title="Copy">${ICON_COPY}</button>
        </div>
      </div>`).join('');
  }

  function renderOptions(data) {
    const options = (data && data.options) || [];
    if (!options.length) return `<div class="empty"><div class="empty-ico">${ICON_SPARK}</div><b>No suggestions returned</b><p>Try rewriting the input or run it again.</p></div>`;
    return options.map((o, i) => `
      <div class="card">
        ${options.length > 1 ? `<span class="chip">${i === 0 ? 'Suggested' : 'Alt ' + i}</span>` : ''}
        <p class="txt" style="${i === 0 && options.length > 1 ? 'font-weight:600;' : ''}">${esc(o.text)}</p>
        ${(o.explanations || []).length ? `<ul class="exps">${o.explanations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <div class="acts">
          <button class="ic" data-act="speak" data-i="${i}" data-task="${activeTab}" title="Listen">${ICON_SPEAK}</button>
          <button class="ic" data-act="copy" data-i="${i}" data-task="${activeTab}" title="Copy">${ICON_COPY}</button>
        </div>
      </div>`).join('');
  }

  function renderDefine(data) {
    if (!data || !data.word) return `<div class="empty"><div class="empty-ico">${ICON_SPARK}</div><b>No definition returned</b><p>Try selecting a single word.</p></div>`;
    const syns = (data.synonyms || []);
    return `
      <div class="card">
        <div class="def-row">
          <div class="def-word">${esc(data.word)}</div>
          <button class="ic" data-act="speak-word" title="Listen">${ICON_SPEAK}</button>
        </div>
        <p class="def-p">${esc(data.definition)}</p>
        ${syns.length ? `<div class="lbl">Synonyms · tap to look up</div><div class="syns">${syns.map((s) => `<button class="syn" data-act="syn" data-word="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
        ${data.usageExample ? `<div class="lbl">Usage</div><div class="usage"><p>“${esc(data.usageExample)}”</p></div>` : ''}
      </div>`;
  }

  function renderCoach(data) {
    if (!data || typeof data.score !== 'number') return `<div class="empty"><div class="empty-ico">${ICON_SPARK}</div><b>No analysis returned</b><p>Try a longer passage or run it again.</p></div>`;
    const score = Math.max(0, Math.min(100, Math.round(data.score)));
    const color = score > 80 ? '#667A54' : score > 50 ? '#A57A2C' : '#A34C41';
    const C = 2 * Math.PI * 30;
    const strengths = data.strengths || [];
    const suggestions = data.suggestions || [];
    return `
      <div class="coach-top">
        <div class="score-card">
          <div class="lbl">Clarity</div>
          <div class="ring">
            <svg viewBox="0 0 76 76">
              <circle class="bg" cx="38" cy="38" r="30"></circle>
              <circle class="fg" cx="38" cy="38" r="30" stroke="${color}"
                stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C - (C * score) / 100).toFixed(1)}"></circle>
            </svg>
            <span>${score}</span>
          </div>
        </div>
        <div class="tone-card">
          <div class="lbl">Detected tone</div>
          <strong>${esc(data.tone || '—')}</strong>
        </div>
      </div>
      ${strengths.length ? `<div class="sec"><div class="lbl"><span class="dot" style="background:#667A54"></span>Key strengths</div>
        ${strengths.map((s) => `<div class="item"><span class="badge g">${ICON_CHECK}</span><p>${esc(s)}</p></div>`).join('')}</div>` : ''}
      ${suggestions.length ? `<div class="sec"><div class="lbl"><span class="dot" style="background:#A57A2C"></span>Suggestions</div>
        ${suggestions.map((s) => `<div class="item"><span class="badge a">!</span><p>${esc(s)}</p></div>`).join('')}</div>` : ''}`;
  }

  // ------------------------------------------------------- results interactions

  function onResultsClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'settings') {
      openOptions();
    } else if (act === 'copy') {
      const text = getTextFor(btn);
      copyText(text).then(() => {
        btn.innerHTML = ICON_CHECK;
        setTimeout(() => { btn.innerHTML = ICON_COPY; }, 1200);
      });
    } else if (act === 'speak') {
      const task = btn.dataset.task;
      const i = parseInt(btn.dataset.i, 10) || 0;
      const d = results[task] && results[task].data;
      const opt = d && d.options && d.options[i];
      const lang = task === 'translate' ? curTarget : 'English';
      if (opt) toggleSpeak(opt.text, BCP47[lang] || 'en-US', btn);
    } else if (act === 'speak-word') {
      const d = results.define && results.define.data;
      if (d) toggleSpeak(`${d.word}. ${d.definition}`, 'en-US', btn);
    } else if (act === 'syn') {
      const w = btn.dataset.word;
      if (w) {
        input.value = w;
        lastSelection = w;
        autoGrow();
        runTask('define');
      }
    }
  }

  function getTextFor(btn) {
    const task = btn.dataset.task;
    const i = parseInt(btn.dataset.i, 10) || 0;
    const d = results[task] && results[task].data;
    if (d && d.options && d.options[i]) return d.options[i].text || '';
    return '';
  }

  function openOptions() {
    try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }); } catch (_) { /* extension context is gone */ }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }

  // ------------------------------------------------------------------ speech

  function clearSpeakState() {
    if (speakBtn) {
      speakBtn.classList.remove('speaking');
      speakBtn = null;
    }
  }

  function toggleSpeak(text, lang, btn) {
    if (!('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;

    if (synth.speaking || synth.pending) {
      synth.cancel();
      const wasBtn = speakBtn === btn;
      clearSpeakState();
      if (wasBtn) return; // second click = stop
    }

    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 1;
    u.onend = u.onerror = () => clearSpeakState();
    speakBtn = btn;
    btn.classList.add('speaking');
    synth.speak(u);
  }

  // ------------------------------------------------------------------- toast

  function showToast(message, opts) {
    if (!toastEl) return;
    opts = opts || {};
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span>${esc(message)}</span>` + (opts.undo ? `<button>Undo</button>` : '');
    if (opts.undo) {
      toastEl.querySelector('button').addEventListener('click', () => {
        opts.undo();
        toastEl.classList.remove('show');
      });
    }
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => { toastEl.classList.remove('show'); }, 6000);
  }

  // -------------------------------------------------------------- global wiring

  // Track page selections so the bubble can auto-fill, and capture smart context.
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      let s = '';
      try { s = String(window.getSelection() || ''); } catch (_) {}
      s = s.trim();
      if (s) {
        lastSelection = s.length > MAX_SEL ? s.slice(0, MAX_SEL) : s;
        lastCtx = captureContext(lastSelection);
      }
    }, 200);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) {
      closePanel();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener('resize', () => {
    if (bubble && settings.showBubble) {
      clampPos();
      bubble.style.left = curX + 'px';
      bubble.style.top = curY + 'px';
    }
    if (panelOpen) positionPanel();
  });

  // Toolbar icon → TOGGLE_PANEL (from background service worker).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'TOGGLE_PANEL') {
      if (panelOpen) closePanel();
      else openPanel({ autoTranslate: true });
      sendResponse({ ok: true });
    }
    return undefined;
  });
})();

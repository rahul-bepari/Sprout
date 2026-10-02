'use strict';
/* =============================================================================
   SPROUT — a spaced-repetition debugging trainer
   Single-file app logic, organized into sections:
     1. UTIL          small shared helpers
     2. DB            IndexedDB wrapper for per-challenge progress
     3. SM2           spaced-repetition scheduler, implemented from the paper
     4. EDITOR        hand-rolled tokenizer + syntax highlighter + contentEditable
     5. SANDBOX       sandboxed iframe execution engine with a timeout watchdog
     6. ANALYTICS     hand-drawn canvas skill-radar chart
     7. PWA           service worker registration
     8. APP           wires everything together
   ============================================================================= */

/* =============================================================================
   1. UTIL
   ============================================================================= */
const UTIL = (() => {
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    if (typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every((k) => deepEqual(a[k], b[k]));
    }
    return false;
  }

  function fmtRelative(ts) {
    const diff = ts - Date.now();
    const day = 86400000;
    if (diff <= 0) return 'due now';
    const days = Math.round(diff / day);
    if (days <= 0) return 'due today';
    if (days === 1) return 'due tomorrow';
    return `due in ${days}d`;
  }

  function safeJSON(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast is-visible' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('is-visible'); }, 3200);
  }

  return { clamp, deepEqual, fmtRelative, safeJSON, toast };
})();

/* =============================================================================
   2. DB — IndexedDB wrapper
   One object store, "progress", keyed by challengeId. Each record holds the
   SM-2 scheduling fields plus a short history log used by the analytics view.
   All calls return Promises so the rest of the app never touches IDBRequest
   objects directly.
   ============================================================================= */
const DB = (() => {
  const NAME = 'sprout-db';
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'challengeId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function getProgress(challengeId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('progress', 'readonly');
      const r = tx.objectStore('progress').get(challengeId);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  }

  async function getAllProgress() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('progress', 'readonly');
      const r = tx.objectStore('progress').getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  async function putProgress(record) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('progress', 'readwrite');
      tx.objectStore('progress').put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  return { getProgress, getAllProgress, putProgress };
})();

/* =============================================================================
   3. SM2 — SuperMemo-2 spaced repetition, implemented from scratch
   Same formula Anki's original algorithm is based on:
     EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02)),  floored at 1.3
     q < 3   -> repetition resets to 0, interval = 1 day (the concept slipped)
     q >= 3  -> repetition increments; interval = 1, then 6, then interval*EF
   "Quality" (0-5) isn't rated by the user here — Sprout derives it from how
   the practice session actually went (see APP.qualityFromAttempt), which
   keeps the loop fast while still feeding SM-2 a meaningful signal.
   ============================================================================= */
const SM2 = (() => {
  function initialState(challengeId) {
    return {
      challengeId,
      repetition: 0,
      easiness: 2.5,
      intervalDays: 0,
      nextReviewAt: Date.now(),   // brand new cards are due immediately
      lastQuality: null,
      totalAttempts: 0,
      totalPasses: 0,
      history: [],                 // [{ts, quality, attempts, hintUsed}]
    };
  }

  function review(prev, quality) {
    let { repetition, easiness, intervalDays } = prev;

    easiness = easiness + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    easiness = Math.max(1.3, easiness);

    if (quality < 3) {
      repetition = 0;
      intervalDays = 1;
    } else {
      if (repetition === 0) intervalDays = 1;
      else if (repetition === 1) intervalDays = 6;
      else intervalDays = Math.round(intervalDays * easiness);
      repetition += 1;
    }

    const nextReviewAt = Date.now() + intervalDays * 24 * 60 * 60 * 1000;
    return {
      ...prev,
      repetition,
      easiness,
      intervalDays,
      nextReviewAt,
      lastQuality: quality,
    };
  }

  // Rough mastery score (0-100) for the analytics radar: rewards both a high
  // easiness factor (the material feels easy) and repetition depth (it's
  // survived several reviews), each capped so one axis can't dominate.
  function masteryScore(state) {
    if (!state || state.totalPasses === 0) return 0;
    const easePart = UTIL.clamp(((state.easiness - 1.3) / (2.5 - 1.3)) * 60, 0, 60);
    const repPart = UTIL.clamp((state.repetition / 5) * 40, 0, 40);
    return Math.round(easePart + repPart);
  }

  return { initialState, review, masteryScore };
})();

/* =============================================================================
   4. EDITOR — hand-rolled contentEditable code editor
   No CodeMirror/Monaco. Two hard problems solved here on purpose:
     a) Syntax highlighting: a single regex tokenizer classifies each line
        into comment/string/number/keyword/bool/function-name/punctuation
        tokens, which are wrapped in spans and re-rendered on every edit.
     b) Cursor preservation: contentEditable re-renders destroy and rebuild
        the DOM, which normally throws the caret to the wrong place. We
        never let the browser mutate the DOM structurally — every keystroke
        is intercepted via `beforeinput`, applied to a plain-string model,
        and then the whole line is re-rendered with the caret restored by
        walking text nodes to the saved integer offset.
   ============================================================================= */
const EDITOR = (() => {
  const KEYWORDS = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for',
    'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'new',
    'this', 'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw',
    'async', 'await', 'yield', 'import', 'export', 'default', 'from', 'static',
    'get', 'set', 'super', 'delete', 'void'];

  // One master regex, alternated by capture group. Order matters: comments
  // and strings must win before anything else can match inside them.
  // NOTE: this is line-based (no cross-line block-comment/template-literal
  // state machine) — a deliberate simplification for a hand-rolled tokenizer
  // used only in short practice snippets, not a general-purpose parser.
  const TOKEN_RE = new RegExp(
    '(\\/\\/.*)' +                                     // 1 line comment
    '|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)' + // 2 string
    '|(\\b\\d+\\.?\\d*\\b)' +                          // 3 number
    '|(\\b(?:' + KEYWORDS.join('|') + ')\\b)' +        // 4 keyword
    '|(\\b(?:true|false|null|undefined)\\b)' +         // 5 boolean/null
    '|([A-Za-z_$][\\w$]*)(?=\\s*\\()' +                // 6 function-call name
    '|([A-Za-z_$][\\w$]*)' +                           // 7 plain identifier
    '|([{}()\\[\\].,;:+\\-*/%=<>!&|^~?]+)' +           // 8 punctuation/operators
    '|([ \\t]+)',                                      // 9 whitespace
    'g'
  );

  function tokenizeLine(line) {
    const tokens = [];
    let last = 0;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(line))) {
      if (m.index > last) tokens.push({ text: line.slice(last, m.index), type: 'plain' });
      let type = 'plain';
      if (m[1] !== undefined) type = 'comment';
      else if (m[2] !== undefined) type = 'string';
      else if (m[3] !== undefined) type = 'number';
      else if (m[4] !== undefined) type = 'keyword';
      else if (m[5] !== undefined) type = 'bool';
      else if (m[6] !== undefined) type = 'func';
      else if (m[7] !== undefined) type = 'plain';
      else if (m[8] !== undefined) type = 'punct';
      else type = 'ws';
      tokens.push({ text: m[0], type });
      last = TOKEN_RE.lastIndex;
      if (m[0].length === 0) TOKEN_RE.lastIndex++; // guard against zero-width infinite loop
    }
    if (last < line.length) tokens.push({ text: line.slice(last), type: 'plain' });
    return tokens;
  }

  class CodeEditor {
    constructor(root, gutterEl, opts) {
      this.root = root;
      this.gutterEl = gutterEl;
      this.onChange = (opts && opts.onChange) || (() => {});
      this.onRunKey = (opts && opts.onRunKey) || (() => {});
      this.code = '';
      this.errorLine = null;
      this._bind();
    }

    setCode(code, errorLine) {
      this.code = code;
      this.errorLine = errorLine || null;
      this._render(0);
    }

    setErrorLine(line) {
      this.errorLine = line || null;
      const caret = this._getCaretOffset();
      this._render(caret);
    }

    getCode() { return this.code; }

    focus() { this.root.focus(); }

    /* ---- DOM <-> integer-offset caret math -------------------------------- */

    _lineDivOf(node) {
      let el = node.nodeType === 3 ? node.parentElement : node;
      while (el && el.parentElement !== this.root) el = el.parentElement;
      return el;
    }

    _nodeOffsetToGlobal(node, nodeOffset) {
      const lineDiv = this._lineDivOf(node);
      const lines = Array.from(this.root.children);
      const lineIndex = lines.indexOf(lineDiv);
      if (lineIndex === -1) return 0;
      const range = document.createRange();
      range.selectNodeContents(lineDiv);
      try { range.setEnd(node, nodeOffset); } catch { /* node not inside lineDiv; ignore */ }
      let global = range.toString().length;
      for (let i = 0; i < lineIndex; i++) global += lines[i].textContent.length + 1; // +1 for '\n'
      return global;
    }

    _getCaretOffset() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !this.root.contains(sel.focusNode)) return this.code.length;
      return this._nodeOffsetToGlobal(sel.focusNode, sel.focusOffset);
    }

    _getSelectionRange() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !this.root.contains(sel.anchorNode)) {
        const end = this.code.length;
        return { start: end, end };
      }
      const a = this._nodeOffsetToGlobal(sel.anchorNode, sel.anchorOffset);
      const b = this._nodeOffsetToGlobal(sel.focusNode, sel.focusOffset);
      return { start: Math.min(a, b), end: Math.max(a, b) };
    }

    _setCaretOffset(offset) {
      const lines = Array.from(this.root.children);
      if (lines.length === 0) return;
      let remaining = UTIL.clamp(offset, 0, this.code.length);
      let targetLine = lines[lines.length - 1];
      let col = targetLine.textContent.length;
      for (const line of lines) {
        const len = line.textContent.length;
        if (remaining <= len) { targetLine = line; col = remaining; break; }
        remaining -= (len + 1);
      }
      const walker = document.createTreeWalker(targetLine, NodeFilter.SHOW_TEXT);
      let node, acc = 0, found = null;
      while ((node = walker.nextNode())) {
        const len = node.textContent.length;
        if (acc + len >= col) { found = { node, offset: col - acc }; break; }
        acc += len;
      }
      const range = document.createRange();
      if (found) range.setStart(found.node, found.offset);
      else range.setStart(targetLine, 0); // empty line
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    /* ---- rendering ---------------------------------------------------------- */

    _render(caretOffset) {
      const lines = this.code.split('\n');
      const frag = document.createDocumentFragment();
      lines.forEach((lineText, idx) => {
        const div = document.createElement('div');
        div.className = 'cs-line';
        if (this.errorLine === idx + 1) div.classList.add('line-error');
        for (const tok of tokenizeLine(lineText)) {
          if (tok.type === 'plain' || tok.type === 'ws') {
            div.appendChild(document.createTextNode(tok.text));
          } else {
            const span = document.createElement('span');
            span.className = 'tok-' + tok.type;
            span.textContent = tok.text;
            div.appendChild(span);
          }
        }
        frag.appendChild(div);
      });
      this.root.innerHTML = '';
      this.root.appendChild(frag);
      this._renderGutter(lines.length);
      if (caretOffset !== null && document.activeElement === this.root) {
        this._setCaretOffset(caretOffset);
      }
    }

    _renderGutter(lineCount) {
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= lineCount; i++) {
        const d = document.createElement('div');
        d.className = 'gutter-line' + (this.errorLine === i ? ' has-error' : '');
        d.textContent = String(i);
        frag.appendChild(d);
      }
      this.gutterEl.innerHTML = '';
      this.gutterEl.appendChild(frag);
    }

    /* ---- editing model: every mutation goes through here -------------------- */

    _commit(newCode, newCaret) {
      this.code = newCode;
      this._render(newCaret);
      this.onChange(this.code);
    }

    _bind() {
      this.root.addEventListener('beforeinput', (e) => {
        e.preventDefault();
        const { start, end } = this._getSelectionRange();
        const code = this.code;
        let newCode, newCaret;
        switch (e.inputType) {
          case 'insertText':
            newCode = code.slice(0, start) + (e.data || '') + code.slice(end);
            newCaret = start + (e.data || '').length;
            break;
          case 'insertLineBreak':
          case 'insertParagraph':
            newCode = code.slice(0, start) + '\n' + code.slice(end);
            newCaret = start + 1;
            break;
          case 'deleteContentBackward': {
            let s = start, en = end;
            if (s === en) s = Math.max(0, s - 1);
            newCode = code.slice(0, s) + code.slice(en);
            newCaret = s;
            break;
          }
          case 'deleteContentForward': {
            let s = start, en = end;
            if (s === en) en = Math.min(code.length, en + 1);
            newCode = code.slice(0, s) + code.slice(en);
            newCaret = s;
            break;
          }
          default:
            return; // unhandled inputType (e.g. formatting commands) — ignore
        }
        this._commit(newCode, newCaret);
      });

      this.root.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        const { start, end } = this._getSelectionRange();
        const newCode = this.code.slice(0, start) + text + this.code.slice(end);
        this._commit(newCode, start + text.length);
      });

      this.root.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const { start, end } = this._getSelectionRange();
          const newCode = this.code.slice(0, start) + '  ' + this.code.slice(end);
          this._commit(newCode, start + 2);
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          this.onRunKey();
        }
      });
    }
  }

  return { CodeEditor, tokenizeLine };
})();

/* =============================================================================
   5. SANDBOX — real, sandboxed JS execution
   The child document lives inside an <iframe sandbox="allow-scripts">: it has
   no `allow-same-origin`, so it gets an opaque origin and cannot read the
   parent's DOM, cookies, or storage. The only channel in or out is
   postMessage. Each run gets a random runId so stray/late messages from a
   recycled frame can never be mistaken for the current run's result.

   Timeout watchdog: JS is single-threaded, so no code running in the same
   thread can forcibly interrupt a synchronous infinite loop already in
   flight — that's a real platform limitation, not a bug in this code. What
   we CAN guarantee is that a run which doesn't report back within
   `timeoutMs` is treated as failed/timed-out immediately from the parent's
   point of view, and the iframe is discarded and replaced so a runaway loop
   can never contaminate a later run or keep listening for messages.
   ============================================================================= */
const SANDBOX = (() => {
  const SANDBOX_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
    function safeStringify(v) {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    function deepEqual(a, b) {
      if (Object.is(a, b)) return true;
      if (typeof a !== typeof b || a === null || b === null) return a === b;
      if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
      }
      if (typeof a === 'object') {
        var ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        return ka.every(function (k) { return deepEqual(a[k], b[k]); });
      }
      return false;
    }
    function extractLine(err) {
      if (!err || !err.stack) return null;
      var m = /(?:<anonymous>|anonymous):(\\d+):\\d+/.exec(err.stack);
      return m ? parseInt(m[1], 10) : null;
    }

    window.addEventListener('message', function (ev) {
      var msg = ev.data || {};
      var runId = msg.runId, code = msg.code, tests = msg.tests, isAsync = !!msg.isAsync;
      var logs = [];
      var origLog = console.log;
      console.log = function () {
        var args = Array.prototype.slice.call(arguments);
        logs.push(args.map(function (a) { return typeof a === 'string' ? a : safeStringify(a); }).join(' '));
      };

      var results = [];
      var fatalError = null;

      (async function run() {
        try {
          var factory = new Function(code + '\\n;return (typeof solve !== "undefined") ? solve : undefined;');
          var solveFn = factory();
          if (typeof solveFn !== 'function') {
            throw new Error('No solve(...) function was found. Define one before running tests.');
          }
          for (var i = 0; i < tests.length; i++) {
            var t = tests[i];
            var passed = false, actual, errMsg = null, line = null;
            try {
              var out = solveFn.apply(null, t.args);
              actual = isAsync ? await out : out;
              passed = deepEqual(actual, t.expected);
            } catch (err) {
              errMsg = (err && err.message) || String(err);
              line = extractLine(err);
            }
            results.push({ args: t.args, expected: t.expected, actual: actual, passed: passed, error: errMsg, line: line });
          }
        } catch (err) {
          fatalError = { message: (err && err.message) || String(err), line: extractLine(err) };
        }
        console.log = origLog;
        parent.postMessage({ runId: runId, results: results, logs: logs, fatalError: fatalError }, '*');
      })();
    });
  <\/script></body></html>`;

  let readyResolve;
  let ready = new Promise((res) => { readyResolve = res; });

  function install(frame) {
    frame.addEventListener('load', () => { readyResolve(); }, { once: true });
    frame.srcdoc = SANDBOX_DOC;
  }

  function recycle() {
    const old = document.getElementById('sandboxFrame');
    const fresh = document.createElement('iframe');
    fresh.id = 'sandboxFrame';
    fresh.className = 'sandbox-frame';
    fresh.setAttribute('sandbox', 'allow-scripts');
    fresh.setAttribute('title', 'code sandbox');
    fresh.setAttribute('aria-hidden', 'true');
    old.replaceWith(fresh);
    ready = new Promise((res) => { readyResolve = res; });
    install(fresh);
    return fresh;
  }

  function init() {
    install(document.getElementById('sandboxFrame'));
  }

  async function run(code, tests, isAsync, timeoutMs = 3000) {
    await ready;
    const runId = 'r' + Math.random().toString(36).slice(2) + Date.now();
    const frame = document.getElementById('sandboxFrame');

    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMsg);
        recycle(); // discard the (possibly still-looping) realm entirely
        resolve({ timedOut: true, results: [], logs: [], fatalError: null });
      }, timeoutMs);

      function onMsg(ev) {
        if (!ev.data || ev.data.runId !== runId) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(Object.assign({ timedOut: false }, ev.data));
      }
      window.addEventListener('message', onMsg);

      frame.contentWindow.postMessage({ runId, code, tests, isAsync }, '*');
    });
  }

  return { init, run };
})();

/* =============================================================================
   6. ANALYTICS — hand-drawn skill radar (canvas, no charting library)
   ============================================================================= */
const ANALYTICS = (() => {
  const CATEGORIES = ['loops', 'operators', 'scope', 'async', 'arrays', 'recursion', 'strings', 'functions'];

  function draw(canvas, scoresByCategory) {
    const dpr = window.devicePixelRatio || 1;
    const cssSize = canvas.clientWidth || 480;
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const size = cssSize;
    const cx = size / 2, cy = size / 2;
    const radius = size * 0.36;
    const n = CATEGORIES.length;
    const angleFor = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;

    ctx.clearRect(0, 0, size, size);

    const styles = getComputedStyle(document.documentElement);
    const line = styles.getPropertyValue('--line').trim() || '#22303f';
    const dim = styles.getPropertyValue('--text-dim').trim() || '#64748b';
    const hi = styles.getPropertyValue('--text-hi').trim() || '#e6edf3';
    const accent = styles.getPropertyValue('--accent').trim() || '#e3b341';

    // concentric rings at 20/40/60/80/100%
    for (let ring = 1; ring <= 5; ring++) {
      ctx.beginPath();
      const r = (radius * ring) / 5;
      for (let i = 0; i <= n; i++) {
        const a = angleFor(i % n);
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // axis spokes + labels
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = dim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    CATEGORIES.forEach((cat, i) => {
      const a = angleFor(i);
      const x = cx + radius * Math.cos(a), y = cy + radius * Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = line;
      ctx.stroke();
      const lx = cx + (radius + 22) * Math.cos(a), ly = cy + (radius + 22) * Math.sin(a);
      ctx.fillText(cat, lx, ly);
    });

    // data polygon
    ctx.beginPath();
    CATEGORIES.forEach((cat, i) => {
      const score = UTIL.clamp(scoresByCategory[cat] || 0, 0, 100);
      const r = (radius * score) / 100;
      const a = angleFor(i);
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = accent + '33';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    // data points
    CATEGORIES.forEach((cat, i) => {
      const score = UTIL.clamp(scoresByCategory[cat] || 0, 0, 100);
      const r = (radius * score) / 100;
      const a = angleFor(i);
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = hi;
      ctx.fill();
    });
  }

  return { draw, CATEGORIES };
})();

/* =============================================================================
   7. PWA — service worker registration (offline-first)
   ============================================================================= */
const PWA = (() => {
  function register() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* offline-first is best-effort */ });
      });
    }
  }

  function watchOnlineStatus() {
    const dot = document.getElementById('netDot');
    const label = document.getElementById('netLabel');
    function update() {
      const online = navigator.onLine;
      dot.classList.toggle('offline', !online);
      label.textContent = online ? 'online' : 'offline';
    }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  return { register, watchOnlineStatus };
})();

/* =============================================================================
   8. APP — wires DB + SM2 + EDITOR + SANDBOX + ANALYTICS together
   ============================================================================= */
const APP = (() => {
  let challenges = [];         // static library, loaded from data/challenges.json
  let progressById = {};       // challengeId -> SM2 state record (from IndexedDB)
  let currentChallenge = null;
  let editor = null;
  let attemptsThisSession = 0; // resets whenever the active challenge changes
  let hintUsed = false;

  async function boot() {
    PWA.register();
    PWA.watchOnlineStatus();
    SANDBOX.init();

    editor = new EDITOR.CodeEditor(
      document.getElementById('codeSurface'),
      document.getElementById('gutter'),
      { onChange: () => clearResults(), onRunKey: () => runTests() }
    );

    bindChrome();

    const res = await fetch('data/challenges.json');
    challenges = await res.json();

    const stored = await DB.getAllProgress();
    progressById = {};
    stored.forEach((rec) => { progressById[rec.challengeId] = rec; });
    challenges.forEach((c) => {
      if (!progressById[c.id]) progressById[c.id] = SM2.initialState(c.id);
    });

    renderSidebar();
    selectChallenge(pickNextChallengeId());
    renderAnalytics();
  }

  function pickNextChallengeId() {
    const sorted = [...challenges].sort((a, b) => progressById[a.id].nextReviewAt - progressById[b.id].nextReviewAt);
    return sorted[0] ? sorted[0].id : null;
  }

  function dueCount() {
    const now = Date.now();
    return challenges.filter((c) => progressById[c.id].nextReviewAt <= now).length;
  }

  /* ---- sidebar ------------------------------------------------------------- */

  function renderSidebar() {
    const list = document.getElementById('challengeList');
    const sorted = [...challenges].sort((a, b) => progressById[a.id].nextReviewAt - progressById[b.id].nextReviewAt);
    list.innerHTML = '';
    sorted.forEach((c) => {
      const prog = progressById[c.id];
      const due = prog.nextReviewAt <= Date.now();
      const mastery = SM2.masteryScore(prog);

      const li = document.createElement('li');
      li.className = 'challenge-item' + (currentChallenge && currentChallenge.id === c.id ? ' is-active' : '');
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      li.addEventListener('click', () => selectChallenge(c.id));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectChallenge(c.id); });

      li.innerHTML = `
        <div class="challenge-item-top">
          <span class="challenge-item-name">${escapeHtml(c.title)}</span>
          <div class="mastery-bar" title="Mastery ${mastery}%"><div class="mastery-bar-fill" style="width:${mastery}%"></div></div>
        </div>
        <div class="challenge-item-meta">
          <span>${escapeHtml(c.category)}</span>
          <span class="due-chip ${due ? '' : 'not-due'}">${due ? 'due' : UTIL.fmtRelative(prog.nextReviewAt)}</span>
        </div>`;
      list.appendChild(li);
    });

    document.getElementById('duePill').textContent = `${dueCount()} due`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---- challenge selection --------------------------------------------------- */

  function selectChallenge(id) {
    const c = challenges.find((x) => x.id === id);
    if (!c) return;
    currentChallenge = c;
    attemptsThisSession = 0;
    hintUsed = false;

    document.getElementById('challengeTitle').textContent = c.title;
    document.getElementById('challengeCategory').textContent = c.category;
    document.getElementById('challengeDifficulty').textContent = '●'.repeat(c.difficulty) + '○'.repeat(3 - c.difficulty);
    document.getElementById('challengePrompt').textContent = c.prompt;
    document.getElementById('editorFilename').textContent = `${c.id}.js`;

    editor.setCode(c.brokenCode, null);
    clearResults();
    renderSidebar();
  }

  function clearResults() {
    document.getElementById('consoleBody').innerHTML = '';
    document.getElementById('consoleHint').textContent = 'Run your code to see results here.';
  }

  /* ---- toolbar bindings ------------------------------------------------------ */

  function bindChrome() {
    document.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.view-btn').forEach((b) => { b.classList.remove('is-active'); b.setAttribute('aria-selected', 'false'); });
        btn.classList.add('is-active');
        btn.setAttribute('aria-selected', 'true');
        const view = btn.dataset.view;
        document.getElementById('view-practice').hidden = view !== 'practice';
        document.getElementById('view-analytics').hidden = view !== 'analytics';
        if (view === 'analytics') renderAnalytics();
      });
    });

    document.getElementById('btnRun').addEventListener('click', () => runTests());
    document.getElementById('btnReset').addEventListener('click', () => {
      if (!currentChallenge) return;
      editor.setCode(currentChallenge.brokenCode, null);
      clearResults();
      UTIL.toast('Reset to the original broken code.');
    });
    document.getElementById('btnHint').addEventListener('click', () => {
      if (!currentChallenge) return;
      hintUsed = true;
      UTIL.toast('Hint: ' + currentChallenge.hint);
    });

    // explain-your-fix modal
    const backdrop = document.getElementById('explainBackdrop');
    const input = document.getElementById('explainInput');
    const submitBtn = document.getElementById('explainSubmit');
    input.addEventListener('input', () => {
      submitBtn.disabled = input.value.trim().split(/\s+/).filter(Boolean).length < 3;
    });
    document.getElementById('explainCancel').addEventListener('click', () => { backdrop.hidden = true; });
    submitBtn.addEventListener('click', () => {
      backdrop.hidden = true;
      executeAgainstTests(input.value.trim());
    });
  }

  /* ---- the core loop: run -> explain -> check -> schedule -------------------- */

  function runTests() {
    if (!currentChallenge) return;
    if (editor.getCode().trim() === currentChallenge.brokenCode.trim()) {
      UTIL.toast("You haven't changed anything yet — find the bug first.", 'fail');
      return;
    }
    const backdrop = document.getElementById('explainBackdrop');
    const input = document.getElementById('explainInput');
    input.value = '';
    document.getElementById('explainSubmit').disabled = true;
    backdrop.hidden = false;
    input.focus();
  }

  async function executeAgainstTests(explanation) {
    const c = currentChallenge;
    const btn = document.getElementById('btnRun');
    btn.disabled = true;
    btn.textContent = 'Running…';

    const outcome = await SANDBOX.run(editor.getCode(), c.tests, !!c.async, 3000);

    btn.disabled = false;
    btn.textContent = 'Run tests ⌘⏎';
    attemptsThisSession += 1;

    renderConsole(outcome, explanation);

    if (outcome.timedOut) {
      editor.setErrorLine(null);
      UTIL.toast('Timed out — looks like an infinite loop. The sandbox was reset.', 'fail');
      return;
    }

    if (outcome.fatalError) {
      editor.setErrorLine(outcome.fatalError.line || null);
      UTIL.toast('Your code threw an error before any test ran.', 'fail');
      return;
    }

    const allPassed = outcome.results.length > 0 && outcome.results.every((r) => r.passed);
    const firstFailLine = outcome.results.find((r) => !r.passed && r.line)?.line || null;
    editor.setErrorLine(allPassed ? null : firstFailLine);

    if (allPassed) {
      await recordSuccess();
      UTIL.toast(`All ${outcome.results.length} tests passed. Nice fix.`, 'pass');
    } else {
      const passCount = outcome.results.filter((r) => r.passed).length;
      UTIL.toast(`${passCount}/${outcome.results.length} tests passed — keep going.`, 'fail');
    }
  }

  function renderConsole(outcome, explanation) {
    const body = document.getElementById('consoleBody');
    body.innerHTML = '';

    const expDiv = document.createElement('div');
    expDiv.className = 'test-detail';
    expDiv.innerHTML = `<b>Your explanation:</b> ${escapeHtml(explanation)}`;
    body.appendChild(expDiv);

    if (outcome.timedOut) {
      const d = document.createElement('div');
      d.className = 'console-error';
      d.textContent = 'Execution did not finish within 3s and was terminated (likely an infinite loop).';
      body.appendChild(d);
      document.getElementById('consoleHint').textContent = 'Timed out';
      return;
    }

    if (outcome.fatalError) {
      const d = document.createElement('div');
      d.className = 'console-error';
      d.textContent = (outcome.fatalError.line ? `Line ${outcome.fatalError.line}: ` : '') + outcome.fatalError.message;
      body.appendChild(d);
      document.getElementById('consoleHint').textContent = 'Error';
      return;
    }

    outcome.results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'test-row';
      const detail = r.error
        ? `threw: ${escapeHtml(r.error)}`
        : `solve(${r.args.map(UTIL.safeJSON).join(', ')}) → <b>${escapeHtml(UTIL.safeJSON(r.actual))}</b>, expected <b>${escapeHtml(UTIL.safeJSON(r.expected))}</b>`;
      row.innerHTML = `<span class="test-status ${r.passed ? 'pass' : 'fail'}">${r.passed ? '✓' : '✗'}</span><span class="test-detail">Test ${i + 1}: ${detail}</span>`;
      body.appendChild(row);
    });

    if (outcome.logs.length) {
      const log = document.createElement('div');
      log.className = 'console-log';
      log.textContent = 'console.log:\n' + outcome.logs.join('\n');
      body.appendChild(log);
    }

    const allPassed = outcome.results.every((r) => r.passed);
    const summary = document.createElement('div');
    summary.className = 'console-summary ' + (allPassed ? 'pass' : 'fail');
    summary.textContent = allPassed
      ? `All ${outcome.results.length} tests passed`
      : `${outcome.results.filter((r) => r.passed).length}/${outcome.results.length} tests passed`;
    body.appendChild(summary);
    document.getElementById('consoleHint').textContent = allPassed ? 'Passed' : 'Failed';
  }

  // Maps how the practice session went to an SM-2 quality rating (0-5).
  // Fewer attempts and no hint = higher quality = longer interval before
  // this concept resurfaces; a hint used caps the score, since leaning on
  // the hint means the concept isn't fully internalized yet.
  function qualityFromAttempt(attempts, hintUsed) {
    let q;
    if (attempts <= 1) q = 5;
    else if (attempts === 2) q = 4;
    else if (attempts === 3) q = 3;
    else if (attempts === 4) q = 2;
    else q = 1;
    if (hintUsed) q = Math.min(q, 3);
    return q;
  }

  async function recordSuccess() {
    const c = currentChallenge;
    const prev = progressById[c.id];
    const quality = qualityFromAttempt(attemptsThisSession, hintUsed);
    const next = SM2.review(prev, quality);
    next.totalAttempts = (prev.totalAttempts || 0) + attemptsThisSession;
    next.totalPasses = (prev.totalPasses || 0) + 1;
    next.history = [...(prev.history || []).slice(-19), { ts: Date.now(), quality, attempts: attemptsThisSession, hintUsed }];
    progressById[c.id] = next;
    await DB.putProgress(next);
    renderSidebar();
  }

  /* ---- analytics ------------------------------------------------------------- */

  function renderAnalytics() {
    const byCategory = {};
    ANALYTICS.CATEGORIES.forEach((cat) => { byCategory[cat] = { total: 0, count: 0 }; });
    challenges.forEach((c) => {
      const prog = progressById[c.id];
      if (!byCategory[c.category]) byCategory[c.category] = { total: 0, count: 0 };
      byCategory[c.category].total += SM2.masteryScore(prog);
      byCategory[c.category].count += 1;
    });
    const scores = {};
    Object.keys(byCategory).forEach((cat) => {
      const b = byCategory[cat];
      scores[cat] = b.count ? Math.round(b.total / b.count) : 0;
    });
    ANALYTICS.draw(document.getElementById('radarCanvas'), scores);

    const totalPasses = Object.values(progressById).reduce((s, p) => s + (p.totalPasses || 0), 0);
    const totalAttempts = Object.values(progressById).reduce((s, p) => s + (p.totalAttempts || 0), 0);
    const mastered = Object.values(progressById).filter((p) => p.repetition >= 3).length;
    const avgMastery = Math.round(Object.values(progressById).reduce((s, p) => s + SM2.masteryScore(p), 0) / (challenges.length || 1));

    const grid = document.getElementById('statsGrid');
    grid.innerHTML = '';
    const stats = [
      ['Challenges due', String(dueCount())],
      ['Challenges mastered', `${mastered}/${challenges.length}`],
      ['Average mastery', `${avgMastery}%`],
      ['Total attempts', String(totalAttempts)],
      ['Total passes', String(totalPasses)],
    ];
    stats.forEach(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'stat-card';
      card.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`;
      grid.appendChild(card);
    });
  }

  return { boot };
})();

document.addEventListener('DOMContentLoaded', APP.boot);

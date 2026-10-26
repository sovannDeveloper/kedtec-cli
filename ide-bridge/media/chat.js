// The chat panel's page. It only draws what the extension sends (chat.ts) and
// sends back what the person does; the agent, its tools and every permission
// decision live in the extension host. Markdown is rendered by the small
// renderer below rather than a library, as everywhere else in this project.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const log = $('log');
  const input = $('input');
  const sendButton = $('send');
  const status = $('status');
  const statusLabel = $('status-label');
  const statusTime = $('status-time');
  const modeButton = $('mode');
  const modelSelect = $('model');
  const contextChip = $('context');
  const contextLabel = $('context-label');
  const usage = $('usage');
  const attachments = $('attachments');
  const suggest = $('suggest');
  const toBottom = $('to-bottom');
  const glyph = $('glyph');
  const fileInput = $('file');
  const composer = document.querySelector('.composer');
  const sessionsView = $('sessions');
  const sessionsList = $('sessions-list');
  const sessionsFilter = $('sessions-filter');
  const sessionsClear = $('sessions-clear');

  const MODE_LABELS = { default: 'Ask first', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };
  // …and in a narrow sidebar.
  const MODE_SHORT = { default: 'Ask', acceptEdits: 'Edits', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };
  const MODE_ABOUT = {
    default: 'asks before every edit and command',
    acceptEdits: 'edits apply at once; commands ask',
    auto: 'edits and low-risk commands run; risky ones ask',
    plan: 'read-only: investigates and proposes a plan',
    bypass: 'nothing asks',
  };
  // The CLI spinner's frames, there and back.
  const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let busy = false;
  let startedAt = 0;
  let clock = 0;
  let restricted = false;
  let includeEditor = true;
  let images = [];
  let assistant = null; // { el, body, raw, reasoning, reasoningRaw }
  let runningTool = null;
  let renderQueued = false;
  const history = [];
  let historyAt = -1;
  let commands = []; // [{ name, args, about }], from the extension
  let matches = []; // what the popup lists: { kind: 'command', name, args, about } or { kind: 'file', path }
  let picked = 0;
  let mention = null; // the "@…" being typed: { start, end, query }
  let mentionSeq = 0; // numbers each question to the extension
  let modes = [];
  let mode = 'default';
  let sessions = []; // [{ id, title, updated, messages, current }], from the extension
  let renaming = null; // the id of the conversation whose title is being edited

  const post = msg => vscode.postMessage(msg);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ── icons: 16×16 strokes, drawn in the text colour ──────────────────────

  const ICONS = {
    file: '<path d="M4 1.5h5l3.5 3.5v9.5h-8.5z"/><path d="M9 1.5V5h3.5"/>',
    filePlus: '<path d="M4 1.5h5l3.5 3.5v9.5h-8.5z"/><path d="M9 1.5V5h3.5M8.25 7.5v4.5M6 9.75h4.5"/>',
    pencil: '<path d="M10.5 2.5l3 3-8 8h-3v-3z"/><path d="M9 4l3 3"/>',
    folder: '<path d="M1.5 4V13h13V5.5H8L6.5 3.5h-4z"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
    terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.75-2 1.75M8.5 10.5h3"/>',
    checklist: '<path d="M2 4l1.25 1.25L5.5 3M2 9.5l1.25 1.25L5.5 8.5M8 4.5h6M8 10h6"/>',
    question: '<circle cx="8" cy="8" r="6.5"/><path d="M6.25 6.25a1.85 1.85 0 1 1 2.6 1.7c-.5.25-.85.6-.85 1.15v.4"/><path d="M8 11.75v.01"/>',
    bookmark: '<path d="M4 1.5h8v13L8 11.5l-4 3z"/>',
    globe: '<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2 2 2.75 4.25 2.75 6.5S10 12.5 8 14.5C6 12.5 5.25 10.25 5.25 8S6 3.5 8 1.5z"/>',
    tool: '<path d="M10 2a3.5 3.5 0 0 0-3.3 4.6L2 11.3 4.7 14l4.7-4.7A3.5 3.5 0 0 0 14 6l-2 2-2-.5-.5-2 2-2A3.5 3.5 0 0 0 10 2z"/>',
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    copy: '<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.75"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/>',
    chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
    warning: '<path d="M8 1.75 14.75 13.5H1.25z"/><path d="M8 6.25v3.25M8 11.5v.01"/>',
    error: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.75v3.75M8 11v.01"/>',
    spark: '<path d="M8 1.5c.5 3.2 1.8 4.7 5 5.25-3.2.55-4.5 2.05-5 5.25-.5-3.2-1.8-4.7-5-5.25 3.2-.55 4.5-2.05 5-5.25z"/>',
    book: '<path d="M2 3c2-.75 4-.75 6 .5 2-1.25 4-1.25 6-.5v10c-2-.75-4-.75-6 .5-2-1.25-4-1.25-6-.5z"/><path d="M8 3.5v10"/>',
    bug: '<rect x="4.5" y="5" width="7" height="9" rx="3.5"/><path d="M6 5V4a2 2 0 0 1 4 0v1M4.5 8.5H2M14 8.5h-2.5M4.75 11.5 2.5 13M11.25 11.5l2.25 1.5M4.75 6 2.5 4.5M11.25 6l2.25-1.5M8 8v6"/>',
    beaker: '<path d="M6 1.5v5L2.25 13a1 1 0 0 0 .9 1.5h9.7a1 1 0 0 0 .9-1.5L10 6.5v-5M5 1.5h6M4 10h8"/>',
    slash: '<path d="M10.5 2.5 5.5 13.5"/>',
    stop: '<circle cx="8" cy="8" r="6.5"/><path d="M6 6h4v4H6z"/>',
    trash: '<path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.75 9.5h6.5L12 4M6.75 6.5v4.5M9.25 6.5v4.5"/>',
    chat: '<path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h-.5A1.5 1.5 0 0 1 2 9.5z"/>',
  };
  const svg = name => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ICONS.tool}</svg>`;
  function icon(name, cls) {
    const node = el('span', `icon${cls ? ` ${cls}` : ''}`);
    node.innerHTML = svg(name);
    return node;
  }
  // The tools' labels (src/tools.ts) and the icon each is drawn with.
  const TOOL_ICONS = {
    Read: 'file', Write: 'filePlus', Edit: 'pencil', List: 'folder', Glob: 'search', Grep: 'search',
    Bash: 'terminal', Todos: 'checklist', Question: 'question', Memory: 'bookmark',
  };
  const toolIcon = label => TOOL_ICONS[label] || (/web|fetch|search|research/i.test(label) ? 'globe' : 'tool');

  // ── scrolling: follow the end unless the person scrolled up ─────────────

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  function keepBottom(change) {
    const stick = atBottom();
    change();
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function append(node) {
    keepBottom(() => {
      const welcome = log.querySelector('.welcome, .fatal');
      if (welcome) welcome.remove();
      log.appendChild(node);
    });
    return node;
  }

  // ── Markdown ────────────────────────────────────────────────────────────

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = s => String(s).replace(/[&<>"']/g, ch => ESC[ch]);

  const CODE_EXT = new Set(('ts tsx js jsx mjs cjs json jsonc md mdx css scss sass less html htm vue svelte py go rs java kt kts dart swift '
    + 'c h cc cpp hpp cs php rb yml yaml toml xml sh bash zsh ps1 sql txt lock env ini cfg conf gradle properties graphql proto').split(' '));
  // "src/app.ts", "app.ts:42", "src/app.ts:42-50": a file the model cites.
  function fileRef(s) {
    const m = /^((?:[\w@.~-]+\/)*[\w@.-]+\.([A-Za-z0-9]{1,10}))(?::(\d+)(?:-(\d+))?)?$/.exec(s);
    return !!m && (s.includes('/') || !!m[3] || CODE_EXT.has(m[2].toLowerCase()));
  }
  const fileLink = (ref, html) => `<span class="link" data-file="${escapeHtml(ref)}">${html}</span>`;

  function inline(text) {
    const slots = [];
    const keep = html => `\u0000${slots.push(html) - 1}\u0000`;
    let s = text;
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, raw) => {
      const code = /^ .* $/.test(raw) ? raw.slice(1, -1) : raw;
      return keep(fileRef(code) ? `<code class="link" data-file="${escapeHtml(code)}">${escapeHtml(code)}</code>` : `<code>${escapeHtml(code)}</code>`);
    });
    s = s.replace(/\[([^\]\n]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, label, url) => {
      if (/^(https?:|mailto:)/i.test(url)) return keep(`<a href="${escapeHtml(url)}">${inline(label)}</a>`);
      return keep(fileLink(url.replace(/^\.\//, '').replace(/#L(\d+)(?:-L?(\d+))?$/, (_m, a, b) => `:${a}${b ? `-${b}` : ''}`), inline(label)));
    });
    s = s.replace(/\bhttps?:\/\/[^\s<>()\u0000]+[^\s<>().,;:!?'"\u0000]/g, url => keep(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
    s = s.replace(/(^|[\s(])((?:[\w@.~-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,10}(?::\d+(?:-\d+)?)?)(?=$|[\s),.;:!?])/g,
      (_, lead, ref) => lead + keep(fileLink(ref, escapeHtml(ref))));
    s = escapeHtml(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
  }

  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const blank = l => !l.trim();
  const startsBlock = l => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || ITEM.test(l) || QUOTE.test(l);

  function codeBlock(code, lang) {
    return `<div class="code"><div class="code-head"><span>${escapeHtml(lang || 'text')}</span><button class="icon-button copy" title="Copy code" aria-label="Copy code">${svg('copy')}</button></div>`
      + `<pre><code>${escapeHtml(code)}</code></pre></div>`;
  }

  function list(lines) {
    const indent = l => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    const base = indent(lines[0]);
    const items = [];
    for (const l of lines) {
      const m = ITEM.exec(l);
      if (m && indent(l) <= base + 1) items.push({ head: m[3], rest: [], marker: m[2] });
      else if (items.length) items[items.length - 1].rest.push(l);
    }
    const ordered = /\d/.test(items[0].marker);
    const start = ordered ? parseInt(items[0].marker, 10) : 1;
    const body = items.map(it => {
      const rest = it.rest.filter(l => !blank(l));
      if (rest.length === 0) return `<li>${inline(it.head)}</li>`;
      const cut = Math.min(...rest.map(indent));
      return `<li>${inline(it.head)}${markdown(it.rest.map(l => l.slice(Math.min(cut, indent(l)))).join('\n'))}</li>`;
    }).join('');
    return ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${body}</ol>` : `<ul>${body}</ul>`;
  }

  function markdown(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (blank(line)) { i++; continue; }
      if ((m = FENCE.exec(line))) {
        const close = new RegExp(`^\\s{0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}\\s*$`);
        const body = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(codeBlock(body.join('\n'), m[2]));
        continue;
      }
      if ((m = HEADING.exec(line))) { const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
        out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
        const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const head = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && !blank(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
          + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if (ITEM.test(line)) {
        const block = [];
        const indent = l => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
        const ordered = l => /\d/.test(ITEM.exec(l)[2]);
        const base = indent(line);
        while (i < lines.length) {
          const l = lines[i];
          // A bullet list and a numbered one after it are two lists.
          if (block.length && ITEM.test(l) && indent(l) <= base + 1 && ordered(l) !== ordered(line)) break;
          if (ITEM.test(l) || (!blank(l) && /^\s+\S/.test(l))) { block.push(l); i++; continue; }
          if (blank(l) && i + 1 < lines.length && (ITEM.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) { block.push(''); i++; continue; }
          break;
        }
        out.push(list(block));
        continue;
      }
      const para = [];
      while (i < lines.length && !blank(lines[i]) && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
      out.push(`<p>${para.map(l => inline(l.trim())).join('<br>')}</p>`);
    }
    return out.join('');
  }

  function diffPre(text) {
    const pre = el('pre', 'diff');
    for (const line of text.split('\n')) {
      const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
        : line.startsWith('-') && !line.startsWith('---') ? 'del'
          : line.startsWith('@@') ? 'hunk' : '';
      const span = el('span', cls, `${line}\n`);
      pre.appendChild(span);
    }
    return pre;
  }

  // ── transcript rows ─────────────────────────────────────────────────────

  // What someone new to the panel might ask first; each one is sent as typed.
  const STARTERS = [
    ['Explain this project', 'what it is and how the pieces fit', 'book'],
    ['Find bugs in the open file', 'and explain each one', 'bug'],
    ['Write tests for the selected code', 'covering its edge cases', 'beaker'],
    ['/init', 'write a KEDTEC.md for future sessions', 'filePlus'],
  ];

  function welcome() {
    log.innerHTML = '';
    const box = el('div', 'welcome');
    box.innerHTML = `<div class="mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 8.5A9.5 9.5 0 1 0 21 13"/><path d="M8.5 7v10"/><path d="M15.5 7l-5 5 5 5"/></svg></div>
      <h2>KEDTec</h2>
      <p class="lead">Ask about this project, or have KEDTec change it. It reads, edits and runs commands, asking first as the mode says.</p>`;
    const starters = el('div', 'starters');
    for (const [text, about, name] of STARTERS) {
      const b = el('button');
      b.append(icon(name), el('b', '', text), el('span', '', about));
      b.onclick = () => { if (busy) return; input.value = text; submit(); };
      starters.appendChild(b);
    }
    box.appendChild(starters);
    const tips = el('div', 'tips');
    tips.innerHTML = '<span><kbd>@</kbd> attach a file</span><span><kbd>/</kbd> commands</span>'
      + '<span><kbd>⇧</kbd><kbd>Tab</kbd> mode</span><span><kbd>Esc</kbd> stop</span>';
    box.appendChild(tips);
    box.appendChild(el('div', 'context-tip', 'The open file or selection goes with your message. Paste or drop images to attach them.'));
    box.appendChild(el('div', 'recent'));
    if (restricted) box.appendChild(callout('notice', 'warning', 'Restricted Mode: the project\'s instruction files, allowed commands and memory are ignored until you trust this folder.'));
    log.appendChild(box);
    renderRecent();
  }

  // The welcome screen's last few conversations, each a click from reopening.
  function renderRecent() {
    const box = log.querySelector('.welcome .recent');
    if (!box) return;
    box.innerHTML = '';
    const recent = sessions.filter(s => !s.current).slice(0, 3);
    if (!recent.length) return;
    const head = el('div', 'recent-head');
    head.appendChild(el('span', '', 'Recent'));
    const all = el('button', 'small', `View all (${sessions.length})`);
    all.onclick = () => showSessions(true);
    head.appendChild(all);
    box.appendChild(head);
    for (const s of recent) {
      const row = el('button', 'recent-row');
      row.append(icon('chat'), el('span', 'title', s.title), el('span', 'when', ago(s.updated)));
      row.title = `Open "${s.title}"`;
      row.onclick = () => post({ type: 'openSession', id: s.id });
      box.appendChild(row);
    }
  }

  // A Copy button under a message, for the text as it was written (a reply's
  // Markdown, not the rendered page).
  function copyable(node, text) {
    if (!text.trim()) return;
    node.copyText = text;
    const bar = el('div', 'msg-actions');
    const button = el('button', 'icon-button copy');
    button.innerHTML = svg('copy');
    button.title = 'Copy this message';
    button.setAttribute('aria-label', 'Copy this message');
    bar.appendChild(button);
    keepBottom(() => node.appendChild(bar));
  }

  function userRow(text, imageUrls, note, imageCount) {
    const wrap = el('div', 'msg from-user');
    const bubble = el('div', 'user', text);
    if (imageUrls && imageUrls.length) {
      const strip = el('div', 'images');
      for (const url of imageUrls) { const img = el('img'); img.src = url; img.alt = 'attached image'; strip.appendChild(img); }
      bubble.appendChild(strip);
    }
    wrap.appendChild(bubble);
    const notes = [note, imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'} attached` : ''].filter(Boolean);
    if (notes.length) wrap.appendChild(el('div', 'note', notes.join(' · ')));
    append(wrap);
    copyable(wrap, text);
    return wrap;
  }

  function assistantRow(text) {
    const node = el('div', 'msg reply');
    const body = el('div', 'assistant');
    body.innerHTML = markdown(text);
    node.appendChild(body);
    append(node);
    copyable(node, text);
    return node;
  }

  function ensureAssistant() {
    if (assistant) return assistant;
    const node = el('div', 'msg reply');
    const body = el('div', 'assistant');
    node.appendChild(body);
    append(node);
    assistant = { el: node, body, raw: '', reasoning: null, reasoningRaw: '' };
    return assistant;
  }

  function renderAssistant() {
    renderQueued = false;
    if (!assistant) return;
    const a = assistant;
    keepBottom(() => {
      a.body.innerHTML = markdown(a.raw);
      if (a.reasoning) a.reasoning.querySelector('div').textContent = a.reasoningRaw;
    });
  }
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderAssistant);
  }

  // A tool call: its icon, "Read  src/app.ts", and a spinner that turns into
  // a check or a cross when it ends.
  function toolRow(label, summary, state) {
    const row = el('div', `tool ${state}`);
    const head = el('div', 'tool-head');
    head.append(icon(toolIcon(label), 'tool-icon'), el('b', '', label));
    if (summary) { const s = el('span', 'summary', summary); s.title = summary; head.appendChild(s); }
    head.appendChild(el('span', 'icon tool-state'));
    row.appendChild(head);
    if (state !== 'running') toolSettled(row, state === 'failed');
    return append(row);
  }

  function toolSettled(row, failed) {
    row.classList.remove('running');
    row.classList.add(failed ? 'failed' : 'done');
    row.querySelector('.tool-state').innerHTML = svg(failed ? 'x' : 'check');
  }

  // The result: up to three lines as they are, a longer one folded to its
  // first line with a toggle for the rest.
  function toolResult(row, display) {
    if (!display) return;
    const lines = display.split('\n');
    const box = el('div', 'tool-result');
    const text = el('span', 'text', lines.length > 3 ? lines[0] : display);
    box.appendChild(text);
    if (lines.length > 3) {
      const more = el('button', 'small more', `Show ${lines.length - 1} more lines`);
      let open = false;
      more.onclick = () => {
        open = !open;
        text.textContent = open ? display : lines[0];
        more.textContent = open ? 'Show less' : `Show ${lines.length - 1} more lines`;
      };
      box.appendChild(more);
    }
    keepBottom(() => row.appendChild(box));
  }

  function line(cls, text) { return append(el('div', cls, text)); }

  // A notice or an error: a tinted box with its icon.
  function callout(cls, name, text) {
    const row = el('div', `callout ${cls}`);
    row.append(icon(name), el('span', '', text));
    return row;
  }

  // Under a finished turn: "Worked for 9s", or that it was interrupted.
  function doneRow(stopped, text) {
    const row = el('div', `turn-done ${stopped ? 'stopped' : 'ok'}`);
    row.append(icon(stopped ? 'stop' : 'spark'), el('span', '', text));
    return append(row);
  }

  function formatTime(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  const formatTokens = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

  // ── approvals ───────────────────────────────────────────────────────────

  // A card: a header naming what is asked ("EDIT  src/app.ts"), then its body.
  function cardShell(id, kind, title, iconName) {
    const card = el('div', 'card');
    card.dataset.id = String(id);
    const head = el('div', 'card-head');
    head.append(icon(iconName), el('span', 'card-kind', kind));
    const t = el('span', 'card-title', title);
    t.title = title;
    head.appendChild(t);
    const body = el('div', 'card-body');
    card.append(head, body);
    return { card, body };
  }

  // `tone` colours the answer: 'yes' (allowed), 'no' (declined), or neither.
  function settle(card, text, tone) {
    card.classList.add('settled');
    card.querySelectorAll('.actions, textarea, input, .option').forEach(n => n.remove());
    card.querySelector('.card-body').appendChild(el('div', `answer${tone ? ` ${tone}` : ''}`, text));
  }

  function permissionCard(msg) {
    // "Edit src/app.ts" → EDIT  src/app.ts; a command's own title is its question.
    const verb = /^(Edit|Create|Overwrite) (.+)$/.exec(msg.title);
    const kind = msg.kind === 'command' ? 'Command' : msg.kind === 'outside' ? 'Outside project' : verb ? verb[1] : 'Edit';
    const iconName = msg.kind === 'command' ? 'terminal' : msg.kind === 'outside' ? 'warning' : verb && verb[1] === 'Create' ? 'filePlus' : 'pencil';
    const { card, body } = cardShell(msg.id, kind, verb ? verb[2] : msg.title, iconName);
    if (msg.detail) {
      if (msg.kind === 'edit') body.appendChild(diffPre(msg.detail));
      else { const pre = el('pre'); pre.appendChild(el('code', '', msg.detail)); body.appendChild(pre); }
    }
    for (const w of msg.warnings || []) { const row = el('div', 'warning'); row.append(icon('warning'), el('span', '', w)); body.appendChild(row); }
    const feedback = el('textarea');
    feedback.rows = 1;
    feedback.placeholder = 'Or tell KEDTec what to do instead (Enter declines with this)';
    const actions = el('div', 'actions');
    const answer = (choice, label) => {
      post({ type: 'permissionAnswer', id: msg.id, choice, feedback: feedback.value });
      settle(card, label + (choice === 'no' && feedback.value.trim() ? `: ${feedback.value.trim()}` : ''), choice === 'no' ? 'no' : 'yes');
      input.focus();
    };
    const yes = el('button', 'primary', 'Yes');
    yes.onclick = () => answer('yes', '✓ Allowed');
    actions.appendChild(yes);
    if (msg.always) {
      const always = el('button', '', msg.always);
      always.onclick = () => answer('always', `✓ ${msg.always}`);
      actions.appendChild(always);
    }
    const no = el('button', '', 'No');
    no.onclick = () => answer('no', '✗ Declined');
    actions.appendChild(no);
    feedback.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); answer('no', '✗ Declined'); }
    });
    body.append(actions, feedback);
    append(card);
    if (!input.value.trim()) yes.focus();
  }

  function questionCard(msg) {
    const questions = msg.questions || [];
    const answers = new Array(questions.length).fill('');
    const { card, body } = cardShell(msg.id, questions.length > 1 ? `${questions.length} questions` : 'Question', '', 'question');
    const submit = el('button', 'primary', 'Send answers');
    const refresh = () => { submit.disabled = answers.every(a => !a.trim()); };
    const finish = () => {
      post({ type: 'questionAnswer', id: msg.id, kind: 'answered', answers });
      settle(card, answers.map((a, i) => (a.trim() ? (questions.length > 1 ? `${questions[i].header || `Q${i + 1}`}: ${a}` : `→ ${a}`) : '')).filter(Boolean).join(' · '));
      input.focus();
    };
    questions.forEach((q, i) => {
      const box = el('div', 'question');
      const title = el('div', 'q');
      if (q.header && questions.length > 1) title.appendChild(el('small', '', q.header));
      title.appendChild(document.createTextNode(q.question));
      box.appendChild(title);
      const custom = el('input');
      custom.type = 'text';
      custom.placeholder = (q.options || []).length ? 'Or type your own answer' : 'Your answer';
      const buttons = (q.options || []).map(o => {
        const b = el('button', 'option', o.label);
        if (o.description) b.appendChild(el('small', '', o.description));
        b.onclick = () => {
          answers[i] = o.label;
          custom.value = '';
          buttons.forEach(x => x.classList.toggle('chosen', x === b));
          refresh();
          // One question with options: a click is the answer.
          if (questions.length === 1) finish();
        };
        box.appendChild(b);
        return b;
      });
      custom.addEventListener('input', () => {
        answers[i] = custom.value;
        buttons.forEach(x => x.classList.remove('chosen'));
        refresh();
      });
      custom.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing && !submit.disabled) { e.preventDefault(); finish(); }
      });
      box.appendChild(custom);
      body.appendChild(box);
    });
    const actions = el('div', 'actions');
    submit.onclick = finish;
    const skip = el('button', '', 'Skip');
    skip.onclick = () => { post({ type: 'questionAnswer', id: msg.id, kind: 'dismissed' }); settle(card, 'Skipped'); };
    const talk = el('button', '', 'Discuss instead');
    talk.onclick = () => { post({ type: 'questionAnswer', id: msg.id, kind: 'chat' }); settle(card, 'Discussing instead'); input.focus(); };
    actions.append(submit, skip, talk);
    body.appendChild(actions);
    refresh();
    append(card);
  }

  // ── footer ──────────────────────────────────────────────────────────────

  function setBusy(on) {
    busy = on;
    sendButton.title = on ? 'Stop (Esc)' : 'Send (Enter)';
    sendButton.setAttribute('aria-label', on ? 'Stop' : 'Send');
    sendButton.classList.toggle('stop', on);
    status.hidden = !on;
    clearInterval(clock);
    if (on) {
      startedAt = Date.now();
      statusLabel.textContent = 'Thinking…';
      statusTime.textContent = '';
      let frame = 0;
      clock = setInterval(() => {
        if (!reducedMotion) glyph.textContent = GLYPHS[frame++ % GLYPHS.length];
        statusTime.textContent = Date.now() - startedAt >= 1000 ? formatTime(Date.now() - startedAt) : '';
      }, 120);
    }
    refreshSend();
  }

  // An empty box has nothing to send; while a turn runs the button is Stop.
  function refreshSend() {
    sendButton.disabled = !busy && !input.value.trim() && images.length === 0;
  }

  function showMode() {
    modeButton.innerHTML = '';
    modeButton.append(el('span', 'long', MODE_LABELS[mode] || mode), el('span', 'short', MODE_SHORT[mode] || mode));
    modeButton.className = `pill mode-${mode}`;
    modeButton.title = `${MODE_LABELS[mode].replace(/^\W+ /, '')}: ${MODE_ABOUT[mode] || ''}. Click or Shift+Tab to change.`;
  }

  function cycleMode() {
    if (modes.length < 2) return;
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    showMode();
    post({ type: 'setMode', mode });
  }

  function fillSelect(select, values, current, label) {
    select.innerHTML = '';
    for (const v of values) {
      const opt = el('option', '', label(v));
      opt.value = typeof v === 'string' ? v : v.id;
      select.appendChild(opt);
    }
    select.value = current;
  }

  function renderAttachments() {
    attachments.innerHTML = '';
    images.forEach((url, i) => {
      const box = el('div', 'attachment');
      const img = el('img');
      img.src = url;
      img.alt = `image ${i + 1}`;
      const remove = el('button', '', '×');
      remove.title = 'Remove';
      remove.onclick = () => { images.splice(i, 1); renderAttachments(); };
      box.append(img, remove);
      attachments.appendChild(box);
    });
    refreshSend();
  }

  // Pasted, dropped or picked: images become attachments, anything else is ignored.
  function attachFiles(files) {
    for (const file of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) continue;
      const reader = new FileReader();
      reader.onload = () => { images.push(String(reader.result)); renderAttachments(); };
      reader.readAsDataURL(file);
    }
  }

  // ── conversations: this folder's saved sessions ─────────────────────────
  // The list comes from the extension (session.ts, shared with the CLI);
  // opening, renaming and deleting are asked of it, and it sends the list back.

  function ago(iso) {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function bucket(iso) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const t = Date.parse(iso);
    const day = 86400000;
    if (t >= today.getTime()) return 'Today';
    if (t >= today.getTime() - day) return 'Yesterday';
    if (t >= today.getTime() - 7 * day) return 'Previous 7 days';
    if (t >= today.getTime() - 30 * day) return 'Previous 30 days';
    return 'Older';
  }

  function showSessions(on) {
    if (on === !sessionsView.hidden) return;
    sessionsView.hidden = !on;
    document.body.classList.toggle('show-sessions', on);
    renaming = null;
    if (on) {
      post({ type: 'sessions' });
      sessionsFilter.value = '';
      renderSessions();
      sessionsFilter.focus();
    } else input.focus();
  }

  function renderSessions() {
    if (sessionsView.hidden || renaming) return;
    const query = sessionsFilter.value.trim().toLowerCase();
    const shown = sessions.filter(s => !query || s.title.toLowerCase().includes(query));
    sessionsList.innerHTML = '';
    const others = sessions.filter(s => !s.current).length;
    sessionsClear.hidden = others === 0;
    sessionsClear.textContent = `Delete ${others === 1 ? 'the other conversation' : `all ${others} others`}…`;
    if (!shown.length) {
      const empty = el('div', 'sessions-empty');
      empty.append(icon('chat'), el('div', '', query ? 'No conversation matches.' : 'No saved conversations in this folder yet.'));
      sessionsList.appendChild(empty);
      return;
    }
    let group = '';
    for (const s of shown) {
      const g = bucket(s.updated);
      if (g !== group) { group = g; sessionsList.appendChild(el('div', 'sessions-group', g)); }
      sessionsList.appendChild(sessionRow(s));
    }
  }

  function sessionRow(s) {
    const row = el('div', `session${s.current ? ' current' : ''}`);
    row.setAttribute('role', 'listitem');
    row.dataset.id = s.id;
    row.tabIndex = 0;
    row.title = s.current ? 'The conversation in progress' : `Open "${s.title}"`;
    const main = el('div', 'session-main');
    const meta = el('div', 'session-meta', `${ago(s.updated)} · ${s.messages} message${s.messages === 1 ? '' : 's'}`);
    if (s.current) meta.prepend(el('span', 'badge', 'Current'));
    main.append(el('div', 'session-title', s.title), meta);
    const actions = el('div', 'session-actions');
    const rename = el('button', 'icon-button');
    rename.innerHTML = svg('pencil');
    rename.title = 'Rename';
    rename.setAttribute('aria-label', 'Rename');
    rename.onclick = e => { e.stopPropagation(); startRename(row, s); };
    actions.appendChild(rename);
    // The conversation in progress is never deleted, as in the CLI.
    if (!s.current) {
      const del = el('button', 'icon-button danger');
      del.innerHTML = svg('trash');
      del.title = 'Delete';
      del.setAttribute('aria-label', 'Delete');
      del.onclick = e => { e.stopPropagation(); confirmDelete(row, s); };
      actions.appendChild(del);
    }
    row.append(icon('chat'), main, actions);
    const open = () => {
      if (!s.current) post({ type: 'openSession', id: s.id });
      showSessions(false);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => {
      if (e.target !== row) return;
      if (e.key === 'Enter') { e.preventDefault(); open(); } else if (e.key === 'F2') { e.preventDefault(); startRename(row, s); } else if (e.key === 'Delete' && !s.current) { e.preventDefault(); confirmDelete(row, s); } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...sessionsList.querySelectorAll('.session')];
        rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
    });
    return row;
  }

  // The title becomes a text box: Enter or leaving it saves, Esc cancels.
  function startRename(row, s) {
    renaming = s.id;
    const box = el('input', 'session-rename');
    box.type = 'text';
    box.value = s.title === '(untitled)' ? '' : s.title;
    box.placeholder = 'Conversation title';
    box.setAttribute('aria-label', 'Conversation title');
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      renaming = null;
      const title = box.value.trim();
      if (save && title && title !== s.title) { s.title = title; post({ type: 'renameSession', id: s.id, title }); }
      renderSessions();
      sessionsList.querySelector(`.session[data-id="${CSS.escape(s.id)}"]`)?.focus();
    };
    box.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    box.addEventListener('blur', () => finish(true));
    box.addEventListener('click', e => e.stopPropagation());
    row.querySelector('.session-title').replaceWith(box);
    row.querySelector('.session-actions').hidden = true;
    box.focus();
    box.select();
  }

  // Asked in the row itself: "Delete this conversation?  Delete  Cancel".
  function confirmDelete(row, s) {
    row.classList.add('confirming');
    row.innerHTML = '';
    row.append(icon('trash'), el('div', 'session-main', 'Delete this conversation? It cannot be undone.'));
    const actions = el('div', 'session-confirm');
    const yes = el('button', 'danger-fill', 'Delete');
    const no = el('button', '', 'Cancel');
    yes.onclick = e => { e.stopPropagation(); sessions = sessions.filter(x => x !== s); post({ type: 'deleteSession', id: s.id }); renderSessions(); renderRecent(); };
    no.onclick = e => { e.stopPropagation(); renderSessions(); };
    actions.append(yes, no);
    row.appendChild(actions);
    no.focus();
  }

  $('sessions-back').addEventListener('click', () => showSessions(false));
  $('sessions-new').addEventListener('click', () => { showSessions(false); post({ type: 'newChat' }); });
  sessionsFilter.addEventListener('input', renderSessions);
  sessionsFilter.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sessionsList.querySelector('.session')?.focus(); }
    if (e.key === 'Enter') { e.preventDefault(); sessionsList.querySelector('.session')?.click(); }
  });
  sessionsView.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !renaming) { e.preventDefault(); showSessions(false); }
  });
  sessionsClear.addEventListener('click', () => {
    const foot = sessionsClear.parentElement;
    const others = sessions.filter(s => !s.current).length;
    sessionsClear.hidden = true;
    const ask = el('div', 'session-confirm wide');
    ask.appendChild(el('span', '', `Delete ${others} conversation${others === 1 ? '' : 's'}? The current one is kept.`));
    const yes = el('button', 'danger-fill', 'Delete');
    const no = el('button', '', 'Cancel');
    const close = () => { ask.remove(); renderSessions(); };
    yes.onclick = () => { sessions = sessions.filter(s => s.current); post({ type: 'deleteAllSessions' }); close(); renderRecent(); };
    no.onclick = close;
    ask.append(yes, no);
    foot.appendChild(ask);
    no.focus();
  });

  // ── suggestions: "/" lists the commands, "@" the project's files ───────
  // The commands are known here; the files come from the extension, which
  // asks mentions.ts as the CLI's input box does.

  function updateSuggest() {
    const m = /^\/(\S*)$/.exec(input.value);
    if (m) {
      mention = null;
      renderSuggest(commands.filter(c => c.name.startsWith(`/${m[1].toLowerCase()}`)).map(c => ({ kind: 'command', ...c })));
      return;
    }
    const cursor = input.selectionStart ?? input.value.length;
    const at = /(?:^|\s)@([^\s@]*)$/.exec(input.value.slice(0, cursor));
    if (!at) { closeSuggest(); return; }
    let end = cursor;
    while (end < input.value.length && !/\s/.test(input.value[end])) end++;
    mention = { start: cursor - at[1].length - 1, end, query: at[1] };
    post({ type: 'mentions', id: ++mentionSeq, query: at[1] });
  }

  function renderSuggest(list) {
    matches = list;
    if (matches.length === 0) { suggest.hidden = true; return; }
    picked = Math.min(picked, matches.length - 1);
    suggest.innerHTML = '';
    matches.forEach((item, i) => {
      const row = el('div', `suggestion${i === picked ? ' picked' : ''}`);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === picked));
      if (item.kind === 'command') {
        row.append(icon('slash'), el('b', '', item.name));
        if (item.args) row.appendChild(el('span', 'args', ` ${item.args}`));
        row.appendChild(el('span', 'about', item.about));
      } else {
        // "chat.ts  ide-bridge/src/": the name first, the folder after it.
        const dir = item.path.endsWith('/');
        const trimmed = dir ? item.path.slice(0, -1) : item.path;
        const cut = trimmed.lastIndexOf('/');
        row.append(icon(dir ? 'folder' : 'file'), el('b', 'file', `${trimmed.slice(cut + 1)}${dir ? '/' : ''}`));
        if (cut >= 0) row.appendChild(el('span', 'about', trimmed.slice(0, cut + 1)));
        row.title = item.path;
      }
      // mousedown, so the input keeps focus.
      row.addEventListener('mousedown', e => { e.preventDefault(); choose(i); });
      suggest.appendChild(row);
    });
    suggest.hidden = false;
    suggest.querySelector('.picked')?.scrollIntoView({ block: 'nearest' });
  }

  function closeSuggest() {
    suggest.hidden = true;
    matches = [];
    picked = 0;
    mention = null;
  }

  // A command that takes nothing runs at once; one with arguments is written
  // into the box for them to be typed after it. A file replaces the "@…"
  // being typed; a folder stays open for the next level, as in the CLI.
  function choose(i) {
    const item = matches[i];
    if (!item) return;
    if (item.kind === 'file') {
      const at = mention;
      if (!at) return;
      const value = item.path.endsWith('/') ? `@${item.path}` : `@${item.path} `;
      input.value = input.value.slice(0, at.start) + value + input.value.slice(at.end).replace(/^ /, '');
      const caret = at.start + value.length;
      input.setSelectionRange(caret, caret);
      resize();
      input.focus();
      if (item.path.endsWith('/')) { picked = 0; updateSuggest(); } else closeSuggest();
      return;
    }
    closeSuggest();
    // While a turn runs, the send button is Stop: leave the command in the box.
    if (item.args || busy) {
      input.value = item.args ? `${item.name} ` : item.name;
      resize();
      input.focus();
    } else {
      input.value = item.name;
      submit();
    }
  }

  function resize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    refreshSend();
  }

  function submit() {
    if (busy) { post({ type: 'stop' }); return; }
    const text = input.value;
    if (!text.trim() && images.length === 0) return;
    if (text.trim()) { history.push(text); historyAt = -1; }
    post({ type: 'send', text, images, includeEditor });
    input.value = '';
    images = [];
    renderAttachments();
    resize();
  }

  sendButton.addEventListener('click', submit);
  input.addEventListener('input', () => { picked = 0; resize(); updateSuggest(); });
  input.addEventListener('blur', closeSuggest);
  // Moving the caret into or out of an "@…" opens or closes its list.
  input.addEventListener('click', updateSuggest);
  input.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateSuggest(); });
  input.addEventListener('keydown', e => {
    // Shift+Tab changes the mode, as in the CLI.
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (!suggest.hidden && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        picked = (picked + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        renderSuggest(matches);
        return;
      }
      // Enter on a command typed out in full runs it, arguments or not.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matches[picked].kind === 'command' && matches[picked].name === input.value && !busy) { e.preventDefault(); closeSuggest(); submit(); return; }
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') { e.preventDefault(); choose(picked); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) submit(); return; }
    if (e.key === 'Escape' && busy) { e.preventDefault(); post({ type: 'stop' }); return; }
    // ↑/↓ walk what was sent, while the box is empty or showing an old message.
    const browsing = !input.value || (historyAt >= 0 && input.value === history[historyAt]);
    if (e.key === 'ArrowUp' && browsing && history.length) {
      e.preventDefault();
      historyAt = historyAt < 0 ? history.length - 1 : Math.max(0, historyAt - 1);
      input.value = history[historyAt];
      resize();
    } else if (e.key === 'ArrowDown' && browsing && historyAt >= 0) {
      e.preventDefault();
      historyAt = historyAt + 1 < history.length ? historyAt + 1 : -1;
      input.value = historyAt < 0 ? '' : history[historyAt];
      resize();
    }
  });
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])].filter(it => it.kind === 'file' && it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
    if (files.length === 0) return;
    e.preventDefault();
    attachFiles(files);
  });
  $('attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { attachFiles([...fileInput.files]); fileInput.value = ''; input.focus(); });
  // Dropping onto the panel; VS Code wants Shift held to drop into a webview.
  let dragDepth = 0;
  document.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; composer.classList.add('dragging'); } });
  document.addEventListener('dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) composer.classList.remove('dragging'); });
  document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    dragDepth = 0;
    composer.classList.remove('dragging');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    attachFiles([...e.dataTransfer.files]);
  });
  log.addEventListener('scroll', () => { toBottom.hidden = atBottom(); });
  toBottom.addEventListener('click', () => { log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }); });
  document.addEventListener('keydown', e => {
    // Not the Esc that just closed the conversations view.
    if (e.key === 'Escape' && busy && !e.defaultPrevented && document.activeElement !== input) post({ type: 'stop' });
  });

  modeButton.addEventListener('click', cycleMode);
  modelSelect.addEventListener('change', () => post({ type: 'setModel', id: modelSelect.value }));
  contextChip.addEventListener('click', () => {
    includeEditor = !includeEditor;
    contextChip.classList.toggle('off', !includeEditor);
    contextChip.title = includeEditor
      ? 'Sent with the next message (click to leave it out)'
      : 'Not sent (click to send it with the next message)';
  });

  log.addEventListener('click', e => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const copy = target.closest('.copy');
    if (copy) {
      // A code block's button copies the code; a message's, the whole message.
      const block = copy.closest('.code');
      const text = block ? block.querySelector('code')?.textContent ?? '' : copy.closest('.msg')?.copyText ?? '';
      navigator.clipboard.writeText(text).then(() => {
        copy.classList.add('copied');
        copy.innerHTML = svg('check');
        setTimeout(() => { copy.classList.remove('copied'); copy.innerHTML = svg('copy'); }, 1200);
      }, () => { /* the clipboard refused; nothing to undo */ });
      return;
    }
    const file = target.closest('[data-file]');
    if (file) post({ type: 'openFile', path: file.getAttribute('data-file') });
  });

  // ── messages from the extension ─────────────────────────────────────────

  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'reset': {
        showSessions(false);
        assistant = null;
        runningTool = null;
        log.innerHTML = '';
        if (!msg.items.length) { welcome(); break; }
        for (const item of msg.items) {
          if (item.type === 'user') userRow(item.text, [], '', item.images);
          else if (item.type === 'assistant') assistantRow(item.text);
          else if (item.type === 'tool') toolRow(item.label, item.summary, item.isError ? 'failed' : 'done');
          else if (item.type === 'notice') append(callout('notice', 'warning', item.message));
        }
        log.scrollTop = log.scrollHeight;
        break;
      }
      case 'state': {
        restricted = !!msg.restricted;
        commands = msg.commands || commands;
        log.querySelector('.fatal')?.remove();
        if (!log.children.length) welcome();
        modes = msg.modes;
        mode = msg.mode;
        showMode();
        fillSelect(modelSelect, msg.models, msg.model, m => m.label);
        modelSelect.title = `Model: ${msg.model} (saved as the default when changed)`;
        // The share of the context window the last request used, once known.
        usage.textContent = !msg.used ? '' : msg.contextWindow ? `${Math.round((msg.used / msg.contextWindow) * 100)}%` : formatTokens(msg.used);
        usage.title = msg.used ? `${msg.used.toLocaleString()}${msg.contextWindow ? ` of ${msg.contextWindow.toLocaleString()}` : ''} tokens of context used (/compact frees it)` : '';
        if (msg.busy !== busy) setBusy(msg.busy);
        break;
      }
      case 'sessions':
        sessions = msg.items || [];
        renderRecent();
        renderSessions();
        if (msg.show) showSessions(true);
        break;
      case 'context':
        contextLabel.textContent = msg.label || '';
        contextChip.hidden = !msg.label;
        break;
      case 'mentionResults':
        // Only an answer for what is typed now; one for an earlier query is stale.
        if (mention && msg.query === mention.query) renderSuggest(msg.items.map(p => ({ kind: 'file', path: p })));
        break;
      case 'user':
        assistant = null;
        userRow(msg.text, msg.images, msg.note, 0);
        break;
      case 'busy':
        setBusy(msg.busy);
        break;
      case 'status':
        statusLabel.textContent = msg.label;
        break;
      case 'text': {
        const a = ensureAssistant();
        a.raw += msg.delta;
        queueRender();
        break;
      }
      case 'reasoning': {
        const a = ensureAssistant();
        if (!a.reasoning) {
          a.reasoning = el('details', 'reasoning');
          const summary = el('summary');
          summary.innerHTML = `${svg('chevron')}Thinking`;
          a.reasoning.appendChild(summary);
          a.reasoning.appendChild(el('div'));
          a.el.insertBefore(a.reasoning, a.body);
        }
        a.reasoningRaw += msg.delta;
        queueRender();
        break;
      }
      case 'assistantEnd':
        if (assistant) {
          renderAssistant();
          if (!assistant.raw.trim() && !assistant.reasoningRaw) assistant.el.remove();
          else copyable(assistant.el, assistant.raw);
        }
        assistant = null;
        break;
      case 'toolStart':
        runningTool = toolRow(msg.label, msg.summary, 'running');
        statusLabel.textContent = `${msg.label === 'Bash' ? 'Running' : msg.label}…`;
        break;
      case 'toolEnd':
        if (runningTool) {
          toolSettled(runningTool, msg.isError);
          toolResult(runningTool, msg.display);
          runningTool = null;
        }
        break;
      case 'sources': {
        if (!msg.rows.length) break;
        const box = el('div', 'sources');
        box.appendChild(el('div', 'label', 'Sources'));
        for (const r of msg.rows) { const d = el('div', '', r); d.title = r; box.appendChild(d); }
        append(box);
        break;
      }
      case 'notice':
        append(callout('notice', 'warning', msg.message));
        break;
      case 'info':
        line('info', msg.text);
        break;
      case 'error':
        append(callout('error', 'error', msg.message));
        break;
      case 'done':
        if (msg.stopped) doneRow(true, 'Interrupted — what should KEDTec do instead?');
        else doneRow(false, `Worked for ${formatTime(Date.now() - startedAt)}`);
        break;
      case 'permission':
        permissionCard(msg);
        statusLabel.textContent = 'Waiting for your approval';
        break;
      case 'question':
        questionCard(msg);
        statusLabel.textContent = 'Waiting for your answer';
        break;
      case 'settled': {
        const card = log.querySelector(`.card[data-id="${msg.id}"]:not(.settled)`);
        if (card) settle(card, 'Cancelled');
        break;
      }
      case 'fatal': {
        log.innerHTML = '';
        const box = el('div', 'fatal');
        box.append(icon('warning'), el('p', '', msg.message));
        const actions = el('div', 'actions');
        if (msg.signIn) {
          const signIn = el('button', 'primary', 'Sign in');
          signIn.onclick = () => post({ type: 'signIn' });
          actions.appendChild(signIn);
        }
        const retry = el('button', '', 'Retry');
        retry.onclick = () => post({ type: 'retry' });
        actions.appendChild(retry);
        box.appendChild(actions);
        log.appendChild(box);
        break;
      }
    }
  });

  welcome();
  refreshSend();
  input.focus();
  post({ type: 'ready' });
})();

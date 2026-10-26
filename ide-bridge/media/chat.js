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
  const modeSelect = $('mode');
  const modelSelect = $('model');
  const contextChip = $('context');
  const usage = $('usage');
  const attachments = $('attachments');
  const suggest = $('suggest');

  const MODE_LABELS = { default: 'Ask before edits', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan (read-only)', bypass: 'Bypass permissions' };

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
  let matches = [];
  let picked = 0;

  const post = msg => vscode.postMessage(msg);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

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
    return `<div class="code"><div class="code-head"><span>${escapeHtml(lang || '')}</span><button class="small copy" title="Copy">Copy</button></div>`
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

  function welcome() {
    log.innerHTML = '';
    const box = el('div', 'welcome');
    box.innerHTML = `<h2>KEDTec</h2>
      <p>Ask about this project, or have KEDTec change it. It reads files, edits them and runs commands,
      and asks first according to the mode below.</p>
      <ul>
        <li>The open file, or the lines selected in it, go with your message (the chip below; click it to leave them out).</li>
        <li>Paste an image to attach it.</li>
        <li>Type <code>/</code> for commands: <code>/compact</code> frees context, <code>/clear</code> starts over, <code>/init</code> writes a KEDTEC.md. <kbd>Esc</kbd> stops a turn.</li>
        <li>Conversations are shared with the <code>kedtec</code> CLI: <code>kedtec -c</code> continues the last one.</li>
      </ul>`;
    if (restricted) box.appendChild(el('p', 'notice', 'Restricted Mode: the project\'s instruction files, allowed commands and memory are ignored until you trust this folder.'));
    log.appendChild(box);
  }

  // A Copy button under a message, for the text as it was written (a reply's
  // Markdown, not the rendered page).
  function copyable(node, text) {
    if (!text.trim()) return;
    node.copyText = text;
    const bar = el('div', 'msg-actions');
    const button = el('button', 'small copy', 'Copy');
    button.title = 'Copy this message';
    bar.appendChild(button);
    keepBottom(() => node.appendChild(bar));
  }

  function userRow(text, imageUrls, note, imageCount) {
    const row = el('div', 'msg user', text);
    if (imageUrls && imageUrls.length) {
      const strip = el('div', 'images');
      for (const url of imageUrls) { const img = el('img'); img.src = url; img.alt = 'attached image'; strip.appendChild(img); }
      row.appendChild(strip);
    }
    const wrap = el('div');
    wrap.appendChild(row);
    const notes = [note, imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'} attached` : ''].filter(Boolean);
    if (notes.length) wrap.appendChild(el('div', 'note', notes.join(' · ')));
    wrap.className = 'msg';
    row.classList.remove('msg');
    append(wrap);
    copyable(wrap, text);
    return wrap;
  }

  function assistantRow(text) {
    const node = el('div', 'msg');
    const body = el('div', 'assistant');
    body.innerHTML = markdown(text);
    node.appendChild(body);
    append(node);
    copyable(node, text);
    return node;
  }

  function ensureAssistant() {
    if (assistant) return assistant;
    const node = el('div', 'msg');
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

  function toolRow(label, summary, state) {
    const row = el('div', `tool ${state}`);
    const head = el('div', 'tool-head');
    head.appendChild(el('span', 'dot'));
    head.appendChild(el('b', '', label));
    if (summary) { const s = el('span', 'summary', summary); s.title = summary; head.appendChild(s); }
    row.appendChild(head);
    return append(row);
  }

  function toolResult(row, display) {
    if (!display) return;
    const lines = display.split('\n');
    const box = el('div', 'tool-result');
    if (lines.length > 12) {
      const details = el('details');
      details.appendChild(el('summary', '', `${lines[0]}  (${lines.length - 1} more lines)`));
      details.appendChild(document.createTextNode(lines.slice(1).join('\n')));
      box.appendChild(details);
    } else box.textContent = display;
    keepBottom(() => row.appendChild(box));
  }

  function line(cls, text) { return append(el('div', cls, text)); }

  function formatTime(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  const formatTokens = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

  // ── approvals ───────────────────────────────────────────────────────────

  function settle(card, text) {
    card.classList.add('settled');
    card.querySelectorAll('.actions, textarea, input, .option').forEach(n => n.remove());
    card.appendChild(el('div', 'answer', text));
  }

  function permissionCard(msg) {
    const card = el('div', 'card');
    card.dataset.id = String(msg.id);
    card.appendChild(el('div', 'card-title', msg.title));
    if (msg.detail) {
      if (msg.kind === 'edit') card.appendChild(diffPre(msg.detail));
      else { const pre = el('pre'); pre.appendChild(el('code', '', msg.detail)); card.appendChild(pre); }
    }
    for (const w of msg.warnings || []) card.appendChild(el('div', 'warning', `⚠ ${w}`));
    const feedback = el('textarea');
    feedback.rows = 1;
    feedback.placeholder = 'Or tell KEDTec what to do instead (Enter declines with this)';
    const actions = el('div', 'actions');
    const answer = (choice, label) => {
      post({ type: 'permissionAnswer', id: msg.id, choice, feedback: feedback.value });
      settle(card, label + (choice === 'no' && feedback.value.trim() ? `: ${feedback.value.trim()}` : ''));
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
    card.appendChild(actions);
    card.appendChild(feedback);
    append(card);
    if (!input.value.trim()) yes.focus();
  }

  function questionCard(msg) {
    const questions = msg.questions || [];
    const answers = new Array(questions.length).fill('');
    const card = el('div', 'card');
    card.dataset.id = String(msg.id);
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
      card.appendChild(box);
    });
    const actions = el('div', 'actions');
    submit.onclick = finish;
    const skip = el('button', '', 'Skip');
    skip.onclick = () => { post({ type: 'questionAnswer', id: msg.id, kind: 'dismissed' }); settle(card, 'Skipped'); };
    const talk = el('button', '', 'Discuss instead');
    talk.onclick = () => { post({ type: 'questionAnswer', id: msg.id, kind: 'chat' }); settle(card, 'Discussing instead'); input.focus(); };
    actions.append(submit, skip, talk);
    card.appendChild(actions);
    refresh();
    append(card);
  }

  // ── footer ──────────────────────────────────────────────────────────────

  function setBusy(on) {
    busy = on;
    sendButton.textContent = on ? 'Stop' : 'Send';
    sendButton.title = on ? 'Stop (Esc)' : 'Send (Enter)';
    sendButton.classList.toggle('stop', on);
    status.hidden = !on;
    clearInterval(clock);
    if (on) {
      startedAt = Date.now();
      statusLabel.textContent = 'Thinking…';
      statusTime.textContent = '';
      clock = setInterval(() => { statusTime.textContent = formatTime(Date.now() - startedAt); }, 1000);
    }
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
  }

  // ── slash commands: typing "/" lists them, filtered as you type ─────────

  function updateSuggest() {
    const m = /^\/(\S*)$/.exec(input.value);
    matches = m ? commands.filter(c => c.name.startsWith(`/${m[1].toLowerCase()}`)) : [];
    if (matches.length === 0) { suggest.hidden = true; return; }
    picked = Math.min(picked, matches.length - 1);
    suggest.innerHTML = '';
    matches.forEach((c, i) => {
      const row = el('div', `suggestion${i === picked ? ' picked' : ''}`);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === picked));
      row.appendChild(el('b', '', c.name));
      if (c.args) row.appendChild(el('span', 'args', ` ${c.args}`));
      row.appendChild(el('span', 'about', c.about));
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
  }

  // A command that takes nothing runs at once; one with arguments is written
  // into the box for them to be typed after it.
  function choose(i) {
    const c = matches[i];
    if (!c) return;
    closeSuggest();
    // While a turn runs, the send button is Stop: leave the command in the box.
    if (c.args || busy) {
      input.value = c.args ? `${c.name} ` : c.name;
      resize();
      input.focus();
    } else {
      input.value = c.name;
      submit();
    }
  }

  function resize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
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
  input.addEventListener('keydown', e => {
    if (!suggest.hidden && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        picked = (picked + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        updateSuggest();
        return;
      }
      // Enter on a command typed out in full runs it, arguments or not.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matches[picked].name === input.value && !busy) { e.preventDefault(); closeSuggest(); submit(); return; }
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
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => { images.push(String(reader.result)); renderAttachments(); };
      reader.readAsDataURL(file);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && busy && document.activeElement !== input) post({ type: 'stop' });
  });

  modeSelect.addEventListener('change', () => post({ type: 'setMode', mode: modeSelect.value }));
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
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
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
        assistant = null;
        runningTool = null;
        log.innerHTML = '';
        if (!msg.items.length) { welcome(); break; }
        for (const item of msg.items) {
          if (item.type === 'user') userRow(item.text, [], '', item.images);
          else if (item.type === 'assistant') assistantRow(item.text);
          else if (item.type === 'tool') toolRow(item.label, item.summary, item.isError ? 'failed' : 'done');
          else if (item.type === 'notice') line('notice', item.message);
        }
        log.scrollTop = log.scrollHeight;
        break;
      }
      case 'state': {
        restricted = !!msg.restricted;
        commands = msg.commands || commands;
        log.querySelector('.fatal')?.remove();
        if (!log.children.length) welcome();
        fillSelect(modeSelect, msg.modes, msg.mode, m => MODE_LABELS[m] || m);
        modeSelect.className = `mode-${msg.mode}`;
        fillSelect(modelSelect, msg.models, msg.model, m => m.label);
        modelSelect.title = `Model: ${msg.model}`;
        usage.textContent = msg.used ? `${formatTokens(msg.used)}${msg.contextWindow ? ` / ${formatTokens(msg.contextWindow)}` : ''} ctx` : '';
        usage.title = msg.contextWindow && msg.used ? `${Math.round((msg.used / msg.contextWindow) * 100)}% of the context window used` : '';
        if (msg.busy !== busy) setBusy(msg.busy);
        break;
      }
      case 'context':
        contextChip.textContent = msg.label || '';
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
          a.reasoning.appendChild(el('summary', '', 'Thinking'));
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
          runningTool.classList.remove('running');
          runningTool.classList.add(msg.isError ? 'failed' : 'done');
          toolResult(runningTool, msg.display);
          runningTool = null;
        }
        break;
      case 'sources': {
        if (!msg.rows.length) break;
        const box = el('div', 'sources');
        box.appendChild(el('div', '', 'Sources:'));
        for (const r of msg.rows) { const d = el('div', '', `  ${r}`); d.title = r; box.appendChild(d); }
        append(box);
        break;
      }
      case 'notice':
        line('notice', `! ${msg.message}`);
        break;
      case 'info':
        line('info', msg.text);
        break;
      case 'error':
        line('error', `✗ ${msg.message}`);
        break;
      case 'done':
        line('done', msg.stopped ? '⎿ Interrupted' : `✻ Worked for ${formatTime(Date.now() - startedAt)}`);
        break;
      case 'permission':
        permissionCard(msg);
        break;
      case 'question':
        questionCard(msg);
        break;
      case 'settled': {
        const card = log.querySelector(`.card[data-id="${msg.id}"]:not(.settled)`);
        if (card) settle(card, 'Cancelled');
        break;
      }
      case 'fatal': {
        log.innerHTML = '';
        const box = el('div', 'fatal');
        box.appendChild(el('p', '', msg.message));
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
  input.focus();
  post({ type: 'ready' });
})();

"use strict";
// Unified line diffs for the confirmation card (src/tools.ts) — so the user
// approves an edit they can actually see, instead of "Replace a section of
// src/foo.ts with updated content".
//
// Deliberately dependency-free (this extension bundles nothing it doesn't have
// to) and sized for display, not for patching: the output is text a human skims
// before clicking Allow, so it's capped, and nothing downstream tries to apply
// it. That's why there's no `@@` line-count arithmetic to get subtly wrong —
// hunk headers carry the starting line numbers and nothing else.
Object.defineProperty(exports, "__esModule", { value: true });
exports.unifiedDiff = unifiedDiff;
exports.additionsOnly = additionsOnly;
const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 400;
// Above this many differing lines on either side, the O(n·m) LCS table is more
// memory than a preview is worth (a 5,000-line rewrite would allocate 25M
// cells). Past it, the changed region is reported as one wholesale
// replacement — still an honest picture of what's about to happen, just
// without line-level matching inside it.
const MAX_LCS_LINES = 1500;
// Longest common subsequence over lines, walked back into an edit script.
// Only ever called on the region that differs after common prefix/suffix have
// been stripped, which in practice is small even for large files.
function lcsOps(a, b) {
    const n = a.length, m = b.length;
    // table[i][j] = LCS length of a[i…] and b[j…]
    const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ kind: 'ctx', text: a[i] });
            i++;
            j++;
        }
        else if (table[i + 1][j] >= table[i][j + 1]) {
            ops.push({ kind: 'del', text: a[i] });
            i++;
        }
        else {
            ops.push({ kind: 'add', text: b[j] });
            j++;
        }
    }
    while (i < n) {
        ops.push({ kind: 'del', text: a[i] });
        i++;
    }
    while (j < m) {
        ops.push({ kind: 'add', text: b[j] });
        j++;
    }
    return ops;
}
function diffOps(a, b) {
    // Common prefix/suffix first: an edit to one function in a 2,000-line file
    // leaves only the handful of lines around it for the expensive part.
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
        start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const head = a.slice(0, start).map((text) => ({ kind: 'ctx', text }));
    const tail = a.slice(endA).map((text) => ({ kind: 'ctx', text }));
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    let mid;
    if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
        mid = [
            ...midA.map((text) => ({ kind: 'del', text })),
            ...midB.map((text) => ({ kind: 'add', text })),
        ];
    }
    else {
        mid = lcsOps(midA, midB);
    }
    return [...head, ...mid, ...tail];
}
// Groups the edit script into hunks, dropping runs of context longer than
// 2×context so unchanged stretches don't pad the card.
function toUnified(ops, context, maxLines) {
    const changed = ops.map(o => o.kind !== 'ctx');
    const keep = new Array(ops.length).fill(false);
    for (let i = 0; i < ops.length; i++) {
        if (!changed[i])
            continue;
        for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++)
            keep[j] = true;
    }
    const lines = [];
    // Line numbers in the *old* file for context/deletions, in the *new* file for
    // additions — tracked separately so a hunk header can name both.
    let oldLine = 1, newLine = 1;
    let inHunk = false;
    let truncated = false;
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (keep[i]) {
            if (!inHunk) {
                lines.push(`@@ line ${op.kind === 'add' ? newLine : oldLine} @@`);
                inHunk = true;
            }
            lines.push((op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' ') + op.text);
            if (lines.length >= maxLines) {
                // Count what's left so the trailer can say how much was hidden rather
                // than just trailing off.
                let rest = 0;
                for (let j = i + 1; j < ops.length; j++)
                    if (keep[j])
                        rest++;
                if (rest > 0) {
                    lines.push(`… ${rest} more line${rest === 1 ? '' : 's'} not shown`);
                    truncated = true;
                }
                break;
            }
        }
        else {
            inHunk = false;
        }
        if (op.kind !== 'add')
            oldLine++;
        if (op.kind !== 'del')
            newLine++;
    }
    if (!truncated && lines.length === 0)
        return '';
    return lines.join('\n');
}
const splitLines = (text) => (text === '' ? [] : text.split('\n'));
// A unified diff of two whole texts, or '' when they're identical.
function unifiedDiff(oldText, newText, opts = {}) {
    if (oldText === newText)
        return '';
    const context = opts.context ?? DEFAULT_CONTEXT;
    const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
    return toUnified(diffOps(splitLines(oldText), splitLines(newText)), context, maxLines);
}
// Every line as an addition — for a file that doesn't exist yet, where a diff
// against '' would be correct but says "no old file" less clearly.
function additionsOnly(text, opts = {}) {
    const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
    const lines = splitLines(text);
    const shown = lines.slice(0, maxLines).map(l => '+' + l);
    if (lines.length > maxLines) {
        const rest = lines.length - maxLines;
        shown.push(`… ${rest} more line${rest === 1 ? '' : 's'} not shown`);
    }
    return shown.join('\n');
}
//# sourceMappingURL=diff.js.map
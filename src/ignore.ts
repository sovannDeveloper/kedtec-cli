import * as fs from 'fs';
import * as path from 'path';
// Unreadable .gitignore files are skipped silently: this is a search filter.
const logError = (_where: string, _err: unknown): void => {};

// .gitignore support. Written for the three search tools in src/tools.ts, which
// were removed when the file tools were replaced by run_command; the surviving
// consumer is @file mention search in chatViewProvider.ts. A search the *model*
// runs is shell now, and is not filtered by any of this.
//
// The hardcoded exclusion list these tools used to carry — node_modules, .git,
// out, dist, .vscode — is JS-project shaped. In a Python, Rust, Go, or PHP repo
// it meant `.venv/`, `target/`, `vendor/`, `__pycache__/`, and `build/` were
// walked, matched, and dumped into the model's context: wasted tokens, and real
// results buried under generated ones. Every one of those repos already states
// what's noise, in the file git reads. So read that.
//
// This implements the practical subset of gitignore(5): comments, blank lines,
// negation (`!`), directory-only rules (trailing `/`), anchoring (a leading or
// interior `/`), basename matching for everything else, `*`/`?`/`**`/`[…]`
// globs, and nested `.gitignore` files overriding shallower ones. It does not
// implement `.git/info/exclude`, the global core.excludesFile, or the index —
// this is a search filter, not a reimplementation of git.

// Used only when a workspace has no .gitignore at all — an unversioned scratch
// directory, say. Better than filtering nothing; .git is excluded regardless.
const FALLBACK_IGNORE = ['node_modules', 'out', 'dist', '.vscode'];

interface Rule {
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
  // Set only for the simple case — an un-anchored, glob-free name like
  // `node_modules` or `.venv` — which is the shape a coarse pre-filter can use
  // directly (see coarseDirNames).
  literalName?: string;
}

// One .gitignore file's rules, plus the directory they're relative to
// (workspace-relative, '' for the root).
interface Scope {
  baseRel: string;
  rules: Rule[];
}

// Translates one gitignore pattern body into a regex source string. Segment
// semantics matter: `*` stops at a slash, `**` doesn't.
function globToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows any number of directories (including none); a bare
        // `**` matches anything left, slashes included.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      // Character class, passed through with git's `!` negation spelling
      // translated to the regex `^`. An unterminated `[` is a literal.
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += '[' + cls + ']';
        i = end;
      }
    } else if (c === '\\') {
      // Escaped literal — take the next character as-is.
      const next = glob[i + 1];
      if (next !== undefined) { out += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

function parseRule(line: string): Rule | undefined {
  let pattern = line;

  // Trailing whitespace is insignificant unless backslash-escaped.
  pattern = pattern.replace(/(?<!\\)\s+$/, '');
  if (pattern === '' || pattern.startsWith('#')) return undefined;

  let negated = false;
  if (pattern.startsWith('!')) { negated = true; pattern = pattern.slice(1); }
  else if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) { pattern = pattern.slice(1); }

  let dirOnly = false;
  if (pattern.endsWith('/')) { dirOnly = true; pattern = pattern.slice(0, -1); }
  if (pattern === '') return undefined;

  // A slash anywhere but the end anchors the pattern to the .gitignore's own
  // directory; without one, it matches by basename at any depth.
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  const body = globToRegExpSource(pattern);
  const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  const literalName = !anchored && !negated && !/[*?[\]\\]/.test(pattern) ? pattern : undefined;
  try {
    return { regex: new RegExp(source), negated, dirOnly, literalName };
  } catch (err) {
    // A pattern with a character class we mistranslated shouldn't take the
    // whole file down — drop that one rule and keep the rest.
    logError('ignore.parseRule', err);
    return undefined;
  }
}

function parseGitignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = parseRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

export interface IgnoreMatcher {
  // relPath is workspace-relative and slash-separated ('src/foo.ts'). isDir
  // matters because `build/` ignores a directory but not a file named `build`.
  isIgnored(relPath: string, isDir: boolean): boolean;
  // True when the workspace actually has a root .gitignore — the tools use this
  // only to decide what to tell the model about why results were filtered.
  hasGitignore: boolean;
  // Plain directory names (no globs) that can be handed to a coarse
  // pre-filter — grep's --exclude-dir, VS Code's findFiles exclude glob — so
  // the big offenders never get walked in the first place. isIgnored still has
  // the final say; this is an optimization, not the filter.
  coarseDirNames(): string[];
}

const ALWAYS_IGNORED = new Set(['.git']);

export function loadIgnoreMatcher(workspacePath: string): IgnoreMatcher {
  // Memoized per directory: a tree walk asks about the same directories
  // repeatedly, and most of them have no .gitignore at all.
  const scopeCache = new Map<string, Scope | null>();

  const scopeFor = (dirRel: string): Scope | null => {
    if (scopeCache.has(dirRel)) return scopeCache.get(dirRel) ?? null;
    let scope: Scope | null = null;
    try {
      const file = path.join(workspacePath, dirRel, '.gitignore');
      if (fs.existsSync(file)) {
        scope = { baseRel: dirRel, rules: parseGitignore(fs.readFileSync(file, 'utf8')) };
      }
    } catch (err) {
      logError('ignore.scopeFor', err);
    }
    scopeCache.set(dirRel, scope);
    return scope;
  };

  const rootScope = scopeFor('');
  const hasGitignore = !!rootScope;

  const fallbackRules: Rule[] = hasGitignore
    ? []
    : FALLBACK_IGNORE.map(name => ({ regex: new RegExp(`^(?:.*/)?${name}$`), negated: false, dirOnly: false }));

  // Every .gitignore from the workspace root down to (and including) the
  // directory holding `relPath`, shallowest first — git resolves deeper files
  // last so they win.
  const scopesFor = (relPath: string): Scope[] => {
    const segments = relPath.split('/');
    const scopes: Scope[] = [];
    let dirRel = '';
    for (let i = 0; i < segments.length; i++) {
      const scope = scopeFor(dirRel);
      if (scope) scopes.push(scope);
      dirRel = dirRel ? `${dirRel}/${segments[i]}` : segments[i];
    }
    return scopes;
  };

  // Last matching rule wins, deeper .gitignore files after shallower ones —
  // exactly git's precedence.
  const decide = (relPath: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const rule of fallbackRules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(relPath)) ignored = !rule.negated;
    }
    for (const scope of scopesFor(relPath)) {
      const scoped = scope.baseRel ? relPath.slice(scope.baseRel.length + 1) : relPath;
      for (const rule of scope.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(scoped)) ignored = !rule.negated;
      }
    }
    return ignored;
  };

  return {
    hasGitignore,

    isIgnored(relPath: string, isDir: boolean): boolean {
      const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (rel === '' || rel === '.') return false;

      const segments = rel.split('/');
      // Walk the ancestors: git can't re-include a path whose parent directory
      // is ignored, so the first ignored ancestor settles it.
      for (let i = 0; i < segments.length; i++) {
        const prefix = segments.slice(0, i + 1).join('/');
        if (ALWAYS_IGNORED.has(segments[i])) return true;
        const prefixIsDir = i < segments.length - 1 ? true : isDir;
        if (decide(prefix, prefixIsDir)) return true;
      }
      return false;
    },

    coarseDirNames(): string[] {
      // Only un-anchored, un-negated, glob-free names from the root .gitignore
      // are safe to pre-exclude wholesale; anything subtler needs the real
      // matcher, which runs over the results either way.
      const names = new Set<string>(['.git']);
      for (const rule of rootScope?.rules ?? []) {
        if (rule.literalName) names.add(rule.literalName);
      }
      if (!hasGitignore) for (const name of FALLBACK_IGNORE) names.add(name);
      return [...names];
    },
  };
}

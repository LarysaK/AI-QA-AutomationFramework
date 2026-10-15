import { homedir, tmpdir } from 'node:os';

/**
 * Last line of defence before a snapshot is written. The snapshot is built by allowlisting
 * fields (nothing is copied wholesale from a report or the environment); this check then
 * rejects any key or string value that still looks like a local path, a credential, an e-mail
 * address or a stack trace. Findings name the JSON location and the category, never the value.
 */

export interface PublicSafetyContext {
  /** Literal strings that must never appear, such as the repository's absolute path. */
  readonly forbiddenLiterals: readonly string[];
}

const CHECKS: readonly (readonly [string, RegExp])[] = [
  [
    'absolute path',
    /(^|[^\w.~-])\/(Users|home|private|tmp|var|etc|root|opt|Volumes|mnt|usr|run)\//,
  ],
  ['absolute path', /(^|[^\w])[A-Za-z]:[\\/]/],
  ['absolute path', /\\\\[\w.-]+\\/],
  ['home-relative path', /(^|\s)~\//],
  ['file URL', /\bfile:\/\//i],
  ['credential', /\bsk-ant-[\w-]{8,}/],
  ['credential', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['credential', /\bAKIA[0-9A-Z]{16}\b/],
  ['credential', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['credential', /\bBearer\s+[\w.~+/-]{16,}/i],
  ['credential', /\bxox[abpr]-[\w-]{10,}/],
  ['environment variable', /\b[A-Z][A-Z0-9]*_(API_KEY|TOKEN|SECRET|PASSWORD|AUTH_TOKEN)\b/],
  ['environment variable', /\bNODE_OPTIONS\b/],
  ['e-mail address', /[\w.+-]+@[\w-]+(\.[\w-]+)+/],
  ['stack trace', /\n\s+at .+:\d+:\d+/],
];

export function defaultSafetyContext(repoRoot: string): PublicSafetyContext {
  return { forbiddenLiterals: [repoRoot, homedir(), tmpdir()].filter((s) => s.length > 1) };
}

/** Returns findings as "<json pointer>: <category>"; empty means the value may be published. */
export function publicSafetyFindings(value: unknown, context: PublicSafetyContext): string[] {
  const findings: string[] = [];
  const check = (text: string, pointer: string): void => {
    const where = pointer === '' ? '/' : pointer;
    for (const literal of context.forbiddenLiterals) {
      if (text.includes(literal)) findings.push(`${where}: local path`);
    }
    for (const [category, pattern] of CHECKS) {
      if (pattern.test(text)) findings.push(`${where}: ${category}`);
    }
  };
  const walk = (node: unknown, pointer: string): void => {
    if (typeof node === 'string') check(node, pointer);
    else if (Array.isArray(node))
      node.forEach((item, i) => {
        walk(item, `${pointer}/${String(i)}`);
      });
    else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        const path = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        check(key, `${path} (key)`);
        walk(child, path);
      }
    }
  };
  walk(value, '');
  return [...new Set(findings)];
}

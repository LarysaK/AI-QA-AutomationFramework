/**
 * Minimal safe HTML templating. Every interpolated value is escaped unless it is
 * already `SafeHtml` (the result of another `html` template).
 */

export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[];

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function renderValue(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  // `false`, `true`, null and undefined render nothing, so `cond && html\`...\`` works.
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += renderValue(value) + (strings[index + 1] ?? '');
  });
  return new SafeHtml(out);
}

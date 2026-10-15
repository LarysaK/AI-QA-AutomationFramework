import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { MarkdownBlock, MarkdownInline } from '../src/components/Markdown';

describe('Markdown is rendered as untrusted text', () => {
  test('raw HTML is never rendered or executed', () => {
    const { container } = render(
      <MarkdownBlock
        source={
          'Text <script>alert(1)</script> and <img src="x" onerror="alert(1)"> <b>bold</b>\n\n<iframe src="https://example.com"></iframe>'
        }
      />,
    );
    expect(container.querySelector('script, img, iframe, b')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });

  test('images are never loaded; their alt text is shown', () => {
    const { container } = render(
      <MarkdownBlock source="![tracking pixel](https://example.com/p.png)" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[image not loaded: tracking pixel]');
  });

  test('only absolute https links become links, with no opener or referrer', () => {
    const { container } = render(
      <MarkdownBlock
        source={
          '[ext](https://example.com/a) [plain](http://example.com) [js](javascript:alert(1)) [data](data:text/html,x) [rel](requirements.md) [anchor](#validation-rules)'
        }
      />,
    );
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com/a');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')?.split(' ').sort()).toEqual([
      'nofollow',
      'noopener',
      'noreferrer',
    ]);
    for (const text of ['plain', 'js', 'data', 'rel', 'anchor'])
      expect(container.textContent).toContain(text);
    expect(container.innerHTML).not.toMatch(/javascript:|data:text/);
  });

  test('tables from the plan are rendered (GitHub-flavoured Markdown)', () => {
    const { container } = render(<MarkdownBlock source={'| A | B |\n| - | - |\n| 1 | 2 |'} />);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  test('inline Markdown keeps formatting but no block elements', () => {
    const { container } = render(
      <MarkdownInline source={'# Heading with `code` and _emphasis_'} />,
    );
    expect(container.querySelector('h1, p')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.textContent).toContain('Heading with code and emphasis');
  });
});

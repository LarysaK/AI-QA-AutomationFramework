import type { ReactNode } from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown from the approved documents, treated as untrusted text:
 * - raw HTML is dropped (`skipHtml`), never parsed or executed;
 * - images are never loaded; only their alt text is shown;
 * - only absolute https links become links (new tab, no referrer, no opener); relative links
 *   and in-document anchors, which point into the source repository, are shown as text;
 * - react-markdown's URL sanitizer still applies to every URL.
 */

const EXTERNAL = /^https:\/\/[^\s]+$/i;

function SafeLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  if (href !== undefined && EXTERNAL.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
        <span className="visually-hidden"> (external link, opens in a new tab)</span>
      </a>
    );
  }
  return <span className="md-link-text">{children}</span>;
}

const blockComponents: Components = {
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  img: ({ alt }) => (
    <span className="md-image-placeholder">[image not loaded{alt ? `: ${alt}` : ''}]</span>
  ),
  table: ({ children }) => (
    <div className="table-scroll" role="region" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

const inlineComponents: Components = {
  ...blockComponents,
  p: ({ children }) => <>{children}</>,
};

const INLINE_ELEMENTS = ['p', 'code', 'em', 'strong', 'del', 'a', 'img'];

export function MarkdownBlock({ source }: { source: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={blockComponents}
      >
        {source}
      </Markdown>
    </div>
  );
}

/** One line of Markdown (a scenario, a table cell): inline formatting only. */
export function MarkdownInline({ source }: { source: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={defaultUrlTransform}
      allowedElements={INLINE_ELEMENTS}
      unwrapDisallowed
      components={inlineComponents}
    >
      {source}
    </Markdown>
  );
}

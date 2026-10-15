import { type ReactNode, useId } from 'react';

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      {eyebrow !== undefined && <p className="eyebrow">{eyebrow}</p>}
      <h1 tabIndex={-1}>{title}</h1>
      {children !== undefined && <div className="page-lede">{children}</div>}
    </header>
  );
}

export function Card({
  title,
  children,
  className = '',
  headingLevel = 2,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={`card ${className}`.trim()}>
      {title !== undefined && <Heading className="card-title">{title}</Heading>}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: 'neutral' | 'accent' | 'muted';
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value">{value}</dd>
      {detail !== undefined && <dd className="stat-detail">{detail}</dd>}
    </div>
  );
}

/**
 * A labelled horizontal bar. The <meter> carries the accessible name (the label) and value (the
 * text); the visible text is hidden from assistive technology so the value is announced once.
 * A native <meter>, so no inline styles are needed.
 */
export function MeterRow({
  label,
  value,
  max,
  text,
  tone = 'accent',
}: {
  label: ReactNode;
  value: number;
  max: number;
  text: string;
  tone?: 'accent' | 'neutral';
}) {
  const labelId = useId();
  return (
    <div className="meter-row">
      <span className="meter-label" id={labelId}>
        {label}
      </span>
      <meter
        className={`meter meter-${tone}`}
        min={0}
        max={Math.max(max, 1)}
        value={value}
        aria-labelledby={labelId}
        aria-valuetext={text}
      />
      <span className="meter-text" aria-hidden="true">
        {text}
      </span>
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'muted' | 'warning' | 'outline';
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Callout({
  title,
  children,
  tone = 'info',
}: {
  title: string;
  children: ReactNode;
  tone?: 'info' | 'empty';
}) {
  return (
    <aside className={`callout callout-${tone}`} aria-label={title}>
      <p className="callout-title">{title}</p>
      <div className="callout-body">{children}</div>
    </aside>
  );
}

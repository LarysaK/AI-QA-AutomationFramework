declare module 'virtual:dashboard-snapshot' {
  /** The dashboard snapshot, validated against snapshot.schema.json at build time. */
  const snapshot: unknown;
  export default snapshot;
}

declare module 'virtual:agent-layer' {
  /** The agent layer facts, checked against the committed files at build time. */
  const agents: unknown;
  export default agents;
}

declare module 'virtual:ci-history' {
  /** The CI execution history export, validated at build time; null when not included. */
  const history: unknown;
  export default history;
}

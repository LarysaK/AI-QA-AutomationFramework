declare module 'virtual:dashboard-snapshot' {
  /** The dashboard snapshot, validated against snapshot.schema.json at build time. */
  const snapshot: unknown;
  export default snapshot;
}

declare module 'virtual:ci-history' {
  /** The CI execution history export, validated at build time; null when not included. */
  const history: unknown;
  export default history;
}

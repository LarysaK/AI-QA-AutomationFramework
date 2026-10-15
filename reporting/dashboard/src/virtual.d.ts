declare module 'virtual:dashboard-snapshot' {
  /** The dashboard snapshot, validated against snapshot.schema.json at build time. */
  const snapshot: unknown;
  export default snapshot;
}

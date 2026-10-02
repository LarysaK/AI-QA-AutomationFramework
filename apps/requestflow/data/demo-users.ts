/**
 * The fixed RequestFlow demo users (Requirements v1.2: Demo users).
 * Kept here, on the test side, so tests never import from the AUT source.
 */
export const DEMO_USERS = {
  alex: { id: 'emp-alex', name: 'Alex Morgan', role: 'EMPLOYEE' },
  sam: { id: 'emp-sam', name: 'Sam Rivera', role: 'EMPLOYEE' },
  jordan: { id: 'rev-jordan', name: 'Jordan Lee', role: 'REVIEWER' },
} as const;

export type DemoUser = (typeof DEMO_USERS)[keyof typeof DEMO_USERS];

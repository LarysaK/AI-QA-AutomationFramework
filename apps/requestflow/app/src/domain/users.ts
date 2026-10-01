import type { User } from './types';

/** Fixed synthetic demo identities (Requirements v1.2: Demo users). */
export const DEMO_USERS: readonly User[] = Object.freeze([
  Object.freeze({ id: 'emp-alex', name: 'Alex Morgan', role: 'EMPLOYEE' }),
  Object.freeze({ id: 'emp-sam', name: 'Sam Rivera', role: 'EMPLOYEE' }),
  Object.freeze({ id: 'rev-jordan', name: 'Jordan Lee', role: 'REVIEWER' }),
]);

export function findDemoUser(id: string): User | undefined {
  return DEMO_USERS.find((user) => user.id === id);
}

/**
 * Statements of approval, authorization or execution in model-owned text (Planner PLN-004, Healer
 * HEA-008). The agents' contracts have no field that can carry an approval or an authorization;
 * these patterns are defense in depth. Uppercase `APPROVED` alone is not a claim: it is a request status.
 */
export const CLAIM_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['an execution authorization', /--authorize-execution/i],
  ['an execution authorization', /\bauthori[sz](e|es|ed|ing)\b[^.\n]{0,40}\bexecut/i],
  [
    'an execution authorization',
    /\bexecution authori[sz]ation\b[^.\n]{0,30}\b(granted|given|provided|supplied|attached|approved)\b/i,
  ],
  [
    'a passed approval gate',
    /\bH[1-7]\b\s+(gate\s+)?(is\s+|has\s+been\s+|was\s+)?(approved|passed|granted|cleared|signed off|opened|open)\b/i,
  ],
  [
    'a passed approval gate',
    /\b(approved|passed|cleared|signed off)\s+(at|under|through|by)\s+(gate\s+)?H[1-7]\b/i,
  ],
  [
    'an approved plan',
    /\b(this|the)\s+(test[- ]plan\s+|planning\s+)?(plan|proposal)\s+(is|has been|was)\s+(already\s+)?(approved|accepted|validated|signed off)\b/i,
  ],
  [
    'a granted approval',
    /\bapproval\s+(has been\s+|was\s+|is\s+)?(granted|given|obtained|recorded)\b/i,
  ],
  ['an applied change', /\b(has been|was|were|is)\s+(applied|committed|merged)\b/i],
  [
    'an execution',
    /\b(i|we)\s+(have\s+)?(executed|ran|run)\s+(the\s+|all\s+)?(tests?|suite|scenarios?)\b/i,
  ],
  [
    'an execution result',
    /\btests?\s+(have\s+|has\s+)?(already\s+)?(passed|been executed|were executed|ran)\b/i,
  ],
  ['a command to execute', /\b(npm\s+(run|test)\b|npx\s+playwright|playwright\s+test)\b/i],
  ['an orchestrator status', /\b(VALIDATED|EXECUTION_AUTHORIZATION_REQUIRED|APPLIED)\b/],
];

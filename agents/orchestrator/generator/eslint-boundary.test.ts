import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

/**
 * ADR-0001 import boundary: tests/**, apps/**, framework/** and playwright.config.ts must not
 * import agents/** or @anthropic-ai/sdk. The rule configuration comes from the real
 * eslint.config.mjs; the samples are linted with exactly that rule.
 */

const REPO = resolve('.');
const project = new ESLint({ cwd: REPO });

async function boundaryRule(file: string): Promise<Linter.RuleEntry | undefined> {
  const config = (await project.calculateConfigForFile(file)) as {
    rules?: Record<string, Linter.RuleEntry>;
  };
  return config.rules?.['no-restricted-imports'];
}

async function violations(file: string, source: string): Promise<number> {
  const rule = await boundaryRule(file);
  assert.ok(rule, `${file} should have the boundary rule`);
  const linter = new ESLint({
    cwd: REPO,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: { 'no-restricted-imports': rule },
      },
    ],
  });
  const [result] = await linter.lintText(source, { filePath: resolve(REPO, file) });
  return (
    result?.messages.filter((message) => message.ruleId === 'no-restricted-imports').length ?? 0
  );
}

describe('ADR-0001 import boundary (ESLint)', () => {
  for (const file of [
    'tests/requestflow/api/x.spec.ts',
    'apps/requestflow/pages/x.page.ts',
    'apps/requestflow/app/src/x.ts',
    'framework/core/x.ts',
    'playwright.config.ts',
  ]) {
    test(`${file} may not import the agent layer or an LLM SDK`, async () => {
      for (const source of [
        "import { generate } from '../../../agents/orchestrator/generator/generate';",
        "import type { GuardResult } from '../agents/orchestrator/validation/types';",
        "import { x } from 'agents/standard';",
        "import Anthropic from '@anthropic-ai/sdk';",
        "import type { Message } from '@anthropic-ai/sdk/resources/messages';",
      ]) {
        assert.equal(await violations(file, `${source}\nexport {};\n`), 1, `${file}: ${source}`);
      }
    });
  }

  test('ordinary runtime imports are not affected', async () => {
    for (const source of [
      "import { test } from '@playwright/test';",
      "import { RequestFlowApi } from '../../../apps/requestflow/api/requestflow-api.client';",
      "import { agentsmith } from './agentsmith';",
    ]) {
      assert.equal(
        await violations('tests/requestflow/api/x.spec.ts', `${source}\nexport {};\n`),
        0,
        source,
      );
    }
  });

  test('the agent layer itself is not restricted', async () => {
    assert.equal(await boundaryRule('agents/orchestrator/generator/generate.ts'), undefined);
  });
});

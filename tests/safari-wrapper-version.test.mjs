import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { safariWrapperVersion } from '../scripts/safari-wrapper-version.mjs';

test('Safari wrapper versions supersede the converter default and remain monotonic', () => {
  assert.deepEqual(safariWrapperVersion('0.1.12'), {
    marketingVersion: '1.1.12',
    buildVersion: '1001012',
  });
  assert.deepEqual(safariWrapperVersion('0.2.0'), {
    marketingVersion: '1.2.0',
    buildVersion: '1002000',
  });
  assert.deepEqual(safariWrapperVersion('1.0.0'), {
    marketingVersion: '2.0.0',
    buildVersion: '2000000',
  });
});

test('Safari wrapper version rejects malformed package versions', () => {
  assert.throws(() => safariWrapperVersion('1.2'), /invalid package version/i);
  assert.throws(() => safariWrapperVersion('not-a-version'), /invalid package version/i);
});

test('Safari app builder patches both wrapper version fields', () => {
  const source = fs.readFileSync('scripts/make-safari-app.sh', 'utf8');
  assert.match(source, /safari-wrapper-version\.mjs/);
  assert.match(source, /MARKETING_VERSION = \[\^;\]\+;/);
  assert.match(source, /CURRENT_PROJECT_VERSION = \[\^;\]\+;/);
  assert.match(source, /marketing_count < 4 or build_count < 4/);
});

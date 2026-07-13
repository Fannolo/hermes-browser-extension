import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Safari converter hard-codes every generated wrapper to version 1.0 (build
 * 1). Give each Hermes release a monotonically increasing wrapper version so
 * PlugInKit cannot prefer an older registered build with the same bundle ID.
 */
export function safariWrapperVersion(packageVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(packageVersion || '').trim());
  if (!match) throw new Error(`Invalid package version: ${packageVersion}`);

  const [, rawMajor, rawMinor, rawPatch] = match;
  const major = Number(rawMajor);
  const minor = Number(rawMinor);
  const patch = Number(rawPatch);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Invalid package version: ${packageVersion}`);
  }

  const wrapperMajor = major + 1;
  return {
    marketingVersion: `${wrapperMajor}.${minor}.${patch}`,
    buildVersion: String((wrapperMajor * 1_000_000) + (minor * 1_000) + patch),
  };
}

function invokedDirectly() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = safariWrapperVersion(packageJson.version);
  process.stdout.write(`${version.marketingVersion} ${version.buildVersion}\n`);
}

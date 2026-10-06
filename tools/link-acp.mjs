/**
 * Point `vendor/prism-acp` at the sibling `prism-acp-ts` working tree.
 *
 * The app depends on `file:vendor/prism-acp` rather than on `file:../prism-acp-ts`
 * for one reason: a path that leaves the repository works on a developer's
 * machine and cannot work in CI, where only this repository is checked out.
 * That is how the first push failed -- `Cannot find module
 * '@particle-academy/prism-acp'` on all three node versions, with every test
 * green locally.
 *
 * So the dependency path stays INSIDE the repo, and the two environments fill
 * it differently: this script links the sibling tree locally, and CI checks the
 * package out into the same place. One dependency path, no conditional in
 * package.json, and the local setup still builds against the working tree --
 * which is this ecosystem's pattern, so the testbed tests before anything is
 * published.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));

// Both packages this app dogfoods. The harness holds per-agent session state;
// the transport drives the agents.
const PACKAGES = [
  { repo: 'prism-acp-ts', at: 'prism-acp' },
  { repo: 'prism-harness-ts', at: 'prism-harness' },
];

for (const { repo, at } of PACKAGES) {
  const target = resolve(here, '..', repo);
  const link = join(here, 'vendor', at);

  if (!existsSync(join(target, 'package.json'))) {
    console.error(`no ${repo} working tree at ${target}`);
    console.error(`Clone it beside this repo, or let CI check it out into vendor/${at}.`);
    process.exit(1);
  }

  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link) || isBrokenLink(link)) rmSync(link, { recursive: true, force: true });

  // 'junction' on Windows, which needs no elevated privileges; 'dir' elsewhere.
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`vendor/${at} -> ${target}`);
}

function isBrokenLink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

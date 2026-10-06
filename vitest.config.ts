import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Only this repository's tests.
     *
     * `vendor/prism-acp` is a junction to the sibling `prism-acp-ts` working
     * tree, and vitest happily walked into it: a run reported **246 tests**
     * where this app has 83. The other 163 were the dependency's own, passing
     * under this repo's name.
     *
     * That is worse than noise. A failure in the transport would have failed
     * this suite, in this repo, pointing at a file that is not ours -- and a
     * green run here would have been claiming coverage of code this app does
     * not own. The inflated count is what gave it away.
     */
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'vendor/**'],
  },
});

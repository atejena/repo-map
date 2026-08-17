/**
 * Starting point for enforcing module boundaries after they have been
 * established. Adopt rules one at a time with severity "warn", fix the
 * existing violations, then promote to "error". Landing all of these as
 * errors at once produces a red build the team learns to ignore.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Cycles block module extraction and make load order fragile.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreachable module. Delete it or wire it up.',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$', '\\.config\\.[cm]?[jt]s$'] },
      to: {},
    },
    {
      name: 'features-stay-independent',
      severity: 'error',
      comment: 'One feature must not reach into another. Route through shared/ or lib/.',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/([^/]+)/', pathNot: ['^src/features/$1/'] },
    },
    {
      name: 'lib-must-not-depend-on-features',
      severity: 'error',
      comment: 'lib/ is the lower layer. A reverse edge here is the accident that creates cycles.',
      from: { path: '^src/lib/' },
      to: { path: '^src/features/' },
    },
    {
      name: 'no-deprecated-deps',
      severity: 'warn',
      from: {},
      to: { dependencyTypes: ['deprecated'] },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'Production code importing a devDependency breaks the deployed build.',
      from: { path: '^src/', pathNot: '\\.(test|spec)\\.[tj]sx?$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '\\.(test|spec)\\.[tj]sx?$' },
    reporterOptions: { text: { highlightFocused: true } },
  },
};

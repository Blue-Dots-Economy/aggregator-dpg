/**
 * dep-cruiser configuration for aggregator-dpg.
 *
 * Enforces import boundary rules across all packages so that
 * interface contracts stay lightweight and cross-service coupling
 * is caught at CI time rather than at runtime.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-heavy-deps-in-interface',
      severity: 'error',
      comment:
        'src/interface.ts files may only import from @aggregator-dpg/shared-primitives, zod, or Node built-ins. ' +
        'All other imports indicate the interface layer is taking on implementation concerns.',
      from: {
        path: '(^|/)src/interface\\.ts$',
      },
      to: {
        pathNot: [
          '^node:', // Node built-ins (node:path, node:fs, …)
          '[/\\\\]node_modules[/\\\\]zod[/\\\\]', // zod
          '[/\\\\]shared-primitives[/\\\\]', // @aggregator-dpg/shared-primitives (workspace)
        ],
      },
    },
  ],

  options: {
    /* Don't recurse into node_modules; only report the direct edge. */
    doNotFollow: {
      path: 'node_modules',
    },

    /* Analyse TypeScript source before compilation so type-only imports are visible. */
    tsPreCompilationDeps: true,

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js'],
    },

    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};

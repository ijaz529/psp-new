export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Conventional commits — keep the prefix list tight so headers stay descriptive.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'chore', 'ci', 'build', 'style', 'revert'],
    ],
    'header-max-length': [2, 'always', 100],
  },
};

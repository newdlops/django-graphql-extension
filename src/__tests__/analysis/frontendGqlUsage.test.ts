import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { __clearMockFiles, __setMockFiles } from 'vscode';
import { extractFrontendGqlUsageFromText, scanFrontendGqlUsages } from '../../analysis/frontendGqlUsage';

beforeEach(() => __clearMockFiles());

describe('extractFrontendGqlUsageFromText', () => {
  it('extracts gql operations, labels, line numbers, and root fields from one file', () => {
    const src = [
      "import { gql } from '@apollo/client';",
      '',
      'const USER_FIELDS = gql`',
      '  fragment UserFields on User {',
      '    id',
      '    name',
      '  }',
      '`;',
      '',
      'const DASHBOARD = gql`',
      '  query DashboardQuery {',
      '    viewer {',
      '      ...UserFields',
      '    }',
      '    team {',
      '      id',
      '    }',
      '  }',
      '`;',
    ].join('\n');

    const usage = extractFrontendGqlUsageFromText(src, '/ws/src/pages/Dashboard.tsx', 'src/pages/Dashboard.tsx');
    expect(usage).not.toBeNull();
    expect(usage!.relativePath).toBe('src/pages/Dashboard.tsx');
    expect(usage!.operationCount).toBe(2);
    expect(usage!.operations).toEqual([
      {
        kind: 'fragment',
        label: 'fragment UserFields',
        lineNumber: 2,
        rootFields: [],
      },
      {
        kind: 'query',
        label: 'query DashboardQuery',
        lineNumber: 9,
        rootFields: ['viewer', 'team'],
      },
    ]);
  });

  it('returns null when a file has no gql templates', () => {
    expect(extractFrontendGqlUsageFromText('const answer = 42;', '/ws/src/x.ts', 'src/x.ts')).toBeNull();
  });
});

describe('scanFrontendGqlUsages', () => {
  it('scans frontend files only, excludes build folders, and normalizes relative paths', async () => {
    __setMockFiles({
      '/ws/src/pages/Dashboard.tsx': [
        "import { gql } from '@apollo/client';",
        'const DASHBOARD = gql`query Dashboard { viewer { id } }`;',
      ].join('\n'),
      '/ws/src/components/UserCard.jsx': [
        "import { gql } from '@apollo/client';",
        'const SAVE = gql`mutation SaveUser { saveUser { ok } }`;',
        'const EXTRA = gql`{ me { id } }`;',
      ].join('\n'),
      '/ws/src/lib/plain.ts': 'export const noop = true;',
      '/ws/node_modules/pkg/index.ts': 'const IGNORED = gql`query Hidden { hidden }`;',
      '/ws/out/generated.js': 'const ALSO_IGNORED = gql`query Generated { hidden }`;',
    });

    const usages = await scanFrontendGqlUsages();
    expect(usages.map((usage) => usage.relativePath)).toEqual([
      'src/components/UserCard.jsx',
      'src/pages/Dashboard.tsx',
    ]);

    expect(usages[0].operations).toEqual([
      {
        kind: 'mutation',
        label: 'mutation SaveUser',
        lineNumber: 1,
        rootFields: ['saveUser'],
      },
      {
        kind: 'anonymous',
        label: 'anonymous gql',
        lineNumber: 2,
        rootFields: ['me'],
      },
    ]);

    expect(usages[1].operations).toEqual([
      {
        kind: 'query',
        label: 'query Dashboard',
        lineNumber: 1,
        rootFields: ['viewer'],
      },
    ]);
  });
});

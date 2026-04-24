import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { __clearMockFiles, __setMockFiles } from 'vscode';
import { extractFrontendGqlUsageFromText, scanFrontendGqlUsages, scanWorkspaceFragments } from '../../analysis/frontendGqlUsage';
import { parseGqlFields } from '../../codelens/gqlCodeLensProvider';

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
        // Fragment bodies now report their selection set so downstream
        // analysis (diagnostics, codelens) can resolve fields against the
        // `on Type` class.
        rootFields: ['id', 'name'],
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

describe('scanWorkspaceFragments', () => {
  it('harvests fragment definitions from every frontend file and ignores excluded folders', async () => {
    __setMockFiles({
      '/ws/src/graphql/fragments.ts': [
        "import gql from 'graphql-tag';",
        '',
        'export const USER_FRAGMENT = gql`',
        '  fragment UserFields on UserType {',
        '    id',
        '    email',
        '  }',
        '`;',
        '',
        'export const COMPANY_FRAGMENT = gql`',
        '  fragment CompanyFields on CompanyType {',
        '    name',
        '    createdAt',
        '  }',
        '`;',
      ].join('\n'),
      '/ws/src/graphql/query.ts': [
        "import gql from 'graphql-tag';",
        "import { USER_FRAGMENT, COMPANY_FRAGMENT } from './fragments';",
        '',
        'export const Q = gql`',
        '  ${USER_FRAGMENT}',
        '  ${COMPANY_FRAGMENT}',
        '  query Combined { viewer { ...UserFields company { ...CompanyFields } } }',
        '`;',
      ].join('\n'),
      '/ws/node_modules/skipped/fragments.ts': 'export const X = gql`fragment ShouldNotAppear on T { id }`;',
      '/ws/out/build.js': 'const Y = gql`fragment AlsoSkipped on T { id }`;',
    });

    const { fragments, constBodies } = await scanWorkspaceFragments();
    expect([...fragments.keys()].sort()).toEqual(['CompanyFields', 'UserFields']);
    expect(fragments.has('ShouldNotAppear')).toBe(false);
    expect(fragments.has('AlsoSkipped')).toBe(false);

    // The JS-const → body map is populated in the same pass so providers
    // can textually inline `${USER_FRAGMENT}` interpolations.
    expect([...constBodies.keys()].sort()).toEqual(['COMPANY_FRAGMENT', 'Q', 'USER_FRAGMENT']);
    expect(constBodies.get('USER_FRAGMENT')).toContain('fragment UserFields on UserType');

    // The fragments should be usable by parseGqlFields when the spread lives
    // in a different file than the fragment definition.
    const parsed = parseGqlFields(
      'query Combined { viewer { ...UserFields company { ...CompanyFields } } }',
      fragments,
    );
    expect(parsed[0].name).toBe('viewer');
    expect(parsed[0].children.map((c) => c.name)).toEqual(['id', 'email', 'company']);
    const company = parsed[0].children.find((c) => c.name === 'company')!;
    expect(company.children.map((c) => c.name)).toEqual(['name', 'createdAt']);
  });

  it('returns empty maps when no frontend files define fragments', async () => {
    __setMockFiles({
      '/ws/src/plain.ts': 'export const noop = 1;',
      '/ws/src/query.ts': "const Q = gql`query Q { me { id } }`;",
    });
    const { fragments, constBodies } = await scanWorkspaceFragments();
    expect(fragments.size).toBe(0);
    // The `Q` const is itself a gql template so it IS indexed — it just
    // doesn't CONTAIN a `fragment X on Y { ... }` block.
    expect(constBodies.has('Q')).toBe(true);
  });

  it('resolves duplicate fragment names deterministically (first file by path wins)', async () => {
    __setMockFiles({
      '/ws/src/a-fragments.ts': 'const F = gql`fragment Dup on T { fromA }`;',
      '/ws/src/b-fragments.ts': 'const F = gql`fragment Dup on T { fromB }`;',
    });
    const { fragments } = await scanWorkspaceFragments();
    const dup = fragments.get('Dup');
    expect(dup).toBeDefined();
    // Inline the fragment into a query body to observe which file's definition won.
    const parsed = parseGqlFields('query Q { item { ...Dup } }', fragments);
    expect(parsed[0].children.map((c) => c.name)).toEqual(['fromA']);
  });
});

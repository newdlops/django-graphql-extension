// Phase (δ): renderTemplateStructuresHtml — aggregate summary + per-root
// sections + unresolved list, all in one payload.

import { describe, it, expect } from 'vitest';
import { renderTemplateStructuresHtml } from '../../preview/queryStructureJson';
import { buildQueryStructure } from '../../analysis/queryStructure';
import { parseGqlFields } from '../../codelens/gqlCodeLensProvider';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[]): ClassInfo {
  return { name, baseClasses: [], framework: 'graphene', filePath: '/p.py', lineNumber: 0, fields, kind: 'type' };
}

describe('renderTemplateStructuresHtml (phase δ)', () => {
  it('aggregates queried/missing counts across all root fields', () => {
    const userType = cls('UserType', [f('id'), f('name')]);
    const statsType = cls('StatsType', [f('count', 'Int'), f('max', 'Int'), f('min', 'Int')]);
    const map = new Map([[userType.name, userType], [statsType.name, statsType]]);

    const s1 = buildQueryStructure(parseGqlFields('query { user { id } }')[0], userType, map);
    const s2 = buildQueryStructure(parseGqlFields('query { stats { count } }')[0], statsType, map);

    const html = renderTemplateStructuresHtml({
      operationKind: 'query',
      operationName: 'Dashboard',
      structures: [
        { structure: s1, note: 'Query.user → UserType' },
        { structure: s2, note: 'Query.stats → StatsType' },
      ],
      unresolved: [],
    });

    // Aggregated counts
    expect(html).toContain('query Dashboard');
    expect(html).toContain('✓ 2 queried'); // 1 from user, 1 from stats
    expect(html).toContain('✗ 3 missing'); // 1 from user (name), 2 from stats (max, min)
    expect(html).toContain('across 2 root fields');
  });

  it('includes per-root notes like "Query.user → UserType"', () => {
    const userType = cls('UserType', [f('id')]);
    const s = buildQueryStructure(parseGqlFields('query { user { id } }')[0], userType, new Map([[userType.name, userType]]));
    const html = renderTemplateStructuresHtml({
      operationKind: 'query',
      structures: [{ structure: s, note: 'Query.user → UserType' }],
      unresolved: [],
    });
    expect(html).toContain('Query.user → UserType');
  });

  it('renders an unresolved-section when some roots could not be matched', () => {
    const userType = cls('UserType', [f('id')]);
    const s = buildQueryStructure(parseGqlFields('query { user { id } }')[0], userType, new Map([[userType.name, userType]]));
    const html = renderTemplateStructuresHtml({
      operationKind: 'query',
      structures: [{ structure: s }],
      unresolved: [{ name: 'stats', reason: 'no matching root field in the schema' }],
    });
    expect(html).toContain('Unresolved root fields');
    expect(html).toContain('<code>stats</code>');
    expect(html).toContain('no matching root field');
  });

  it('pluralization: 1 root field is singular, 2+ is plural', () => {
    const userType = cls('UserType', [f('id')]);
    const s = buildQueryStructure(parseGqlFields('query { user { id } }')[0], userType, new Map([[userType.name, userType]]));
    const single = renderTemplateStructuresHtml({
      operationKind: 'query',
      structures: [{ structure: s }],
      unresolved: [],
    });
    expect(single).toContain('across 1 root field');
    expect(single).not.toContain('1 root fields');

    const many = renderTemplateStructuresHtml({
      operationKind: 'query',
      structures: [{ structure: s }, { structure: s }],
      unresolved: [],
    });
    expect(many).toContain('across 2 root fields');
  });
});

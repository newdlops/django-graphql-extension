import { describe, it, expect } from 'vitest';
import { parseGqlFields, collectDocumentFragments } from '../../codelens/gqlCodeLensProvider';

const names = (fields: { name: string; children: { name: string }[] }[]) =>
  fields.map((f) => ({ name: f.name, children: f.children.map((c) => c.name) }));

describe('parseGqlFields fragment inlining', () => {
  it('inlines named fragment spreads defined in the same gql literal', () => {
    const gql = `
      fragment StatusFields on RtccType {
        approvalStatus
        approvedAt
        investors { id name }
      }
      query Q($id: ID!) {
        rightToConsentOrConsult(id: $id) {
          id
          ...StatusFields
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('rightToConsentOrConsult');
    expect(names(parsed[0].children)).toEqual([
      { name: 'id', children: [] },
      { name: 'approvalStatus', children: [] },
      { name: 'approvedAt', children: [] },
      { name: 'investors', children: ['id', 'name'] },
    ]);
  });

  it('flattens inline fragments `... on Type { ... }` into the current selection', () => {
    const gql = `
      query Q {
        node(id: "x") {
          id
          ... on UserType {
            email
            profile { bio }
          }
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    expect(names(parsed[0].children)).toEqual([
      { name: 'id', children: [] },
      { name: 'email', children: [] },
      { name: 'profile', children: ['bio'] },
    ]);
  });

  it('resolves fragments that reference other fragments', () => {
    const gql = `
      fragment Inner on UserType { id email }
      fragment Outer on UserType { name ...Inner }
      query Q { me { ...Outer } }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed[0].children.map((c) => c.name)).toEqual(['name', 'id', 'email']);
  });

  it('guards against cyclic fragments without infinite recursion', () => {
    const gql = `
      fragment A on T { id ...B }
      fragment B on T { name ...A }
      query Q { item { ...A } }
    `;
    const parsed = parseGqlFields(gql);
    // Cycle is broken on the second A reference — either ordering is acceptable
    // as long as parsing terminates with both 'id' and 'name' present.
    const flat = parsed[0].children.map((c) => c.name);
    expect(flat).toContain('id');
    expect(flat).toContain('name');
  });

  it('drops unknown fragment spreads (same-literal scope)', () => {
    const gql = `
      query Q {
        user {
          id
          ...ExternalFragment
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed[0].children.map((c) => c.name)).toEqual(['id']);
  });

  it('handles directives on fragment spreads', () => {
    const gql = `
      fragment F on T { id name }
      query Q($x: Boolean!) {
        item {
          slug
          ...F @include(if: $x)
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed[0].children.map((c) => c.name)).toEqual(['slug', 'id', 'name']);
  });

  it('finds operations that appear after fragment definitions in the same literal', () => {
    const gql = `
      fragment F on T { id }
      query Q { item { ...F } }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('item');
    expect(parsed[0].children.map((c) => c.name)).toEqual(['id']);
  });
});

describe('parseGqlFields — argName extraction', () => {
  it('records the names of args the user wrote on a field', () => {
    const gql = `
      query Q($cid: ID!, $page: Int) {
        rtccEmailList(companyId: $cid, page: $page) {
          id
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('rtccEmailList');
    expect(parsed[0].argNames).toEqual(['companyId', 'page']);
  });

  it('skips nested values (objects, arrays, strings) when collecting arg names', () => {
    const gql = `
      mutation M {
        createThing(input: { name: "Hello, world", tags: [1, 2, 3] }, meta: { a: 1 })
      }
    `;
    const parsed = parseGqlFields(gql);
    // Only the TOP-level arg names, not nested keys inside values.
    expect(parsed[0].argNames).toEqual(['input', 'meta']);
  });

  it('sets argNames to undefined when the field has no `(...)`', () => {
    const gql = `query Q { me { id } }`;
    const parsed = parseGqlFields(gql);
    expect(parsed[0].argNames).toBeUndefined();
    expect(parsed[0].children[0].argNames).toBeUndefined();
  });

  it('records an empty array when the user wrote `()` with nothing inside', () => {
    const gql = `query Q { foo() { bar } }`;
    const parsed = parseGqlFields(gql);
    expect(parsed[0].argNames).toEqual([]);
  });

  it('collects every arg when the gql uses comma-less list formatting', () => {
    // GraphQL allows whitespace-only separators between args. Captain's real
    // queries are written this way — all-on-new-lines without commas.
    const gql = `
      query RtccEmailList(
        $companyId: ID!
        $rightToConsentOrConsultId: ID!
        $page: Int
        $perPage: Int
      ) {
        rtccEmailList(
          companyId: $companyId
          rightToConsentOrConsultId: $rightToConsentOrConsultId
          page: $page
          perPage: $perPage
        ) {
          id
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed[0].argNames).toEqual([
      'companyId', 'rightToConsentOrConsultId', 'page', 'perPage',
    ]);
  });

  it('does not confuse enum / boolean values with the next arg name', () => {
    // `status: ACTIVE` — ACTIVE is an enum literal, not an arg. Without the
    // `Name:` lookahead guard the scanner would stop at `published:` here.
    const gql = `
      query Q {
        posts(status: ACTIVE published: true flag: false) {
          id
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed[0].argNames).toEqual(['status', 'published', 'flag']);
  });
});

describe('collectDocumentFragments — cross-literal fragment inlining', () => {
  it('resolves `...F` in one gql literal when F is defined in another', () => {
    const docText = `
      import { gql } from '@apollo/client';

      const USER_FIELDS = gql\`
        fragment UserFields on User {
          id
          name
          email
        }
      \`;

      const GET_USER = gql\`
        query GetUser($id: ID!) {
          user(id: $id) {
            ...UserFields
            createdAt
          }
        }
        \${USER_FIELDS}
      \`;
    `;
    const docFragments = collectDocumentFragments(docText);
    expect(docFragments.has('UserFields')).toBe(true);

    // Now parse the query literal (body only) and confirm the spread inlines.
    const queryBody = `
        query GetUser($id: ID!) {
          user(id: $id) {
            ...UserFields
            createdAt
          }
        }

    `;
    const parsed = parseGqlFields(queryBody, docFragments);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('user');
    expect(parsed[0].children.map((c) => c.name)).toEqual(['id', 'name', 'email', 'createdAt']);
  });

  it('supports fragments spreading other cross-literal fragments', () => {
    const docText = `
      const INNER = gql\`fragment Inner on T { id email }\`;
      const OUTER = gql\`fragment Outer on T { name ...Inner }\`;
      const Q = gql\`query Q { me { ...Outer } } \${OUTER} \${INNER}\`;
    `;
    const docFragments = collectDocumentFragments(docText);
    expect(docFragments.has('Outer')).toBe(true);
    expect(docFragments.has('Inner')).toBe(true);

    const queryBody = `query Q { me { ...Outer } }        `;
    const parsed = parseGqlFields(queryBody, docFragments);
    expect(parsed[0].children.map((c) => c.name)).toEqual(['name', 'id', 'email']);
  });

  it('local fragment wins when same name is defined in both literals', () => {
    const docText = `
      const A = gql\`fragment F on T { foo }\`;
      const B = gql\`fragment F on T { bar } query Q { item { ...F } }\`;
    `;
    const docFragments = collectDocumentFragments(docText);
    // The B literal's local F should take precedence over A's.
    const queryBody = `fragment F on T { bar } query Q { item { ...F } }`;
    const parsed = parseGqlFields(queryBody, docFragments);
    expect(parsed[0].children.map((c) => c.name)).toEqual(['bar']);
  });

  it('still drops truly unresolvable spreads (not defined anywhere in document)', () => {
    const docText = `
      const Q = gql\`query Q { user { ...MissingFrag id } }\`;
    `;
    const docFragments = collectDocumentFragments(docText);
    const parsed = parseGqlFields(`query Q { user { ...MissingFrag id } }`, docFragments);
    expect(parsed[0].children.map((c) => c.name)).toEqual(['id']);
  });
});

describe('parseGqlFields fragment origin tagging', () => {
  it('tags top-level fields inlined from a named spread with `fromFragment`', () => {
    const gql = `
      fragment UserFields on UserType {
        name
        email
      }
      query Q {
        user {
          id
          ...UserFields
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    const user = parsed[0];
    const byName = new Map(user.children.map((c) => [c.name, c] as const));
    expect(byName.get('id')!.fromFragment).toBeUndefined();
    expect(byName.get('name')!.fromFragment).toBe('UserFields');
    expect(byName.get('email')!.fromFragment).toBe('UserFields');
  });

  it('does not tag fields introduced via inline `... on Type` spreads', () => {
    const gql = `
      query Q {
        node(id: "x") {
          id
          ... on UserType {
            email
          }
        }
      }
    `;
    const parsed = parseGqlFields(gql);
    const node = parsed[0];
    const byName = new Map(node.children.map((c) => [c.name, c] as const));
    expect(byName.get('id')!.fromFragment).toBeUndefined();
    expect(byName.get('email')!.fromFragment).toBeUndefined();
  });

  it('uses the OUTER fragment name when fragments nest — users wrote that one', () => {
    const gql = `
      fragment Inner on T { a b }
      fragment Outer on T { ...Inner c }
      query Q { item { ...Outer } }
    `;
    const parsed = parseGqlFields(gql);
    const item = parsed[0];
    // All three fields arrived at `item` via the `...Outer` spread the user
    // wrote in the query. The inner `...Inner` tag gets overwritten.
    for (const child of item.children) {
      expect(child.fromFragment).toBe('Outer');
    }
  });

  it('anchors inlined field offsets at the spread site (not the fragment body)', () => {
    // Regression: before the fix, inlined field offsets pointed into
    // `def.source` — either another file or the appended region of the
    // expanded body — so provider markers (CodeLens, diagnostics, inlay
    // hints) were placed outside the gql template and the user saw nothing
    // next to `...FragName`. Now every inlined descendant anchors on the
    // `...FragName` text in the CURRENT body.
    const gql = `
      fragment UserFields on UserType {
        id
        name
        email
      }
      query Q {
        user {
          ...UserFields
        }
      }
    `;
    const spreadOffset = gql.indexOf('...UserFields');
    const spreadLen = '...UserFields'.length;

    const parsed = parseGqlFields(gql);
    const user = parsed[0];
    expect(user.children).toHaveLength(3);
    // Each top-level inlined field anchors on the spread's first dot.
    for (const child of user.children) {
      expect(child.offset).toBe(spreadOffset);
      expect(child.nameOffset).toBe(spreadOffset);
      expect(child.nameLength).toBe(spreadLen);
      expect(child.fromFragment).toBe('UserFields');
    }
  });

  it('also rebases descendants of inlined fragment fields to the spread site', () => {
    // Nested selection inside a fragment body — when inlined, the inner
    // children carry offsets into the fragment body, not the current
    // gql. Rebase recursively so they land at the spread site too.
    const gql = `
      fragment Outer on T {
        wrapper {
          innerA
          innerB
        }
      }
      query Q {
        node {
          ...Outer
        }
      }
    `;
    const spreadOffset = gql.indexOf('...Outer');
    const spreadLen = '...Outer'.length;
    const parsed = parseGqlFields(gql);
    const node = parsed[0];
    const wrapper = node.children[0];
    expect(wrapper.name).toBe('wrapper');
    expect(wrapper.offset).toBe(spreadOffset);
    expect(wrapper.nameLength).toBe(spreadLen);
    for (const inner of wrapper.children) {
      expect(inner.offset).toBe(spreadOffset);
      expect(inner.nameLength).toBe(spreadLen);
      expect(inner.fromFragment).toBe('Outer');
    }
  });

  it('same FragmentDef used from two spread sites gets each site\'s name', () => {
    // Parser caches FragmentDef.fields, so we must shallow-copy before
    // assigning `fromFragment` or cross-talk would pollute earlier sites.
    const gql = `
      fragment F on T { a }
      query Q {
        one { ...F }
        two { ...F }
      }
    `;
    const parsed = parseGqlFields(gql);
    const one = parsed.find((f) => f.name === 'one')!;
    const two = parsed.find((f) => f.name === 'two')!;
    expect(one.children[0].fromFragment).toBe('F');
    expect(two.children[0].fromFragment).toBe('F');
  });
});

describe('parseGqlFields fragment-only literal', () => {
  it('parses the body of a bare fragment definition', () => {
    const gql = `
      fragment UserFields on UserType {
        id
        name
        email
      }
    `;
    const parsed = parseGqlFields(gql);
    expect(parsed.map((f) => f.name)).toEqual(['id', 'name', 'email']);
  });

  it('inlines nested fragment spreads inside a fragment body (workspace-scope)', () => {
    // Mirrors the real-world pattern where `VcmFundDocRequestReceiverFragment`
    // spreads `VcmFundDocRequestBaseFragment` which spreads
    // `VcmDocRequestUserFragment` — three-deep chain, all in different files.
    const fragmentsDoc = `
      const USER = gql\`fragment UserFields on UserType { id email }\`;
      const BASE = gql\`
        \${USER}
        fragment BaseFields on BaseType {
          id
          owner { ...UserFields }
        }
      \`;
    `;
    const workspaceFragments = collectDocumentFragments(fragmentsDoc);

    // Top-level fragment references BaseFields, which itself references UserFields.
    const outerBody = `
      fragment OuterFields on OuterType {
        id
        base {
          ...BaseFields
        }
      }
    `;
    const parsed = parseGqlFields(outerBody, workspaceFragments);
    expect(parsed.map((f) => f.name)).toEqual(['id', 'base']);
    const base = parsed.find((f) => f.name === 'base')!;
    expect(base.children.map((c) => c.name)).toEqual(['id', 'owner']);
    const owner = base.children.find((c) => c.name === 'owner')!;
    expect(owner.children.map((c) => c.name)).toEqual(['id', 'email']);
  });

  it('handles top-level spread inside a fragment body', () => {
    const fragmentsDoc = 'const F = gql`fragment Common on T { x y }`;';
    const workspaceFragments = collectDocumentFragments(fragmentsDoc);
    const body = 'fragment Outer on T { ...Common z }';
    const parsed = parseGqlFields(body, workspaceFragments);
    expect(parsed.map((f) => f.name)).toEqual(['x', 'y', 'z']);
  });

  it('does not recurse infinitely when two fragments spread each other', () => {
    // Cyclic fragments are guarded by the `resolving` flag inside FragmentDef.
    // The guard kicks in on the second spread attempt, so one extra copy of
    // A's fields makes it into the expanded tree — but crucially, parsing
    // terminates instead of overflowing the stack.
    const gql = `
      fragment A on T {
        id
        ...B
      }
      fragment B on T {
        name
        ...A
      }
    `;
    const parsed = parseGqlFields(gql);
    // Finite output — duplicates are an acceptable artifact of the guard.
    expect(parsed.length).toBeGreaterThan(0);
    expect(new Set(parsed.map((f) => f.name))).toEqual(new Set(['id', 'name']));
  });
});

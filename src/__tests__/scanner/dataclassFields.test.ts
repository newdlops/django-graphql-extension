// Dataclass + Python typing coverage: @dataclass classes with `name: Type`
// annotation syntax, list[X] / X | None / Optional[X] unwrap in TypedField and
// in annotations, and the resolvedType-expansion that pulls a @dataclass into
// the class map when referenced from a graphene Query class.

import { describe, it, expect, beforeEach } from 'vitest';
import { parseClassFields, parseGrapheneSchemas, EMPTY_IMPORTS, ImportInfo } from '../../scanner/grapheneParser';
import { __setMockFiles, __clearMockFiles } from '../__mocks__/vscode';

beforeEach(() => __clearMockFiles());

function makeImports(fromGraphene: string[] = [], fromGrapheneDjango: string[] = []): ImportInfo {
  return {
    fromGraphene: new Set(fromGraphene),
    fromGrapheneDjango: new Set(fromGrapheneDjango),
    hasGrapheneImport: fromGraphene.length > 0,
  };
}

describe('parseClassFields — @dataclass annotation fields', () => {
  it('maps Python scalars to GraphQL scalar fieldType (leaf)', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    id: int',
      '    name: str',
      '    active: bool',
      '    ratio: float',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields.map((f) => f.name)).toEqual(['id', 'name', 'active', 'ratio']);
    expect(fields.map((f) => f.fieldType)).toEqual(['Int', 'String', 'Boolean', 'Float']);
    // Scalar leaves don't carry a resolvedType — it would be expanded as a
    // class lookup, which wouldn't make sense for a bare scalar.
    expect(fields.every((f) => f.resolvedType === undefined)).toBe(true);
  });

  it('maps datetime / Decimal / UUID dotted scalars', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    created_at: datetime.datetime',
      '    today: datetime.date',
      '    price: decimal.Decimal',
      '    uid: uuid.UUID',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields.map((f) => f.fieldType)).toEqual(['DateTime', 'Date', 'Decimal', 'ID']);
  });

  it('list of scalar → fieldType List, resolvedType scalar', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    tags: list[str]',
      '    counts: list[int]',
      '    ids: list[UUID]',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields[0]).toMatchObject({ name: 'tags', fieldType: 'List', resolvedType: 'String' });
    expect(fields[1]).toMatchObject({ name: 'counts', fieldType: 'List', resolvedType: 'Int' });
    expect(fields[2]).toMatchObject({ name: 'ids', fieldType: 'List', resolvedType: 'ID' });
  });

  it('list of class → fieldType List, resolvedType class', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    users: list[UserType]',
      '    maybe_users: list[UserType] | None',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields[0]).toMatchObject({ name: 'users', fieldType: 'List', resolvedType: 'UserType' });
    expect(fields[1]).toMatchObject({ name: 'maybe_users', fieldType: 'List', resolvedType: 'UserType' });
  });

  it('Union[X, None] behaves like X | None', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    a: Union[AuthorType, None]',
      '    b: Union[None, BookType]',
      '    c: Union[int, None]',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields[0]).toMatchObject({ name: 'a', fieldType: 'Field', resolvedType: 'AuthorType' });
    expect(fields[1]).toMatchObject({ name: 'b', fieldType: 'Field', resolvedType: 'BookType' });
    expect(fields[2]).toMatchObject({ name: 'c', fieldType: 'Int', resolvedType: undefined });
  });

  it('extracts annotated class references as resolvedType', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    author: UserType',
      '    tags: list[TagType]',
      '    maybe: OptionalType | None',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields[0].resolvedType).toBe('UserType');
    expect(fields[1].resolvedType).toBe('TagType');
    expect(fields[2].resolvedType).toBe('OptionalType');
  });

  it('handles Optional[X], typing.Optional[X], and None | X union', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    a: Optional[AuthorType]',
      '    b: typing.Optional[BookType]',
      '    c: None | ChapterType',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields.map((f) => f.resolvedType)).toEqual(['AuthorType', 'BookType', 'ChapterType']);
  });

  it('unwraps nested containers: list[X | None], Optional[list[X]]', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    a: list[AuthorType | None]',
      '    b: Optional[list[BookType]]',
      '    c: list[list[ChapterType]]',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields.map((f) => f.resolvedType)).toEqual(['AuthorType', 'BookType', 'ChapterType']);
  });

  it('drops default values after =', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    tags: list[TagType] = field(default_factory=list)',
      '    count: int = 0',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields[0]).toMatchObject({ name: 'tags', resolvedType: 'TagType' });
    expect(fields[1]).toMatchObject({ name: 'count', resolvedType: undefined });
  });

  it('skips annotations inside method bodies', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    id: int',
      '',
      '    @staticmethod',
      '    def resolve_x():',
      '        local: int = 5',
      '        other: SomeType = None',
      '        return local',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields.map((f) => f.name)).toEqual(['id']);
  });

  it('skips ClassVar annotations (not dataclass fields)', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    instances: ClassVar[list[FooType]] = []',
      '    id: int',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields.map((f) => f.name)).toEqual(['id']);
  });

  it('ignores annotation-style fields when isDataclass is false', () => {
    const src = [
      'class Foo(ObjectType):',
      '    id: int',
      '    name: str',
    ];
    const fields = parseClassFields(src, 0, '/f.py', makeImports(['ObjectType']), false);
    expect(fields).toEqual([]);
  });

  it('normalizes camelCase field names to snake_case for lookup consistency', () => {
    // Real captain pattern: @dataclass with field names written in camelCase
    // so the wire name matches the Python attribute. Without normalization,
    // `camelToSnake('undeliveredCount') === 'undelivered_count'` from the
    // frontend side won't find a backend field called `undeliveredCount`.
    const src = [
      '@dataclass',
      'class RtccEmailEmailListItemSummary:',
      '    totalCount: int',
      '    deliveringCount: int',
      '    deliveredCount: int',
      '    undeliveredCount: int',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields.map((f) => f.name)).toEqual([
      'total_count', 'delivering_count', 'delivered_count', 'undelivered_count',
    ]);
    // Field types still reflect the scalar mapping.
    expect(fields.every((f) => f.fieldType === 'Int')).toBe(true);
  });

  it('joins multi-line annotations with continued brackets', () => {
    const src = [
      '@dataclass',
      'class Foo:',
      '    bars: list[',
      '        BarType,',
      '    ]',
      '    last: int',
    ];
    const fields = parseClassFields(src, 1, '/f.py', EMPTY_IMPORTS, true);
    expect(fields.map((f) => f.name)).toEqual(['bars', 'last']);
    expect(fields[0].resolvedType).toBe('BarType');
  });
});

describe('mutation args — nested Arguments / TypedArguments / Input class', () => {
  it('extracts graphene-style `class Arguments:` fields on `ClassName.Field()` mutation', async () => {
    __setMockFiles({
      '/root/schema.py': [
        'import graphene',
        'from .mutation import Mutation',
        'schema = graphene.Schema(mutation=Mutation)',
      ].join('\n'),
      '/root/mutation.py': [
        'import graphene',
        '',
        'class CreateFoo(graphene.Mutation):',
        '    class Arguments:',
        '        name = graphene.String(required=True)',
        '        count = graphene.Int()',
        '',
        '    ok = graphene.Boolean()',
        '',
        'class Mutation(graphene.ObjectType):',
        '    create_foo = CreateFoo.Field()',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/root');
    const all = [
      ...schemas.flatMap((s) => s.queries),
      ...schemas.flatMap((s) => s.mutations),
      ...schemas.flatMap((s) => s.types),
    ];
    const mutationRoot = all.find((c) => c.name === 'Mutation')!;
    const field = mutationRoot.fields.find((f) => f.name === 'create_foo')!;
    const args = field.args ?? [];
    const byName = new Map(args.map((a) => [a.name, a]));
    expect(byName.get('name')!.required).toBe(true);
    expect(byName.get('name')!.type).toBe('String');
    expect(byName.get('count')!.required).toBe(false);
    expect(byName.get('count')!.type).toBe('Int');
  });

  it('does NOT leak class-level type hints (validate/execute) as mutation args', async () => {
    // Captain's TypedBaseMutation has `validate: Callable[...]`,
    // `execute: Callable[...]` type hints at the class body level (not
    // inside `TypedArguments`). Those are attribute/method type hints, not
    // args — the resolver must skip them. Regression for a pipeline where
    // the Query Structure header was showing `validate`, `execute`,
    // `post_execute`, `__build_context__` as mutation arguments.
    __setMockFiles({
      '/root/schema.py': [
        'import graphene',
        'from .mutation import Mutation',
        'schema = graphene.Schema(mutation=Mutation)',
      ].join('\n'),
      '/root/base.py': [
        'import graphene',
        'from typing import Callable, TypedDict, Self',
        '',
        'class TypedBaseMutation(graphene.Mutation):',
        '    class TypedArguments(TypedDict):',
        '        pass',
        '',
        '    ok = graphene.Boolean()',
        '    errors = graphene.Field(object)',
        '',
        '    validate: Callable[..., object]',
        '    execute: Callable[..., Self]',
        '    post_execute: Callable[..., None]',
        '    __build_context__: Callable[..., None]',
      ].join('\n'),
      '/root/mutation.py': [
        'import graphene',
        'from .base import TypedBaseMutation',
        '',
        'class CreateFoo(TypedBaseMutation):',
        '    class TypedArguments(TypedBaseMutation.TypedArguments):',
        '        name: str',
        '        count: int',
        '',
        'class CreateFooMutation:',
        '    create_foo = CreateFoo.Field(required=True)',
        '',
        'class Mutation(CreateFooMutation, graphene.ObjectType):',
        '    pass',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/root');
    const all = [
      ...schemas.flatMap((s) => s.queries),
      ...schemas.flatMap((s) => s.mutations),
      ...schemas.flatMap((s) => s.types),
    ];
    const outer = all.find((c) => c.name === 'CreateFooMutation')!;
    const field = outer.fields.find((f) => f.name === 'create_foo')!;
    const args = field.args ?? [];
    const names = args.map((a) => a.name);

    // Actual args from TypedArguments must be present.
    expect(names).toContain('name');
    expect(names).toContain('count');
    // Class-level type hints on TypedBaseMutation must NOT be args.
    expect(names).not.toContain('validate');
    expect(names).not.toContain('execute');
    expect(names).not.toContain('post_execute');
    expect(names).not.toContain('__build_context__');
    // Assignment fields on TypedBaseMutation (ok, errors) must not be args either.
    expect(names).not.toContain('ok');
    expect(names).not.toContain('errors');
  });

  it('extracts captain-style `class TypedArguments:` annotation fields (with dotted inheritance)', async () => {
    __setMockFiles({
      '/root/schema.py': [
        'import graphene',
        'from .mutation import Mutation',
        'schema = graphene.Schema(mutation=Mutation)',
      ].join('\n'),
      '/root/base.py': [
        'import graphene',
        'from typing import TypedDict',
        '',
        'class TypedBaseMutation(graphene.Mutation):',
        '    class TypedArguments(TypedDict):',
        '        client_mutation_id: str',
        '',
        '    ok = graphene.Boolean()',
      ].join('\n'),
      '/root/mutation.py': [
        'import graphene',
        'from typing import TypedDict',
        'from .base import TypedBaseMutation',
        '',
        'class CreateRightToConsentOrConsult(TypedBaseMutation):',
        '    class TypedArguments(TypedBaseMutation.TypedArguments):',
        '        company_id: IDStr',
        '        title: str',
        '        selected_stakeholder_ids: list[IDStr]',
        '',
        '    ok = graphene.Boolean()',
        '',
        'class CreateRightToConsentOrConsultMutation:',
        '    create_right_to_consent_or_consult = CreateRightToConsentOrConsult.Field(required=True)',
        '',
        'class Mutation(CreateRightToConsentOrConsultMutation, graphene.ObjectType):',
        '    pass',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/root');
    const all = [
      ...schemas.flatMap((s) => s.queries),
      ...schemas.flatMap((s) => s.mutations),
      ...schemas.flatMap((s) => s.types),
    ];
    const outer = all.find((c) => c.name === 'CreateRightToConsentOrConsultMutation')!;
    const field = outer.fields.find((f) => f.name === 'create_right_to_consent_or_consult')!;
    const args = field.args ?? [];
    const names = args.map((a) => a.name);
    // Inherited client_mutation_id + captain-specific args all present.
    expect(names).toContain('client_mutation_id');
    expect(names).toContain('company_id');
    expect(names).toContain('title');
    expect(names).toContain('selected_stakeholder_ids');
    const byName = new Map(args.map((a) => [a.name, a]));
    expect(byName.get('company_id')!.required).toBe(true);
    expect(byName.get('title')!.type).toBe('String');
  });
});

describe('parseFieldArgs — **ArgsClass.__annotations__ unpacking', () => {
  it('resolves args from a TypedDict referenced via .__annotations__', async () => {
    __setMockFiles({
      '/root/schema.py': [
        'import graphene',
        'from .query import Query',
        'schema = graphene.Schema(query=Query)',
      ].join('\n'),
      '/root/query.py': [
        'import graphene',
        'from typing import TypedDict, NotRequired',
        'from .types import Ret',
        '',
        'class RtccArgs(TypedDict):',
        '    company_id: IDStr',
        '    right_to_consent_or_consult_id: IDStr',
        '    page: NotRequired[int]',
        '    per_page: NotRequired[int]',
        '',
        'class RtccQuery:',
        '    rtcc_email_list = TypedField(',
        '        Ret,',
        '        **RtccArgs.__annotations__,',
        '    )',
        '',
        'class Query(RtccQuery, graphene.ObjectType):',
        '    pass',
      ].join('\n'),
      '/root/types.py': [
        'from dataclasses import dataclass',
        '',
        '@dataclass',
        'class Ret:',
        '    id: int',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/root');
    const classes = [
      ...schemas.flatMap((s) => s.queries),
      ...schemas.flatMap((s) => s.types),
      ...schemas.flatMap((s) => s.mutations),
    ];
    const rtcc = classes.find((c) => c.name === 'RtccQuery')!;
    const field = rtcc.fields.find((f) => f.name === 'rtcc_email_list')!;
    const args = field.args ?? [];
    const byName = new Map(args.map((a) => [a.name, a]));
    expect(byName.get('company_id')!.required).toBe(true);
    expect(byName.get('right_to_consent_or_consult_id')!.required).toBe(true);
    expect(byName.get('page')!.required).toBe(false);
    expect(byName.get('page')!.type).toBe('Int');
    expect(byName.get('per_page')!.required).toBe(false);
    expect(byName.get('per_page')!.type).toBe('Int');
  });

  it('renders TypedDict-unpacked args all the way into the Query Structure header', async () => {
    // Full pipeline: parseGrapheneSchemas → classMap → buildQueryStructure with
    // the clicked field's backend FieldInfo → renderQueryStructureHtml. The
    // root args must survive every boundary and land in the header.
    __setMockFiles({
      '/root/schema.py': [
        'import graphene',
        'from .query import Query',
        'schema = graphene.Schema(query=Query)',
      ].join('\n'),
      '/root/query.py': [
        'import graphene',
        'from typing import TypedDict, NotRequired',
        'from .types import Ret',
        '',
        'class RtccEmailEmailListQuery:',
        '    class RtccEmailEmailListQueryArguments(TypedDict):',
        '        company_id: IDStr',
        '        right_to_consent_or_consult_id: IDStr',
        '        page: NotRequired[int]',
        '        per_page: NotRequired[int]',
        '',
        '    rtcc_email_list = TypedField(',
        '        Ret,',
        '        **RtccEmailEmailListQueryArguments.__annotations__,',
        '    )',
        '',
        'class Query(RtccEmailEmailListQuery, graphene.ObjectType):',
        '    pass',
      ].join('\n'),
      '/root/types.py': [
        'from dataclasses import dataclass',
        '',
        '@dataclass',
        'class Ret:',
        '    id: int',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/root');
    const classMap = new Map<string, import('../../types').ClassInfo>();
    for (const s of schemas) {
      for (const c of [...s.queries, ...s.mutations, ...s.types]) classMap.set(c.name, c);
    }
    const owner = classMap.get('RtccEmailEmailListQuery')!;
    const field = owner.fields.find((f) => f.name === 'rtcc_email_list')!;
    expect(field.args, 'backend args should be populated on the field').toBeDefined();
    expect(field.args!.map((a) => a.name)).toEqual([
      'company_id', 'right_to_consent_or_consult_id', 'page', 'per_page',
    ]);

    // Now feed it to buildQueryStructure + renderQueryStructureHtml as the
    // showMissingFields command does.
    const { buildQueryStructure } = await import('../../analysis/queryStructure');
    const { renderQueryStructureHtml } = await import('../../preview/queryStructureWebview');
    const { parseGqlFields } = await import('../../codelens/gqlCodeLensProvider');
    const gf = parseGqlFields('query { rtccEmailList { id } }')[0];
    const retCls = classMap.get('Ret')!;
    const structure = buildQueryStructure(gf, retCls, classMap, undefined, field);
    const html = renderQueryStructureHtml(structure);

    expect(html).toContain('class="header-args"');
    expect(html).toContain('companyId: <span class="arg-type">IDStr!');
    expect(html).toContain('page: <span class="arg-type">Int');
    expect(html).not.toContain('page: <span class="arg-type">Int!');
  });

  it('resolves args when the TypedDict is nested inside the query class (captain pattern)', async () => {
    __setMockFiles({
      '/root/schema.py': [
        'import graphene',
        'from .query import Query',
        'schema = graphene.Schema(query=Query)',
      ].join('\n'),
      '/root/query.py': [
        'import graphene',
        'from typing import TypedDict, NotRequired',
        'from .types import Ret',
        '',
        'class RtccEmailEmailListQuery:',
        '    class RtccEmailEmailListQueryArguments(TypedDict):',
        '        company_id: IDStr',
        '        right_to_consent_or_consult_id: IDStr',
        '        page: NotRequired[int]',
        '        per_page: NotRequired[int]',
        '',
        '    rtcc_email_list = TypedField(',
        '        Ret,',
        '        **RtccEmailEmailListQueryArguments.__annotations__,',
        '    )',
        '',
        'class Query(RtccEmailEmailListQuery, graphene.ObjectType):',
        '    pass',
      ].join('\n'),
      '/root/types.py': [
        'from dataclasses import dataclass',
        '',
        '@dataclass',
        'class Ret:',
        '    id: int',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/root');
    const all = [
      ...schemas.flatMap((s) => s.queries),
      ...schemas.flatMap((s) => s.types),
    ];
    const q = all.find((c) => c.name === 'RtccEmailEmailListQuery')!;
    const field = q.fields.find((f) => f.name === 'rtcc_email_list')!;
    const args = field.args ?? [];
    expect(args.map((a) => a.name)).toEqual([
      'company_id', 'right_to_consent_or_consult_id', 'page', 'per_page',
    ]);
    const byName = new Map(args.map((a) => [a.name, a]));
    expect(byName.get('company_id')!.required).toBe(true);
    expect(byName.get('page')!.required).toBe(false);
    expect(byName.get('page')!.type).toBe('Int');
  });

  it('inherits args transitively through TypedDict subclasses', async () => {
    __setMockFiles({
      '/root/schema.py': [
        'import graphene',
        'from .query import Query',
        'schema = graphene.Schema(query=Query)',
      ].join('\n'),
      '/root/query.py': [
        'import graphene',
        'from typing import TypedDict, NotRequired',
        'from .types import Ret',
        '',
        'class PaginationArgs(TypedDict):',
        '    page: NotRequired[int]',
        '    per_page: NotRequired[int]',
        '',
        'class ListArgs(PaginationArgs):',
        '    company_id: IDStr',
        '',
        'class ListQuery:',
        '    list_things = TypedField(',
        '        Ret,',
        '        **ListArgs.__annotations__,',
        '    )',
        '',
        'class Query(ListQuery, graphene.ObjectType):',
        '    pass',
      ].join('\n'),
      '/root/types.py': [
        'from dataclasses import dataclass',
        '',
        '@dataclass',
        'class Ret:',
        '    id: int',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/root');
    const classes = [
      ...schemas.flatMap((s) => s.queries),
      ...schemas.flatMap((s) => s.types),
    ];
    const q = classes.find((c) => c.name === 'ListQuery')!;
    const args = q.fields.find((f) => f.name === 'list_things')!.args ?? [];
    const names = args.map((a) => a.name);
    // Inherited page/per_page should appear alongside company_id.
    expect(names).toContain('page');
    expect(names).toContain('per_page');
    expect(names).toContain('company_id');
  });
});

describe('firstPositionalType via TypedField — list[X] & X | None', () => {
  it('unwraps TypedField(list[X], ...) and marks the field as a List', () => {
    const src = [
      'class Q:',
      '    xs = TypedField(',
      '        list[FooType],',
      '        **Args.__annotations__,',
      '    )',
    ];
    const fields = parseClassFields(src, 0, '/q.py', EMPTY_IMPORTS, false);
    expect(fields).toHaveLength(1);
    // The ctor is TypedField but its first arg is a Python list — fieldType
    // reports 'List' so the structure UI renders `[FooType]` brackets.
    expect(fields[0]).toMatchObject({ name: 'xs', fieldType: 'List', resolvedType: 'FooType' });
  });

  it('unwraps TypedField(FooType | None)', () => {
    const src = [
      'class Q:',
      '    x = TypedField(FooType | None)',
    ];
    const fields = parseClassFields(src, 0, '/q.py', EMPTY_IMPORTS, false);
    expect(fields[0].resolvedType).toBe('FooType');
  });

  it('unwraps TypedField(list[FooType | None])', () => {
    const src = [
      'class Q:',
      '    xs = TypedField(list[FooType | None])',
    ];
    const fields = parseClassFields(src, 0, '/q.py', EMPTY_IMPORTS, false);
    expect(fields[0].resolvedType).toBe('FooType');
  });
});

// ---- End-to-end: parseGrapheneSchemas pulls in referenced @dataclass types ----

describe('parseGrapheneSchemas — @dataclass is reachable via TypedField', () => {
  it('pulls @dataclass return types into classMap and parses their fields', async () => {
    __setMockFiles({
      '/root/schema.py': [
        'import graphene',
        'from .query import Query',
        '',
        'schema = graphene.Schema(query=Query)',
      ].join('\n'),
      '/root/query.py': [
        'import graphene',
        'from zuzu.common.graphql.typed_graphene import TypedField',
        'from .types import FooDataclass',
        '',
        'class FooQuery:',
        '    foo = TypedField(FooDataclass)',
        '',
        'class Query(FooQuery, graphene.ObjectType):',
        '    pass',
      ].join('\n'),
      '/root/types.py': [
        'from dataclasses import dataclass',
        '',
        '@dataclass',
        'class BarDataclass:',
        '    id: int',
        '    title: str',
        '',
        '@dataclass',
        'class FooDataclass:',
        '    id: int',
        '    bars: list[BarDataclass]',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/root');
    expect(schemas.length).toBeGreaterThan(0);
    const allClasses = [
      ...schemas.flatMap((s) => s.queries),
      ...schemas.flatMap((s) => s.types),
      ...schemas.flatMap((s) => s.mutations),
    ];
    const names = new Set(allClasses.map((c) => c.name));
    expect(names.has('FooDataclass')).toBe(true);
    expect(names.has('BarDataclass')).toBe(true);

    const foo = allClasses.find((c) => c.name === 'FooDataclass')!;
    expect(foo.fields.map((f) => f.name)).toEqual(['id', 'bars']);
    const barsField = foo.fields.find((f) => f.name === 'bars')!;
    expect(barsField.resolvedType).toBe('BarDataclass');

    const bar = allClasses.find((c) => c.name === 'BarDataclass')!;
    expect(bar.fields.map((f) => f.name)).toEqual(['id', 'title']);
  });
});

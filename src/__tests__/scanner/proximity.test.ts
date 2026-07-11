// Scenario 11: two modules define a class with the same name. The scanner should
// resolve each schema entry's references using directory proximity to the Schema() call.

import { describe, it, expect, beforeEach } from 'vitest';
import { __setMockFiles, __clearMockFiles } from '../__mocks__/vscode';
import { parseGrapheneSchemas } from '../../scanner/grapheneParser';
import { ClassInfo, SchemaInfo } from '../../types';

beforeEach(() => __clearMockFiles());

function allClasses(schemas: SchemaInfo[]): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (const s of schemas) {
    out.push(...s.queries, ...s.mutations, ...s.types);
  }
  return out;
}

describe('parseGrapheneSchemas — proximity resolution (scenario 11)', () => {
  it('picks the UserType whose path shares the longest prefix with schema.py', async () => {
    __setMockFiles({
      '/proj/core/types.py': [
        'from graphene import ObjectType, String',
        '',
        'class UserType(ObjectType):',
        '    name = String()',
      ].join('\n'),
      '/proj/api/types.py': [
        'from graphene import ObjectType, Int',
        '',
        'class UserType(ObjectType):',
        '    id = Int()',
      ].join('\n'),
      '/proj/core/schema.py': [
        'from graphene import ObjectType, Field, Schema',
        'from core.types import UserType',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    const coreSchema = schemas.find((s) => s.filePath === '/proj/core/schema.py');
    expect(coreSchema, 'schema originating from core/schema.py must exist').toBeDefined();

    const user = [...coreSchema!.queries, ...coreSchema!.types].find((c) => c.name === 'UserType');
    expect(user, 'UserType must be resolved in this schema context').toBeDefined();

    // Proximity: the core UserType has `name`, the api one has `id`.
    // The Schema() call is in /proj/core/schema.py, so the core version must win.
    const names = user!.fields.map((f) => f.name).sort();
    expect(names).toEqual(['name']);
    expect(user!.filePath).toBe('/proj/core/types.py');
  });

  it('picks the api UserType when the schema lives under /api/', async () => {
    __setMockFiles({
      '/proj/core/types.py': [
        'from graphene import ObjectType, String',
        '',
        'class UserType(ObjectType):',
        '    name = String()',
      ].join('\n'),
      '/proj/api/types.py': [
        'from graphene import ObjectType, Int',
        '',
        'class UserType(ObjectType):',
        '    id = Int()',
      ].join('\n'),
      '/proj/api/schema.py': [
        'from graphene import ObjectType, Field, Schema',
        'from api.types import UserType',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    const apiSchema = schemas.find((s) => s.filePath === '/proj/api/schema.py');
    expect(apiSchema, 'schema originating from api/schema.py must exist').toBeDefined();

    const user = [...apiSchema!.queries, ...apiSchema!.types].find((c) => c.name === 'UserType');
    expect(user!.fields.map((f) => f.name)).toEqual(['id']);
    expect(user!.filePath).toBe('/proj/api/types.py');
  });

  it('prefers a top-level class over a nested test-double with the same name', async () => {
    // Regression: captain has tests like
    //     class RequestCaptableTestCase(GraphQLTestCase):
    //         class Query(ObjectType):
    //             dummy = Boolean()
    //         schema = Schema(query=Query, mutation=Mutation)
    // When the scanner captures nested classes (needed for TypedDict arg
    // containers), the test's inner `Query` used to shadow the real app Query
    // because the test file imports graphene and the real query module
    // doesn't — the graphene-import tiebreaker picked the test double.
    // Proximity resolution must now prefer the top-level class first so the
    // real Query and its mixin chain stay in the classMap.
    __setMockFiles({
      '/proj/app/query.py': [
        // Canonical production Query — no graphene import at the top of this
        // file, matching captain's layout where it's pure composition over
        // mixin Query classes defined elsewhere.
        'from .mixins import FooQueries',
        '',
        'class Query(FooQueries):',
        '    pass',
      ].join('\n'),
      '/proj/app/mixins.py': [
        'from graphene import ObjectType, Field, String',
        '',
        'class FooType(ObjectType):',
        '    name = String()',
        '',
        'class FooQueries:',
        '    foo = Field(FooType)',
      ].join('\n'),
      '/proj/app/schema.py': [
        'import graphene',
        'from .query import Query',
        '',
        'SCHEMA = graphene.Schema(query=Query)',
      ].join('\n'),
      '/proj/tests/test_foo.py': [
        // Test double with a nested `class Query(ObjectType)` — the scanner
        // now captures this because arg containers are nested too.
        'from graphene import Boolean, ObjectType, Schema',
        'from app.query import Query as RealQuery',
        '',
        'class FooTestCase:',
        '    class Query(ObjectType):',
        '        dummy = Boolean()',
        '',
        '    schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    const appSchema = schemas.find((s) => s.filePath === '/proj/app/schema.py');
    expect(appSchema, 'app schema must exist').toBeDefined();

    // The real Query must be resolved — its `foo` field inherited from
    // `FooQueries` must land in the classMap. Picking the test double would
    // produce a Query with only `dummy` instead.
    const queryCls = appSchema!.queries.find((c) => c.name === 'Query');
    expect(queryCls, 'Query class must exist in the app schema').toBeDefined();
    const fooField = queryCls!.fields.find((f) => f.name === 'foo');
    expect(fooField, 'real Query.foo must survive — not replaced by the test double').toBeDefined();
    // The test double would have `dummy` instead; make sure we didn't pick it.
    expect(queryCls!.fields.find((f) => f.name === 'dummy')).toBeUndefined();

    // And the mixin queries must be reachable (they were what "went missing"
    // in the original bug report — 1151 classes vanished).
    const fooQueries = appSchema!.queries.find((c) => c.name === 'FooQueries');
    expect(fooQueries, 'mixin query class must survive').toBeDefined();
  });

  it('prefers a nearby composition root over a top-level Graphene test Query', async () => {
    // Captain's application Query is a composition-only class and therefore
    // has no direct Graphene import. A distant test module also declares a
    // top-level Query(ObjectType). The schema package must win before the
    // Graphene-import tie-breaker is considered.
    __setMockFiles({
      '/proj/app/graphql/schema.py': [
        'import graphene',
        'from .query import Query',
        '',
        'SCHEMA = graphene.Schema(query=Query)',
      ].join('\n'),
      '/proj/app/graphql/query/__init__.py': [
        'from .company_query import CompanyQuery',
        'from packages.captable.app_queries import AppCaptableQueries',
        '',
        'class AppQueries(CompanyQuery):',
        '    pass',
        '',
        'class Query(AppQueries, AppCaptableQueries):',
        '    pass',
      ].join('\n'),
      '/proj/app/graphql/query/company_query.py': [
        'from common.typed_graphene import TypedField',
        '',
        'class CompanyType:',
        '    captable_english_name = TypedField(str)',
        '',
        'class CompanyQuery:',
        '    company = TypedField(CompanyType)',
      ].join('\n'),
      '/proj/packages/captable/app_queries.py': [
        'from .captable_query import CaptableQuery',
        '',
        'class AppCaptableQueries(CaptableQuery):',
        '    pass',
      ].join('\n'),
      '/proj/packages/captable/captable_query.py': [
        'from common.typed_graphene import TypedField',
        '',
        'class CaptableType:',
        '    items = TypedField(list[CaptableItemType])',
        '',
        'class CaptableItemType:',
        '    ownership = TypedField(float)',
        '',
        'class CaptableQuery:',
        '    captable = TypedField(CaptableType)',
      ].join('\n'),
      '/proj/packages/payroll/graphql/tests/test_query.py': [
        'from graphene import Field, ObjectType, String',
        '',
        'class PayrollType(ObjectType):',
        '    id = String()',
        '',
        'class Query(ObjectType):',
        '    payroll = Field(PayrollType)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    const appSchema = schemas.find((s) => s.filePath === '/proj/app/graphql/schema.py');
    expect(appSchema, 'application schema must exist').toBeDefined();

    const root = appSchema!.queries.find((c) => c.name === 'Query');
    expect(root?.filePath).toBe('/proj/app/graphql/query/__init__.py');
    expect(root?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(['company', 'captable']),
    );
    expect(root?.fields.some((field) => field.name === 'payroll')).toBe(false);
    expect(appSchema!.queries.find((c) => c.name === 'CompanyQuery')?.isSchemaRootContributor).toBe(true);
    expect(appSchema!.queries.find((c) => c.name === 'CaptableQuery')?.isSchemaRootContributor).toBe(true);
  });

  it('resolves both schemas independently when two Schema() calls exist in different subtrees', async () => {
    __setMockFiles({
      '/proj/core/types.py': [
        'from graphene import ObjectType, String',
        '',
        'class UserType(ObjectType):',
        '    name = String()',
      ].join('\n'),
      '/proj/api/types.py': [
        'from graphene import ObjectType, Int',
        '',
        'class UserType(ObjectType):',
        '    id = Int()',
      ].join('\n'),
      '/proj/core/schema.py': [
        'from graphene import ObjectType, Field, Schema',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
      '/proj/api/schema.py': [
        'from graphene import ObjectType, Field, Schema',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    expect(schemas.length).toBeGreaterThanOrEqual(2);

    const core = schemas.find((s) => s.filePath === '/proj/core/schema.py');
    const api = schemas.find((s) => s.filePath === '/proj/api/schema.py');
    expect(core && api, 'both schema entries must exist').toBeTruthy();

    const coreUser = allClasses([core!]).find((c) => c.name === 'UserType');
    const apiUser = allClasses([api!]).find((c) => c.name === 'UserType');
    expect(coreUser!.filePath).toBe('/proj/core/types.py');
    expect(apiUser!.filePath).toBe('/proj/api/types.py');
    expect(core!.queries.find((c) => c.name === 'Query')!.isSchemaRoot).toBe(true);
    expect(api!.queries.find((c) => c.name === 'Query')!.isSchemaRoot).toBe(true);
    expect(coreUser!.isSchemaRoot).not.toBe(true);
    expect(apiUser!.isSchemaRoot).not.toBe(true);
  });
});

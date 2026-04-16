# Django GraphQL Explorer

A VS Code extension that discovers and navigates GraphQL schemas in Django projects. Supports **Graphene**, Strawberry, Ariadne, and `.graphql` schema files.

## Features

### Schema Tree Explorer

Browse your entire GraphQL schema from a dedicated Activity Bar panel.

- Auto-detects Django projects with GraphQL frameworks
- Displays Queries, Mutations, Subscriptions, and Types in a collapsible tree
- Click to preview GraphQL SDL, double-click to jump to Python source
- Real-time search with regex, case-sensitive, and whole-word toggle
- Sort alphabetically (A-Z / Z-A)

### Frontend-Backend Mapping (CodeLens)

Automatically maps frontend `gql` queries to backend Python classes.

```typescript
// CodeLens appears above each field:
// → StockQuery.stock [Query]
gql`
  query {
    stock(companyId: $companyId) {
      id
      name
    }
  }
`;
```

- Matches `gql`, `graphql` tagged templates, `/* GraphQL */` comments
- Handles `${fragment}` template expressions
- Supports query, mutation, and type field matching
- Click CodeLens to jump to the Python class definition

### Hover Information

Hover over any field inside a `gql` template to see:

- Backend class and field name mapping (`camelCase` -> `snake_case`)
- Resolved type information
- Field arguments
- Missing fields not queried from the backend type
- Clickable link to view all missing fields

### Schema Preview

Click any class in the tree to preview its GraphQL schema in frontend query style:

```graphql
query StockQuery($companyId: ID!) {
  stock(companyId: $companyId) {
    id
    name
    company {
      id
      name
      address
    }
  }
}
```

- Types expanded inline (not as separate definitions)
- Arguments shown with variable declarations
- `snake_case` auto-converted to `camelCase`

## Supported Frameworks

| Framework | Detection | Schema Parsing |
|-----------|-----------|----------------|
| **Graphene / graphene-django** | `GRAPHENE` in settings.py or `import graphene` | Full: classes, fields, args, inheritance, `.Field()` pattern |
| **Strawberry** | `strawberry_django` in settings.py | Basic |
| **Ariadne** | `ariadne` in settings.py | Basic |
| **.graphql / .gql files** | File presence | SDL parsing |

## Performance

- **File-level caching** with SHA-256 content hashing
- Cold start: ~7s, warm cache (no changes): ~1-2s
- Incremental: only changed files re-parsed
- Cache persists across VS Code sessions

## Requirements

- VS Code 1.75.0+
- A Django project with one of the supported GraphQL frameworks

## Extension Settings

No configuration required. The extension auto-detects projects on activation.

## Known Limitations

- Fields defined via `@property` or dynamic `resolve_*` methods without class-level field declarations may not be detected
- Import aliases across deeply nested module chains may occasionally break class resolution
- Common field names (`id`, `name`) may match imprecise types when `resolvedType` is unavailable

## License

MIT

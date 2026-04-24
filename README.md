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
// → ProductQuery.product [Query]
gql`
  query ProductById($productId: ID!) {
    product(productId: $productId) {
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
query ProductQuery($productId: ID!) {
  product(productId: $productId) {
    id
    name
    category {
      id
      name
      slug
    }
  }
}
```

- Types expanded inline (not as separate definitions)
- Arguments shown with variable declarations
- `snake_case` auto-converted to `camelCase`

### Live Query Inspector

Open a **side-by-side** panel that auto-follows the cursor inside any `gql`/`graphql` template. It shows:

- The operation signature (`query X($var: Type!, …)`) with every variable declared at the top
- Per-field backend args, but only the args the user actually passed — not every arg the backend allows
- A JSON-tree view of the entire selection with missing-field markers and frontend-only markers
- Lazy **▸ expand** markers on any subtree truncated by the depth cap or cycle guard — click to load another two levels on demand, same as a debugger inspecting a variable

Open via **Django GraphQL: Open Live Query Structure** (Command Palette) or the icon in the Schema Explorer title bar.

### Typed Graphene Patterns

The parser understands modern graphene codebases that mix `@dataclass` types, `TypedField`, and `TypedDict`-based argument containers:

```python
@dataclass
class ItemListSummary:
    total_count: int
    active_count: int
    ...

class ItemListQuery:
    class ItemListArguments(TypedDict):
        account_id: IDStr
        page: NotRequired[int]

    item_list = TypedField(
        ItemList,
        **ItemListArguments.__annotations__,
    )
```

- `list[X]` / `Optional[X]` / `X | None` / `Union[X, None]` unwrap to `X`
- Python primitives (`str`/`int`/`float`/`bool`/`Decimal`/`UUID`/`datetime.*`) map to GraphQL scalars for leaf display
- `**ArgsClass.__annotations__` / `**Unpack[ArgsClass]` expands to the class's annotation fields (including inherited TypedDict chains)
- Mutation args come from `X.Field()` → `X.Arguments` / `X.TypedArguments` / `X.Input` (including dotted inheritance across nested typed argument classes)

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

## Commands

| Command | Description |
|---------|-------------|
| **Django GraphQL: Refresh Schema** | Re-scans all project files. |
| **Django GraphQL: Open Live Query Structure** | Opens the side-by-side live inspector that follows the cursor. |
| **Django GraphQL: Inspect Type…** | Quick-pick any class to view its SDL preview. |
| **Django GraphQL: Clear Parse Cache** | Drops the persisted parse cache and re-scans from scratch. Useful after an extension upgrade or when a stale result looks suspicious. |

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `djangoGraphqlExplorer.inlayHints` | `false` | Show inline `→ TypeName` chips after every gql field. Disabled by default in favor of the Live Query Graph (Beside panel). |

No further configuration required. The extension auto-detects projects on activation.

## Known Limitations

- Fields defined via `@property` or dynamic `resolve_*` methods without class-level field declarations may not be detected
- Import aliases across deeply nested module chains may occasionally break class resolution
- Common field names (`id`, `name`) may match imprecise types when `resolvedType` is unavailable

## License

MIT

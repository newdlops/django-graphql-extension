# Changelog

## 0.0.2 — 2026-04-18

### Highlights
- Full support for the Captain-style `TypedField` + `@dataclass` pattern (annotation-based fields, TypedDict arg unpacking, `list[X]` / `X | None` / `Union[X, None]` type syntax).
- Cross-literal fragment spreads — `${FRAGMENT_VAR}` in one gql template resolves to a `fragment` defined in another literal.
- Live Query Inspector now shows the operation's variable declarations (`query X($companyId: ID!, …)`), the exact arguments the user passed on each field (not every backend arg), and supports **lazy deeper expansion** — click the blue ▸ on truncated subtrees to load another two levels on demand.
- Mutation arguments are pulled from the mutation class's nested `Arguments` / `TypedArguments` / `Input` class, including dotted-path inheritance (`TypedBaseMutation.TypedArguments`).
- New Activity Bar / marketplace icons (GraphQL-style pink hexagon).
- New command **Django GraphQL: Clear Parse Cache** for forcing a fresh re-scan after an upgrade or unusual result.

### Parser
- **`@dataclass` classes**: detects the decorator, parses `name: Type` annotations as fields, skips method bodies, nested classes, and `ClassVar`. Fields are normalised to `snake_case` on storage so camelCase Python names still match gql `camelToSnake` lookups.
- **Python typing syntax** (`list[X]` / `List[X]` / `Optional[X]` / `Sequence[X]` / `Tuple[X]` / `dict[K, V]` / `Annotated[X, …]` / `typing.*` / `X | None` / `Union[X, None]`) — all unwrap to the payload type.
- **Python primitive → GraphQL scalar mapping** (`str → String`, `int → Int`, `float → Float`, `bool → Boolean`, `Decimal → Decimal`, `UUID → ID`, `datetime.datetime → DateTime`, `datetime.date → Date`, `datetime.time → Time`) so dataclass leaves render a meaningful type instead of `DataclassField`.
- **TypedDict unpacking**: `TypedField(Ret, **ArgsClass.__annotations__)` / `**Unpack[ArgsClass]` resolves `ArgsClass` (including nested inside a query class) and inlines its annotations as field args. Follows TypedDict inheritance chains.
- **Mutation args**: `field = X.Field()` pulls its args from `X`'s nested `Arguments` / `TypedArguments` / `Input` class. Handles both graphene-style `name = String(required=True)` assignment fields and captain-style `name: Type` annotation fields. Follows dotted inheritance like `TypedBaseMutation.TypedArguments`.
- **Nested classes** are now captured in the class index (needed for TypedDict arg containers). Proximity resolution prefers **top-level** classes over nested ones so a test double's `class Query(ObjectType)` no longer shadows the real production `Query`.
- **Multi-line `Meta.fields = [...]` / `fields = (...)`** lists are collected across line breaks.
- **List-shape detection** on Pattern 1 fields — `TypedField(list[X])` / `Field(List(X))` / `NonNull(List(X))` / `lambda: List(X)` all report `fieldType: 'List'` so the UI renders `[X]` brackets.
- Relay `Connection` classes auto-synthesize `edges` / `node` / `cursor` / `page_info` fields from the `Meta.node` reference.
- `InputObjectType` arg types reachable via field `args` are now pulled into the class map so their shape shows up in the inspector.
- Resolved-type saturation pass: `@dataclass` types referenced only via `TypedField(...)` from graphene classes are pulled into the schema even when they live in files that don't import graphene themselves.
- Fixed: `class Foo(graphene.ObjectType)` was being filtered out by the base-class regex (`\w+` vs `[\w.]+`) so dotted base names now survive.

### Frontend gql matcher
- **Cross-literal fragments**: `${FRAGMENT}` spreads now resolve to any `fragment` defined elsewhere in the same source file. New `collectDocumentFragments(docText)` helper, threaded through CodeLens, Hover, coverage, cursor resolver, and diagnostics.
- **Operation-level variables** parsed from `query X($companyId: ID!, $page: Int) { … }` — supports comma-less lists, list types, `!` required marker, default values. Surfaced on the Live Inspector.
- **Field args**: `collectArgNames` captures the names the user actually wrote in `(...)`, handling comma-less GraphQL syntax, nested objects/arrays/strings, and enum/boolean literals that aren't arg names.
- `GqlField.argNames?: string[]` — used by `buildQueryStructure` to filter the root's args to only what the user passed (marked `provided: true`). Empty `(...)` or no `(...)` falls back to the full backend surface so users can still discover available args.

### Query Structure UI
- Root node carries backend args (`rootFieldInfo.args` threaded through `buildQueryStructure`). The "⚠ missing fields" panel renders them in a `.header-args` block; Live Inspector renders them inline next to each root.
- `hasMoreChildren` marker — when expansion is truncated (depth cap or cycle), the node is rendered as a collapsed `<details class="block-lazy">` with data attributes. First open posts `expandType` to the extension, which responds with a two-level subtree rendered at the correct depth (same `<details>` shape as eager nodes, so indentation and line spacing line up).
- Scalar leaves (`String`, `Int`, `Float`, …) are treated as known — no more italic "unknown type" on them.
- Enlarged ✓ / ✗ markers and ▾ / ▸ twisties for better visibility.
- New `buildLazySubtree(cls, classMap, ancestors, maxDepth)` + `renderJsonSubtreeHtml(nodes, ancestry, startDepth)` exports.

### Commands & UI
- **Django GraphQL: Clear Parse Cache** (`djangoGraphqlExplorer.clearCache`) — drops the persisted cache and re-scans. Available in the Schema Explorer view title overflow and the Command Palette.
- `ParseCache.clearAll()` / `ParseCache.size()` for programmatic use and reporting.
- Packaged marketplace icon at `media/icon.png` (128×128, GraphQL pink hexagon), generated via `npm run icons` from `scripts/generate-icon.mjs` (pure Node, no native deps).
- Activity Bar icon → `media/graphql-activity.svg` (monochrome, adapts to theme).

### Fixes
- Resolved cache-staleness bug where bumping the classRegex between versions silently returned old (incomplete) class lists — cache key bumped v5 → v8 across this release.
- Fixed: test files' nested `class Query(ObjectType):` test-doubles were shadowing the real production `Query`, collapsing the app schema's ~1400 query classes to a single stub. Added `isNested` tracking + proximity tiebreaker prefers top-level.
- Fixed: `TypedBaseMutation`'s class-level `Callable` type hints (`validate:`, `execute:`, `post_execute:`, `__build_context__:`) were being treated as mutation args by the annotation resolver. Resolver now only picks up class-body annotations for TypedDict / `@dataclass` classes; regular graphene classes must use a nested `Arguments` class.

### Tests
- 272 unit tests covering the scanner, frontend parser, cursor resolver, query structure builder, and all webview rendering paths.

## 0.0.1 — 2026-04-16

### Initial Release

#### Schema Explorer
- Auto-detect Django GraphQL projects (Graphene, Strawberry, Ariadne, .graphql)
- Activity Bar panel with integrated search + tree view
- Real-time search with regex, case-sensitive, whole-word toggles
- Alphabetical sort (none / A-Z / Z-A)
- Click to preview GraphQL SDL, double-click to open Python source
- Schema preview in frontend query style with inline type expansion

#### Graphene Parser
- Class extraction with inheritance graph traversal
- Multi-pass scanning: graphene files first, then missing base classes
- `.Field()` mutation registration pattern support
- `lambda: Type` and string type reference support
- Multi-line field definition parsing (up to 15 lines look-ahead)
- Import alias resolution (`import X as Y`)
- Keyword argument extraction for field args
- Schema() call detection for root Query/Mutation identification
- Proximity-based class resolution for multi-schema projects

#### Caching
- SHA-256 content hash per file for O(1) invalidation
- globalState persistence across VS Code sessions
- Automatic pruning of deleted files
- Cache version tracking for parser upgrades

#### Deduplication
- Resolved root class dedup (different files resolving to same schema)
- File-path dedup (multiple Schema() calls in same file)
- Schema entry dedup by (filePath, queryRootName, mutationRootName)

#### CodeLens & Hover
- Frontend `gql`/`graphql` template detection
- `${...}` template expression handling
- `fragment` definition skipping
- Recursive field matching with parent type context
- `camelCase` <-> `snake_case` conversion
- Missing field detection with coverage display
- Type inference from field name conventions
- Alias, spread, directive, comment handling in GQL parser
- Click-through to Python source from CodeLens
- Hover with match details, arguments, and missing fields

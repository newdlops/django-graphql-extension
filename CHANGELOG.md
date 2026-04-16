# Changelog

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

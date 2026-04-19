use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;

// --- Compiled regexes (match TypeScript patterns in src/scanner/grapheneParser.ts) ---

// Class declaration. Multi-line base lists are absorbed by [^)]* (which matches \n).
static CLASS_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?m)^[ \t]*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:").unwrap()
});

static COMMENT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"#[^\n]*").unwrap());
static DOTTED_IDENT_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"^[A-Za-z0-9_.]+$").unwrap());

static DATACLASS_DECO_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"^@\s*(?:dataclasses\s*\.\s*)?dataclass\b").unwrap());
static NESTED_CLASS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[ \t]+class\b").unwrap());

static GRAPHENE_IMPORT_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"from\s+graphene\s+import\s+(.+)").unwrap());
static DJANGO_IMPORT_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"from\s+graphene_django(?:\.[A-Za-z_][A-Za-z0-9_]*)?\s+import\s+(.+)").unwrap()
});
static IMPORT_GRAPHENE_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"import\s+graphene").unwrap());

static CONTAINS_GRAPHENE_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)graphene").unwrap());

static SCHEMA_DOTTED_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?s)graphene\.Schema\s*\(([^)]*)\)").unwrap());
static SCHEMA_BARE_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?s)Schema\s*\(([^)]*)\)").unwrap());
static QUERY_ASSIGN_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"query\s*=\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap());
static MUTATION_ASSIGN_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"mutation\s*=\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap());

static ALIAS_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?s)from\s+\S+\s+import\s+([^)]+(?:\([^)]*\))?)").unwrap()
});
static AS_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$").unwrap()
});

pub struct RawClass {
  pub name: String,
  pub base_classes: Vec<String>,
  pub line_number: u32,
  pub is_dataclass: bool,
  pub is_nested: bool,
}

pub struct Imports {
  pub from_graphene: Vec<String>,
  pub from_graphene_django: Vec<String>,
  pub has_graphene_import: bool,
}

pub struct SchemaEntry {
  pub query_root_name: Option<String>,
  pub mutation_root_name: Option<String>,
}

pub struct FileParsed {
  pub contains_graphene: bool,
  pub classes: Vec<RawClass>,
  pub imports: Imports,
  pub schema_entries: Vec<SchemaEntry>,
}

fn line_of_byte(text: &str, byte_offset: usize) -> u32 {
  let end = byte_offset.min(text.len());
  text.as_bytes()[..end]
    .iter()
    .filter(|&&b| b == b'\n')
    .count() as u32
}

fn extract_classes(text: &str, all_lines: &[&str]) -> Vec<RawClass> {
  let mut out = Vec::new();

  for caps in CLASS_RE.captures_iter(text) {
    let m0 = caps.get(0).unwrap();
    let name = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
    let base_raw = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();

    // Strip comments, split by comma, filter to dotted identifiers only.
    let stripped = COMMENT_RE.replace_all(&base_raw, "");
    let base_classes: Vec<String> = stripped
      .split(',')
      .map(|b| b.trim().to_string())
      .filter(|b| !b.is_empty() && DOTTED_IDENT_RE.is_match(b))
      .collect();

    let line_number = line_of_byte(text, m0.start());
    let class_line = all_lines.get(line_number as usize).copied().unwrap_or("");
    let is_nested = NESTED_CLASS_RE.is_match(class_line);

    // Scan upward for a `@dataclass` / `@dataclasses.dataclass` decorator.
    // Blanks and `#` comments are skipped; any other non-decorator line ends the scan.
    let mut is_dataclass = false;
    if line_number > 0 {
      let mut i = (line_number as i64) - 1;
      while i >= 0 {
        let prev = all_lines.get(i as usize).copied().unwrap_or("").trim();
        if prev.is_empty() || prev.starts_with('#') {
          i -= 1;
          continue;
        }
        if prev.starts_with('@') {
          if DATACLASS_DECO_RE.is_match(prev) {
            is_dataclass = true;
          }
          i -= 1;
          continue;
        }
        break;
      }
    }

    out.push(RawClass {
      name,
      base_classes,
      line_number,
      is_dataclass,
      is_nested,
    });
  }

  out
}

fn parse_imports(text: &str) -> Imports {
  let mut from_graphene: Vec<String> = Vec::new();
  let mut from_graphene_django: Vec<String> = Vec::new();

  let mut seen_graphene: std::collections::HashSet<String> = Default::default();
  for caps in GRAPHENE_IMPORT_RE.captures_iter(text) {
    let block = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    for part in block.split(',') {
      let trimmed = part.trim();
      if trimmed.is_empty() { continue; }
      // `X as Y` → take Y (the alias used in local scope).
      let name = if let Some(idx) = trimmed.find(" as ") {
        trimmed[idx + 4..].trim().to_string()
      } else {
        trimmed.to_string()
      };
      if !name.is_empty() && seen_graphene.insert(name.clone()) {
        from_graphene.push(name);
      }
    }
  }

  let mut seen_django: std::collections::HashSet<String> = Default::default();
  for caps in DJANGO_IMPORT_RE.captures_iter(text) {
    let block = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    for part in block.split(',') {
      let trimmed = part.trim();
      if trimmed.is_empty() { continue; }
      let name = if let Some(idx) = trimmed.find(" as ") {
        trimmed[idx + 4..].trim().to_string()
      } else {
        trimmed.to_string()
      };
      if !name.is_empty() && seen_django.insert(name.clone()) {
        from_graphene_django.push(name);
      }
    }
  }

  let has_graphene_import = IMPORT_GRAPHENE_RE.is_match(text);

  Imports {
    from_graphene,
    from_graphene_django,
    has_graphene_import,
  }
}

fn build_alias_map(text: &str) -> HashMap<String, String> {
  // `from X import A as B, C` → aliasMap["B"] = "A".
  let mut map = HashMap::new();
  for caps in ALIAS_RE.captures_iter(text) {
    let block = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    let cleaned: String = block.chars().filter(|c| *c != '(' && *c != ')').collect();
    for part in cleaned.split(',') {
      let trimmed = part.trim();
      if let Some(caps2) = AS_RE.captures(trimmed) {
        let original = caps2.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let alias = caps2.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
        if !original.is_empty() && !alias.is_empty() {
          map.insert(alias, original);
        }
      }
    }
  }
  map
}

fn detect_schema_calls(text: &str, imports: &Imports) -> Vec<SchemaEntry> {
  // Matches TS detectSchemaCall: always scan `graphene.Schema(...)`; also scan
  // bare `Schema(...)` when Schema was imported from graphene. Any resulting
  // duplicates are collapsed by the JS-side key dedup over schemaEntries.
  let mut out = Vec::new();

  let push_from_args = |args: &str, out: &mut Vec<SchemaEntry>| {
    let q = QUERY_ASSIGN_RE
      .captures(args)
      .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    let m = MUTATION_ASSIGN_RE
      .captures(args)
      .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    out.push(SchemaEntry {
      query_root_name: q,
      mutation_root_name: m,
    });
  };

  for caps in SCHEMA_DOTTED_RE.captures_iter(text) {
    let args = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    push_from_args(args, &mut out);
  }

  if imports.from_graphene.iter().any(|n| n == "Schema") {
    for caps in SCHEMA_BARE_RE.captures_iter(text) {
      let args = caps.get(1).map(|m| m.as_str()).unwrap_or("");
      push_from_args(args, &mut out);
    }
  }

  out
}

pub fn parse_file(text: &str) -> FileParsed {
  let contains_graphene = CONTAINS_GRAPHENE_RE.is_match(text);
  let imports = if contains_graphene {
    parse_imports(text)
  } else {
    Imports {
      from_graphene: Vec::new(),
      from_graphene_django: Vec::new(),
      has_graphene_import: false,
    }
  };

  let alias_map = build_alias_map(text);
  let all_lines: Vec<&str> = text.split('\n').collect();
  let raw_classes = extract_classes(text, &all_lines);

  // Resolve aliased base class names (`from X import A as B` → `B` → `A`).
  let classes: Vec<RawClass> = raw_classes
    .into_iter()
    .map(|mut c| {
      c.base_classes = c
        .base_classes
        .into_iter()
        .map(|bc| alias_map.get(&bc).cloned().unwrap_or(bc))
        .collect();
      c
    })
    .collect();

  let schema_entries = if contains_graphene {
    detect_schema_calls(text, &imports)
  } else {
    Vec::new()
  };

  FileParsed {
    contains_graphene,
    classes,
    imports,
    schema_entries,
  }
}

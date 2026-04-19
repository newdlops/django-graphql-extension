use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use rayon::prelude::*;

mod detector;
mod parser;
mod walker;

#[napi(object)]
pub struct ScanOptions {
  pub root_dir: String,
  /// Map of absolute file path → cached content hash. When the freshly
  /// computed hash matches, `data` is omitted and `cache_hit` is true —
  /// the JS caller reuses its existing cached parse result.
  pub cached_hashes: HashMap<String, String>,
  /// Subset of cached_hashes whose cached parse has at least one class (so
  /// their text is still needed on the JS side for Pass 2 saturation /
  /// parseClassFields later). Passed in because cache hits never re-parse
  /// in Rust and therefore can't self-report. Files NOT in this list are
  /// assumed to have zero classes and their text is omitted from the
  /// response — saving a big chunk of the NAPI boundary cost and V8 string
  /// allocation churn. When omitted, behavior falls back to always
  /// shipping text for cache hits (Phase 1 semantics).
  pub cached_nonempty_paths: Option<Vec<String>>,
  /// When false, the returned files omit the full text. Only meaningful for
  /// callers that already have the text cached or plan to re-read on demand
  /// (e.g. once parseClassFields moves to the native side). Defaults to
  /// true to preserve the Phase 1 behavior.
  pub include_text: Option<bool>,
}

#[napi(object)]
pub struct ClassEntryJs {
  pub name: String,
  pub base_classes: Vec<String>,
  pub line_number: u32,
  pub is_dataclass: bool,
  pub is_nested: bool,
}

#[napi(object)]
pub struct ImportsJs {
  pub from_graphene: Vec<String>,
  pub from_graphene_django: Vec<String>,
  pub has_graphene_import: bool,
}

#[napi(object)]
pub struct SchemaEntryJs {
  pub query_root_name: Option<String>,
  pub mutation_root_name: Option<String>,
}

#[napi(object)]
pub struct FileParsedJs {
  pub contains_graphene: bool,
  pub classes: Vec<ClassEntryJs>,
  pub imports: ImportsJs,
  pub schema_entries: Vec<SchemaEntryJs>,
}

#[napi(object)]
pub struct FileResultJs {
  pub path: String,
  pub content_hash: String,
  /// Full file text. Present when `ScanOptions.include_text` is not false.
  pub text: Option<String>,
  pub cache_hit: bool,
  pub data: Option<FileParsedJs>,
}

#[napi(object)]
pub struct ScanStatsJs {
  pub file_count: u32,
  pub total_bytes: u32,
  pub walk_ms: u32,
  pub read_ms: u32,
  pub parse_ms: u32,
  pub total_ms: u32,
}

#[napi(object)]
pub struct ScanResultJs {
  pub files: Vec<FileResultJs>,
  pub stats: ScanStatsJs,
}

fn to_js(p: parser::FileParsed) -> FileParsedJs {
  FileParsedJs {
    contains_graphene: p.contains_graphene,
    classes: p
      .classes
      .into_iter()
      .map(|c| ClassEntryJs {
        name: c.name,
        base_classes: c.base_classes,
        line_number: c.line_number,
        is_dataclass: c.is_dataclass,
        is_nested: c.is_nested,
      })
      .collect(),
    imports: ImportsJs {
      from_graphene: p.imports.from_graphene,
      from_graphene_django: p.imports.from_graphene_django,
      has_graphene_import: p.imports.has_graphene_import,
    },
    schema_entries: p
      .schema_entries
      .into_iter()
      .map(|s| SchemaEntryJs {
        query_root_name: s.query_root_name,
        mutation_root_name: s.mutation_root_name,
      })
      .collect(),
  }
}

struct FileComputed {
  path: String,
  content_hash: String,
  text: String,
  cache_hit: bool,
  data: Option<FileParsedJs>,
  contains_graphene: bool,
}

fn run_scan(opts: ScanOptions) -> ScanResultJs {
  let t_total = std::time::Instant::now();
  let include_text = opts.include_text.unwrap_or(true);

  let t_walk = std::time::Instant::now();
  let paths = walker::collect_py_paths(&opts.root_dir);
  let walk_ms = t_walk.elapsed().as_millis() as u32;

  let t_read = std::time::Instant::now();
  let raws = walker::read_all_parallel(&paths);
  let read_ms = t_read.elapsed().as_millis() as u32;

  let total_bytes: u64 = raws.iter().map(|r| r.bytes).sum();

  // Set of cache-hit paths that still need their text on the JS side. Passed
  // in because Rust doesn't re-parse cache hits and can't know whether the
  // cached entry had any classes. Falls back to "always include" when the
  // caller doesn't hint.
  let hint_available = opts.cached_nonempty_paths.is_some();
  let cached_nonempty: std::collections::HashSet<String> = opts
    .cached_nonempty_paths
    .as_ref()
    .map(|v| v.iter().cloned().collect())
    .unwrap_or_default();

  let t_parse = std::time::Instant::now();
  let computed: Vec<FileComputed> = raws
    .into_par_iter()
    .map(|raw| {
      let cache_hit = opts
        .cached_hashes
        .get(&raw.path)
        .map(|h| h == &raw.hash)
        .unwrap_or(false);
      let (data, has_classes) = if cache_hit {
        // Cache hit: defer to JS hint (nonempty_paths). When no hint was
        // provided, play safe and keep the text (Phase 1 behavior).
        let keep = !hint_available || cached_nonempty.contains(&raw.path);
        (None, keep)
      } else {
        let parsed = parser::parse_file(&raw.text);
        let has = !parsed.classes.is_empty();
        (Some(to_js(parsed)), has)
      };
      FileComputed {
        path: raw.path,
        content_hash: raw.hash,
        text: raw.text,
        cache_hit,
        data,
        contains_graphene: has_classes,
      }
    })
    .collect();
  let parse_ms = t_parse.elapsed().as_millis() as u32;

  let files: Vec<FileResultJs> = computed
    .into_iter()
    .map(|fc| {
      // `contains_graphene` here is reused as "has_classes or needs text".
      // Files with no classes contribute nothing to rawMultiMap downstream
      // (reconstructFromCache iterates cached.classes, extractClassesFromCachedFile
      // iterates data.classes — both no-op when empty) so shipping their text
      // is pure overhead.
      let include = include_text && fc.contains_graphene;
      FileResultJs {
        path: fc.path,
        content_hash: fc.content_hash,
        text: if include { Some(fc.text) } else { None },
        cache_hit: fc.cache_hit,
        data: fc.data,
      }
    })
    .collect();

  let file_count = files.len() as u32;
  let total_ms = t_total.elapsed().as_millis() as u32;

  ScanResultJs {
    files,
    stats: ScanStatsJs {
      file_count,
      total_bytes: total_bytes.min(u32::MAX as u64) as u32,
      walk_ms,
      read_ms,
      parse_ms,
      total_ms,
    },
  }
}

pub struct ScanTask(Option<ScanOptions>);

impl Task for ScanTask {
  type Output = ScanResultJs;
  type JsValue = ScanResultJs;

  fn compute(&mut self) -> Result<Self::Output> {
    let opts = self
      .0
      .take()
      .ok_or_else(|| Error::from_reason("scan task consumed twice"))?;
    Ok(run_scan(opts))
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi]
pub fn scan_project(opts: ScanOptions) -> Result<ScanResultJs> {
  Ok(run_scan(opts))
}

#[napi(ts_return_type = "Promise<ScanResultJs>")]
pub fn scan_project_async(opts: ScanOptions) -> AsyncTask<ScanTask> {
  AsyncTask::new(ScanTask(Some(opts)))
}

#[napi(object)]
pub struct ProjectInfoJs {
  pub root_dir: String,
  pub frameworks: Vec<String>,
}

#[napi(object)]
pub struct DetectResultJs {
  pub projects: Vec<ProjectInfoJs>,
  pub walk_ms: u32,
  pub total_ms: u32,
}

fn run_detect(workspace_roots: Vec<String>) -> DetectResultJs {
  let t_total = std::time::Instant::now();
  let t_walk = std::time::Instant::now();
  let projects = detector::detect_projects(&workspace_roots);
  let walk_ms = t_walk.elapsed().as_millis() as u32;
  let total_ms = t_total.elapsed().as_millis() as u32;
  DetectResultJs {
    projects: projects
      .into_iter()
      .map(|p| ProjectInfoJs {
        root_dir: p.root_dir,
        frameworks: p.frameworks,
      })
      .collect(),
    walk_ms,
    total_ms,
  }
}

pub struct DetectTask(Option<Vec<String>>);

impl Task for DetectTask {
  type Output = DetectResultJs;
  type JsValue = DetectResultJs;

  fn compute(&mut self) -> Result<Self::Output> {
    let roots = self
      .0
      .take()
      .ok_or_else(|| Error::from_reason("detect task consumed twice"))?;
    Ok(run_detect(roots))
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi]
pub fn detect_projects(workspace_roots: Vec<String>) -> Result<DetectResultJs> {
  Ok(run_detect(workspace_roots))
}

/// Parse a single file's text on demand. Used by the file watcher path to
/// keep the JS-side parseCache in sync on save without paying for a full
/// project walk. Cheap enough (~microseconds per file) to call synchronously.
#[napi]
pub fn parse_file(text: String) -> Result<FileParsedJs> {
  Ok(to_js(parser::parse_file(&text)))
}

/// sha256 of a byte sequence as a hex string. Exposed so the JS-side cache
/// stays keyed by exactly the same hash the Rust walker produces during a
/// full scan. Without this, a fresh watcher-driven re-parse would write a
/// different-looking hash and always report a cache miss on the next scan.
#[napi]
pub fn hash_text(text: String) -> Result<String> {
  use sha2::{Digest, Sha256};
  let mut hasher = Sha256::new();
  hasher.update(text.as_bytes());
  Ok(hex::encode(hasher.finalize()))
}

#[napi(ts_return_type = "Promise<DetectResultJs>")]
pub fn detect_projects_async(workspace_roots: Vec<String>) -> AsyncTask<DetectTask> {
  AsyncTask::new(DetectTask(Some(workspace_roots)))
}

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use walkdir::{DirEntry, WalkDir};

// --- Framework marker regexes (mirror src/scanner/djangoDetector.ts) ---

static SETTINGS_GRAPHENE_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r#"GRAPHENE\s*=\s*\{|['"]graphene_django['"]"#).unwrap()
});
static SETTINGS_STRAWBERRY_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r#"['"]strawberry_django['"]|['"]strawberry\.django['"]"#).unwrap()
});
static SETTINGS_ARIADNE_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r#"['"]ariadne['"]|['"]ariadne_django['"]"#).unwrap()
});

static PY_GRAPHENE_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?:import\s+graphene|from\s+graphene|from\s+graphene_django)").unwrap()
});
static PY_STRAWBERRY_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?:import\s+strawberry|from\s+strawberry)").unwrap()
});
static PY_ARIADNE_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?:import\s+ariadne|from\s+ariadne)").unwrap()
});

pub struct ProjectOut {
  pub root_dir: String,
  pub frameworks: Vec<String>,
}

fn skip_dir(entry: &DirEntry) -> bool {
  if !entry.file_type().is_dir() {
    return false;
  }
  let name = entry.file_name().to_string_lossy();
  matches!(
    name.as_ref(),
    "node_modules"
      | ".venv"
      | "venv"
      | "env"
      | "site-packages"
      | ".git"
      | ".tox"
      | ".mypy_cache"
      | ".pytest_cache"
      | "__pycache__"
      | "migrations"
  )
}

struct WalkCollected {
  settings_paths: Vec<PathBuf>,
  manage_dirs: HashSet<PathBuf>,
  graphql_paths: Vec<PathBuf>,
  py_paths: Vec<PathBuf>,
}

fn walk_collect(workspace_root: &Path) -> WalkCollected {
  let mut settings_paths = Vec::new();
  let mut manage_dirs: HashSet<PathBuf> = HashSet::new();
  let mut graphql_paths = Vec::new();
  let mut py_paths = Vec::new();

  let walker = WalkDir::new(workspace_root).follow_links(false).into_iter();
  for entry in walker.filter_entry(|e| !skip_dir(e)) {
    let Ok(entry) = entry else { continue };
    if !entry.file_type().is_file() {
      continue;
    }
    let path = entry.into_path();
    let name = path
      .file_name()
      .map(|s| s.to_string_lossy().into_owned())
      .unwrap_or_default();

    match name.as_str() {
      "settings.py" => {
        settings_paths.push(path);
        continue;
      }
      "manage.py" => {
        if let Some(parent) = path.parent() {
          manage_dirs.insert(parent.to_path_buf());
        }
        continue;
      }
      _ => {}
    }

    match path.extension().and_then(|s| s.to_str()) {
      Some("graphql") | Some("gql") => graphql_paths.push(path),
      Some("py") => py_paths.push(path),
      _ => {}
    }
  }

  WalkCollected {
    settings_paths,
    manage_dirs,
    graphql_paths,
    py_paths,
  }
}

fn detect_from_settings(text: &str) -> Vec<String> {
  let mut out = Vec::new();
  if SETTINGS_GRAPHENE_RE.is_match(text) {
    out.push("graphene".to_string());
  }
  if SETTINGS_STRAWBERRY_RE.is_match(text) {
    out.push("strawberry".to_string());
  }
  if SETTINGS_ARIADNE_RE.is_match(text) {
    out.push("ariadne".to_string());
  }
  out
}

fn detect_from_py(text: &str) -> Vec<String> {
  let mut out = Vec::new();
  if PY_GRAPHENE_RE.is_match(text) {
    out.push("graphene".to_string());
  }
  if PY_STRAWBERRY_RE.is_match(text) {
    out.push("strawberry".to_string());
  }
  if PY_ARIADNE_RE.is_match(text) {
    out.push("ariadne".to_string());
  }
  out
}

fn resolve_root(
  settings_path: &Path,
  workspace_root: &Path,
  manage_dirs: &HashSet<PathBuf>,
) -> PathBuf {
  // Walk up from settings.py's parent looking for a directory that also
  // contains manage.py. Matches the TS resolveProjectRoot behavior, but uses
  // the pre-collected manage-dir set so the lookup is O(depth) instead of
  // issuing a new findFiles call for each level.
  let mut dir = settings_path
    .parent()
    .map(|p| p.to_path_buf())
    .unwrap_or_else(|| settings_path.to_path_buf());

  loop {
    if manage_dirs.contains(&dir) {
      return dir;
    }
    if dir == *workspace_root {
      break;
    }
    match dir.parent() {
      Some(parent) if parent != dir => dir = parent.to_path_buf(),
      _ => break,
    }
  }

  // Fallback mirrors TS: parent of settings.py dir.
  settings_path
    .parent()
    .and_then(|d| d.parent())
    .map(|d| d.to_path_buf())
    .unwrap_or_else(|| settings_path.to_path_buf())
}

fn merge_frameworks(existing: &mut Vec<String>, new_fws: &[String]) {
  for fw in new_fws {
    if !existing.iter().any(|f| f == fw) {
      existing.push(fw.clone());
    }
  }
}

pub fn detect_projects(workspace_roots: &[String]) -> Vec<ProjectOut> {
  let mut projects: Vec<ProjectOut> = Vec::new();
  let mut seen_roots: HashMap<String, usize> = HashMap::new();

  for root_str in workspace_roots {
    let workspace_root = PathBuf::from(root_str);
    let collected = walk_collect(&workspace_root);

    // Strategy 1: settings.py + framework marker detection.
    for settings_path in &collected.settings_paths {
      let Ok(text) = fs::read_to_string(settings_path) else {
        continue;
      };
      let frameworks = detect_from_settings(&text);
      if frameworks.is_empty() {
        continue;
      }
      let root_dir = resolve_root(settings_path, &workspace_root, &collected.manage_dirs);
      let root_str = root_dir.to_string_lossy().into_owned();
      if let Some(idx) = seen_roots.get(&root_str) {
        merge_frameworks(&mut projects[*idx].frameworks, &frameworks);
      } else {
        seen_roots.insert(root_str.clone(), projects.len());
        projects.push(ProjectOut {
          root_dir: root_str,
          frameworks,
        });
      }
    }

    // Strategy 2: scan up to 50 .py files for framework imports. Matches the
    // TS limit; the cap is there mostly to keep the scan cheap — Rust could
    // read everything, but preserving the cap keeps behavior parity and
    // avoids surfacing ambient imports from non-Django code.
    for py_path in collected.py_paths.iter().take(50) {
      let Ok(text) = fs::read_to_string(py_path) else {
        continue;
      };
      let frameworks = detect_from_py(&text);
      if frameworks.is_empty() {
        continue;
      }
      let root_dir = resolve_root(py_path, &workspace_root, &collected.manage_dirs);
      let root_str = root_dir.to_string_lossy().into_owned();
      if let Some(idx) = seen_roots.get(&root_str) {
        merge_frameworks(&mut projects[*idx].frameworks, &frameworks);
      } else {
        seen_roots.insert(root_str.clone(), projects.len());
        projects.push(ProjectOut {
          root_dir: root_str,
          frameworks,
        });
      }
    }

    // Strategy 3: plain .graphql/.gql files. The TS path scoped these to the
    // workspace folder that owns the first match — we do the same: attach to
    // an existing project if the workspace root already has one, otherwise
    // register the workspace root itself as a graphql-schema-only project.
    if !collected.graphql_paths.is_empty() {
      let root_str = workspace_root.to_string_lossy().into_owned();
      let fws = vec!["graphql-schema".to_string()];
      if let Some(idx) = seen_roots.get(&root_str) {
        merge_frameworks(&mut projects[*idx].frameworks, &fws);
      } else {
        seen_roots.insert(root_str.clone(), projects.len());
        projects.push(ProjectOut {
          root_dir: root_str,
          frameworks: fws,
        });
      }
    }
  }

  projects
}

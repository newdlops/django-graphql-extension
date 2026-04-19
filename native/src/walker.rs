use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use sha2::{Digest, Sha256};
use walkdir::{DirEntry, WalkDir};

pub struct RawFile {
  pub path: String,
  pub text: String,
  pub hash: String,
  pub bytes: u64,
}

fn is_hidden_or_ignored_dir(entry: &DirEntry) -> bool {
  if !entry.file_type().is_dir() {
    return false;
  }
  let name = entry.file_name().to_string_lossy();
  matches!(
    name.as_ref(),
    "migrations"
      | "__pycache__"
      | "node_modules"
      | ".venv"
      | "venv"
      | "env"
      | ".git"
      | ".tox"
      | ".mypy_cache"
      | ".pytest_cache"
      | "site-packages"
  )
}

pub fn collect_py_paths(root_dir: &str) -> Vec<PathBuf> {
  let mut paths = Vec::new();
  let walker = WalkDir::new(root_dir).follow_links(false).into_iter();

  for entry in walker.filter_entry(|e| !is_hidden_or_ignored_dir(e)) {
    let Ok(entry) = entry else { continue };
    if !entry.file_type().is_file() {
      continue;
    }
    let path = entry.into_path();
    if path.extension().and_then(|s| s.to_str()) == Some("py") {
      paths.push(path);
    }
  }
  paths
}

fn read_one(path: &Path) -> Option<RawFile> {
  let bytes = fs::read(path).ok()?;
  // Skip non-UTF8 files silently (matches behavior of VS Code readFile +
  // Buffer.toString('utf-8'), which replaces invalid sequences but never
  // throws). We prefer skipping to replacement here because the parser
  // regexes are ASCII-only anyway.
  let text = String::from_utf8(bytes).ok()?;
  let size = text.len() as u64;

  let mut hasher = Sha256::new();
  hasher.update(text.as_bytes());
  let digest = hasher.finalize();
  let hash = hex::encode(digest);

  Some(RawFile {
    path: path.to_string_lossy().into_owned(),
    text,
    hash,
    bytes: size,
  })
}

pub fn read_all_parallel(paths: &[PathBuf]) -> Vec<RawFile> {
  paths.par_iter().filter_map(|p| read_one(p)).collect()
}

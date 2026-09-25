//! The workspace roots sessions run in: resolving a session's directory,
//! listing project folders for the phone's picker, creating a new project.
//!
//! Every path from the phone is untrusted and must stay inside a root.
//! Containment is decided on path components, never string prefixes
//! (`/ws/app-2` is not inside `/ws/app`).

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use bridge_core::ports::Workspace;

/// Directories that are build or dependency output, never a project.
const SKIP: [&str; 8] = ["node_modules", "target", "dist", "build", "out", "venv", "__pycache__", "vendor"];
/// The folder list rides every heartbeat, so it is bounded.
pub const FOLDER_LIMIT: usize = 200;
/// A build file marks a directory as a project in its own right; its
/// subdirectories are modules of it and are not listed.
const SELF_CONTAINED: [&str; 10] = [
    ".planning",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "pubspec.yaml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
];
/// Folders change on the timescale of starting a project, not a heartbeat.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// `requested` joined to `root` and normalized, when it stays inside `root`
/// (the root itself included). Absolute paths and `..` escapes give None.
fn confine(root: &Path, requested: &str) -> Option<PathBuf> {
    let requested = Path::new(requested);
    let mut out = root.to_path_buf();
    let mut depth = 0usize;
    for part in requested.components() {
        match part {
            Component::Normal(p) => {
                out.push(p);
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return None;
                }
                out.pop();
                depth -= 1;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

fn git_init(dir: &Path) {
    if dir.join(".git").exists() {
        return;
    }
    match Command::new("git").arg("-C").arg(dir).args(["init", "--quiet"]).status() {
        Ok(s) if s.success() => log::info!("[Workspace] git init {}", dir.display()),
        other => log::warn!("[Workspace] git init failed in {}: {other:?} (continuing)", dir.display()),
    }
}

fn is_dir(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// One root's project folders, relative to it: every visible child
/// directory, plus nested ones that carry a project marker — except inside a
/// child that is itself a project.
pub fn list_folders(root: &Path) -> Vec<String> {
    let listable = |parent: &Path, name: &str| !name.starts_with('.') && !SKIP.contains(&name) && is_dir(&parent.join(name));
    let has_any = |dir: &Path, markers: &[&str]| markers.iter().any(|m| dir.join(m).exists());
    let names = |dir: &Path| -> Vec<String> {
        fs::read_dir(dir)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    };
    let mut found = Vec::new();
    for child in names(root) {
        if !listable(root, &child) {
            continue;
        }
        let child_path = root.join(&child);
        found.push(child.clone());
        if has_any(&child_path, &SELF_CONTAINED) {
            continue;
        }
        for nested in names(&child_path) {
            let nested_path = child_path.join(&nested);
            if listable(&child_path, &nested) && (nested_path.join(".git").exists() || has_any(&nested_path, &SELF_CONTAINED)) {
                found.push(format!("{child}/{nested}"));
            }
        }
    }
    found.sort_by_key(|f| f.to_lowercase());
    found
}

pub struct FsWorkspace {
    roots: Vec<PathBuf>,
    cache: Option<(Instant, Vec<String>)>,
}

impl FsWorkspace {
    pub fn new(roots: Vec<PathBuf>) -> Self {
        assert!(!roots.is_empty(), "a workspace needs a root");
        Self { roots, cache: None }
    }

    /// Every root's folders, first root first; a relative path present in
    /// two roots belongs to the first (as `resolve_cwd` resolves it).
    pub fn all_folders(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for root in &self.roots {
            for folder in list_folders(root) {
                if !out.contains(&folder) {
                    out.push(folder);
                }
            }
        }
        if out.len() > FOLDER_LIMIT {
            log::info!("[Workspace] {} folders — listing the first {FOLDER_LIMIT}", out.len());
            out.truncate(FOLDER_LIMIT);
        }
        out
    }
}

impl Workspace for FsWorkspace {
    fn roots(&self) -> Vec<String> {
        self.roots.iter().map(|r| r.to_string_lossy().into_owned()).collect()
    }

    fn folders(&mut self) -> Vec<String> {
        if let Some((at, folders)) = &self.cache {
            if at.elapsed() < CACHE_TTL {
                return folders.clone();
            }
        }
        let folders = self.all_folders();
        self.cache = Some((Instant::now(), folders.clone()));
        folders
    }

    /// A bad or stale request falls back to the first root rather than
    /// failing: a stale bookmark on the phone must not make sessions
    /// impossible to create. With `create`, a missing directory is made (and
    /// `git init`-ed) under the first root that contains the request.
    fn resolve_cwd(&mut self, requested: Option<&str>, create: bool) -> String {
        let first = self.roots[0].to_string_lossy().into_owned();
        let Some(requested) = requested.filter(|r| !r.is_empty()) else { return first };
        let candidates: Vec<PathBuf> = self.roots.iter().filter_map(|root| confine(root, requested)).collect();
        if let Some(existing) = candidates.iter().find(|p| is_dir(p)) {
            return existing.to_string_lossy().into_owned();
        }
        match candidates.first() {
            Some(target) if create => match fs::create_dir_all(target) {
                Ok(()) => {
                    log::info!("[Workspace] Created session directory {}", target.display());
                    git_init(target);
                    self.cache = None;
                    target.to_string_lossy().into_owned()
                }
                Err(e) => {
                    log::warn!("[Workspace] Could not create {}: {e} — using {first}", target.display());
                    first
                }
            },
            Some(_) => {
                log::info!("[Workspace] Session directory not found: {requested} — using {first}");
                first
            }
            None => {
                log::warn!("[Workspace] Refused a session directory outside the workspace: {requested}");
                first
            }
        }
    }

    /// Explicit creation never falls back: it creates exactly what was asked,
    /// inside the root, or fails.
    fn create_folder(&mut self, root: Option<&str>, path: &str) -> Result<String, String> {
        let root = match root {
            None => self.roots[0].clone(),
            Some(r) => self.roots.iter().find(|x| x.as_path() == Path::new(r)).cloned().ok_or("unknown workspace root")?,
        };
        let path = path.trim();
        if path.is_empty() {
            return Err("folder name is empty".into());
        }
        if Path::new(path).is_absolute() {
            return Err("folder path must be relative to the workspace root".into());
        }
        let target = confine(&root, path).filter(|t| *t != root).ok_or("folder path escapes the workspace root")?;
        let rel = target.strip_prefix(&root).expect("confined").to_string_lossy().replace('\\', "/");
        if target.exists() {
            return if is_dir(&target) { Ok(rel) } else { Err("a file with that name already exists".into()) };
        }
        fs::create_dir_all(&target).map_err(|e| format!("could not create folder: {e}"))?;
        log::info!("[Workspace] Created project folder {}", target.display());
        git_init(&target);
        self.cache = None;
        Ok(rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(dir: &Path, paths: &[&str]) {
        for p in paths {
            let full = dir.join(p);
            if p.ends_with('/') {
                fs::create_dir_all(full).unwrap();
            } else {
                fs::create_dir_all(full.parent().unwrap()).unwrap();
                fs::write(full, "").unwrap();
            }
        }
    }

    #[test]
    fn lists_children_and_marked_nested_projects_but_not_modules_or_noise() {
        let d = tempfile::tempdir().unwrap();
        tree(
            d.path(),
            &[
                "web/package.json",
                "web/src/",
                "group/api/Cargo.toml",
                "group/notes/",
                "group/repo/.git/",
                "node_modules/",
                ".hidden/",
                "README.md",
            ],
        );
        assert_eq!(list_folders(d.path()), ["group", "group/api", "group/repo", "web"]);
    }

    #[test]
    fn a_session_directory_stays_inside_the_roots() {
        let d = tempfile::tempdir().unwrap();
        tree(d.path(), &["app/", "app-2/"]);
        let mut ws = FsWorkspace::new(vec![d.path().to_path_buf()]);
        let root = d.path().to_string_lossy().into_owned();
        assert_eq!(ws.resolve_cwd(Some("app"), false), d.path().join("app").to_string_lossy());
        assert_eq!(ws.resolve_cwd(Some("../etc"), false), root);
        assert_eq!(ws.resolve_cwd(Some("/etc"), false), root);
        assert_eq!(ws.resolve_cwd(Some("missing"), false), root);
        assert_eq!(ws.resolve_cwd(None, false), root);
        let made = ws.resolve_cwd(Some("fresh/one"), true);
        assert!(is_dir(Path::new(&made)) && made.ends_with("one"));
    }

    #[test]
    fn a_later_root_is_used_when_only_it_has_the_folder() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        tree(b.path(), &["only-b/"]);
        let mut ws = FsWorkspace::new(vec![a.path().into(), b.path().into()]);
        assert_eq!(ws.resolve_cwd(Some("only-b"), false), b.path().join("only-b").to_string_lossy());
        assert_eq!(ws.folders(), ["only-b"]);
    }

    #[test]
    fn create_folder_is_confined_idempotent_and_explicit() {
        let d = tempfile::tempdir().unwrap();
        tree(d.path(), &["file.txt"]);
        let mut ws = FsWorkspace::new(vec![d.path().into()]);
        assert_eq!(ws.create_folder(None, "new/proj").unwrap(), "new/proj");
        assert_eq!(ws.create_folder(None, "new/proj").unwrap(), "new/proj");
        assert!(ws.create_folder(None, "../x").is_err());
        assert!(ws.create_folder(None, "/abs").is_err());
        assert!(ws.create_folder(None, " ").is_err());
        assert!(ws.create_folder(None, "file.txt").is_err());
        assert!(ws.create_folder(Some("/elsewhere"), "x").is_err());
    }
}

use crate::workspace::{self, Result, Root};
use serde::Serialize;
use std::{path::Path, process::{Command, Output}};

const ENV: [&str; 4] = ["env", "GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "GIT_OPTIONAL_LOCKS=0"];
fn process(root: &Root, args: &[&str]) -> Result<Output> {
    let root = match root {
        Root::Local(root) => root,
        Root::Remote(remote) => return remote.run(&[&ENV[..], &["git", "--no-pager", "-c", "color.ui=false"], args].concat()),
    };
    let mut command = Command::new("git");
    command.current_dir(root).args(["--no-pager", "-c", "color.ui=false"]).args(args).env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true").env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command.output().map_err(|e| format!("No se puede ejecutar Git. Instálalo y añádelo al PATH: {e}"))
}
pub fn run(root: &Root, args: &[&str]) -> Result<String> {
    let result = process(root, args)?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_owned();
        // Merge conflicts and some hooks only report on stdout.
        return Err(if stderr.is_empty() { String::from_utf8_lossy(&result.stdout).trim().to_owned() } else { stderr });
    }
    Ok(String::from_utf8_lossy(&result.stdout).into())
}

fn repository(root: &Root) -> Result<()> {
    let top = run(root, &["rev-parse", "--show-toplevel"])?;
    let inside = match root {
        Root::Local(root) => Path::new(top.trim()).canonicalize().map_err(|e| e.to_string())? == *root,
        Root::Remote(remote) => top.trim() == remote.root,
    };
    if !inside { return Err(format!("Abre la raíz del repositorio para usar Git: {}", top.trim())); }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change { pub path: String, pub old_path: Option<String>, pub index: char, pub worktree: char, pub conflict: bool }

pub fn parse_status(data: &str) -> Vec<Change> {
    let mut entries = data.split('\0');
    let mut changes = Vec::new();
    while let Some(entry) = entries.next() {
        if entry.len() < 4 || !entry.is_char_boundary(3) { continue; }
        let index = entry.as_bytes()[0] as char; let worktree = entry.as_bytes()[1] as char;
        let old_path = if index == 'R' || index == 'C' || worktree == 'R' || worktree == 'C' { entries.next().map(str::to_owned) } else { None };
        let conflict = index == 'U' || worktree == 'U' || (index == 'A' && worktree == 'A') || (index == 'D' && worktree == 'D');
        changes.push(Change { path: entry[3..].to_owned(), old_path, index, worktree, conflict });
    }
    changes
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub branch: String, pub upstream: Option<String>, pub ahead: u32, pub behind: u32, pub changes: Vec<Change>, pub merging: bool, pub rebasing: bool, pub cherry_picking: bool }
pub fn status(root: &Root) -> Result<Status> {
    repository(root)?;
    let branch = run(root, &["symbolic-ref", "--short", "HEAD"]).unwrap_or_else(|_| run(root, &["rev-parse", "--short", "HEAD"]).unwrap_or("HEAD".into()));
    let upstream = run(root, &["rev-parse", "--abbrev-ref", "@{upstream}"]).ok().map(|s| s.trim().to_owned());
    let counts = run(root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).unwrap_or_default();
    let mut counts = counts.split_whitespace().map(|v| v.parse::<u32>().unwrap_or(0));
    let git_path = |name: &str| run(root, &["rev-parse", "--git-path", name]).ok().is_some_and(|p| root.git_file_exists(p.trim()));
    Ok(Status { branch: branch.trim().into(), upstream, ahead: counts.next().unwrap_or(0), behind: counts.next().unwrap_or(0), changes: parse_status(&run(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?), merging: git_path("MERGE_HEAD"), rebasing: git_path("rebase-merge") || git_path("rebase-apply"), cherry_picking: git_path("CHERRY_PICK_HEAD") })
}

#[derive(Serialize)]
pub struct Commit { pub hash: String, pub short: String, pub author: String, pub date: String, pub subject: String, pub refs: String, pub parents: Vec<String> }
pub fn log(root: &Root, path: Option<&str>) -> Result<Vec<Commit>> {
    repository(root)?;
    let mut args = vec!["log", "-300", "--topo-order", "--date=short", "--format=%H%x00%h%x00%an%x00%ad%x00%s%x00%D%x00%P%x00"];
    if let Some(path) = path { root.check(path, false)?; args.extend(["--follow", "--", path]); }
    let text = match run(root, &args) { Ok(text) => text, Err(_) if !process(root, &["rev-parse", "--verify", "HEAD"])?.status.success() => return Ok(vec![]), Err(e) => return Err(e) };
    let parts: Vec<&str> = text.split('\0').collect();
    Ok(parts.chunks(7).filter(|p| p.len() == 7).map(|p| Commit { hash: p[0].trim().into(), short: p[1].into(), author: p[2].into(), date: p[3].into(), subject: p[4].into(), refs: p[5].into(), parents: p[6].split_whitespace().map(str::to_owned).collect() }).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch { pub name: String, pub current: bool, pub remote: bool }
pub fn branches(root: &Root) -> Result<Vec<Branch>> {
    repository(root)?;
    Ok(run(root, &["for-each-ref", "--format=%(HEAD)%00%(refname:short)%00%(refname)", "refs/heads", "refs/remotes"])?
        .lines().filter_map(|line| { let p: Vec<_> = line.split('\0').collect(); (p.len() == 3 && !p[1].ends_with("/HEAD")).then(|| Branch { current: p[0] == "*", name: p[1].into(), remote: p[2].starts_with("refs/remotes/") }) }).collect())
}

#[derive(Serialize)]
pub struct Diff { pub original: String, pub modified: String, pub title: String }
pub fn diff(root: &Root, path: &str, staged: bool, old_path: Option<&str>) -> Result<Diff> {
    repository(root)?;
    root.check(path, false)?;
    let old = old_path.unwrap_or(path); root.check(old, false)?;
    let original_spec = if staged { format!("HEAD:{old}") } else { format!(":{path}") };
    let original = blob(root, &original_spec)?;
    let modified = if staged { blob(root, &format!(":{path}"))? } else if root.exists(path) { root.read(path)? } else { String::new() };
    Ok(Diff { original, modified, title: format!("{} · {}", path, if staged { "Preparado" } else { "Cambios" }) })
}

fn blob(root: &Root, spec: &str) -> Result<String> {
    if !process(root, &["cat-file", "-e", spec])?.status.success() { return Ok(String::new()); }
    let size = run(root, &["cat-file", "-s", spec])?.trim().parse::<u64>().map_err(|e| e.to_string())?;
    if size > workspace::MAX_FILE { return Err("La diferencia supera los 5 MB".into()); }
    let data = run(root, &["show", spec])?;
    if data.contains('\0') { return Err("No se muestran diferencias binarias".into()); }
    Ok(data)
}

fn valid_ref(value: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') || value.contains('\0') { Err("Referencia Git inválida".into()) } else { Ok(()) }
}

fn pair(value: &str) -> Result<(&str, &str)> {
    let (first, second) = value.split_once('\n').ok_or("Faltan datos para esta operación")?;
    valid_ref(first)?; valid_ref(second)?; Ok((first, second))
}

pub fn action(root: &Root, action: &str, value: &str, paths: &[String]) -> Result<String> {
    if action != "init" { repository(root)?; }
    for path in paths { root.check(path, false)?; }
    match action {
        "init" => run(root, &["init", "-b", "main"]),
        "stage" | "unstage" => {
            if paths.is_empty() { return Err("Selecciona archivos".into()); }
            let mut args = if action == "stage" { vec!["add", "--"] } else if process(root, &["rev-parse", "--verify", "HEAD"])?.status.success() { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "--"] };
            args.extend(paths.iter().map(String::as_str)); run(root, &args)
        }
        "commit" | "commit-all" => {
            if value.trim().is_empty() { return Err("Escribe un mensaje de commit".into()); }
            if action == "commit-all" { run(root, &["add", "-A"])?; }
            run(root, &["commit", "-m", value])
        }
        "commit-amend" => if value.trim().is_empty() { run(root, &["commit", "--amend", "--no-edit"]) } else { run(root, &["commit", "--amend", "-m", value]) },
        "discard" => {
            if paths.is_empty() { return Err("Selecciona archivos".into()); }
            let mut args = vec!["restore", "--"]; args.extend(paths.iter().map(String::as_str)); run(root, &args)
        }
        // Untracked files have no Git copy, so they go to the recoverable system trash.
        "clean" => { for path in paths { root.trash(path)?; } Ok(String::new()) }
        "fetch" => run(root, &["fetch", "--all", "--prune"]),
        "pull" => run(root, &["pull", "--ff-only"]),
        "pull-rebase" => run(root, &["pull", "--rebase"]),
        "pull-merge" => run(root, &["pull", "--no-rebase", "--no-edit"]),
        "push" => { let branch = run(root, &["symbolic-ref", "--short", "HEAD"])?; valid_ref(branch.trim())?; run(root, &["push", "--set-upstream", "origin", branch.trim()]) }
        "push-force" => { let branch = run(root, &["symbolic-ref", "--short", "HEAD"])?; valid_ref(branch.trim())?; run(root, &["push", "--force-with-lease", "--set-upstream", "origin", branch.trim()]) }
        "push-tags" => run(root, &["push", "origin", "--tags"]),
        "checkout" => { valid_ref(value)?; run(root, &["switch", value]) }
        "checkout-detached" => { valid_ref(value)?; run(root, &["switch", "--detach", value]) }
        "branch" => { valid_ref(value)?; run(root, &["switch", "-c", value]) }
        "branch-from" => { let (name, start) = pair(value)?; run(root, &["switch", "-c", name, start]) }
        "branch-rename" => { let (old, new) = pair(value)?; run(root, &["branch", "-m", old, new]) }
        "branch-delete" => { valid_ref(value)?; run(root, &["branch", "-d", value]) }
        "branch-delete-force" => { valid_ref(value)?; run(root, &["branch", "-D", value]) }
        "track" => { let values: Vec<_> = value.splitn(2, '\n').collect(); if values.len() != 2 { return Err("Selecciona una rama remota".into()); } valid_ref(values[0])?; valid_ref(values[1])?; run(root, &["switch", "-c", values[0], "--track", values[1]]) }
        "merge" => { valid_ref(value)?; run(root, &["merge", "--no-edit", value]) }
        "rebase" => { valid_ref(value)?; run(root, &["rebase", value]) }
        "merge-abort" => run(root, &["merge", "--abort"]),
        "rebase-abort" => run(root, &["rebase", "--abort"]),
        "merge-continue" => run(root, &["commit", "--no-edit"]),
        "rebase-continue" => run(root, &["rebase", "--continue"]),
        "cherry-pick" => { valid_ref(value)?; run(root, &["cherry-pick", value]) }
        "cherry-pick-abort" => run(root, &["cherry-pick", "--abort"]),
        "cherry-pick-continue" => run(root, &["cherry-pick", "--continue"]),
        "revert" => { valid_ref(value)?; run(root, &["revert", "--no-edit", value]) }
        "reset-soft" | "reset-mixed" | "reset-hard" => { valid_ref(value)?; run(root, &["reset", &format!("--{}", &action[6..]), value]) }
        "stash" => run(root, &["stash", "push", "-u", "-m", if value.is_empty() { "Lumen" } else { value }]),
        "stash-pop" | "stash-apply" | "stash-drop" => {
            let verb = &action[6..];
            if value.is_empty() { run(root, &["stash", verb]) } else { valid_ref(value)?; run(root, &["stash", verb, value]) }
        }
        "tag" => { valid_ref(value)?; run(root, &["tag", value]) }
        "tag-at" => { let (name, target) = pair(value)?; run(root, &["tag", name, target]) }
        "tag-delete" => { valid_ref(value)?; run(root, &["tag", "-d", value]) }
        "remote" => { let mut values = value.splitn(2, '\n'); let name = values.next().unwrap_or(""); let url = values.next().unwrap_or(""); valid_ref(name)?; if url.is_empty() || url.starts_with('-') { return Err("URL inválida".into()); } run(root, &["remote", "add", name, url]) }
        "remote-remove" => { valid_ref(value)?; run(root, &["remote", "remove", value]) }
        _ => Err("Operación Git no permitida".into())
    }
}

fn valid_hash(hash: &str) -> Result<()> {
    if hash.len() != 40 && hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) { Err("Hash inválido".into()) } else { Ok(()) }
}

#[derive(Serialize)]
pub struct CommitFile { pub status: String, pub path: String }
pub fn commit_files(root: &Root, hash: &str) -> Result<Vec<CommitFile>> {
    repository(root)?; valid_hash(hash)?;
    let text = run(root, &["diff-tree", "-r", "--root", "-m", "--first-parent", "--no-commit-id", "--name-status", "-z", hash])?;
    let parts: Vec<&str> = text.split('\0').collect();
    Ok(parts.chunks(2).filter(|p| p.len() == 2).map(|p| CommitFile { status: p[0].trim().into(), path: p[1].into() }).collect())
}
pub fn commit_diff(root: &Root, hash: &str, path: &str) -> Result<Diff> {
    repository(root)?; valid_hash(hash)?; root.check(path, false)?;
    Ok(Diff { original: blob(root, &format!("{hash}^:{path}"))?, modified: blob(root, &format!("{hash}:{path}"))?, title: format!("{} · {}", path, &hash[..7]) })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct LineChange { pub start: u32, pub count: u32, pub kind: char }
pub fn parse_hunks(diff: &str) -> Vec<LineChange> {
    diff.lines().filter_map(|line| {
        let mut fields = line.strip_prefix("@@ -")?.split_whitespace();
        let range = |text: &str| { let mut p = text.split(','); Some((p.next()?.parse::<u32>().ok()?, p.next().map_or(Some(1), |c| c.parse().ok())?)) };
        let (_, removed) = range(fields.next()?)?;
        let (start, added) = range(fields.next()?.strip_prefix('+')?)?;
        Some(match (removed, added) { (0, _) => LineChange { start, count: added, kind: 'A' }, (_, 0) => LineChange { start: start.max(1), count: 1, kind: 'D' }, _ => LineChange { start, count: added, kind: 'M' } })
    }).collect()
}
pub fn line_changes(root: &Root, path: &str) -> Result<Vec<LineChange>> {
    repository(root)?; root.check(path, false)?;
    Ok(parse_hunks(&run(root, &["diff", "-U0", "--no-ext-diff", "HEAD", "--", path])?))
}

#[derive(Serialize)]
pub struct Blame { pub hash: String, pub author: String, pub time: u64, pub summary: String }
pub fn blame(root: &Root, path: &str, line: u32) -> Result<Option<Blame>> {
    repository(root)?; root.check(path, true)?;
    let text = run(root, &["blame", "--porcelain", "-L", &format!("{line},{line}"), "--", path])?;
    let hash = text.split_whitespace().next().unwrap_or("").to_owned();
    if hash.bytes().all(|c| c == b'0') { return Ok(None); }
    let field = |name: &str| text.lines().find_map(|l| l.strip_prefix(name)).unwrap_or("").to_owned();
    Ok(Some(Blame { hash, author: field("author "), time: field("author-time ").parse().unwrap_or(0), summary: field("summary ") }))
}

pub fn list(root: &Root, kind: &str) -> Result<Vec<String>> {
    repository(root)?;
    let text = match kind {
        "tags" => run(root, &["for-each-ref", "--format=%(refname:short)", "refs/tags"])?,
        "stashes" => run(root, &["stash", "list", "--format=%gd%x09%gs"])?,
        "remotes" => run(root, &["remote"])?,
        _ => return Err("Consulta Git no permitida".into()),
    };
    Ok(text.lines().map(str::to_owned).collect())
}

pub fn commit_detail(root: &Root, hash: &str) -> Result<String> {
    repository(root)?;
    valid_hash(hash)?;
    // Cap the patch in the subprocess so enormous commits cannot fill the editor.
    use std::io::Read;
    const SHOW: [&str; 6] = ["show", "--format=fuller", "--stat", "--patch", "--no-ext-diff", "--no-textconv"];
    let root = match root {
        Root::Local(root) => root,
        Root::Remote(remote) => {
            let bytes = remote.run_limited(&[&ENV[..], &["git", "--no-pager"], &SHOW[..], &[hash]].concat(), workspace::MAX_FILE + 1)?;
            if bytes.len() as u64 > workspace::MAX_FILE { return Err("Este commit es demasiado grande para mostrarlo (5 MB)".into()); }
            return Ok(String::from_utf8_lossy(&bytes).into());
        }
    };
    let mut command = Command::new("git");
    command.current_dir(root).args(["--no-pager", "show", "--format=fuller", "--stat", "--patch", "--no-ext-diff", "--no-textconv", hash]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let result = child.stdout.take().unwrap().take(workspace::MAX_FILE + 1).read_to_end(&mut bytes);
    let _ = child.kill(); let _ = child.wait(); result.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > workspace::MAX_FILE { return Err("Este commit es demasiado grande para mostrarlo (5 MB)".into()); }
    Ok(String::from_utf8_lossy(&bytes).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_renames_unicode_and_conflicts() {
        let data = "R  nuevo ñ.rs\0viejo.rs\0 M src/main.rs\0?? new.txt\0UU conflict.rs\0";
        let changes = parse_status(data);
        assert_eq!(changes.len(), 4); assert_eq!(changes[0].old_path.as_deref(), Some("viejo.rs"));
        assert_eq!(changes[0].path, "nuevo ñ.rs"); assert!(changes[3].conflict);
    }
    #[test]
    fn git_lifecycle_and_staged_diff() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().canonicalize().unwrap(); let root = Root::Local(path.clone());
        action(&root, "init", "", &[]).unwrap();
        run(&root, &["config", "user.name", "Lumen test"]).unwrap(); run(&root, &["config", "user.email", "test@example.invalid"]).unwrap();
        std::fs::write(path.join("file.txt"), "initial\n").unwrap();
        assert_eq!(status(&root).unwrap().changes.len(), 1);
        action(&root, "stage", "", &["file.txt".into()]).unwrap();
        assert_eq!(diff(&root, "file.txt", true, None).unwrap().original, "");
        action(&root, "commit", "Initial", &[]).unwrap();
        std::fs::write(path.join("file.txt"), "modified\n").unwrap();
        let d = diff(&root, "file.txt", false, None).unwrap(); assert_eq!(d.original, "initial\n"); assert_eq!(d.modified, "modified\n");
        action(&root, "stage", "", &["file.txt".into()]).unwrap(); action(&root, "unstage", "", &["file.txt".into()]).unwrap();
        assert_eq!(status(&root).unwrap().changes[0].worktree, 'M');
        assert_eq!(log(&root, None).unwrap().len(), 1);
        action(&root, "branch", "feature/test", &[]).unwrap(); assert_eq!(status(&root).unwrap().branch, "feature/test");
        assert!(action(&root, "checkout", "--force", &[]).is_err());
    }
    #[test]
    fn hunks_become_gutter_changes() {
        let hunks = parse_hunks("@@ -1,0 +2,3 @@ a\n+x\n@@ -5 +8 @@\n@@ -9,2 +11,0 @@ b\n");
        assert_eq!(hunks, vec![LineChange { start: 2, count: 3, kind: 'A' }, LineChange { start: 8, count: 1, kind: 'M' }, LineChange { start: 11, count: 1, kind: 'D' }]);
    }
    #[test]
    fn full_version_control_flow() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().canonicalize().unwrap(); let root = Root::Local(path.clone());
        action(&root, "init", "", &[]).unwrap();
        run(&root, &["config", "user.name", "Lumen test"]).unwrap(); run(&root, &["config", "user.email", "test@example.invalid"]).unwrap();
        std::fs::write(path.join("a.txt"), "one\n").unwrap();
        action(&root, "commit-all", "First", &[]).unwrap();
        std::fs::write(path.join("a.txt"), "two\n").unwrap();
        assert_eq!(line_changes(&root, "a.txt").unwrap()[0].kind, 'M');
        action(&root, "discard", "", &["a.txt".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(path.join("a.txt")).unwrap().trim(), "one");
        std::fs::write(path.join("b.txt"), "b\n").unwrap();
        action(&root, "stash", "wip", &[]).unwrap();
        assert_eq!(list(&root, "stashes").unwrap().len(), 1);
        action(&root, "stash-pop", "stash@{0}", &[]).unwrap();
        action(&root, "commit-all", "Second", &[]).unwrap();
        action(&root, "commit-amend", "Second, amended", &[]).unwrap();
        let commits = log(&root, None).unwrap();
        assert_eq!(commits[0].subject, "Second, amended"); assert_eq!(commits[0].parents, vec![commits[1].hash.clone()]);
        let files = commit_files(&root, &commits[0].hash).unwrap();
        assert_eq!(files[0].path, "b.txt"); assert_eq!(files[0].status, "A");
        assert_eq!(commit_diff(&root, &commits[0].hash, "b.txt").unwrap().modified.trim(), "b");
        assert_eq!(blame(&root, "b.txt", 1).unwrap().unwrap().summary, "Second, amended");
        action(&root, "tag-at", &format!("v1\n{}", commits[1].hash), &[]).unwrap();
        assert_eq!(list(&root, "tags").unwrap(), vec!["v1"]);
        action(&root, "branch-from", &format!("old\n{}", commits[1].hash), &[]).unwrap();
        action(&root, "branch-rename", "old\nolder", &[]).unwrap();
        action(&root, "checkout", "main", &[]).unwrap();
        action(&root, "revert", &commits[0].hash, &[]).unwrap();
        action(&root, "reset-hard", &commits[0].hash, &[]).unwrap();
        action(&root, "branch-delete-force", "older", &[]).unwrap();
        assert_eq!(branches(&root).unwrap().len(), 1);
    }
}

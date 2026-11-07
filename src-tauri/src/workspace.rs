use ignore::{overrides::OverrideBuilder, WalkBuilder};
use regex::RegexBuilder;
use serde::Serialize;
use std::{fs, io::Write, path::{Component, Path, PathBuf}, sync::Mutex};

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_FILE: u64 = 5 * 1024 * 1024;
#[derive(Default)]
pub struct Workspace(pub Mutex<Option<PathBuf>>);

impl Workspace {
    pub fn root(&self) -> Result<PathBuf> {
        self.0.lock().map_err(|e| e.to_string())?.clone().ok_or("Abre una carpeta primero".into())
    }
}

// Canonicalize the existing parent too: lexical checks alone allow symlink escapes.
pub fn resolve(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute() || path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("La ruta debe estar dentro de la carpeta abierta".into());
    }
    if path.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")) {
        return Err("La carpeta interna .git está protegida".into());
    }
    let joined = root.join(path);
    let checked = if must_exist { joined.canonicalize() } else {
        let mut ancestor = joined.as_path(); let mut suffix = Vec::new();
        while !ancestor.exists() { suffix.push(ancestor.file_name().ok_or("Ruta inválida")?.to_owned()); ancestor = ancestor.parent().ok_or("Ruta inválida")?; }
        ancestor.canonicalize().map(|mut p| { for part in suffix.iter().rev() { p.push(part); } p })
    }.map_err(|e| e.to_string())?;
    if !checked.starts_with(root) { return Err("La ruta sale de la carpeta abierta".into()); }
    if joined.exists() && !joined.canonicalize().map_err(|e| e.to_string())?.starts_with(root) {
        return Err("El enlace apunta fuera del proyecto".into());
    }
    Ok(checked)
}

// Windows canonical paths carry a verbatim prefix that shells and users should not see.
pub fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    match text.strip_prefix(r"\\?\") { Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_owned(), _ => text }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo { pub path: String, pub name: String }

pub fn set_workspace(state: &Workspace, path: PathBuf) -> Result<WorkspaceInfo> {
    let root = path.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() { return Err("Selecciona una carpeta".into()); }
    let info = WorkspaceInfo {
        name: root.file_name().unwrap_or_default().to_string_lossy().into(),
        path: display_path(&root),
    };
    *state.0.lock().map_err(|e| e.to_string())? = Some(root);
    Ok(info)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry { pub name: String, pub path: String, pub is_dir: bool }

pub fn list(root: &Path, relative: &str) -> Result<Vec<Entry>> {
    let directory = if relative.is_empty() { root.to_path_buf() } else { resolve(root, relative, true)? };
    let mut result = Vec::new();
    for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        if name == ".git" { continue; }
        // Do not traverse junctions or symlinks outside the selected project.
        let canonical = match item.path().canonicalize() { Ok(p) if p.starts_with(root) => p, _ => continue };
        result.push(Entry { name, path: item.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), is_dir: canonical.is_dir() });
    }
    result.sort_by(|a,b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(result)
}

pub fn read(root: &Path, path: &str) -> Result<String> {
    let file = resolve(root, path, true)?;
    if fs::metadata(&file).map_err(|e| e.to_string())?.len() > MAX_FILE { return Err("El editor admite archivos de texto de hasta 5 MB".into()); }
    let text = fs::read_to_string(file).map_err(|e| format!("No se puede abrir como texto UTF-8: {e}"))?;
    if text.contains('\0') { return Err("Este archivo parece binario".into()); }
    Ok(text)
}

pub fn save(root: &Path, path: &str, content: &str, expected: &str) -> Result<()> {
    let file = resolve(root, path, true)?;
    if read(root, path)? != expected { return Err("CONFLICT: El archivo cambió en disco. Recárgalo o guarda una copia antes de sobrescribir.".into()); }
    let parent = file.parent().ok_or("Ruta inválida")?;
    let temporary = parent.join(format!(".lumen-save-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let result = (|| -> Result<()> {
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
        output.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        fs::set_permissions(&temporary, fs::metadata(&file).map_err(|e| e.to_string())?.permissions()).map_err(|e| e.to_string())?;
        // Check again after writing the temporary copy, before replacing the original.
        if read(root, path)? != expected { return Err("CONFLICT: El archivo cambió durante el guardado".into()); }
        fs::rename(&temporary, &file).map_err(|e| e.to_string())
    })();
    if temporary.exists() { let _ = fs::remove_file(temporary); }
    result
}

pub fn create(root: &Path, path: &str, directory: bool) -> Result<()> {
    let file = resolve(root, path, false)?;
    if directory { fs::create_dir(file).map_err(|e| e.to_string()) }
    else { fs::OpenOptions::new().write(true).create_new(true).open(file).map(|_| ()).map_err(|e| e.to_string()) }
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<()> {
    let from = resolve(root, from, true)?;
    let to = resolve(root, to, false)?;
    if to.exists() { return Err("Ya existe un archivo con ese nombre".into()); }
    fs::rename(from, to).map_err(|e| e.to_string())
}

// `include` holds comma-separated globs; a leading ! excludes.
fn walker(root: &Path, include: &str) -> Result<ignore::Walk> {
    let mut overrides = OverrideBuilder::new(root);
    for glob in include.split(',').map(str::trim).filter(|g| !g.is_empty()) { overrides.add(glob).map_err(|e| e.to_string())?; }
    Ok(WalkBuilder::new(root).hidden(false).follow_links(false).overrides(overrides.build().map_err(|e| e.to_string())?).filter_entry(|e| {
        ![".git", "node_modules", "target", ".tools", "dist"].contains(&e.file_name().to_string_lossy().as_ref())
    }).build())
}

pub fn files(root: &Path) -> Vec<String> {
    walker(root, "").into_iter().flatten().filter_map(|e| e.ok()).filter(|e| e.file_type().is_some_and(|f| f.is_file()))
        .filter_map(|e| e.path().strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/")))
        .take(20000).collect()
}

#[derive(Serialize)]
pub struct Match { pub path: String, pub line: usize, pub column: usize, pub text: String }
#[derive(Serialize)]
pub struct SearchResults { pub matches: Vec<Match>, pub truncated: bool }
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query { pub query: String, pub case_sensitive: bool, pub regex: bool, pub whole_word: bool, pub include: String }
impl Query {
    fn matcher(&self) -> Result<regex::Regex> {
        let pattern = if self.regex { self.query.clone() } else { regex::escape(&self.query) };
        let pattern = if self.whole_word { format!(r"\b(?:{pattern})\b") } else { pattern };
        RegexBuilder::new(&pattern).case_insensitive(!self.case_sensitive).size_limit(1024 * 1024).build().map_err(|e| e.to_string())
    }
}
fn text_files(root: &Path, include: &str) -> Result<impl Iterator<Item = (String, String)>> {
    let root = root.to_path_buf();
    Ok(walker(&root, include)?.filter_map(|e| e.ok()).filter(|e| e.file_type().is_some_and(|f| f.is_file())).filter_map(move |entry| {
        if entry.metadata().map(|m| m.len()).unwrap_or(MAX_FILE + 1) > MAX_FILE { return None; }
        let text = fs::read_to_string(entry.path()).ok().filter(|t| !t.contains('\0'))?;
        Some((entry.path().strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/"), text))
    }))
}
pub fn search(root: &Path, query: &Query) -> Result<SearchResults> {
    if query.query.is_empty() { return Ok(SearchResults { matches: vec![], truncated: false }); }
    let matcher = query.matcher()?;
    let mut matches = Vec::new();
    for (path, text) in text_files(root, &query.include)? {
        for (line, content) in text.lines().enumerate() {
            if let Some(found) = matcher.find(content) {
                matches.push(Match { path: path.clone(), line: line + 1, column: content[..found.start()].encode_utf16().count() + 1, text: content.chars().take(240).collect() });
                if matches.len() == 2000 { return Ok(SearchResults { matches, truncated: true }); }
            }
        }
    }
    Ok(SearchResults { matches, truncated: false })
}

pub fn replace(root: &Path, query: &Query, replacement: &str) -> Result<usize> {
    if query.query.is_empty() { return Ok(0); }
    let matcher = query.matcher()?;
    let mut count = 0;
    for (path, text) in text_files(root, &query.include)? {
        let found = matcher.find_iter(&text).count();
        if found == 0 { continue; }
        let updated = if query.regex { matcher.replace_all(&text, replacement) } else { matcher.replace_all(&text, regex::NoExpand(replacement)) };
        save(root, &path, &updated, &text)?;
        count += found;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_safety_and_conflict_detection() {
        let dir = tempfile::tempdir().unwrap(); let root = dir.path().canonicalize().unwrap();
        assert!(resolve(&root, "../secret", false).is_err());
        assert!(resolve(&root, ".git/config", false).is_err());
        create(&root, "hello.rs", false).unwrap();
        assert!(create(&root, "hello.rs", false).is_err());
        save(&root, "hello.rs", "one", "").unwrap();
        fs::write(root.join("hello.rs"), "external").unwrap();
        assert!(save(&root, "hello.rs", "two", "one").unwrap_err().starts_with("CONFLICT:"));
        assert_eq!(read(&root, "hello.rs").unwrap(), "external");
        rename(&root, "hello.rs", "renamed.rs").unwrap();
        assert_eq!(list(&root, "").unwrap()[0].name, "renamed.rs");
    }
    #[test]
    fn search_reports_utf16_columns_and_invalid_regex() {
        let dir = tempfile::tempdir().unwrap(); let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("sample.txt"), "😀 hello\nHELLO").unwrap();
        let query = |query: &str, regex: bool, include: &str| Query { query: query.into(), case_sensitive: false, regex, whole_word: false, include: include.into() };
        let found = search(&root, &query("hello", false, "")).unwrap();
        assert_eq!(found.matches.len(), 2); assert_eq!(found.matches[0].column, 4);
        assert!(search(&root, &query("[", true, "")).is_err());
        assert!(search(&root, &query("hello", false, "*.rs")).unwrap().matches.is_empty());
        assert_eq!(replace(&root, &query("hello", false, "*.txt"), "$bye").unwrap(), 2);
        assert_eq!(fs::read_to_string(root.join("sample.txt")).unwrap(), "😀 $bye\n$bye");
    }
}

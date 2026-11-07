//! Remote folders over the system `ssh`. One persistent `sh` session per workspace carries every request,
//! so the IDE reuses the user's keys and ~/.ssh/config, adds no daemon on the remote side and pays the
//! handshake once. Each request is framed and its output returned base64-encoded so any byte survives.
use crate::workspace::{self, Entry, Match, Query, Result, SearchResults, MAX_FILE};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{io::{BufRead, BufReader, Read, Write}, process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Output, Stdio}, sync::Mutex};

/// Quotes a value for POSIX sh. Single quotes keep everything literal, newlines included.
pub fn q(value: &str) -> String { format!("'{}'", value.replace('\'', r"'\''")) }

const OPTIONS: [&str; 6] = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15", "-o", "ConnectTimeout=10"];
const SETUP: &str = "LO=$(mktemp) && LE=$(mktemp) && LC=$(mktemp) || exit 1; trap 'rm -f \"$LO\" \"$LE\" \"$LC\"' EXIT; printf '__LUMEN_READY__\\n'\n";
const SKIP: [&str; 5] = [".git", "node_modules", "target", ".tools", "dist"];

struct Connection { child: Child, stdin: ChildStdin, stdout: BufReader<ChildStdout> }
impl Drop for Connection { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }

pub struct Remote { pub host: String, pub root: String, password: Option<String>, connection: Mutex<Option<Connection>> }

fn exit_status(code: i32) -> ExitStatus {
    #[cfg(windows)] { use std::os::windows::process::ExitStatusExt; ExitStatus::from_raw(code as u32) }
    #[cfg(unix)] { use std::os::unix::process::ExitStatusExt; ExitStatus::from_raw(code << 8) }
}
fn failure(output: &Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if text.is_empty() { format!("El comando remoto terminó con código {}", output.status.code().unwrap_or(-1)) } else { text }
}

impl Remote {
    /// `spec` is `host:path`, where host may be `user@host` or a ~/.ssh/config alias and path may be relative to home.
    pub fn open(spec: &str, password: Option<String>) -> Result<Remote> {
        let (host, path) = spec.split_once(':').unwrap_or((spec, ""));
        if host.is_empty() || host.starts_with('-') || host.contains(char::is_whitespace) { return Err("Host SSH inválido".into()); }
        let mut remote = Remote { host: host.to_owned(), root: String::new(), password: password.filter(|p| !p.is_empty()), connection: Mutex::new(None) };
        let path = if path == "~" { "" } else { path.strip_prefix("~/").unwrap_or(path) };
        // The session starts in the remote home, so relative paths resolve from there.
        let root = remote.checked(&format!("cd -- {} && pwd -P", q(if path.is_empty() { "." } else { path })))?;
        remote.root = String::from_utf8_lossy(&root).trim().to_owned();
        if remote.root.is_empty() { return Err("No se pudo abrir la carpeta remota".into()); }
        Ok(remote)
    }
    pub fn display(&self) -> String { format!("ssh://{}:{}", self.host, self.root) }

    fn environment(&self) -> Vec<(String, String)> {
        let Some(password) = &self.password else { return vec![] };
        let program = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
        vec![("SSH_ASKPASS".into(), program), ("SSH_ASKPASS_REQUIRE".into(), "force".into()), ("LUMEN_ASKPASS".into(), password.clone())]
    }
    fn options(&self) -> Vec<String> {
        let mut options: Vec<String> = OPTIONS.iter().map(|s| s.to_string()).collect();
        options.extend(["-o".into(), format!("BatchMode={}", if self.password.is_some() { "no" } else { "yes" })]);
        options
    }
    /// Program, arguments and environment for an interactive shell in the project folder.
    pub fn terminal(&self) -> (Vec<String>, Vec<(String, String)>) {
        let mut args = self.options(); args.extend(["-t".into(), self.host.clone(), format!("cd {} && exec ${{SHELL:-sh}} -l", q(&self.root))]);
        (args, self.environment())
    }
    /// ssh arguments and environment that run `argv` in the project folder through a login shell,
    /// so tools installed in ~/.local/bin or by nvm are on PATH.
    pub fn command(&self, argv: &[&str]) -> (Vec<String>, Vec<(String, String)>) {
        let inner = format!("cd {} && exec {}", q(&self.root), argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" "));
        let mut args = self.options(); args.extend(["-T".into(), self.host.clone(), format!("exec \"${{SHELL:-sh}}\" -lc {}", q(&inner))]);
        (args, self.environment())
    }

    fn connect(&self) -> Result<Connection> {
        let mut command = Command::new("ssh");
        command.args(self.options()).args(["-T", &self.host, "sh"]);
        // Tests drive the same protocol through a local shell instead of a real server.
        #[cfg(test)] if self.host == "local-test" { command = Command::new(tests::SHELL); command.env("PATH", tests::path()); }
        command.envs(self.environment()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|e| format!("No se puede ejecutar ssh. Instala OpenSSH y añádelo al PATH: {e}"))?;
        let mut connection = Connection { stdin: child.stdin.take().ok_or("ssh sin entrada")?, stdout: BufReader::new(child.stdout.take().ok_or("ssh sin salida")?), child };
        let ready = connection.stdin.write_all(SETUP.as_bytes()).and_then(|_| connection.stdin.flush()).is_ok() && {
            let mut line = String::new();
            loop { line.clear(); match connection.stdout.read_line(&mut line) { Ok(0) | Err(_) => break false, Ok(_) if line.trim_end() == "__LUMEN_READY__" => break true, Ok(_) => {} } }
        };
        if ready { return Ok(connection); }
        let mut error = String::new();
        if let Some(mut stderr) = connection.child.stderr.take() { let _ = stderr.read_to_string(&mut error); }
        Err(format!("No se pudo conectar por SSH a {}: {}", self.host, error.trim()))
    }

    /// Runs a script in the remote session. A request is retried on a fresh connection only when it could not be sent.
    pub fn script(&self, script: &str) -> Result<Output> {
        let mut guard = self.connection.lock().map_err(|e| e.to_string())?;
        for attempt in 0..2 {
            if guard.is_none() { *guard = Some(self.connect()?); }
            match exchange(guard.as_mut().unwrap(), script) {
                Ok(output) => return Ok(output),
                Err((sent, error)) => { *guard = None; if sent || attempt == 1 { return Err(format!("Conexión SSH perdida: {error}")); } }
            }
        }
        Err("Conexión SSH perdida".into())
    }
    fn checked(&self, script: &str) -> Result<Vec<u8>> {
        let output = self.script(script)?;
        if output.status.success() { Ok(output.stdout) } else { Err(failure(&output)) }
    }
    /// Runs a program with arguments in the project folder.
    pub fn run(&self, argv: &[&str]) -> Result<Output> {
        self.script(&format!("cd {} && {}", q(&self.root), argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ")))
    }
    pub fn run_limited(&self, argv: &[&str], limit: u64) -> Result<Vec<u8>> {
        self.checked(&format!("cd {} && {} | head -c {limit}", q(&self.root), argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ")))
    }

    fn path(&self, relative: &str) -> Result<String> {
        workspace::lexical(relative)?;
        Ok(if relative.is_empty() { self.root.clone() } else { format!("{}/{}", self.root, relative.replace('\\', "/")) })
    }
    pub fn exists(&self, relative: &str) -> bool { workspace::lexical(relative).is_ok() && self.test_exists(relative) }
    /// Checks a path relative to the project (or absolute) without the user-facing path rules.
    pub fn test_exists(&self, path: &str) -> bool {
        self.script(&format!("cd {} && [ -e {} ]", q(&self.root), q(path))).is_ok_and(|o| o.status.success())
    }
    pub fn list(&self, relative: &str) -> Result<Vec<Entry>> {
        let directory = self.path(relative)?;
        let data = self.checked(&format!("cd {} && find . -mindepth 1 -maxdepth 1 ! -name .git -printf '%Y\\t%P\\0'", q(&directory)))?;
        let mut result: Vec<Entry> = String::from_utf8_lossy(&data).split('\0').filter_map(|item| {
            let (kind, name) = item.split_once('\t')?;
            Some(Entry { name: name.to_owned(), path: if relative.is_empty() { name.to_owned() } else { format!("{relative}/{name}") }, is_dir: kind == "d" })
        }).collect();
        result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(result)
    }
    pub fn read_bytes(&self, relative: &str, limit: u64) -> Result<Vec<u8>> {
        self.checked(&format!("head -c {} -- {}", limit + 1, q(&self.path(relative)?)))
    }
    pub fn read(&self, relative: &str) -> Result<String> {
        let bytes = self.read_bytes(relative, MAX_FILE)?;
        if bytes.len() as u64 > MAX_FILE { return Err("El editor admite archivos de texto de hasta 5 MB".into()); }
        let text = String::from_utf8(bytes).map_err(|e| format!("No se puede abrir como texto UTF-8: {e}"))?;
        if text.contains('\0') { return Err("Este archivo parece binario".into()); }
        Ok(text)
    }
    pub fn save(&self, relative: &str, content: &str, expected: &str) -> Result<()> {
        if self.read(relative)? != expected { return Err("CONFLICT: El archivo cambió en disco. Recárgalo o guarda una copia antes de sobrescribir.".into()); }
        let file = self.path(relative)?;
        let parent = file.rsplit_once('/').map_or(self.root.as_str(), |(p, _)| p);
        let temporary = q(&format!("{parent}/.lumen-save-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let file = q(&file);
        // The payload is plain base64, which is safe inside single quotes.
        self.checked(&format!("printf '%s' '{}' | base64 -d > {temporary} && {{ chmod --reference={file} {temporary} 2>/dev/null; mv -f -- {temporary} {file}; }} || {{ rm -f -- {temporary}; exit 1; }}", STANDARD.encode(content))).map(|_| ())
    }
    pub fn create(&self, relative: &str, directory: bool) -> Result<()> {
        let path = q(&self.path(relative)?);
        self.checked(&if directory { format!("mkdir -- {path}") } else { format!("set -C && : > {path}") }).map(|_| ())
    }
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (from, to) = (q(&self.path(from)?), q(&self.path(to)?));
        self.checked(&format!("if [ -e {to} ] || [ -L {to} ]; then echo 'Ya existe un archivo con ese nombre' >&2; exit 1; fi; mv -- {from} {to}")).map(|_| ())
    }
    /// Moves to the freedesktop trash in the remote home, so the item stays recoverable.
    pub fn trash(&self, relative: &str) -> Result<()> {
        if relative.is_empty() { return Err("Ruta inválida".into()); }
        let path = self.path(relative)?; let name = q(path.rsplit('/').next().unwrap_or("item"));
        self.checked(&format!("d=\"${{XDG_DATA_HOME:-$HOME/.local/share}}/Trash\"; n=\"$(printf '%s' {name}).$(date +%s%N)\"; mkdir -p \"$d/files\" \"$d/info\" && printf '[Trash Info]\\nPath=%s\\nDeletionDate=%s\\n' {p} \"$(date +%Y-%m-%dT%H:%M:%S)\" > \"$d/info/$n.trashinfo\" && mv -- {p} \"$d/files/$n\"", p = q(&path))).map(|_| ())
    }
    pub fn files(&self) -> Result<Vec<String>> {
        let prune = SKIP.iter().map(|s| format!("-name {}", q(s))).collect::<Vec<_>>().join(" -o ");
        let data = self.checked(&format!("cd {} && find . \\( {prune} \\) -prune -o -type f -print0 | head -z -n 20000", q(&self.root)))?;
        Ok(String::from_utf8_lossy(&data).split('\0').filter_map(|p| p.strip_prefix("./")).map(str::to_owned).collect())
    }

    /// grep finds candidate lines on the remote side; the Rust matcher then confirms them and computes columns,
    /// so results follow the same rules as local search.
    fn grep(&self, query: &Query, flags: &str) -> Result<Vec<u8>> {
        // -P with the local pattern keeps both engines close; -F -i aborts on multibyte text in older greps.
        let mut args = vec![format!("-rIP{flags}")];
        if !query.case_sensitive { args.push("-i".into()); }
        args.extend(SKIP.iter().map(|s| format!("--exclude-dir={}", q(s))));
        for glob in query.include.split(',').map(str::trim).filter(|g| !g.is_empty()) {
            args.push(match glob.strip_prefix('!') { Some(g) => format!("--exclude={}", q(g)), None => format!("--include={}", q(glob)) });
        }
        let output = self.script(&format!("cd {} && LC_ALL=C.UTF-8 grep {} -e {} -- . | head -n 20000", q(&self.root), args.join(" "), q(&query.pattern())))?;
        if output.status.success() { Ok(output.stdout) } else { Err(failure(&output)) }
    }
    pub fn search(&self, query: &Query) -> Result<SearchResults> {
        if query.query.is_empty() { return Ok(SearchResults { matches: vec![], truncated: false }); }
        let matcher = query.matcher()?;
        let data = self.grep(query, "HnZ")?; let data = String::from_utf8_lossy(&data);
        let mut matches = Vec::new();
        for line in data.lines() {
            let Some((path, rest)) = line.split_once('\0') else { continue };
            let Some((number, content)) = rest.split_once(':') else { continue };
            if let Some(found) = matcher.find(content) {
                matches.push(Match { path: path.trim_start_matches("./").to_owned(), line: number.parse().unwrap_or(1), column: content[..found.start()].encode_utf16().count() + 1, text: content.chars().take(240).collect() });
                if matches.len() == 2000 { return Ok(SearchResults { matches, truncated: true }); }
            }
        }
        Ok(SearchResults { matches, truncated: false })
    }
    pub fn replace(&self, query: &Query, replacement: &str) -> Result<usize> {
        if query.query.is_empty() { return Ok(0); }
        let matcher = query.matcher()?;
        let data = self.grep(query, "lZ")?;
        let mut count = 0;
        for path in String::from_utf8_lossy(&data).split('\0').map(|p| p.trim_start_matches("./")).filter(|p| !p.is_empty()) {
            let Ok(text) = self.read(path) else { continue };
            if let Some((updated, found)) = workspace::replaced(&matcher, query, &text, replacement) { self.save(path, &updated, &text)?; count += found; }
        }
        Ok(count)
    }
}

/// Sends one framed request. The error flag says whether the request may already have run.
fn exchange(connection: &mut Connection, script: &str) -> std::result::Result<Output, (bool, String)> {
    let frame = format!("{{ ( {script}\n) </dev/null >\"$LO\" 2>\"$LE\"; printf '%s\\n' \"$?\" >\"$LC\"; }}; printf '__LUMEN__\\n'; base64 <\"$LO\" | tr -d '\\n'; printf '\\n'; base64 <\"$LE\" | tr -d '\\n'; printf '\\n'; cat \"$LC\"\n");
    connection.stdin.write_all(frame.as_bytes()).and_then(|_| connection.stdin.flush()).map_err(|e| (false, e.to_string()))?;
    let mut read = || { let mut line = String::new(); match connection.stdout.read_line(&mut line) { Ok(0) => Err((true, "la sesión se cerró".to_owned())), Ok(_) => Ok(line.trim_end().to_owned()), Err(e) => Err((true, e.to_string())) } };
    while read()? != "__LUMEN__" {}
    let decode = |text: String| STANDARD.decode(text).map_err(|e| (true, e.to_string()));
    let stdout = decode(read()?)?; let stderr = decode(read()?)?;
    let code = read()?.parse().unwrap_or(1);
    Ok(Output { status: exit_status(code), stdout, stderr })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)] pub const SHELL: &str = r"C:\Program Files\Git\usr\bin\sh.exe";
    #[cfg(not(windows))] pub const SHELL: &str = "sh";
    #[cfg(windows)] pub fn path() -> String { format!("{};{}", r"C:\Program Files\Git\usr\bin", std::env::var("PATH").unwrap_or_default()) }
    #[cfg(not(windows))] pub fn path() -> String { std::env::var("PATH").unwrap_or_default() }

    #[test]
    fn remote_protocol_round_trip() {
        if cfg!(windows) && !std::path::Path::new(SHELL).exists() { return; }
        let dir = tempfile::tempdir().unwrap();
        let spec = format!("local-test:{}", dir.path().display().to_string().replace('\\', "/"));
        let remote = Remote::open(&spec, None).unwrap();
        let root = workspace::Root::Remote(std::sync::Arc::new(remote));
        root.create("src", true).unwrap();
        root.create("src/a b's.txt", false).unwrap();
        assert!(root.create("src/a b's.txt", false).is_err());
        let text = "hola 'mundo' ñ 😀\n$HOME `x`\nhello\n";
        root.save("src/a b's.txt", text, "").unwrap();
        assert_eq!(root.read("src/a b's.txt").unwrap(), text);
        assert!(root.save("src/a b's.txt", "x", "stale").unwrap_err().starts_with("CONFLICT:"));
        assert_eq!(root.list("src").unwrap()[0].path, "src/a b's.txt");
        assert!(root.list("").unwrap()[0].is_dir);
        assert_eq!(root.files().unwrap(), vec!["src/a b's.txt"]);
        let query = Query { query: "hello".into(), case_sensitive: false, regex: false, whole_word: false, include: String::new() };
        let found = root.search(&query).unwrap();
        assert_eq!((found.matches.len(), found.matches[0].line), (1, 3));
        assert_eq!(root.replace(&query, "bye").unwrap(), 1);
        assert!(root.read("src/a b's.txt").unwrap().ends_with("bye\n"));
        root.rename("src/a b's.txt", "src/b.txt").unwrap();
        assert!(root.exists("src/b.txt") && !root.exists("src/a b's.txt"));
        assert!(root.read("../outside").is_err() && root.read(".git/config").is_err());
        assert_eq!(root.read_binary("src/b.txt", Some(4)).unwrap(), b"hola");
        let failed = std::sync::Arc::new(Remote::open(&spec, None).unwrap()).run(&["sh", "-c", "echo oops >&2; exit 3"]).unwrap();
        assert_eq!((failed.status.code(), failed.stderr), (Some(3), b"oops\n".to_vec()));
    }

    #[test]
    fn quoting_survives_quotes_and_rejects_bad_hosts() {
        assert_eq!(q("it's"), r"'it'\''s'");
        assert!(Remote::open("-oProxyCommand=x:/tmp", None).is_err());
        assert!(Remote::open("a b:/tmp", None).is_err());
    }
}

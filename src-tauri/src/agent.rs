//! Chat with the Claude Code and Codex CLIs. Each message starts the CLI in non-interactive JSON mode and
//! resumes the previous session, so nothing stays in memory between turns and the CLIs keep their own login,
//! settings and history (the same chats the terminal versions show).
use crate::{remote::{q, Remote}, workspace::{display_path, Result, Root}};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, io::{BufRead, BufReader, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{atomic::{AtomicU32, Ordering}, Arc, Mutex}};
use tauri::ipc::Channel;

#[derive(Default, Clone)]
pub struct Runs(Arc<Mutex<HashMap<u32, Child>>>);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent { Line { line: String }, Done { code: i32, error: String } }

fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') }

/// Every argument is a fixed word or a validated session id; the prompt always goes through stdin.
fn arguments(agent: &str, session: Option<&str>, mode: &str) -> Result<Vec<String>> {
    if session.is_some_and(|s| !valid_id(s)) { return Err("Sesión inválida".into()); }
    let mut args = match agent {
        "claude" => vec!["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", match mode { "read" => "plan", "full" => "bypassPermissions", _ => "acceptEdits" }],
        "codex" => {
            let mut args = vec!["codex", "exec", "--json", "--skip-git-repo-check"];
            args.extend(match mode { "read" => &["-s", "read-only"][..], "full" => &["--dangerously-bypass-approvals-and-sandbox"][..], _ => &["--full-auto"][..] });
            args
        }
        _ => return Err("Agente desconocido".into()),
    };
    args.extend(match session { Some(_) if agent == "claude" => Some("--resume"), Some(_) => Some("resume"), None => None });
    let mut args: Vec<String> = args.into_iter().map(str::to_owned).collect();
    args.extend(session.map(str::to_owned));
    if agent == "codex" { args.push("-".into()); }
    Ok(args)
}

/// npm installs CLIs as .cmd shims, which only cmd.exe can start. The arguments are fixed words, so this is safe.
fn local_command(args: &[String]) -> Command {
    #[cfg(windows)] {
        let exe = format!("{}.exe", args[0]);
        let found = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(&exe).is_file()));
        if !found { let mut command = Command::new("cmd"); command.arg("/C").args(args); return command; }
    }
    let mut command = Command::new(&args[0]); command.args(&args[1..]); command
}

pub fn send(root: &Root, runs: &Runs, channel: Channel<AgentEvent>, agent: &str, prompt: &str, session: Option<&str>, mode: &str) -> Result<u32> {
    let args = arguments(agent, session, mode)?;
    let mut command = match root {
        Root::Local(dir) => { let mut command = local_command(&args); command.current_dir(dir); command }
        Root::Remote(remote) => { let (ssh, environment) = remote.command(&args.iter().map(String::as_str).collect::<Vec<_>>()); let mut command = Command::new("ssh"); command.args(ssh).envs(environment); command }
    };
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|e| format!("No se puede ejecutar {}: {e}. Instala su CLI y añádela al PATH", args[0]))?;
    let (mut stdin, stdout, mut stderr) = (child.stdin.take().ok_or("Sin entrada")?, child.stdout.take().ok_or("Sin salida")?, child.stderr.take().ok_or("Sin errores")?);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    runs.0.lock().map_err(|e| e.to_string())?.insert(id, child);
    let prompt = prompt.to_owned();
    std::thread::spawn(move || { let _ = stdin.write_all(prompt.as_bytes()); });
    let errors = std::thread::spawn(move || { let mut text = String::new(); let _ = stderr.read_to_string(&mut text); text });
    let runs = runs.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !line.trim().is_empty() && channel.send(AgentEvent::Line { line }).is_err() { break; }
        }
        let child = runs.0.lock().ok().and_then(|mut runs| runs.remove(&id));
        let code = child.and_then(|mut c| c.wait().ok()).and_then(|s| s.code()).unwrap_or(-1);
        let error = errors.join().unwrap_or_default();
        let _ = channel.send(AgentEvent::Done { code, error: if code == 0 { String::new() } else { error.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect() } });
    });
    Ok(id)
}
pub fn stop(runs: &Runs, id: u32) { if let Some(child) = runs.0.lock().ok().as_mut().and_then(|r| r.get_mut(&id)) { let _ = child.kill(); } }
pub fn stop_all(runs: &Runs) { if let Ok(mut runs) = runs.0.lock() { for child in runs.values_mut() { let _ = child.kill(); } } }

/* ---------- History ---------- */

#[derive(Serialize, Debug)]
pub struct Chat { pub id: String, pub title: String, pub time: u64 }
#[derive(Serialize, Debug, PartialEq)]
pub struct Message { pub role: String, pub text: String }

fn home() -> PathBuf { PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default()) }
fn claude_dir() -> PathBuf { std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude")) }
fn codex_dir() -> PathBuf { std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".codex")).join("sessions") }
/// Claude Code keeps a project's sessions in a folder named after its path with every other character as '-'.
fn slug(path: &str) -> String { path.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect() }
const REMOTE_CLAUDE: &str = "\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/\"";
const REMOTE_CODEX: &str = "\"${CODEX_HOME:-$HOME/.codex}/sessions\"";

fn modified(path: &Path) -> u64 { path.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()) }
fn head_and_tail(path: &Path, head: u64, tail: u64) -> String {
    let Ok(mut file) = std::fs::File::open(path) else { return String::new() };
    let mut bytes = Vec::new(); let _ = (&mut file).take(head).read_to_end(&mut bytes);
    let length = file.metadata().map_or(0, |m| m.len());
    if tail > 0 && length > head { bytes.push(b'\n'); let _ = file.seek(SeekFrom::Start(length.saturating_sub(tail).max(head))); let _ = file.take(tail).read_to_end(&mut bytes); }
    String::from_utf8_lossy(&bytes).into_owned()
}
fn codex_files(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() { codex_files(&path, found); } else if path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("rollout-")) { found.push(path); }
    }
}
fn first_line(path: &Path) -> String { let mut line = String::new(); if let Ok(file) = std::fs::File::open(path) { let _ = BufReader::new(file).read_line(&mut line); } line }
/// Parses records written by the remote listing scripts: "\x1e<time>\t<name>\n<text>".
fn records(data: &[u8]) -> Vec<(u64, String, String)> {
    String::from_utf8_lossy(data).split('\x1e').filter_map(|record| {
        let (header, text) = record.split_once('\n')?; let (time, name) = header.split_once('\t')?;
        Some((time.trim().parse().unwrap_or(0), name.to_owned(), text.to_owned()))
    }).collect()
}
fn remote_output(remote: &Remote, script: &str) -> Result<Vec<u8>> {
    let output = remote.script(script)?;
    if output.status.success() { Ok(output.stdout) } else { Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()) }
}

fn clip(text: &str, length: usize) -> String { let line = text.split_whitespace().collect::<Vec<_>>().join(" "); if line.chars().count() > length { format!("{}…", line.chars().take(length).collect::<String>()) } else { line } }
/// Text a person typed: plain strings or text blocks, without the tags the CLIs inject (commands, context).
fn user_text(content: &Value) -> Option<String> {
    let text = match content { Value::String(s) => s.clone(), Value::Array(blocks) => blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"), _ => return None };
    let text = text.trim(); if text.is_empty() || text.starts_with('<') { None } else { Some(text.to_owned()) }
}
pub fn tool_summary(name: &str, input: &Value) -> String {
    let detail = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"].iter().find_map(|k| input[*k].as_str()).unwrap_or("");
    if detail.is_empty() { name.to_owned() } else { format!("{name}: {}", clip(detail, 160)) }
}

fn claude_title(text: &str) -> Option<String> {
    let mut first = None; let mut custom = None;
    for value in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        match value["type"].as_str() {
            Some("custom-title") => custom = value["customTitle"].as_str().map(str::to_owned),
            Some("summary") if custom.is_none() => custom = value["summary"].as_str().map(str::to_owned),
            Some("user") if first.is_none() && value["isMeta"] != true && value["isSidechain"] != true => first = user_text(&value["message"]["content"]),
            _ => {}
        }
    }
    custom.or(first).map(|t| clip(&t, 90))
}
fn codex_session(text: &str, cwd: &str) -> Option<(String, String)> {
    let mut lines = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok());
    let meta = lines.next()?;
    if meta["payload"]["cwd"].as_str().map(|c| c.trim_end_matches(['/', '\\'])) != Some(cwd.trim_end_matches(['/', '\\'])) { return None; }
    let id = meta["payload"]["id"].as_str()?.to_owned();
    let title = lines.find_map(|v| (v["type"] == "event_msg" && v["payload"]["type"] == "user_message").then(|| v["payload"]["message"].as_str().map(str::to_owned)).flatten()).unwrap_or_else(|| "Codex".into());
    Some((id, clip(&title, 90)))
}

pub fn chats(root: &Root, agent: &str) -> Result<Vec<Chat>> {
    let mut chats = Vec::new();
    match (agent, root) {
        ("claude", Root::Local(dir)) => {
            let folder = claude_dir().join("projects").join(slug(&display_path(dir)));
            let mut files: Vec<_> = std::fs::read_dir(folder).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "jsonl")).map(|p| (modified(&p), p)).collect();
            files.sort_by(|a, b| b.0.cmp(&a.0));
            for (time, path) in files.into_iter().take(40) {
                if let Some(title) = claude_title(&head_and_tail(&path, 32768, 16384)) { chats.push(Chat { id: path.file_stem().unwrap_or_default().to_string_lossy().into(), title, time }); }
            }
        }
        ("claude", Root::Remote(remote)) => {
            let script = format!("cd {REMOTE_CLAUDE}{} 2>/dev/null || exit 0; ls -t -- *.jsonl 2>/dev/null | head -40 | while IFS= read -r f; do printf '\\036%s\\t%s\\n' \"$(stat -c %Y -- \"$f\")\" \"${{f%.jsonl}}\"; head -c 32768 -- \"$f\"; printf '\\n'; tail -c 16384 -- \"$f\"; printf '\\n'; done", q(&slug(&remote.root)));
            for (time, id, text) in records(&remote_output(remote, &script)?) { if let Some(title) = claude_title(&text) { chats.push(Chat { id, title, time }); } }
        }
        ("codex", Root::Local(dir)) => {
            let mut files = Vec::new(); codex_files(&codex_dir(), &mut files);
            files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
            let cwd = display_path(dir);
            for path in files.into_iter().take(300) {
                if !first_line(&path).contains("\"cwd\"") { continue; }
                if let Some((id, title)) = codex_session(&head_and_tail(&path, 131072, 0), &cwd) { chats.push(Chat { id, title, time: modified(&path) }); }
                if chats.len() == 40 { break; }
            }
        }
        ("codex", Root::Remote(remote)) => {
            let script = format!("n=0; find {REMOTE_CODEX} -name 'rollout-*.jsonl' 2>/dev/null | sort -r | head -300 | while IFS= read -r f; do head -n1 -- \"$f\" | grep -qF {} || continue; printf '\\036%s\\t%s\\n' \"$(stat -c %Y -- \"$f\")\" x; head -c 131072 -- \"$f\"; printf '\\n'; n=$((n+1)); [ $n -ge 40 ] && break; done; true", q(&format!("\"cwd\":\"{}\"", remote.root)));
            for (time, _, text) in records(&remote_output(remote, &script)?) { if let Some((id, title)) = codex_session(&text, &remote.root) { chats.push(Chat { id, title, time }); } }
        }
        _ => return Err("Agente desconocido".into()),
    }
    Ok(chats)
}

pub fn history(root: &Root, agent: &str, id: &str) -> Result<Vec<Message>> {
    if !valid_id(id) { return Err("Sesión inválida".into()); }
    let text = match (agent, root) {
        ("claude", Root::Local(dir)) => std::fs::read_to_string(claude_dir().join("projects").join(slug(&display_path(dir))).join(format!("{id}.jsonl"))).map_err(|e| e.to_string())?,
        ("claude", Root::Remote(remote)) => String::from_utf8_lossy(&remote_output(remote, &format!("cat -- {REMOTE_CLAUDE}{}/{id}.jsonl", q(&slug(&remote.root))))?).into_owned(),
        ("codex", Root::Local(_)) => { let mut files = Vec::new(); codex_files(&codex_dir(), &mut files); std::fs::read_to_string(files.iter().find(|p| p.to_string_lossy().ends_with(&format!("{id}.jsonl"))).ok_or("No se encontró el chat")?).map_err(|e| e.to_string())? }
        ("codex", Root::Remote(remote)) => String::from_utf8_lossy(&remote_output(remote, &format!("f=$(find {REMOTE_CODEX} -name '*{id}.jsonl' | head -n1); [ -n \"$f\" ] && cat -- \"$f\""))?).into_owned(),
        _ => return Err("Agente desconocido".into()),
    };
    Ok(if agent == "claude" { claude_messages(&text) } else { codex_messages(&text) })
}

fn push(messages: &mut Vec<Message>, role: &str, text: String) {
    match messages.last_mut() { Some(last) if last.role == role && role == "assistant" => { last.text.push_str("\n\n"); last.text.push_str(&text); } _ => messages.push(Message { role: role.into(), text }) }
}
pub fn claude_messages(text: &str) -> Vec<Message> {
    let mut messages = Vec::new();
    for value in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        if value["isSidechain"] == true || value["isMeta"] == true { continue; }
        let content = &value["message"]["content"];
        match value["type"].as_str() {
            Some("user") => if let Some(text) = user_text(content) { push(&mut messages, "user", text); },
            Some("assistant") => for block in content.as_array().into_iter().flatten() {
                match block["type"].as_str() {
                    Some("text") => if let Some(text) = block["text"].as_str().filter(|t| !t.trim().is_empty()) { push(&mut messages, "assistant", text.to_owned()); },
                    Some("tool_use") => push(&mut messages, "tool", tool_summary(block["name"].as_str().unwrap_or("Tool"), &block["input"])),
                    _ => {}
                }
            },
            _ => {}
        }
    }
    messages
}
pub fn codex_messages(text: &str) -> Vec<Message> {
    let mut messages = Vec::new();
    for value in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let payload = &value["payload"];
        if value["type"] != "event_msg" { continue; }
        match payload["type"].as_str() {
            Some("user_message") => if let Some(text) = payload["message"].as_str() { push(&mut messages, "user", text.to_owned()); },
            Some("agent_message") => if let Some(text) = payload["message"].as_str() { push(&mut messages, "assistant", text.to_owned()); },
            Some("exec_command_end") => push(&mut messages, "tool", format!("Shell: {}", clip(&payload["command"].as_array().map(|c| c.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")).unwrap_or_default(), 160))),
            _ => {}
        }
    }
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments_reject_bad_sessions_and_parse_histories() {
        assert!(arguments("claude", Some("x; rm -rf /"), "edit").is_err());
        assert_eq!(arguments("codex", Some("abc-1"), "read").unwrap(), vec!["codex", "exec", "--json", "--skip-git-repo-check", "-s", "read-only", "resume", "abc-1", "-"]);
        assert_eq!(slug(r"C:\Users\A b\IDE"), "C--Users-A-b-IDE");
        let claude = [
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","message":{"content":"Arregla el bug"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Miro"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hecho"}]}}"#,
            r#"{"type":"custom-title","customTitle":"Bug"}"#,
        ].join("\n");
        assert_eq!(claude_messages(&claude).iter().map(|m| m.role.as_str()).collect::<Vec<_>>(), ["user", "assistant", "tool", "assistant"]);
        assert_eq!(claude_title(&claude).as_deref(), Some("Bug"));
        let codex = [r#"{"type":"session_meta","payload":{"id":"u-1","cwd":"/home/pi/p"}}"#, r#"{"type":"event_msg","payload":{"type":"user_message","message":"hola"}}"#, r#"{"type":"event_msg","payload":{"type":"agent_message","message":"buenas"}}"#].join("\n");
        assert_eq!(codex_session(&codex, "/home/pi/p/"), Some(("u-1".into(), "hola".into())));
        assert!(codex_session(&codex, "/other").is_none());
        assert_eq!(codex_messages(&codex).len(), 2);
    }
}

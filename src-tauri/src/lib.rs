mod agent;
mod docker;
mod git;
mod remote;
mod terminal;
mod workspace;

use tauri::{Manager, State};
use workspace::{Result, Workspace};

#[tauri::command(async)]
fn open_workspace(state: State<Workspace>, terminals: State<terminal::Terminals>, path: Option<String>, password: Option<String>) -> Result<Option<workspace::WorkspaceInfo>> {
    if let Some(spec) = path.as_deref().and_then(|p| p.strip_prefix("ssh://")) {
        let remote = remote::Remote::open(spec, password)?;
        let info = workspace::WorkspaceInfo { name: remote.root.rsplit('/').find(|s| !s.is_empty()).unwrap_or(&remote.host).to_owned(), path: remote.display() };
        *state.0.lock().map_err(|e| e.to_string())? = Some(workspace::Root::Remote(std::sync::Arc::new(remote)));
        terminal::close_all(&terminals);
        return Ok(Some(info));
    }
    let selected = match path { Some(p) => Some(p.into()), None => rfd::FileDialog::new().set_title("Abrir proyecto en Lumen").pick_folder() };
    match selected { Some(path) => {
        let info = workspace::set_workspace(&state, path)?;
        terminal::close_all(&terminals);
        Ok(Some(info))
    }, None => Ok(None) }
}

/// Forgets the open folder; for a remote one this also ends its SSH session and terminals.
#[tauri::command(async)]
fn close_workspace(state: State<Workspace>, terminals: State<terminal::Terminals>) -> Result<()> {
    *state.0.lock().map_err(|e| e.to_string())? = None;
    terminal::close_all(&terminals);
    Ok(())
}

#[tauri::command(async)]
fn pick_folder() -> Option<String> { rfd::FileDialog::new().set_title("Abrir proyecto en Lumen").pick_folder().map(|p| p.display().to_string()) }

#[tauri::command(async)]
fn clone_repository(state: State<Workspace>, terminals: State<terminal::Terminals>, url: String, name: String) -> Result<Option<workspace::WorkspaceInfo>> {
    if url.is_empty() || url.starts_with('-') || url.contains('\0') { return Err("URL de repositorio inválida".into()); }
    if name.is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." { return Err("Nombre de carpeta inválido".into()); }
    let Some(parent) = rfd::FileDialog::new().set_title("Clonar en esta carpeta").pick_folder() else { return Ok(None) };
    let target = parent.join(&name);
    if target.exists() { return Err("La carpeta de destino ya existe".into()); }
    // Git receives individual arguments, never an interpolated shell command.
    git::run(&workspace::Root::Local(parent.clone()), &["clone", "--", &url, &name])?;
    let info = workspace::set_workspace(&state, target)?;
    terminal::close_all(&terminals);
    Ok(Some(info))
}
#[tauri::command(async)]
fn list_directory(state: State<Workspace>, path: String) -> Result<Vec<workspace::Entry>> { state.root()?.list(&path) }
#[tauri::command(async)]
fn list_files(state: State<Workspace>) -> Result<Vec<String>> { state.root()?.files() }
#[tauri::command(async)]
fn read_file(state: State<Workspace>, path: String) -> Result<String> { state.root()?.read(&path) }
#[tauri::command(async)]
fn read_binary(state: State<Workspace>, path: String, limit: Option<u64>) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(state.root()?.read_binary(&path, limit)?))
}
#[tauri::command(async)]
fn save_file(state: State<Workspace>, path: String, content: String, expected: String) -> Result<()> { state.root()?.save(&path, &content, &expected) }
#[tauri::command(async)]
fn create_entry(state: State<Workspace>, path: String, directory: bool) -> Result<()> { state.root()?.create(&path, directory) }
#[tauri::command(async)]
fn rename_entry(state: State<Workspace>, from: String, to: String) -> Result<()> { state.root()?.rename(&from, &to) }
#[tauri::command(async)]
fn trash_entry(state: State<Workspace>, path: String) -> Result<()> {
    state.root()?.trash(&path)
}
#[tauri::command(async)]
fn search_files(state: State<Workspace>, query: workspace::Query) -> Result<workspace::SearchResults> { state.root()?.search(&query) }
#[tauri::command(async)]
fn replace_files(state: State<Workspace>, query: workspace::Query, replacement: String) -> Result<usize> { state.root()?.replace(&query, &replacement) }
#[tauri::command(async)]
fn reveal_entry(state: State<Workspace>, path: String) -> Result<()> {
    let workspace::Root::Local(root) = state.root()? else { return Err("No disponible en carpetas remotas".into()) };
    let target = workspace::display_path(&if path.is_empty() { root.clone() } else { workspace::resolve(&root, &path, true)? });
    let mut command = std::process::Command::new(if cfg!(windows) { "explorer" } else { "xdg-open" });
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.raw_arg(format!("/select,\"{target}\"")); }
    #[cfg(not(windows))] command.arg(std::path::Path::new(&target).parent().unwrap_or(std::path::Path::new(&target)));
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}
#[tauri::command]
fn startup_path() -> Option<String> { std::env::args().nth(1).filter(|a| !a.starts_with('-')) }
#[tauri::command(async)]
fn git_status(state: State<Workspace>) -> Result<git::Status> { git::status(&state.root()?) }
#[tauri::command(async)]
fn git_log(state: State<Workspace>, path: Option<String>) -> Result<Vec<git::Commit>> { git::log(&state.root()?, path.as_deref()) }
#[tauri::command(async)]
fn git_commit(state: State<Workspace>, hash: String) -> Result<String> { git::commit_detail(&state.root()?, &hash) }
#[tauri::command(async)]
fn git_branches(state: State<Workspace>) -> Result<Vec<git::Branch>> { git::branches(&state.root()?) }
#[tauri::command(async)]
fn git_diff(state: State<Workspace>, path: String, staged: bool, old_path: Option<String>) -> Result<git::Diff> { git::diff(&state.root()?, &path, staged, old_path.as_deref()) }
#[tauri::command(async)]
fn git_action(state: State<Workspace>, action: String, value: String, paths: Vec<String>) -> Result<String> { git::action(&state.root()?, &action, &value, &paths) }
#[tauri::command(async)]
fn git_commit_files(state: State<Workspace>, hash: String) -> Result<Vec<git::CommitFile>> { git::commit_files(&state.root()?, &hash) }
#[tauri::command(async)]
fn git_commit_diff(state: State<Workspace>, hash: String, path: String) -> Result<git::Diff> { git::commit_diff(&state.root()?, &hash, &path) }
#[tauri::command(async)]
fn git_line_changes(state: State<Workspace>, path: String) -> Result<Vec<git::LineChange>> { git::line_changes(&state.root()?, &path) }
#[tauri::command(async)]
fn git_blame(state: State<Workspace>, path: String, line: u32) -> Result<Option<git::Blame>> { git::blame(&state.root()?, &path, line) }
#[tauri::command(async)]
fn git_list(state: State<Workspace>, kind: String) -> Result<Vec<String>> { git::list(&state.root()?, &kind) }
#[tauri::command(async)]
fn docker_list(state: State<Workspace>) -> Result<Vec<docker::Container>> { docker::list(state.remote().as_deref()) }
#[tauri::command(async)]
fn docker_action(state: State<Workspace>, action: String, id: String) -> Result<()> { docker::action(state.remote().as_deref(), &action, &id) }
#[tauri::command(async)]
fn docker_logs(state: State<Workspace>, id: String) -> Result<String> { docker::logs(state.remote().as_deref(), &id) }
#[tauri::command(async)]
fn agent_send(state: State<Workspace>, runs: State<agent::Runs>, channel: tauri::ipc::Channel<agent::AgentEvent>, agent: String, prompt: String, session: Option<String>, mode: String) -> Result<u32> { agent::send(&state.root()?, &runs, channel, &agent, &prompt, session.as_deref(), &mode) }
#[tauri::command]
fn agent_stop(runs: State<agent::Runs>, id: u32) { agent::stop(&runs, id) }
#[tauri::command(async)]
fn agent_chats(state: State<Workspace>, agent: String) -> Result<Vec<agent::Chat>> { agent::chats(&state.root()?, &agent) }
#[tauri::command(async)]
fn agent_history(state: State<Workspace>, agent: String, id: String) -> Result<Vec<agent::Message>> { agent::history(&state.root()?, &agent, &id) }
#[tauri::command(async)]
fn terminal_start(state: State<Workspace>, terminals: State<terminal::Terminals>, channel: tauri::ipc::Channel<terminal::TerminalEvent>, shell: Option<String>) -> Result<u32> { terminal::start(&state.root()?, &terminals, channel, shell) }
#[tauri::command(async)]
fn terminal_write(terminals: State<terminal::Terminals>, id: u32, data: String) -> Result<()> { terminal::write(&terminals, id, &data) }
#[tauri::command(async)]
fn terminal_resize(terminals: State<terminal::Terminals>, id: u32, rows: u16, cols: u16) -> Result<()> { terminal::resize(&terminals, id, rows, cols) }
#[tauri::command(async)]
fn terminal_close(terminals: State<terminal::Terminals>, id: u32) -> Result<()> { terminal::close(&terminals, id) }

// A stopped load leaves an empty page with no script of ours running, so recovery must come from outside it.
const RECOVER_BLANK_PAGE: &str = "try { const key = 'lumen.bootRetries', tries = Number(sessionStorage.getItem(key) ?? 0); if (document.querySelector('#app')?.childElementCount) sessionStorage.removeItem(key); else if (tries < 3) { sessionStorage.setItem(key, tries + 1); location.reload(); } } catch { location.reload(); }";

pub fn run() {
    tauri::Builder::default().manage(Workspace::default()).manage(terminal::Terminals::default()).manage(agent::Runs::default())
        .invoke_handler(tauri::generate_handler![pick_folder, open_workspace, close_workspace, clone_repository, list_directory, list_files, read_file, read_binary, save_file, create_entry, rename_entry, trash_entry, search_files, replace_files, reveal_entry, startup_path, git_commit_files, git_commit_diff, git_line_changes, git_blame, git_list, git_status, git_log, git_commit, git_branches, git_diff, git_action, docker_list, docker_action, docker_logs, agent_send, agent_stop, agent_chats, agent_history, terminal_start, terminal_write, terminal_resize, terminal_close])
        .on_page_load(|webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished { return; }
            let webview = webview.clone();
            std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(800)); let _ = webview.eval(RECOVER_BLANK_PAGE); });
        })
        .on_window_event(|window, event| { if matches!(event, tauri::WindowEvent::Destroyed) { terminal::close_all(&window.state::<terminal::Terminals>()); agent::stop_all(&window.state::<agent::Runs>()); } })
        .run(tauri::generate_context!()).expect("No se pudo iniciar Lumen");
}

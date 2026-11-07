use crate::workspace::Result;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{collections::HashMap, io::{Read, Write}, path::Path, sync::{Arc, Mutex}, sync::atomic::{AtomicU32, Ordering}};
use tauri::ipc::Channel;

pub struct Session { master: Box<dyn MasterPty + Send>, writer: Box<dyn Write + Send>, killer: Box<dyn ChildKiller + Send + Sync> }
#[derive(Default, Clone)]
pub struct Terminals(pub Arc<Mutex<HashMap<u32, Session>>>);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent { Data { data: Vec<u8> }, Exit { code: u32 } }

pub fn start(root: &Path, terminals: &Terminals, channel: Channel<TerminalEvent>, shell: Option<String>) -> Result<u32> {
    let mut sessions = terminals.0.lock().map_err(|e| e.to_string())?;
    if sessions.len() >= 8 { return Err("Máximo de 8 terminales simultáneas".into()); }
    let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    #[cfg(windows)] let default = "powershell.exe -NoLogo".to_owned();
    #[cfg(not(windows))] let default = std::env::var("SHELL").unwrap_or("/bin/sh".into());
    let line = shell.filter(|s| !s.trim().is_empty()).unwrap_or(default);
    let mut parts = line.split_whitespace();
    let mut command = CommandBuilder::new(parts.next().ok_or("Consola inválida")?);
    command.args(parts);
    command.cwd(crate::workspace::display_path(root)); command.env("TERM", "xterm-256color"); command.env("COLORTERM", "truecolor");
    let mut child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    sessions.insert(id, Session { master: pair.master, writer, killer: child.clone_killer() });
    drop(pair.slave); drop(sessions);
    let output_channel = channel.clone();
    std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        loop { match reader.read(&mut bytes) {
            Ok(0) | Err(_) => break,
            Ok(count) => if output_channel.send(TerminalEvent::Data { data: bytes[..count].to_vec() }).is_err() { break; },
        } }
    });
    let sessions = terminals.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        if let Ok(mut sessions) = sessions.0.lock() { sessions.remove(&id); }
        let _ = channel.send(TerminalEvent::Exit { code });
    });
    Ok(id)
}

pub fn write(terminals: &Terminals, id: u32, data: &str) -> Result<()> {
    if data.len() > 1024 * 1024 { return Err("Entrada de terminal demasiado grande".into()); }
    let mut sessions = terminals.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("La terminal ha terminado")?;
    session.writer.write_all(data.as_bytes()).and_then(|_| session.writer.flush()).map_err(|e| e.to_string())
}
pub fn resize(terminals: &Terminals, id: u32, rows: u16, cols: u16) -> Result<()> {
    let sessions = terminals.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("La terminal ha terminado")?;
    session.master.resize(PtySize { rows: rows.clamp(1,500), cols: cols.clamp(1,1000), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}
pub fn close(terminals: &Terminals, id: u32) -> Result<()> {
    if let Some(mut session) = terminals.0.lock().map_err(|e| e.to_string())?.remove(&id) { session.killer.kill().map_err(|e| e.to_string())?; }
    Ok(())
}
pub fn close_all(terminals: &Terminals) {
    if let Ok(mut sessions) = terminals.0.lock() { for (_, mut session) in sessions.drain() { let _ = session.killer.kill(); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_real_pty_accepts_input_and_exits() {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        #[cfg(windows)] let mut command = { let mut c = CommandBuilder::new("powershell.exe"); c.args(["-NoLogo", "-NoProfile", "-Command", "Write-Output lumen-pty-ok"]); c };
        #[cfg(not(windows))] let mut command = { let mut c = CommandBuilder::new("sh"); c.args(["-c", "printf lumen-pty-ok"]); c };
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        drop(pair.slave);
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut output = String::new(); let mut reader = reader; let mut bytes = [0; 4096];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 { break; }
                output.push_str(&String::from_utf8_lossy(&bytes[..count]));
                if output.contains("\u{1b}[6n") { let _ = writer.write_all(b"\x1b[1;1R"); }
                if output.contains("lumen-pty-ok") { break; }
            }
            let _ = sender.send(output);
        });
        let output = receiver.recv_timeout(std::time::Duration::from_secs(15));
        let _ = child.kill(); let _ = child.wait();
        assert!(output.unwrap().contains("lumen-pty-ok"));
    }
}

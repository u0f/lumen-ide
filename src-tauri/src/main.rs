#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ssh runs this same program as SSH_ASKPASS to read the password of a remote folder.
    if let Ok(password) = std::env::var("LUMEN_ASKPASS") { println!("{password}"); return; }
    lumen_lib::run();
}

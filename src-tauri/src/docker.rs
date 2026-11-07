use crate::{remote::Remote, workspace::Result};
use serde::Serialize;
use std::process::Command;

fn docker(host: Option<&Remote>, args: &[&str]) -> Result<std::process::Output> {
    // With a remote folder open, containers are the ones on that machine.
    if let Some(remote) = host {
        let output = remote.run(&[&["docker"], args].concat())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()); }
        return Ok(output);
    }
    let mut command = Command::new("docker");
    command.args(args);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let output = command.output().map_err(|e| format!("No se puede ejecutar Docker. Instálalo y añádelo al PATH: {e}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()); }
    Ok(output)
}

/// Container IDs and names only use these characters; anything else could be read as a flag.
fn valid(id: &str) -> Result<&str> {
    if id.is_empty() || id.starts_with('-') || !id.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) { return Err("Contenedor inválido".into()); }
    Ok(id)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Container { pub id: String, pub name: String, pub image: String, pub state: String, pub status: String, pub ports: String }

pub fn parse(data: &str) -> Vec<Container> {
    data.lines().filter_map(|line| {
        let mut f = line.split('\t').map(str::to_owned);
        Some(Container { id: f.next()?, name: f.next()?, image: f.next()?, state: f.next()?, status: f.next()?, ports: f.next().unwrap_or_default() })
    }).collect()
}

pub fn list(host: Option<&Remote>) -> Result<Vec<Container>> {
    let output = docker(host, &["ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"])?;
    Ok(parse(&String::from_utf8_lossy(&output.stdout)))
}

pub fn action(host: Option<&Remote>, action: &str, id: &str) -> Result<()> {
    let args: &[&str] = match action { "start" | "stop" | "restart" | "pause" | "unpause" => &[action], "rm" => &["rm", "-f"], _ => return Err("Acción de Docker desconocida".into()) };
    docker(host, &[args, &[valid(id)?]].concat()).map(|_| ())
}

pub fn logs(host: Option<&Remote>, id: &str) -> Result<String> {
    // Containers write to both streams; the CLI forwards each one as is.
    let output = docker(host, &["logs", "--tail", "500", "--timestamps", valid(id)?])?;
    Ok(format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_rows_and_rejects_flags() {
        let rows = parse("abc\tweb\tnginx\trunning\tUp 2 hours\t0.0.0.0:80->80/tcp\ndef\tdb\tpostgres\texited\tExited (0)\t\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].ports, "0.0.0.0:80->80/tcp");
        assert_eq!(rows[1].state, "exited");
        assert!(valid("--help").is_err() && valid("a b").is_err() && valid("my_app-1.2").is_ok());
    }
}

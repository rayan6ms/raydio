//! Discloud's Rust entry point; replace this process with the native bot.
use std::{
    os::unix::{fs::PermissionsExt, process::CommandExt},
    process::Command,
};

fn main() -> std::io::Result<()> {
    let binary = std::env::current_dir()?.join("bin/raydio");
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))?;
    Err(Command::new(binary)
        .arg("--testbot")
        .env("MALLOC_ARENA_MAX", "2")
        .env("RAYDIO_WORKER_THREADS", "2")
        .exec())
}

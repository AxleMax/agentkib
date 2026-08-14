use std::{env, process::Command};

fn main() {
    let compiler = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join("Bin").join("makensis.exe")))
        .expect("failed to resolve the NSIS compiler path");
    let status = Command::new(compiler)
        .args(env::args_os().skip(1))
        .status()
        .expect("failed to start the NSIS compiler");
    std::process::exit(status.code().unwrap_or(1));
}

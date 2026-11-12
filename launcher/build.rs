//! Gives the launcher the app's icon when the Windows SDK resource compiler
//! (rc.exe) can be found. Best effort: without it the exe gets the default
//! icon and the build goes on.

use std::{env, fs, path::PathBuf, process::Command};

fn find_rc() -> Option<PathBuf> {
    let kits = PathBuf::from(r"C:\Program Files (x86)\Windows Kits\10\bin");
    let mut versions: Vec<PathBuf> = fs::read_dir(&kits)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.join("x64").join("rc.exe").is_file())
        .collect();
    versions.sort();
    versions.pop().map(|path| path.join("x64").join("rc.exe"))
}

fn main() {
    let icon = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("..")
        .join("build")
        .join("icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    let Some(rc) = find_rc() else {
        println!("cargo:warning=rc.exe not found; the launcher keeps the default icon");
        return;
    };
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let script = out.join("launcher.rc");
    let res = out.join("launcher.res");
    let icon_path = icon.canonicalize().unwrap_or(icon).display().to_string();
    let icon_path = icon_path.trim_start_matches(r"\\?\").replace('\\', "\\\\");
    fs::write(&script, format!("1 ICON \"{icon_path}\"\n")).unwrap();
    let ok = Command::new(rc)
        .args(["/nologo", "/fo"])
        .arg(&res)
        .arg(&script)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if ok {
        println!("cargo:rustc-link-arg-bins={}", res.display());
    } else {
        println!("cargo:warning=rc.exe failed; the launcher keeps the default icon");
    }
}

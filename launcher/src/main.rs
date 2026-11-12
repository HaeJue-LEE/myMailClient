//! Mail Client launcher: a single exe that carries the app as a zip.
//!
//! The first run (and the first run after an update) unpacks the app into a
//! `Mail Client` folder next to this exe, showing a small "installing"
//! window; later runs just start the unpacked app, so they are as fast as
//! starting it directly. Nothing is written outside that folder (the app
//! itself keeps its data in %APPDATA%), and no folder this launcher did not
//! create is ever replaced.
//!
//! The exe ends with a trailer written by scripts/dist-public.mjs:
//! `[zip][package id][id length: u32][zip length: u64]["MCPKG001"]`, the id
//! being a hash of the zip, so a rebuilt package is unpacked again.

#![windows_subsystem = "windows"]

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const MAGIC: &[u8; 8] = b"MCPKG001";
const APP_DIR: &str = "Mail Client";
const APP_EXE: &str = "Mail Client.exe";
/// Written last into an unpacked folder: the package id. Its presence is
/// what marks a folder as this launcher's to replace.
const MARKER: &str = ".mailclient-package";
const PAYLOAD: &str = "payload.zip";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// --- Win32: a message box and a borderless "installing" popup ---------------

type Hwnd = *mut core::ffi::c_void;

#[repr(C)]
struct Msg {
    hwnd: Hwnd,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
    private: u32,
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: Hwnd, text: *const u16, caption: *const u16, kind: u32) -> i32;
    fn CreateWindowExW(
        ex_style: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: Hwnd,
        menu: Hwnd,
        instance: Hwnd,
        param: *mut core::ffi::c_void,
    ) -> Hwnd;
    fn DestroyWindow(hwnd: Hwnd) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn PeekMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(msg: *const Msg) -> i32;
    fn DispatchMessageW(msg: *const Msg) -> isize;
    fn SendMessageW(hwnd: Hwnd, msg: u32, w_param: usize, l_param: isize) -> isize;
    fn SetProcessDPIAware() -> i32;
    fn GetDpiForSystem() -> u32;
    fn GetDC(hwnd: Hwnd) -> *mut core::ffi::c_void;
    fn ReleaseDC(hwnd: Hwnd, dc: *mut core::ffi::c_void) -> i32;
    fn DrawTextW(dc: *mut core::ffi::c_void, text: *const u16, len: i32, rect: *mut Rect, format: u32) -> i32;
    fn SetWindowPos(hwnd: Hwnd, after: Hwnd, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn GetStockObject(index: i32) -> *mut core::ffi::c_void;
    fn SelectObject(dc: *mut core::ffi::c_void, object: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    fn DeleteObject(object: *mut core::ffi::c_void) -> i32;
    #[allow(clippy::too_many_arguments)]
    fn CreateFontW(
        height: i32,
        width: i32,
        escapement: i32,
        orientation: i32,
        weight: i32,
        italic: u32,
        underline: u32,
        strike_out: u32,
        charset: u32,
        out_precision: u32,
        clip_precision: u32,
        quality: u32,
        pitch_and_family: u32,
        face: *const u16,
    ) -> *mut core::ffi::c_void;
}

#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

fn message(text: &str, error: bool) {
    let (text, caption) = (wide(text), wide("Mail Client"));
    // MB_ICONERROR or MB_ICONINFORMATION.
    let kind = if error { 0x10 } else { 0x40 };
    unsafe { MessageBoxW(core::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), kind) };
}

const WS_POPUP: u32 = 0x8000_0000;
const WS_CHILD: u32 = 0x4000_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_BORDER: u32 = 0x0080_0000;
const SS_CENTER: u32 = 0x1;
const WS_EX_TOPMOST: u32 = 0x8;
const WS_EX_TOOLWINDOW: u32 = 0x80;
const WM_SETFONT: u32 = 0x30;
const DT_CENTER: u32 = 0x1;
const DT_WORDBREAK: u32 = 0x10;
const DT_CALCRECT: u32 = 0x400;
const DT_NOPREFIX: u32 = 0x800;

unsafe fn static_window(ex_style: u32, style: u32, text: &[u16], rect: (i32, i32, i32, i32), parent: Hwnd) -> Hwnd {
    CreateWindowExW(
        ex_style,
        wide("STATIC").as_ptr(),
        text.as_ptr(),
        style,
        rect.0,
        rect.1,
        rect.2,
        rect.3,
        parent,
        core::ptr::null_mut(),
        core::ptr::null_mut(),
        core::ptr::null_mut(),
    )
}

/// Shows the "installing" popup: a bordered frame with the text centred in
/// it both ways. A STATIC control centres several lines only across, so the
/// text sits in a child control as tall as the text, placed mid-height.
/// Returns the frame and the font to free.
unsafe fn show_progress_popup() -> (Hwnd, *mut core::ffi::c_void) {
    let scale = |value: i32| value * GetDpiForSystem().max(96) as i32 / 96;
    let (width, height, padding) = (scale(400), scale(110), scale(20));
    let text = wide("Mail Client를 이 폴더에 준비하고 있습니다…\n처음 한 번만 걸리며, 잠시면 끝납니다.");
    let x = (GetSystemMetrics(0) - width) / 2;
    let y = (GetSystemMetrics(1) - height) / 2;
    let frame = static_window(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        WS_POPUP | WS_VISIBLE | WS_BORDER,
        &wide(""),
        (x, y, width, height),
        core::ptr::null_mut(),
    );
    if frame.is_null() {
        return (frame, core::ptr::null_mut());
    }
    let inner = width - 2 * padding;
    let label = static_window(0, WS_CHILD | WS_VISIBLE | SS_CENTER, &text, (padding, 0, inner, 0), frame);
    // Malgun Gothic (the Korean UI font), else the stock GUI font.
    let mut font = CreateFontW(-scale(15), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, wide("Malgun Gothic").as_ptr());
    if font.is_null() {
        font = GetStockObject(17);
    }
    SendMessageW(label, WM_SETFONT, font as usize, 0);

    // The text's height in that font, at the label's width.
    let dc = GetDC(label);
    let previous = SelectObject(dc, font);
    let mut rect = Rect { left: 0, top: 0, right: inner, bottom: 0 };
    DrawTextW(dc, text.as_ptr(), -1, &mut rect, DT_CALCRECT | DT_WORDBREAK | DT_CENTER | DT_NOPREFIX);
    SelectObject(dc, previous);
    ReleaseDC(label, dc);
    let text_height = rect.bottom - rect.top;
    // SWP_NOZORDER | SWP_NOACTIVATE
    SetWindowPos(label, core::ptr::null_mut(), padding, (height - text_height) / 2, inner, text_height, 0x4 | 0x10);
    (frame, font)
}

/// Runs `work` on another thread while a small popup says it is installing.
fn with_progress_window<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let (hwnd, font) = unsafe { show_progress_popup() };

    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(work());
    });
    loop {
        if let Ok(result) = done_rx.recv_timeout(Duration::from_millis(30)) {
            unsafe {
                if !hwnd.is_null() {
                    DestroyWindow(hwnd);
                }
                // Stock objects ignore DeleteObject, so the fallback is safe too.
                if !font.is_null() {
                    DeleteObject(font);
                }
            }
            return result;
        }
        // Keep the popup painted while the work runs.
        unsafe {
            let mut msg: Msg = core::mem::zeroed();
            while PeekMessageW(&mut msg, core::ptr::null_mut(), 0, 0, 1) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

// --- the package --------------------------------------------------------------

struct Package {
    exe: PathBuf,
    id: String,
    zip_start: u64,
    zip_len: u64,
}

fn read_package(exe: PathBuf) -> Result<Package, String> {
    let broken = "이 실행 파일에 앱이 들어 있지 않거나 손상되었습니다. 다시 받아 주세요.";
    let mut file = File::open(&exe).map_err(|e| format!("실행 파일을 열지 못했습니다: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len < 20 {
        return Err(broken.into());
    }
    let mut tail = [0u8; 20];
    file.seek(SeekFrom::End(-20)).map_err(|e| e.to_string())?;
    file.read_exact(&mut tail).map_err(|e| e.to_string())?;
    if &tail[12..20] != MAGIC {
        return Err(broken.into());
    }
    let id_len = u32::from_le_bytes(tail[0..4].try_into().unwrap()) as u64;
    let zip_len = u64::from_le_bytes(tail[4..12].try_into().unwrap());
    if id_len > 256 || id_len + zip_len + 20 > len {
        return Err(broken.into());
    }
    let mut id = vec![0u8; id_len as usize];
    file.seek(SeekFrom::Start(len - 20 - id_len)).map_err(|e| e.to_string())?;
    file.read_exact(&mut id).map_err(|e| e.to_string())?;
    let id = String::from_utf8(id).map_err(|_| broken.to_string())?;
    Ok(Package { zip_start: len - 20 - id_len - zip_len, zip_len, id, exe })
}

fn installed_id(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(MARKER)).ok().map(|id| id.trim().to_string())
}

const NOT_WRITABLE: &str =
    "이 폴더에는 파일을 만들 수 없습니다. 실행 파일을 문서나 바탕 화면처럼 쓰기가 가능한 폴더로 옮겨 실행해 주세요.";

/// The lock against a second launch unpacking at the same time: a file held
/// open without sharing. Windows lets go of it when the process ends, even
/// by a crash or a kill, so a leftover never blocks the next run.
fn take_lock(base: &Path) -> Result<File, String> {
    match fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .share_mode(0)
        .open(base.join(format!("{APP_DIR}.unpacking.lock")))
    {
        Ok(lock) => Ok(lock),
        // ERROR_SHARING_VIOLATION: another launcher holds it.
        Err(e) if e.raw_os_error() == Some(32) => {
            Err("이미 다른 창에서 Mail Client를 준비하고 있습니다. 잠시 후 다시 실행해 주세요.".into())
        }
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => Err(NOT_WRITABLE.into()),
        Err(e) => Err(format!("준비할 폴더를 만들지 못했습니다: {e}")),
    }
}

/// A fresh unpack folder; whatever an interrupted run left there goes first.
fn fresh_unpack_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| format!("이전에 풀다 만 파일을 지우지 못했습니다: {e}"))?;
    }
    fs::create_dir(dir).map_err(|e| match e.kind() {
        io::ErrorKind::PermissionDenied => NOT_WRITABLE.to_string(),
        _ => format!("준비할 폴더를 만들지 못했습니다: {e}"),
    })
}

/// Unpacks the zip into `unpack` with Windows' own tar. tar runs inside the
/// folder on an ASCII file name, so no (possibly Korean) path goes through
/// its arguments.
fn unpack(package: &Package, unpack: &Path) -> Result<(), String> {
    let payload = unpack.join(PAYLOAD);
    {
        let mut source = File::open(&package.exe).map_err(|e| e.to_string())?;
        source.seek(SeekFrom::Start(package.zip_start)).map_err(|e| e.to_string())?;
        let mut target = File::create(&payload).map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))?;
        let copied = io::copy(&mut source.take(package.zip_len), &mut target)
            .map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))?;
        if copied != package.zip_len {
            return Err("실행 파일이 잘려 있습니다. 다시 받아 주세요.".into());
        }
    }
    let windows = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let tar = Path::new(&windows).join("System32").join("tar.exe");
    let status = Command::new(&tar)
        .args(["-xf", PAYLOAD])
        .current_dir(unpack)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Windows 압축 해제 도구(tar.exe)를 실행하지 못했습니다: {e}"))?;
    let _ = fs::remove_file(&payload);
    if !status.success() {
        return Err("압축을 풀지 못했습니다. 디스크 공간을 확인하고 다시 실행해 주세요.".into());
    }
    if !unpack.join(APP_EXE).is_file() {
        return Err("압축을 풀었지만 앱 실행 파일이 없습니다. 다시 받아 주세요.".into());
    }
    // Last: only a complete unpack carries the marker.
    fs::write(unpack.join(MARKER), &package.id).map_err(|e| e.to_string())
}

/// Puts a finished unpack in place of the app folder, replacing an older one
/// only when this launcher made it.
fn swap_in(base: &Path, unpacked: &Path) -> Result<(), String> {
    let app_dir = base.join(APP_DIR);
    if app_dir.exists() {
        if installed_id(&app_dir).is_none() {
            return Err(format!(
                "이 폴더에 이미 '{APP_DIR}' 폴더가 있는데 이 실행 파일이 만든 것이 아닙니다. 실행 파일을 빈 폴더로 옮겨 실행해 주세요."
            ));
        }
        let old = base.join(format!("{APP_DIR}.old-{}", std::process::id()));
        if fs::rename(&app_dir, &old).is_err() {
            return Err("Mail Client가 실행 중이라 새 버전으로 바꾸지 못했습니다. 열려 있는 Mail Client 창을 모두 닫고 다시 실행해 주세요.".into());
        }
        let _ = fs::remove_dir_all(&old);
    }
    fs::rename(unpacked, &app_dir).map_err(|e| format!("앱 폴더를 만들지 못했습니다: {e}"))
}

fn run() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let base = exe.parent().ok_or("실행 파일의 폴더를 알 수 없습니다.")?.to_path_buf();
    let package = read_package(exe.clone())?;
    let app_dir = base.join(APP_DIR);
    // Not an update: the app is set up here for the first time.
    let first_install = !app_dir.exists();

    let current = installed_id(&app_dir).as_deref() == Some(package.id.as_str())
        && app_dir.join(APP_EXE).is_file();
    if !current {
        let lock = take_lock(&base)?;
        let unpack_dir = base.join(format!("{APP_DIR}.unpacking"));
        fresh_unpack_dir(&unpack_dir)?;
        let work_dir = unpack_dir.clone();
        let result = with_progress_window(move || unpack(&package, &work_dir));
        let result = result.and_then(|()| swap_in(&base, &unpack_dir));
        if result.is_err() {
            let _ = fs::remove_dir_all(&unpack_dir);
        }
        drop(lock);
        let _ = fs::remove_file(base.join(format!("{APP_DIR}.unpacking.lock")));
        result?;
    }

    // Options are passed on, e.g. --user-data-dir to try it with a fresh profile.
    let mut app = Command::new(app_dir.join(APP_EXE));
    app.args(std::env::args_os().skip(1))
        .current_dir(&app_dir)
        // What shortcuts should point at: this exe, which also applies updates.
        .env("MAIL_CLIENT_LAUNCHER", &exe)
        .env_remove("MAIL_CLIENT_FIRST_INSTALL");
    if first_install && !current {
        // The app then offers to make a desktop shortcut, once.
        app.env("MAIL_CLIENT_FIRST_INSTALL", "1");
    }
    app.spawn()
        .map(|_| ())
        .map_err(|e| format!("Mail Client를 실행하지 못했습니다: {e}"))
}

fn main() {
    // Real pixels on scaled displays: crisp text instead of a stretched bitmap.
    unsafe { SetProcessDPIAware() };
    if let Err(error) = run() {
        message(&format!("Mail Client를 시작하지 못했습니다.\n\n{error}"), true);
    }
}

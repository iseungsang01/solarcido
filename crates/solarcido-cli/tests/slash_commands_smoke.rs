use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be monotonic enough for tests")
        .as_millis();
    std::env::temp_dir().join(format!("{prefix}-{stamp}-{}", std::process::id()))
}

fn run_repl_script(input: &str) -> (std::process::ExitStatus, String, String) {
    let root = unique_temp_dir("solarcido-slash-test");
    let home = root.join("home");
    let workspace = root.join("workspace");

    fs::create_dir_all(&home).expect("home directory should exist");
    fs::create_dir_all(&workspace).expect("workspace should exist");

    let mut child = Command::new(env!("CARGO_BIN_EXE_solarcido"))
        .current_dir(&workspace)
        .env("SOLARCIDO_HOME", &home)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("UPSTAGE_API_KEY", "test-key")
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("solarcido should launch");

    {
        let stdin = child.stdin.as_mut().expect("stdin should be piped");
        stdin
            .write_all(input.as_bytes())
            .expect("script should write to stdin");
    }

    let output = child.wait_with_output().expect("child should finish");

    let _ = fs::remove_dir_all(&root);

    (
        output.status,
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn repl_help_slash_command_renders_registry_help() {
    let (status, stdout, stderr) = run_repl_script("/help\n/quit\n");

    assert!(status.success(), "stderr: {stderr}");
    assert!(stdout.contains("Slash commands:"), "stdout: {stdout}");
    assert!(stdout.contains("/mcp"), "stdout: {stdout}");
    assert!(stdout.contains("/exit"), "stdout: {stdout}");
}

#[test]
fn repl_mcp_slash_command_lists_configured_servers() {
    let (status, stdout, stderr) = run_repl_script("/mcp\n/quit\n");

    assert!(status.success(), "stderr: {stderr}");
    assert!(stdout.contains("No MCP servers configured."), "stdout: {stdout}");
}

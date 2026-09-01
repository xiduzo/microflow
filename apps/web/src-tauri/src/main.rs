// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // `microflow --mcp <token>` is not the app: it is a stdio↔socket relay onto
  // the MCP server the *running* app hosts (`mcp.rs`), which is how an agent
  // CLI reaches Ask AI's flow tools. It must return before `run()` so the
  // single-instance plugin never sees a second copy.
  let mut args = std::env::args().skip(1);
  if let Some(token) = args.by_ref().find(|arg| arg == "--mcp").and(args.next()) {
    if let Err(error) = app_lib::mcp::relay(&token) {
      eprintln!("microflow --mcp: {error}. Is Microflow Studio running?");
      std::process::exit(1);
    }
    return;
  }
  app_lib::run();
}

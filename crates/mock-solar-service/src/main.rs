//! Mock Solar service binary. Binds an HTTP server that returns scripted
//! OpenAI-compatible responses for parity testing.
//!
//! Usage:
//!   cargo run -p mock-solar-service -- --bind 127.0.0.1:0
//!
//! Full HTTP server implementation deferred to Phase 8.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bind = args
        .windows(2)
        .find(|w| w[0] == "--bind")
        .map(|w| w[1].as_str())
        .unwrap_or("127.0.0.1:0");

    eprintln!("mock-solar-service: stub — full HTTP server deferred to Phase 8.");
    eprintln!("Would bind to: {bind}");
    eprintln!("Builtin scenarios:");
    for s in mock_solar_service::builtin_scenarios() {
        eprintln!("  - {}", s.name);
    }
}

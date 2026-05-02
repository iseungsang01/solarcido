//! Mock Solar service binary.
//!
//! Usage:
//!   cargo run -p mock-solar-service -- --bind 127.0.0.1:0

#[tokio::main(flavor = "multi_thread")]
async fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let bind = args
        .windows(2)
        .find(|w| w[0] == "--bind")
        .map(|w| w[1].as_str())
        .unwrap_or("127.0.0.1:0");

    let service = mock_solar_service::MockSolarService::spawn_on(bind).await?;
    eprintln!("mock-solar-service: listening on {}", service.base_url());
    eprintln!("Builtin scenarios:");
    for scenario in mock_solar_service::builtin_scenarios() {
        eprintln!("  - {}", scenario.name);
    }
    eprintln!("Press Ctrl+C to stop.");

    let _ = tokio::signal::ctrl_c().await;
    drop(service);
    Ok(())
}

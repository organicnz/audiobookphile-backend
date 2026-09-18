use anyhow::{Context, Result};
use colored::*;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::Path;

pub async fn run_backup(output_dir: &Path) -> Result<()> {
    println!("{}", "💾 Running Database Table Snapshot Export...".bold().cyan());

    let supabase_url = env::var("SUPABASE_URL")
        .or_else(|_| env::var("NEXT_PUBLIC_SUPABASE_URL"))
        .unwrap_or_else(|_| "https://kfidobawnbziftwxavyl.supabase.co".to_string());

    let service_key = env::var("SUPABASE_SERVICE_ROLE_KEY")
        .context("SUPABASE_SERVICE_ROLE_KEY is required for full table snapshots")?;

    fs::create_dir_all(output_dir)?;

    let tables = [
        "library_items",
        "authors",
        "book_authors",
        "series",
        "book_series",
        "profiles",
        "server_settings",
        "media_progress",
        "playback_sessions",
    ];

    let client = reqwest::Client::new();

    for table in tables {
        let url = format!("{}/rest/v1/{}?select=*", supabase_url, table);
        let resp = client
            .get(&url)
            .header("apikey", &service_key)
            .header("Authorization", format!("Bearer {}", service_key))
            .send()
            .await?;

        if resp.status().is_success() {
            let data: Value = resp.json().await?;
            let count = data.as_array().map(|a| a.len()).unwrap_or(0);
            let file_path = output_dir.join(format!("{}.json", table));
            fs::write(&file_path, serde_json::to_string_pretty(&data)?)?;
            println!("  {} {} ({} rows saved to {})", "✔".green(), table.bold(), count, file_path.display());
        } else {
            eprintln!("  {} Failed to export table {}: HTTP {}", "✖".red(), table, resp.status());
        }
    }

    println!("{}", "✅ Database snapshot completed successfully!".bold().green());
    Ok(())
}

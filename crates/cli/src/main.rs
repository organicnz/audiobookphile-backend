mod audit;
mod backup;
mod storage;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::exit;

#[derive(Parser)]
#[command(name = "audiobookphile")]
#[command(author = "Audiobookphile Engineering")]
#[command(version = "1.0.0")]
#[command(about = "Unified native CLI toolkit for Audiobookphile monorepo", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Deep multi-threaded cybersecurity & repository quality audit
    Audit {
        /// Primary root directory to scan (defaults to current directory)
        #[arg(short, long, default_value = ".")]
        path: PathBuf,

        /// Strict mode: fail on any warnings
        #[arg(short, long)]
        strict: bool,

        /// Skip audio media bloat scanner
        #[arg(long)]
        no_bloat: bool,
    },

    /// Supabase storage quota & capacity verification
    StorageHealth,

    /// Full database snapshot backup
    DbBackup {
        /// Target export directory
        #[arg(short, long, default_value = "./backup_export")]
        output: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Audit { path, strict, no_bloat } => {
            let options = audit::AuditOptions {
                path,
                strict,
                scan_bloat: !no_bloat,
            };
            let passed = audit::run_audit(options)?;
            if !passed {
                exit(1);
            }
        }
        Commands::StorageHealth => {
            let ok = storage::check_storage_health().await?;
            if !ok {
                exit(1);
            }
        }
        Commands::DbBackup { output } => {
            backup::run_backup(&output).await?;
        }
    }

    Ok(())
}

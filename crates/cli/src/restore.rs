use anyhow::{Context, Result};
use colored::*;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::Path;

pub async fn run_restore(project_ref: &str, backup_dir: &Path) -> Result<()> {
    println!("{}", format!("🚀 Starting Database Restoration to project: {}", project_ref).bold().cyan());

    let token = env::var("SUPABASE_ACCESS_TOKEN")
        .context("SUPABASE_ACCESS_TOKEN is required for project restoration")?;

    let client = reqwest::Client::new();
    let query_url = format!("https://api.supabase.com/v1/projects/{}/database/query", project_ref);

    let execute_sql = |sql: &str| {
        let client = client.clone();
        let token = token.clone();
        let query_url = query_url.clone();
        let sql = sql.to_string();
        async move {
            let resp = client
                .post(&query_url)
                .bearer_auth(&token)
                .json(&json!({ "query": sql }))
                .send()
                .await?;
            if !resp.status().is_success() {
                let err_text = resp.text().await.unwrap_or_default();
                anyhow::bail!("SQL query execution failed: {}", err_text);
            }
            Ok(())
        }
    };

    // Step 1: Extensions
    let ext_path = backup_dir.join("01_extensions.sql");
    if ext_path.exists() {
        println!("  [1/6] Applying Extensions from {}...", ext_path.display());
        let sql = fs::read_to_string(&ext_path)?;
        execute_sql(&sql).await?;
        println!("  {} Extensions applied.", "✔".green());
    }

    // Step 2: DDL Schemas
    let schema_path = backup_dir.join("02_schema.sql");
    if schema_path.exists() {
        println!("  [2/6] Applying Table DDL Schemas from {}...", schema_path.display());
        let sql = fs::read_to_string(&schema_path)?;
        execute_sql(&sql).await?;
        println!("  {} Tables created.", "✔".green());
    }

    // Step 3: Functions, Triggers, RLS
    for f in &["05_functions.sql", "04_indexes.sql", "03_foreign_keys.sql", "06_triggers.sql", "07_rls_policies.sql"] {
        let p = backup_dir.join(f);
        if p.exists() {
            println!("  Applying {}...", f);
            let sql = fs::read_to_string(&p)?;
            execute_sql(&sql).await?;
        }
    }
    println!("  {} Functions, Indexes, Triggers, and RLS applied.", "✔".green());

    // Step 4: Auth Users
    let auth_users_path = backup_dir.join("08_auth_users.json");
    if auth_users_path.exists() {
        println!("  [4/6] Restoring Auth Users from {}...", auth_users_path.display());
        let users: Vec<Value> = serde_json::from_str(&fs::read_to_string(&auth_users_path)?)?;
        for user in &users {
            if let Some(obj) = user.as_object() {
                let mut cols = Vec::new();
                let mut vals = Vec::new();
                for (k, v) in obj {
                    if k == "is_anonymous" {
                        continue;
                    }
                    cols.push(format!("\"{}\"", k));
                    match v {
                        Value::Null => vals.push("NULL".to_string()),
                        Value::Bool(b) => vals.push(if *b { "TRUE" } else { "FALSE" }.to_string()),
                        Value::Number(n) => vals.push(n.to_string()),
                        Value::String(s) => vals.push(format!("'{}'", s.replace('\'', "''"))),
                        _ => vals.push(format!("'{}'::jsonb", serde_json::to_string(v)?.replace('\'', "''"))),
                    }
                }
                let sql = format!("INSERT INTO auth.users ({}) VALUES ({}) ON CONFLICT (id) DO NOTHING;", cols.join(", "), vals.join(", "));
                let _ = execute_sql(&sql).await;
            }
        }
        println!("  {} Auth users restored ({} users processed).", "✔".green(), users.len());
    }

    // Step 5: Public Data
    let data_path = backup_dir.join("09_restore_data.sql");
    if data_path.exists() {
        println!("  [5/6] Restoring Public Table Data from {}...", data_path.display());
        let restore_sql = fs::read_to_string(&data_path)?;
        let statements: Vec<&str> = restore_sql.split(";\n\n").map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        execute_sql("SET session_replication_role = 'replica';").await?;
        for (idx, stmt) in statements.iter().enumerate() {
            let mut s = stmt.to_string();
            if !s.ends_with(';') {
                s.push(';');
            }
            execute_sql(&s).await?;
            if (idx + 1) % 10 == 0 || idx + 1 == statements.len() {
                println!("    Executed batch {}/{}...", idx + 1, statements.len());
            }
        }
        execute_sql("SET session_replication_role = 'origin';").await?;
        println!("  {} Public table data restored successfully.", "✔".green());
    }

    // Step 6: Storage Buckets
    let buckets_path = backup_dir.join("10_storage_buckets.json");
    if buckets_path.exists() {
        println!("  [6/6] Restoring Storage Buckets from {}...", buckets_path.display());
        let buckets: Vec<Value> = serde_json::from_str(&fs::read_to_string(&buckets_path)?)?;
        for b in &buckets {
            if let (Some(id), Some(name), Some(public)) = (b.get("id").and_then(|v| v.as_str()), b.get("name").and_then(|v| v.as_str()), b.get("public").and_then(|v| v.as_bool())) {
                let sql = format!(
                    "INSERT INTO storage.buckets (id, name, public) VALUES ('{}', '{}', {}) ON CONFLICT (id) DO NOTHING;",
                    id, name, if public { "TRUE" } else { "FALSE" }
                );
                let _ = execute_sql(&sql).await;
            }
        }
        println!("  {} Storage buckets restored.", "✔".green());
    }

    println!("{}", format!("🎉 Complete database restoration finished on {}!", project_ref).bold().green());
    Ok(())
}

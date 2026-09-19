use anyhow::Result;
use colored::*;
use ignore::WalkBuilder;
use regex::Regex;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

pub struct AuditOptions {
    pub path: PathBuf,
    pub strict: bool,
    pub scan_bloat: bool,
}

pub struct AuditViolation {
    pub file: PathBuf,
    pub line: usize,
    pub rule: String,
    pub message: String,
}

pub fn run_audit(options: AuditOptions) -> Result<bool> {
    let start_time = Instant::now();
    println!("{}", "🔍 Running Audiobookphile Monorepo Deep Security & Quality Audit...".bold().cyan());
    if options.strict {
        println!("  {}", "Mode: Strict verification enabled".dimmed());
    }

    let secret_regex = Regex::new(
        r"(?i)(sbp_[a-zA-Z0-9]{20,}|eyJhbGci[a-zA-Z0-9_\-]{20,}|SUPABASE_SERVICE_ROLE_KEY=[a-zA-Z0-9]|BEGIN (RSA|EC|OPENSSH|PGP)? PRIVATE KEY|sk_live_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16})"
    )?;

    let conflict_regex = Regex::new(r"^(<<<<<<<|=======|>>>>>>>)")?;

    let localhost_regex = Regex::new(r"http://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?")?;

    let insecure_random_regex = Regex::new(r"(Double\.random|Math\.random\()")?;

    let unpinned_branch_regex = Regex::new(r#"branch:\s*["'][^"']+["']"#)?;

    let sql_injection_regex = Regex::new(r"(\.query\([^)]*\+|from\([^)]*\+)")?;

    let sql_drop_table_regex = Regex::new(r"(?i)\bDROP\s+TABLE\b")?;

    let sql_truncate_regex = Regex::new(r"(?i)\bTRUNCATE\b")?;

    let dangerously_html_regex = Regex::new(r"dangerouslySetInnerHTML")?;

    let deprecated_deno_std_regex = Regex::new(r"https://deno\.land/std@0\.[0-9]{2}\.")?;

    let bloat_extensions = ["m4b", "mp3", "flac", "aac", "wav", "ogg", "zip", "tar.gz", "iso"];

    let mut violations: Vec<AuditViolation> = Vec::new();
    let mut files_scanned = 0;

    let walker = WalkBuilder::new(&options.path)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git" | ".build" | "node_modules" | "DerivedData" | ".next" | ".vercel" | "target" | ".trunk" | ".snapshots" | ".temp"
            )
        })
        .build();

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        files_scanned += 1;
        let path_str = path.to_string_lossy();

        // 1. Check bloat
        if options.scan_bloat {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                let ext_lower = ext.to_lowercase();
                if bloat_extensions.contains(&ext_lower.as_str()) {
                    violations.push(AuditViolation {
                        file: path.to_path_buf(),
                        line: 0,
                        rule: "REPO_BLOAT_GUARD".to_string(),
                        message: format!("Accidental audio media or large binary archive committed: {}", path_str),
                    });
                }
            }
        }

        // Skip binary files and known examples / markdown docs for secret inspection
        if path_str.ends_with(".png")
            || path_str.ends_with(".jpg")
            || path_str.ends_with(".jpeg")
            || path_str.ends_with(".webp")
            || path_str.ends_with(".ico")
            || path_str.ends_with(".xcresult")
            || path_str.ends_with(".log")
            || path_str.ends_with(".lock")
            || path_str.ends_with(".example")
            || path_str.ends_with(".md")
        {
            continue;
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue, // Binary file or invalid UTF-8
        };

        // 2. Secret Scan
        // Exclude audit tools / scripts defining the forbidden patterns themselves
        let is_audit_script = path_str.contains("crates/cli/src/audit.rs")
            || path_str.contains("scripts/security-audit.sh")
            || path_str.contains("scripts/pre-commit.sh")
            || path_str.contains(".env.example");

        if !is_audit_script {
            for (idx, line) in content.lines().enumerate() {
                if line.contains("your-") || line.contains("placeholder") || line.contains("EXAMPLE") {
                    continue;
                }
                if secret_regex.is_match(line) {
                    violations.push(AuditViolation {
                        file: path.to_path_buf(),
                        line: idx + 1,
                        rule: "LEAKED_CREDENTIAL".to_string(),
                        message: format!("Potential secret or private key pattern detected: {}", line.trim()),
                    });
                }
            }
        }

        // 3. Merge conflict marker check
        if !is_audit_script {
            for (idx, line) in content.lines().enumerate() {
                if conflict_regex.is_match(line) {
                    violations.push(AuditViolation {
                        file: path.to_path_buf(),
                        line: idx + 1,
                        rule: "MERGE_CONFLICT".to_string(),
                        message: format!("Unresolved git merge conflict marker: {}", line.trim()),
                    });
                }
            }
        }

        // 4. Hardcoded Localhost check (only in production sources, not tests or previews)
        let is_test_or_mock = path_str.contains("/tests/")
            || path_str.contains("/__tests__/")
            || path_str.contains("Tests/")
            || path_str.contains("Mock")
            || path_str.contains("Preview")
            || path_str.contains("/test_")
            || path_str.ends_with("_test.ts")
            || path_str.ends_with(".test.ts")
            || path_str.ends_with(".test.js")
            || path_str.ends_with(".spec.ts")
            || path_str.contains("k6/")
            || path_str.contains("scripts/monitor.sh")
            || path_str.contains("scripts/deploy.sh")
            || path_str.ends_with("supabase/config.toml")
            || path_str.contains("Dockerfile")
            || path_str.contains("Containerfile")
            || path_str.contains(".lighthouserc")
            || path_str.contains("playwright.config")
            || path_str.contains(".env")
            || is_audit_script;

        if !is_test_or_mock {
            for (idx, line) in content.lines().enumerate() {
                if localhost_regex.is_match(line) {
                    // Allow comment explanations, dev-only fallbacks, or local mock fallbacks
                    let trimmed = line.trim();
                    if !trimmed.starts_with("//")
                        && !trimmed.starts_with('#')
                        && !trimmed.contains("dev-only fallback")
                        && !trimmed.contains("NEXT_PUBLIC_SITE_URL")
                        && !trimmed.contains("functions/v1/api")
                    {
                        violations.push(AuditViolation {
                            file: path.to_path_buf(),
                            line: idx + 1,
                            rule: "HARDCODED_LOCALHOST".to_string(),
                            message: format!("Hardcoded localhost/dev URL in production code: {}", trimmed),
                        });
                    }
                }
            }
        }

        // 5. Dynamic Code Execution (eval / new Function)
        if !is_test_or_mock && (path_str.ends_with(".ts") || path_str.ends_with(".tsx") || path_str.ends_with(".js")) {
            for (idx, line) in content.lines().enumerate() {
                if line.contains("eval(") || line.contains("new Function(") {
                    violations.push(AuditViolation {
                        file: path.to_path_buf(),
                        line: idx + 1,
                        rule: "DYNAMIC_EXECUTION".to_string(),
                        message: format!("Dynamic code execution detected (eval / new Function): {}", line.trim()),
                    });
                }
            }
        }

        // 6. Unpinned Wildcard Package Dependency ("*")
        if path_str.ends_with("package.json") {
            for (idx, line) in content.lines().enumerate() {
                if line.contains(r#""*""#) {
                    violations.push(AuditViolation {
                        file: path.to_path_buf(),
                        line: idx + 1,
                        rule: "UNPINNED_WILDCARD_PACKAGE".to_string(),
                        message: format!("Unpinned wildcard package dependency '*' in package.json: {}", line.trim()),
                    });
                }
            }
        }

        // 5. Insecure Random Token Generation (Swift / TS security critical files)
        if !is_test_or_mock && (path_str.ends_with(".swift") || path_str.ends_with(".ts") || path_str.ends_with(".tsx")) {
            let is_known_visual = path_str.contains("GlassParticles")
                || path_str.contains("LibraryService")
                || path_str.contains("AudiobookphileAPI"); // AWS full-jitter backoff

            if !is_known_visual {
                for (idx, line) in content.lines().enumerate() {
                    if insecure_random_regex.is_match(line) {
                        let lower = line.to_lowercase();
                        if lower.contains("token") || lower.contains("secret") || lower.contains("auth") || lower.contains("key") || lower.contains("nonce") {
                            violations.push(AuditViolation {
                                file: path.to_path_buf(),
                                line: idx + 1,
                                rule: "INSECURE_RANDOM_GENERATOR".to_string(),
                                message: format!("Non-cryptographic random generator used for security token: {}", line.trim()),
                            });
                        }
                    }
                }
            }
        }

        // 6. SPM Unpinned Branch Dependencies
        if path_str.ends_with("Package.swift") {
            for (idx, line) in content.lines().enumerate() {
                if unpinned_branch_regex.is_match(line) {
                    violations.push(AuditViolation {
                        file: path.to_path_buf(),
                        line: idx + 1,
                        rule: "SPM_UNPINNED_BRANCH".to_string(),
                        message: format!("Unpinned git branch dependency in Package.swift: {}", line.trim()),
                    });
                }
            }
        }

        // 7. SQL Injection Risk Scanner (Raw String Concatenation in SQL)
        if !is_test_or_mock && !is_audit_script && (path_str.ends_with(".ts") || path_str.ends_with(".js")) {
            for (idx, line) in content.lines().enumerate() {
                if sql_injection_regex.is_match(line) {
                    violations.push(AuditViolation {
                        file: path.to_path_buf(),
                        line: idx + 1,
                        rule: "SQL_INJECTION_RISK".to_string(),
                        message: format!("Potential SQL injection or string concatenation in query: {}", line.trim()),
                    });
                }
            }
        }

        // 8. SQL Migration Safety Scanner (Destructive DROP TABLE or TRUNCATE)
        if path_str.ends_with(".sql") && (path_str.contains("/migrations/") || path_str.contains("/supabase/")) {
            let is_data_backup = path_str.contains("data_backup")
                || path_str.contains("backup_export")
                || path_str.contains("09_restore_data");
            if !is_data_backup {
                for (idx, line) in content.lines().enumerate() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("--") {
                        continue;
                    }
                    if sql_drop_table_regex.is_match(line) {
                        let upper = line.to_uppercase();
                        if !upper.contains("IF EXISTS") {
                            violations.push(AuditViolation {
                                file: path.to_path_buf(),
                                line: idx + 1,
                                rule: "UNSAFE_SQL_DROP_TABLE".to_string(),
                                message: format!("DROP TABLE without IF EXISTS in migration: {}", trimmed),
                            });
                        }
                    }
                    if sql_truncate_regex.is_match(line) {
                        violations.push(AuditViolation {
                            file: path.to_path_buf(),
                            line: idx + 1,
                            rule: "UNSAFE_SQL_TRUNCATE".to_string(),
                            message: format!("Destructive TRUNCATE found in migration — prefer DELETE with WHERE: {}", trimmed),
                        });
                    }
                }
            }
        }

        // 9. Unsanitized HTML Rendering / XSS
        if !is_test_or_mock && (path_str.ends_with(".tsx") || path_str.ends_with(".jsx")) {
            let is_approved_html_widget = path_str.contains("ExpandableHtml")
                || path_str.contains("ViewEpisodeModal")
                || path_str.contains("EpisodeRow")
                || path_str.contains("SlateEditorExamples");
            if !is_approved_html_widget {
                for (idx, line) in content.lines().enumerate() {
                    if dangerously_html_regex.is_match(line) {
                        violations.push(AuditViolation {
                            file: path.to_path_buf(),
                            line: idx + 1,
                            rule: "UNSANITIZED_HTML_XSS".to_string(),
                            message: format!("dangerouslySetInnerHTML found outside approved widget components: {}", line.trim()),
                        });
                    }
                }
            }
        }

        // 10. Outdated Deno std library version below std@0.200.0
        if !is_test_or_mock && !is_audit_script && path_str.ends_with(".ts") {
            for (idx, line) in content.lines().enumerate() {
                if deprecated_deno_std_regex.is_match(line) {
                    violations.push(AuditViolation {
                        file: path.to_path_buf(),
                        line: idx + 1,
                        rule: "DEPRECATED_DENO_STD".to_string(),
                        message: format!("Outdated Deno std library version below std@0.200.0: {}", line.trim()),
                    });
                }
            }
        }
    }

    let elapsed = start_time.elapsed();

    if violations.is_empty() {
        println!(
            "{}",
            format!(
                "✅ Security & Quality Audit Passed cleanly! (Scanned {} files in {:.2?})",
                files_scanned, elapsed
            )
            .bold()
            .green()
        );
        Ok(true)
    } else {
        eprintln!(
            "{}",
            format!(
                "❌ Audit FAILED with {} violation(s) across {} files scanned ({:.2?}):",
                violations.len(),
                files_scanned,
                elapsed
            )
            .bold()
            .red()
        );
        for v in &violations {
            eprintln!(
                "  {} [{}] {}:{} - {}",
                "✖".red().bold(),
                v.rule.yellow(),
                v.file.display().to_string().cyan(),
                v.line,
                v.message
            );
        }
        Ok(false)
    }
}

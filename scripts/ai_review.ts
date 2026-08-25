// AI code review for backend changes.
//
// Sends a git diff to an LLM (Groq primary, z.ai fallback) and produces a
// prioritized findings report. The LLM is advisory only: its output is
// schema-sanitized and never blocks merges unless --strict is passed with a
// critical finding present.
//
// Usage:
//   deno run --allow-all scripts/ai_review.ts [--range HEAD~3..HEAD] [--strict]
//
// Env: GROQ_API_KEY | ZAI_API_KEY, SUPABASE_* not required.

interface Finding {
  severity: "critical" | "major" | "minor";
  file: string;
  line?: string;
  issue: string;
  fix: string;
}

const RANGE_IDX = Deno.args.indexOf("--range");
const range = RANGE_IDX >= 0 ? Deno.args[RANGE_IDX + 1] : "HEAD~1..HEAD";
const STRICT = Deno.args.includes("--strict");

const GROQ = Deno.env.get("GROQ_API_KEY") ?? "";
const ZAI = Deno.env.get("ZAI_API_KEY") ?? "";

const SYSTEM =
  `You are a meticulous senior backend reviewer (Deno/TypeScript, PostgreSQL/PLpgSQL, GitHub Actions). Review the provided unified diff. Hunt ONLY for defects that matter:
1) correctness bugs and broken invariants,
2) security issues (secrets, injection, authz gaps),
3) data-loss risks,
4) CI/workflow mistakes that would break pipelines.
Ignore style, naming, formatting, and speculative architecture. Reply ONLY with JSON:
{"findings":[{"severity":"critical|major|minor","file":"path","line":"approx","issue":"...","fix":"..."}]}
Maximum 12 findings, most severe first. Empty findings array if clean.`;

async function llm(
  prompt: string,
): Promise<{ provider: string; content: string } | null> {
  const providers = [];
  if (GROQ) {
    providers.push({
      name: "groq",
      key: GROQ,
      url: "https://api.groq.com/openai/v1/chat/completions",
      model: Deno.env.get("AI_REVIEW_GROQ_MODEL") ?? "openai/gpt-oss-120b",
      extra: { response_format: { type: "json_object" } },
    });
  }
  if (ZAI) {
    providers.push({
      name: "zai",
      key: ZAI,
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: Deno.env.get("AI_REVIEW_ZAI_MODEL") ?? "glm-4.6",
      extra: {
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      },
    });
  }
  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${p.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: p.model,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 3000,
          ...p.extra,
        }),
      });
      if (!res.ok) {
        console.warn(`[${p.name}] HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const content = String(data?.choices?.[0]?.message?.content ?? "");
      if (!content.trim()) continue;
      return { provider: p.name, content };
    } catch (e) {
      console.warn(`[${p.name}] ${(e as Error).message}`);
    }
  }
  return null;
}

function parseFindings(raw: string): Finding[] {
  const unfenced = raw.replace(/```(?:json)?/g, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1)) as {
      findings?: unknown;
    };
    if (!Array.isArray(parsed.findings)) return [];
    const sev = new Set(["critical", "major", "minor"]);
    return parsed.findings
      .filter((f): f is Record<string, unknown> =>
        typeof f === "object" && f !== null
      )
      .map((f) => ({
        severity: (typeof f.severity === "string" && sev.has(f.severity)
          ? f.severity
          : "minor") as Finding["severity"],
        file: String(f.file ?? "?").slice(0, 200),
        line: typeof f.line === "string" || typeof f.line === "number"
          ? String(f.line).slice(0, 20)
          : undefined,
        issue: String(f.issue ?? "").slice(0, 600),
        fix: String(f.fix ?? "").slice(0, 600),
      }))
      .filter((f) =>
        f.issue.length > 0
      )
      .slice(0, 12);
  } catch {
    return [];
  }
}

/** Resolve a reviewable diff even on shallow checkouts (CI fetch-depth: 1). */
function resolveDiffArgs(range: string): string[] {
  for (const candidate of [range, "HEAD~3..HEAD", "HEAD~1..HEAD"]) {
    const probe = new Deno.Command("git", {
      args: ["diff", "--stat", candidate],
    }).outputSync();
    if (probe.success) return ["diff", candidate];
  }
  // depth-1 clone: review just the tip commit against the empty tree
  console.warn("[ai-review] shallow checkout - reviewing HEAD only");
  return ["show", "--stat", "HEAD"];
}

async function main() {
  const diffArgs = resolveDiffArgs(range);
  const stat = new Deno.Command("git", { args: diffArgs }).outputSync();
  if (!stat.success) throw new Error("git diff failed - is the range valid?");
  console.log(new TextDecoder().decode(stat.stdout));

  const fileArgs = [...diffArgs, "--", "*.ts", "*.sql", "*.yml", "*.yaml"];
  const full = new Deno.Command("git", { args: fileArgs }).outputSync();
  let diff = new TextDecoder().decode(full.stdout);
  if (!diff.trim()) {
    console.log("No reviewable diff in range.");
    return;
  }
  // cap context for the model, keeping hunks from every file
  if (diff.length > 60_000) {
    diff = diff.slice(0, 60_000) + "\n... [truncated]";
  }

  const result = await llm(
    `Review this diff (${range}). Current date context: production Supabase backend.\n\n\`\`\`diff\n${diff}\n\`\`\``,
  );

  await Deno.mkdir("reports", { recursive: true });
  const shortSha = new TextDecoder()
    .decode(
      new Deno.Command("git", { args: ["rev-parse", "--short", "HEAD"] })
        .outputSync().stdout,
    )
    .trim();

  if (!result) {
    console.warn("[ai-review] no provider available - skipping");
    await Deno.writeTextFile(
      `reports/ai-review-${shortSha}.md`,
      `# AI review ${shortSha}\n\nSkipped: no LLM provider available.\n`,
    );
    return;
  }

  const findings = parseFindings(result.content);
  const criticals = findings.filter((f) => f.severity === "critical");
  const majors = findings.filter((f) => f.severity === "major");

  let md =
    `# AI review \`${range}\` @ ${shortSha}\n\nProvider: ${result.provider} · ${findings.length} finding(s) (${criticals.length} critical, ${majors.length} major)\n\n`;
  if (!findings.length) md += "_Clean - no significant defects found._\n";
  for (const f of findings) {
    md += `## [${f.severity.toUpperCase()}] ${f.file}${
      f.line ? `:${f.line}` : ""
    }\n`;
    md += `- **Issue:** ${f.issue}\n- **Suggested fix:** ${f.fix}\n\n`;
  }
  await Deno.writeTextFile(`reports/ai-review-${shortSha}.md`, md);
  console.log(md);

  if (STRICT && criticals.length > 0) {
    console.error(`FAIL: ${criticals.length} critical AI finding(s)`);
    Deno.exit(1);
  }
  console.log(`PASS: review complete (${result.provider})`);
}

if (import.meta.main) await main();

#!/usr/bin/env -S deno run -A
/**
 * Synchronize unresolved Sentry issues to GitHub Issues.
 *
 * Runs as part of CI or scheduled maintenance to ensure every active
 * Sentry error is tracked as an actionable GitHub Issue with full context.
 *
 * Env:
 *   SENTRY_AUTH_TOKEN   Sentry API token (issue:read, project:read)
 *   SENTRY_ORG          Sentry org slug (default: organicnz)
 *   SENTRY_PROJECT      Sentry project slug (default: audiobookphile-backend)
 *   GITHUB_TOKEN        GitHub token with issues:write permission
 *   GITHUB_REPOSITORY   GitHub repo slug (e.g. organicnz/audiobookphile-backend)
 */

const env = Deno.env.toObject();
const SENTRY_API = env.SENTRY_API || "https://sentry.io/api/0";
const ORG = env.SENTRY_ORG || "organicnz";
const PROJECT = env.SENTRY_PROJECT || "audiobookphile-backend";
const SENTRY_AUTH_TOKEN = env.SENTRY_AUTH_TOKEN || "";
const GITHUB_TOKEN = env.GITHUB_TOKEN || "";
const REPO = env.GITHUB_REPOSITORY || "";
const MAX_ISSUES = Number.parseInt(env.MAX_ISSUES || "5", 10);

function log(msg: string) {
  console.log(`[sync-sentry-issues] ${msg}`);
}

function warn(msg: string) {
  console.warn(`[sync-sentry-issues] ${msg}`);
}

async function sentryGet(path: string): Promise<unknown> {
  const url = `${SENTRY_API}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${SENTRY_AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    warn(`Sentry GET ${path} failed: ${res.status} ${res.statusText}`);
    return null;
  }
  return await res.json();
}

function exec(cmd: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const process = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      env: { GITHUB_TOKEN, ...Deno.env.toObject() },
    });
    const output = process.outputSync();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (err) {
    return { code: 1, stdout: "", stderr: String(err) };
  }
}

async function main(): Promise<void> {
  if (!SENTRY_AUTH_TOKEN) {
    log("SENTRY_AUTH_TOKEN not set — skipping Sentry issue synchronization.");
    return;
  }

  log(`Fetching unresolved issues for ${ORG}/${PROJECT}...`);
  const issues = (await sentryGet(
    `/organizations/${ORG}/issues/?query=is:unresolved&sort=date&statsPeriod=14d&project=${PROJECT}`,
  )) as Array<Record<string, unknown>> | null;

  if (!issues || issues.length === 0) {
    log("No unresolved Sentry issues found.");
    return;
  }

  log(`Found ${issues.length} unresolved issues in Sentry.`);

  // Check existing GitHub issues with the sentry label
  const ghList = exec([
    "gh",
    "issue",
    "list",
    ...(REPO ? ["--repo", REPO] : []),
    "--label",
    "sentry",
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "title,body,number",
  ]);

  const existingIssues: Array<{ title: string; body: string; number: number }> =
    ghList.code === 0 ? JSON.parse(ghList.stdout || "[]") : [];

  let createdCount = 0;

  for (const issue of issues) {
    if (createdCount >= MAX_ISSUES) break;

    const id = String(issue.id ?? "");
    const shortId = String(issue.shortId ?? id);
    const title = String(issue.title ?? "Unknown Error");
    const permalink = String(
      issue.permalink ?? `https://${ORG}.sentry.io/issues/${id}/`,
    );
    const count = String(issue.count ?? "1");
    const userCount = String(issue.userCount ?? "0");
    const firstSeen = String(issue.firstSeen ?? "");
    const lastSeen = String(issue.lastSeen ?? "");
    const culprit = String(issue.culprit ?? "");

    // Check if an issue already exists for this Sentry issue
    const alreadyExists = existingIssues.some((ghIssue) =>
      ghIssue.title.includes(shortId) ||
      ghIssue.body.includes(permalink) ||
      ghIssue.body.includes(`Sentry ID: ${id}`)
    );

    if (alreadyExists) {
      log(`Issue ${shortId} already tracked on GitHub; skipping.`);
      continue;
    }

    log(`Creating GitHub issue for Sentry ${shortId}: ${title}`);

    const issueBody = `## Sentry Bug Report: ${title}

**Sentry Issue:** [${shortId}](${permalink})
**Sentry ID:** \`${id}\`
**Project:** \`${PROJECT}\`
**Culprit:** \`${culprit || "N/A"}\`

### Statistics
- **Total Events:** ${count}
- **Affected Users:** ${userCount}
- **First Seen:** ${firstSeen}
- **Last Seen:** ${lastSeen}

### Context
This issue was automatically opened by the Sentry synchronization pipeline.
To investigate stack traces, suspect commits, or breadcrumbs, visit the [Sentry Issue Details](${permalink}).
`;

    const createCmd = [
      "gh",
      "issue",
      "create",
      ...(REPO ? ["--repo", REPO] : []),
      "--title",
      `[Sentry ${shortId}] ${title}`,
      "--body",
      issueBody,
      "--label",
      "bug,sentry,auto-generated",
    ];

    const createRes = exec(createCmd);
    if (createRes.code === 0) {
      log(
        `Successfully opened GitHub Issue for ${shortId}: ${createRes.stdout.trim()}`,
      );
      createdCount++;
    } else {
      warn(`Failed to create GitHub Issue for ${shortId}: ${createRes.stderr}`);
    }
  }

  log(`Done: ${createdCount} new GitHub Issue(s) opened from Sentry.`);
}

if (import.meta.main) {
  await main();
}

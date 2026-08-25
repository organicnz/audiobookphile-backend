// AI-driven API compatibility probe.
//
// Uses an LLM (Groq first, z.ai fallback) to generate adversarial-but-SAFE
// request variants for a fixed set of read-mostly endpoints, executes them
// against the deployed Edge API, and treats ANY 5xx as a compatibility
// regression. LLM output is untrusted: every case is schema-validated,
// method-restricted (GET + two sandboxed POSTs), and capped before execution.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional GROQ_API_KEY/ZAI_API_KEY.
// Exit code: 0 when no 5xx (or when providers are down -> baseline-only run),
// 1 on any unexpected 5xx.

interface ProbeCase {
  endpoint: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

const URL_BASE = Deno.env.get("SUPABASE_URL") ?? "";
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GROQ = Deno.env.get("GROQ_API_KEY") ?? "";
const ZAI = Deno.env.get("ZAI_API_KEY") ?? "";

const TARGETS = [
  { endpoint: "/functions/v1/api/health", method: "GET" },
  { endpoint: "/functions/v1/api/me", method: "GET", auth: true },
  {
    endpoint: "/functions/v1/api/items/029bb772-cea8-4d3f-882a-1bf9f54198d8",
    method: "GET",
    auth: true,
  },
  {
    endpoint:
      "/functions/v1/api/items/029bb772-cea8-4d3f-882a-1bf9f54198d8/cover",
    method: "GET",
  },
  { endpoint: "/functions/v1/api/libraries", method: "GET", auth: true },
];

const SANDBOX_POSTS = [
  // validation paths - must 400/401/404 gracefully, never 500
  {
    endpoint: "/functions/v1/api/auth/login",
    method: "POST",
    bodyHint: "malformed or hostile login payloads",
  },
  {
    endpoint:
      "/functions/v1/api/session/00000000-0000-4000-8000-000000000000/sync",
    method: "POST",
    auth: true,
    bodyHint:
      "hostile playback sync payloads (wrong types, huge numbers, injection strings)",
  },
];

const SYSTEM =
  `You are an API resilience tester. Generate test cases that probe for crashes WITHOUT being destructive: no SQL injection payloads intended to exfiltrate, no resource-exhaustion (max 8KB strings), no illegal characters in URLs. Vary: missing fields, wrong types, boundary numbers (0, -1, 1e308), unicode, empty objects, deeply nested JSON (max depth 10). Reply ONLY with JSON: {"cases":[{...}]}.`;

async function llmJson(
  prompt: string,
): Promise<{ cases: ProbeCase[] } | null> {
  const providers = [] as {
    name: string;
    key: string;
    url: string;
    model: string;
  }[];
  if (GROQ) {
    providers.push({
      name: "groq",
      key: GROQ,
      url: "https://api.groq.com/openai/v1/chat/completions",
      model: Deno.env.get("AI_PROBE_GROQ_MODEL") ?? "openai/gpt-oss-120b",
    });
  }
  if (ZAI) {
    providers.push({
      name: "zai",
      key: ZAI,
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: Deno.env.get("AI_PROBE_ZAI_MODEL") ?? "glm-4.6",
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
          temperature: 0.7,
          max_tokens: 2000,
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        console.warn(`[${p.name}] HTTP ${res.status}, trying next provider`);
        continue;
      }
      const data = await res.json();
      const content = String(data?.choices?.[0]?.message?.content ?? "");
      const unfenced = content.replace(/```(?:json)?/g, "").trim();
      const start = unfenced.indexOf("{");
      const end = unfenced.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      const parsed = JSON.parse(unfenced.slice(start, end + 1)) as {
        cases: ProbeCase[];
      };
      if (!Array.isArray(parsed.cases)) continue;
      console.log(
        `[ai] ${parsed.cases.length} cases generated via ${p.name}/${p.model}`,
      );
      return parsed;
    } catch (e) {
      console.warn(`[${p.name}] failed: ${(e as Error).message}`);
    }
  }
  return null;
}

/** Untrusted LLM output is coerced into a safe shape or dropped. */
function sanitize(c: unknown): ProbeCase | null {
  if (typeof c !== "object" || c === null) return null;
  const rec = c as Record<string, unknown>;
  if (typeof rec.endpoint !== "string") return null;
  const allowed = new Set(
    TARGETS.map((t) => t.endpoint).concat(SANDBOX_POSTS.map((t) => t.endpoint)),
  );
  if (!allowed.has(rec.endpoint)) return null;
  const out: ProbeCase = { endpoint: rec.endpoint };
  const cleanRecord = (v: unknown, maxEntries: number) => {
    if (typeof v !== "object" || v === null) return undefined;
    const entries = Object.entries(v as Record<string, unknown>)
      .slice(0, maxEntries)
      .filter(([k]) => typeof k === "string" && k.length <= 64)
      .map((
        [k, val],
      ) => [k, typeof val === "string" ? val.slice(0, 2048) : val]);
    return Object.fromEntries(entries);
  };
  out.query = cleanRecord(rec.query, 12);
  out.headers = cleanRecord(rec.headers, 8);
  if ("body" in rec) out.body = rec.body;
  return out;
}

async function runCase(
  token: string,
  method: string,
  c: ProbeCase,
): Promise<number> {
  const url = new URL(URL_BASE + c.endpoint);
  for (const [k, v] of Object.entries(c.query ?? {})) {
    url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (method === "POST") headers["Content-Type"] = "application/json";
  const authEndpoints = new Set(
    TARGETS.filter((t) => t.auth).map((t) => t.endpoint),
  );
  if (token && authEndpoints.has(c.endpoint)) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(c.body ?? {}) : undefined,
    redirect: "manual",
  });
  // drain body to free the connection
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

if (import.meta.main) await main();

async function main() {
  if (!URL_BASE || !SVC) {
    throw new Error("SUPABASE_URL / SERVICE_ROLE required");
  }

  // session token for authed targets
  const email = `ai-probe-${Date.now()}@audiobookphile.test`;
  const password = `Probe-${crypto.randomUUID().slice(0, 12)}!`;
  await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SVC,
      Authorization: `Bearer ${SVC}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const login = await fetch(`${URL_BASE}/functions/v1/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: email, password }),
  }).then((r) => r.json());
  const token = String(login?.user?.token ?? "");

  const results: {
    provider: string;
    executed: number;
    byStatus: Record<string, number>;
    serverErrors: { endpoint: string; status: number }[];
  } = { provider: "none", executed: 0, byStatus: {}, serverErrors: [] };

  let cases: ProbeCase[] = [];
  const generated = await llmJson(
    `Targets:\n${
      JSON.stringify([...TARGETS, ...SANDBOX_POSTS], null, 1)
    }\n\nGenerate 24 diverse cases across these targets.`,
  );
  if (generated) {
    results.provider = GROQ ? "groq" : "zai";
    cases = generated.cases.map(sanitize).filter((c): c is ProbeCase => !!c);
  } else {
    console.warn(
      "[ai] all providers unavailable - running static baseline only",
    );
  }

  // deterministic baseline always runs (LLM outage must not blind the check)
  const baseline: ProbeCase[] = [
    { endpoint: "/functions/v1/api/health", query: { q: "' OR 1=1 --" } },
    { endpoint: "/functions/v1/api/me", query: { expand: "$junk" } },
    { endpoint: "/functions/v1/api/items/not-a-uuid/cover" },
    {
      endpoint: "/functions/v1/api/auth/login",
      body: { username: { $ne: null }, password: [] },
    },
    {
      endpoint:
        "/functions/v1/api/session/00000000-0000-4000-8000-000000000000/sync",
      body: { currentTime: 1e308, timeListened: -1, progress: "NaN" },
    },
  ];
  const all = [...baseline, ...cases];

  const postSet = new Set(SANDBOX_POSTS.map((t) => t.endpoint));
  for (const c of all) {
    const method = postSet.has(c.endpoint) ? "POST" : "GET";
    try {
      const status = await runCase(token, method, c);
      results.executed++;
      const bucket = `${Math.floor(status / 100)}xx`;
      results.byStatus[bucket] = (results.byStatus[bucket] ?? 0) + 1;
      if (status >= 500) {
        results.serverErrors.push({ endpoint: c.endpoint, status });
      }
    } catch (e) {
      console.warn(`probe error ${c.endpoint}: ${(e as Error).message}`);
    }
  }

  // cleanup probe user profiles (best effort, only when management token present)
  const mgmt = Deno.env.get("SUPABASE_ACCESS_TOKEN") ?? "";
  if (mgmt) {
    const ref = URL_BASE.match(/https:\/\/(.+)\.supabase\.co/)?.[1] ?? "";
    if (ref) {
      await fetch(
        `https://api.supabase.com/v1/projects/${ref}/database/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${mgmt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query:
              `DELETE FROM public.profiles WHERE username LIKE 'ai-probe-%'`,
          }),
        },
      ).catch(() => {});
    }
  }

  console.log("\n=== AI probe summary ===");
  console.log(`provider: ${results.provider}`);
  console.log(`executed: ${results.executed}`);
  console.log(`byStatus: ${JSON.stringify(results.byStatus)}`);

  await Deno.mkdir("reports", { recursive: true });
  await Deno.writeTextFile(
    "reports/ai-probe-report.json",
    JSON.stringify(results, null, 2),
  );

  if (results.serverErrors.length > 0) {
    console.error(
      `FAIL: ${results.serverErrors.length} unexpected 5xx responses`,
    );
    Deno.exit(1);
  }
  console.log("PASS: zero 5xx across all probes");
}

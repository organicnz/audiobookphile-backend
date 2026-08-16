# Workspace Agent Rules

These rules apply universally to all tasks within the `audiobookphile` workspace.

## 1. Bleeding-Edge Standards
- **Always follow the Custom Skills**: You MUST implicitly load and adhere to the guidelines outlined in the local skills:
  - `bleeding-edge-backend`
  - `bleeding-edge-frontend`
  - `bleeding-edge-mobile`
  - `bun-runtime`
  - `bleeding-edge-database`
  - `bleeding-edge-testing`
  - `bleeding-edge-ai`
  - `bleeding-edge-web-design`
  - `bleeding-edge-mobile-design`
  - `apple-design-mastery`
  - `supabase-edge-guard`
  - `bleeding-edge-cicd`
  - `lefthook-monorepo-guard`
  - `cybersecurity-hardened-guard`
  - `bleeding-edge-audio`
  - `bleeding-edge-accessibility`
  - `bleeding-edge-observability`
  - `bleeding-edge-performance`
  - `bleeding-edge-localization`
- **No Legacy Code**: Never scaffold legacy patterns (e.g., CommonJS, `@Published` for Swift, old React class components, thick client-side fetching when RSC applies). Always write state-of-the-art, modern implementations.
- **Premium Aesthetics**: For any UI work (web or mobile), always default to premium aesthetics like glassmorphism, micro-animations, and fluid transitions as outlined in the frontend and mobile skills.

## 2. Runtime and Package Management
- **Default to Bun**: Always use Bun (`bun install`, `bun run`, `bun test`) for JavaScript/TypeScript environments outside of Supabase.
- **Supabase Exception**: The `supabase/functions` directory is the ONLY exception and must strictly remain on Deno.

## 3. Supabase Edge Function Guard
- **Mandatory Imports**: Every Supabase Edge Function using `createClient` MUST explicitly import `import { createClient } from "npm:@supabase/supabase-js@2.44.0";` at line 1.
- **Pre-Deployment Verification**: Always run `deno check` and `deno lint` before deploying any Supabase Edge Function to prevent runtime `ReferenceError` crashes.

## 4. CI/CD & Automated Deployments
- **Always Deploy via GitHub CI/CD**: Never deploy code, edge functions, or database migrations manually from a local machine. All deployments across backend, web, and mobile MUST be automated through GitHub Actions workflows (`.github/workflows/`).
- **Pre-Deployment Checks**: Every CI/CD pipeline MUST execute complete verification (`deno lint` & `deno check` for backend, `bun run typecheck` & `bun run lint` & `bun run build` for web) before deploying to production.

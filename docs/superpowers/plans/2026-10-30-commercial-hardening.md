# KnowLattice Commercial Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GPL-3.0 KnowLattice release commercially distributable and keep its current feature set except the retired Medical Pathway builder.

**Architecture:** Treat existing modules as candidate implementations, not automatic dependencies. Close licensing, privacy, credential, rendering, and release risks in isolated slices. Preserve old pathway Markdown as read-only content while removing the builder surface.

**Tech Stack:** Vite, React 19, TypeScript, Tauri 2, PDF.js 6, IndexedDB.

**Spec:** `README.md`, `THIRD-PARTY-NOTICES.md`, `public/legal.md`

## Global Constraints

- License is GPL-3.0-only; all distributed builds must preserve source and corresponding-source access.
- Third-party data keeps its own license and attribution; do not describe all assets as GPL.
- The Medical Pathway builder is retired; existing ```pathway notes must still render.
- No patient-identifying data or clinical decision claims.
- Keep existing uncommitted work; do not rewrite unrelated modules.

## Review Focus

- A path with no editor open, malformed Markdown, old pathway notes, a commercial PDF, and an API key saved on a shared device.
- Each case must fail safely without data loss or silent omission.

---

### Task 1: Retire the Medical Pathway Builder

**Files:**
- Modify: `src/views/railCatalog.tsx`, `src/views/panelRegistry.ts`, `src/views/featureRouting.ts`, `src/views/Workspace.tsx`
- Delete: `src/views/MedicalPathwayBuilder.tsx`, `src/views/MedicalPathwayBuilder.test.ts`
- Test: `src/views/__tests__/featureRouting.test.ts`, `src/views/__tests__/panelRegistry.test.ts`, `e2e/smoke.spec.ts`

**Interfaces:**
- Produces: no `pathway` rail key or command; ` ```pathway ` rendering remains via `src/core/pathway.ts`.

- [x] Remove the rail, command-palette command, panel route, and builder render branch.
- [x] Keep the Markdown/pathway renderer for backward compatibility.
- [x] Update routing and browser smoke tests.
- [x] Run `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`.

### Task 2: Centralize Untrusted HTML

**Files:**
- Create: `src/core/domSanitize.ts` additions or a dedicated sanitizer helper.
- Modify: `src/views/ConvertView.tsx`, `src/views/AiAgentPanel.tsx`, `src/views/Preview.tsx`
- Test: new DOM tests for dangerous link protocols and converted HTML.

- [x] Write tests proving `javascript:` URLs, inline scripts, event handlers, and unsafe SVG are removed.
- [x] Run tests and observe the red state.
- [x] Add one sanitizer at every HTML sink, keeping Markdown `html:false` as defense in depth.
- [x] Run unit, lint, browser, and build checks.

### Task 3: Make AI Data Handling Explicit

**Files:**
- Modify: `src/views/AgentSettingsForm.tsx`, `src/views/SafetyNotice.tsx`, `public/legal.md`, `docs/AI助手使用指南.md`
- Test: settings DOM tests and legal-copy assertions.

- [ ] Specify exactly what leaves the device, to which endpoint, and which data is persisted.
- [ ] Keep “remember key” opt-in and show the local-storage risk before enabling it.
- [ ] Add a clear delete/reset path for saved endpoint and key.
- [ ] Verify no API key is included in exports or logs.

### Task 4: Move Desktop Credentials Out of Web Storage

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src/views/AgentSettingsForm.tsx`, `src/core/aiAgent.ts`
- Test: Rust unit tests plus a Tauri contract test.

- [x] Add an OS credential-store command with get/set/delete semantics.
- [x] Fall back to session-only credentials when secure storage is unavailable.
- [x] Never write the key to localStorage on desktop when secure storage succeeds.
- [ ] Verify a clean install, restart, and delete flow.

### Task 5: Release Gate

**Files:**
- Modify: `.github/workflows/*`, `README.md`, `THIRD-PARTY-NOTICES.md`
- Test: CI dry-run and `scripts/assert-public-dist.mjs`.

- [ ] Run official-registry production audit and fail on high/critical findings.
- [ ] Generate the GPL corresponding-source notice and exact dependency/data manifest.
- [ ] Confirm updater signing keys are not tracked and publishing uses CI secrets.
- [ ] Reconcile README, legal, and third-party claims for every bundled asset.

## Verification

- `npm run lint`
- `npm test`
- `npm run test:e2e`
- `npm run build`
- `npm audit --registry=https://registry.npmjs.org --omit=dev`

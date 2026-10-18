---
issue: 3215, 3216, 3217
---

# Skill frontmatter hardening: stamp anchoring, flow-map handling, generated-tree convergence (#3215, #3216, #3217)

## What changed

- The `swarm-contract-digest` stamp reader no longer resolves stamp-shaped text that sits
  inside a YAML block scalar (`description: >` / `|` continuations). The two-space
  metadata-child stamp form is only accepted inside a real `metadata:` block; the legacy
  column-0 form is unchanged. A spoofed digest can no longer shadow or impersonate a
  skill's contract stamp in drift-check staleness findings (#3215).
- An inline flow-map `metadata:` value (`metadata: {audience: swarm-plugin}`) is now
  resolved by the frontmatter reader exactly like the block form — a skill whose audience
  is declared that way is constrained by it instead of silently matching every project
  and runner (the previous absent/match-all fail-open). Malformed flow values fail
  closed (audience invalid, no match) (#3217).
- The skill reviser rewrites any inline-valued `metadata:` line to the canonical block
  form when bumping a version — a revision can no longer emit a second `metadata:` block
  beneath a legacy inline one (#3217).
- The 13 generated skills that still carried a legacy top-level `triggers:` list are
  migrated to the generator's own emission shape (`triggers` as the first
  `metadata:` child, a single-quoted JSON array string), and one generated skill whose
  directory name did not match its `name:` field is renamed to match — the directory
  now carries the generator's `sanitizeSlug` output including its trailing hyphen
  (64 characters; the pre-existing `name:` field and body self-reference already used
  that form) (#3216).
- The drift-check `skill-frontmatter` detector now enforces the generated tree
  (`.opencode/skills/generated/`) — hand-edits reintroducing non-spec top-level keys or
  name mismatches there fail `bun run drift:check --enforce` — and flags non-empty
  inline `metadata:` values as non-canonical. Only the audience detector keeps its
  generated-tree skip (#3216, #3217).

## Why

All three residuals came from the PR #3207 review: the bounded frontmatter parser was
used statelessly or shape-blindly at four sites, so YAML shapes other than the writer's
canonical block form were mis-read (spoofed stamp accepted, audience constraint
dropped), mis-written (duplicate `metadata:` key), or invisible to CI (a whole tree
exempt from the conformance detector).

## Verification

- New regression suites: `skill-contract-digest-block-scalar-3215.test.ts` (its
  block-scalar spoof assertions are RED at base), `skill-frontmatter-flow-forms-3217.test.ts`
  (flow-map and reviser assertions RED at base, block-form controls green),
  `generated-triggers-convergence-3216.test.ts` (RED at base: 13 legacy files; also pins
  name === directory), and `generated-triggers-migration-shape-3216.test.ts` (migration
  shape parity with the generator's `yamlJsonString` emission — its shape oracle is green
  at base by construction; the companion 13-file declaration test carries the RED leg).
  The feedback round adds a battery for the multi-line flow, quoting, and stamp-writer
  surfaces in `skill-frontmatter-feedback-3387.test.ts`.
- Preserving floors green: the #2907 transition matrix, skill-audience suite,
  skill-generator suites, skill-reviser suite, and the stamp script (all four shipped
  stamp forms still verify).
- `bun run drift:check --enforce` exit 0 with the exemption removed and the tree
  converged.

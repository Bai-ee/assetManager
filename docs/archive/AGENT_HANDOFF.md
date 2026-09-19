# HITLOOP Archive — Agent Operating Protocol

This repository is designed to survive model/context interruption.

## Before doing work

1. Read ARCHITECTURE.md.
2. Read IMPLEMENTATION_PLAN.md.
3. Read DECISIONS.md.
4. Read CURRENT_STATE.md.
5. Inspect current branch/commits/tests.
6. Work only within the assigned phase/subsystem unless a blocking contract change is documented.

Do not rely on chat history as source of truth.

## During work

- Prefer small commits with meaningful messages.
- Do not invent provider APIs, credentials, wallet details, pricing, or successful integrations.
- Mock/stub external services explicitly when credentials are unavailable.
- Do not mutate NAS originals.
- Update tests with implementation.
- Record architectural decisions, especially contract/schema changes.
- Parallel agents should own disjoint files/subsystems where practical.

## Before stopping

Update CURRENT_STATE.md with:
- current phase
- status
- exact work completed
- tests run and results
- files/subsystems changed
- unresolved failures/blockers
- next exact task
- last verified commit/ref

If architecture changed, update ARCHITECTURE.md and DECISIONS.md in the same handoff.

## Handoff standard

A new agent should be able to answer within minutes:
1. What are we building?
2. What phase are we in?
3. What is already verified?
4. What is broken/unknown?
5. What exact task should I do next?

If the docs cannot answer those questions, the outgoing agent has not completed handoff.

## Multi-agent integration rule

Plan → shard → implement → test each shard → reconcile contracts → integration test.

Do not let agents independently redefine shared schemas. Shared contract changes require a documented decision and downstream review.

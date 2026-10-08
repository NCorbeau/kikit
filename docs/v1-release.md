# V1 release checklist

Updated 2026-10-07. V1 is not complete. [MAC-152](https://linear.app/mglownia/issue/MAC-152) owns final acceptance; a task is complete only with evidence under the recorded conditions.

## Agreed scope

The existing editor, private accounts and signed-in sharing remain the baseline. [Deletion and hosted recovery targets](data-policy.md) are accepted. The user explicitly included recovery import, stylesheet refactoring, and document snapshots/compaction before v1; the architecture diagram and authenticated demonstration also remain in scope. No new hosting plan, spending limit or reliability guarantee is selected.

## Gates

| Gate | Task | Current evidence/state |
| --- | --- | --- |
| Deletion/retention/recovery decision | [MAC-101](https://linear.app/mglownia/issue/MAC-101) | Accepted 2026-10-07; hosted targets still require evidence |
| Snapshot scope conflict | [MAC-149](https://linear.app/mglownia/issue/MAC-149) | Resolved: document snapshots/compaction are required |
| Complete CI on existing main | [MAC-148](https://linear.app/mglownia/issue/MAC-148) | Baseline `0d86fff` passed on [attempt 2](https://github.com/NCorbeau/kikit/actions/runs/37374105908/attempts/2); subsequent documentation/demo main `dea5660` has [successful CI](https://github.com/NCorbeau/kikit/actions/runs/37684834220). Local feature commits still require their own checks |
| Permanent owner-only deletion | [MAC-95](https://linear.app/mglownia/issue/MAC-95) | Implemented locally with passing checks; review/CI and hosted proof remain |
| Hosted backups and isolated restoration | [MAC-102](https://linear.app/mglownia/issue/MAC-102) | [Provider/cost/isolation plan](hosted-recovery-plan.md) prepared; disposable capability experiment awaits provisioning approval, then production backup review/drill |
| Binary recovery import | [MAC-103](https://linear.app/mglownia/issue/MAC-103) | [Implemented locally](recovery-contract.md): original-note merge/private copy, older-backup history repair and retry identity; final review/CI and hosted rollout remain |
| Document snapshots and safe compaction | [MAC-153](https://linear.app/mglownia/issue/MAC-153) | Implemented locally with passing PostgreSQL/browser/restore checks; review/CI and hosted rollout remain |
| Stylesheet organization/refactor | [MAC-112](https://linear.app/mglownia/issue/MAC-112) | [Organized locally](styles.md), initially byte-identical; subsequent recovery styling/focus/contrast changes have separate evidence; review/CI remain |
| Browser/native input/accessibility | [MAC-104](https://linear.app/mglownia/issue/MAC-104) | [Chromium composition/keyboard/contrast/reduced-motion/reflow checks](accessibility.md) implemented; supported platforms, actual OS IME/mobile keyboard/screen reader/native zoom remain open |
| Hard crashes, partitions, overload and slow recipients | [MAC-105](https://linear.app/mglownia/issue/MAC-105) | [Local OS-kill/COMMIT-response-loss/socket-pressure evidence](failure-verification.md) recorded; final feature CI remains; no hosted failure/soak claim |
| Performance under stated conditions | [MAC-106](https://linear.app/mglownia/issue/MAC-106) | [Local baseline measured](performance.md): 180 paced inputs, 90 verified offline batches and memory observations; publication/CI remain; no hosted or capacity claim |
| Complete automated stop/migrate/start proof | [MAC-146](https://linear.app/mglownia/issue/MAC-146) | Open; first rollout required manual completion |
| Hosted current-feature verification | [MAC-150](https://linear.app/mglownia/issue/MAC-150) | Open; current-feature rollout/verification follows release checks |
| Hosted session renewal/expiry | [MAC-85](https://linear.app/mglownia/issue/MAC-85) | Open; issued cookie metadata is not lifecycle proof |
| Current planning and milestone summaries | [MAC-151](https://linear.app/mglownia/issue/MAC-151) | Repository, product planning and Linear checkpoints reconciled with local implementation and separate hosted/manual gates; publication remains |
| Architecture/edit-flow diagram | [MAC-113](https://linear.app/mglownia/issue/MAC-113) | [Repository diagrams](architecture.md) prepared for current document 2/database 7/protocol 2 implementation; final source review/CI remain |
| Authenticated sharing demonstration | [MAC-114](https://linear.app/mglownia/issue/MAC-114) | [PR #19](https://github.com/NCorbeau/kikit/pull/19) published a two-account local recording; joining precedes capture. A checked explicit-join supplement is prepared for the following demo PR; existing capture conditions are in the [recording details](demos/README.md) |
| Final acceptance | [MAC-152](https://linear.app/mglownia/issue/MAC-152) | Open until all required evidence is linked |

The [dated verification record](verification.md) retains already satisfied local and hosted boundaries, including two-account sharing. Keep its recorded versions and conditions distinct from the final release commit. Final acceptance must name the exact source/deployment and document/database/protocol versions, supported platforms, measured conditions and unresolved limits.

# V1 release checklist

Updated 2026-10-07. V1 is not complete. [MAC-152](https://linear.app/mglownia/issue/MAC-152) owns final acceptance; a task is complete only with evidence under the recorded conditions.

## Agreed scope

The existing editor, private accounts and signed-in sharing remain the baseline. [Deletion and hosted recovery targets](data-policy.md) are accepted. The user explicitly included recovery import, stylesheet refactoring, and document snapshots/compaction before v1; the architecture diagram and authenticated demonstration also remain in scope. No new hosting plan, spending limit or reliability guarantee is selected.

## Gates

| Gate | Task | Current evidence/state |
| --- | --- | --- |
| Deletion/retention/recovery decision | [MAC-101](https://linear.app/mglownia/issue/MAC-101) | Accepted 2026-10-07; implementation and drill remain open |
| Snapshot scope conflict | [MAC-149](https://linear.app/mglownia/issue/MAC-149) | Resolved: document snapshots/compaction are required |
| Complete CI on existing main | [MAC-148](https://linear.app/mglownia/issue/MAC-148) | Main `0d86fff` passed all four jobs on [attempt 2](https://github.com/NCorbeau/kikit/actions/runs/37374105908/attempts/2); future feature commits require their own checks |
| Permanent owner-only deletion | [MAC-95](https://linear.app/mglownia/issue/MAC-95) | Implemented locally with passing checks; review/CI and hosted proof remain |
| Hosted backups and isolated restoration | [MAC-102](https://linear.app/mglownia/issue/MAC-102) | Open; targets remain unverified |
| Binary recovery import | [MAC-103](https://linear.app/mglownia/issue/MAC-103) | Required; open |
| Document snapshots and safe compaction | [MAC-153](https://linear.app/mglownia/issue/MAC-153) | Implemented locally with passing PostgreSQL/browser/restore checks; review/CI and hosted rollout remain |
| Stylesheet organization/refactor | [MAC-112](https://linear.app/mglownia/issue/MAC-112) | Implemented locally: identical production CSS, passing focused browser/visual/focus checks; review/CI remain |
| Browser/native input/accessibility | [MAC-104](https://linear.app/mglownia/issue/MAC-104) | Supported platforms and full evidence remain open |
| Hard crashes, partitions, overload and slow recipients | [MAC-105](https://linear.app/mglownia/issue/MAC-105) | Open beyond previously recorded failure checks |
| Performance under stated conditions | [MAC-106](https://linear.app/mglownia/issue/MAC-106) | Open; no measured capacity claim |
| Complete automated stop/migrate/start proof | [MAC-146](https://linear.app/mglownia/issue/MAC-146) | Open; first rollout required manual completion |
| Hosted current-feature verification | [MAC-150](https://linear.app/mglownia/issue/MAC-150) | Open; current-feature rollout/verification follows release checks |
| Hosted session renewal/expiry | [MAC-85](https://linear.app/mglownia/issue/MAC-85) | Open; issued cookie metadata is not lifecycle proof |
| Current planning and milestone summaries | [MAC-151](https://linear.app/mglownia/issue/MAC-151) | Decision checkpoint recorded; full reconciliation remains open |
| Architecture/edit-flow diagram | [MAC-113](https://linear.app/mglownia/issue/MAC-113) | Open |
| Authenticated sharing demonstration | [MAC-114](https://linear.app/mglownia/issue/MAC-114) | Open; existing recording uses the development fixture |
| Final acceptance | [MAC-152](https://linear.app/mglownia/issue/MAC-152) | Open until all required evidence is linked |

The [dated verification record](verification.md) retains already satisfied local and hosted boundaries, including two-account sharing. Keep its recorded versions and conditions distinct from the final release commit. Final acceptance must name the exact source/deployment and document/database/protocol versions, supported platforms, measured conditions and unresolved limits.

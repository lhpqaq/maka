<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

## Verification report: bounded Artifact point reads and Session revisions

Tested implementation: `99ac97bc6625d14f044f8ed7be41d29231e629da` ([commit](https://github.com/lhpqaq/maka/commit/99ac97bc6625d14f044f8ed7be41d29231e629da)). This report supersedes the earlier fixed-10-record-Session report for the current PR head; the [earlier report](https://github.com/lhpqaq/maka/blob/70ff4de21d34328dd159386a8e6a85eb42a2d6cb/PR-4037-TEST-REPORT.md) remains historical evidence for `46b131dfe`.

### Result

The [maintainer's two growth checks](https://github.com/apache/maka/issues/4037#issuecomment-5554341099) are now covered separately. `getInSession` returns **one Artifact row plus one persisted Session revision row**, decoding only the Artifact, regardless of target/other Session growth. A missing ID decodes zero records. The record and revision come from one read snapshot.

At **50,000 target-Session records**, get-plus-revision P50 changed from **163.323 to 0.017 ms** relative to the previous PR implementation. Mutation work stays bounded, but is not free: creation P50 at that size was **3.272 → 3.896 ms (19.1% slower)** in this run.

### Evidence attachments

All links below pin the harnesses and results to an immutable commit on the separate evidence branch:

- [Benchmark harness](https://github.com/lhpqaq/maka/blob/af7ea45c2485b62a131dd22d94b059dff8f777ab/packages/storage/scripts/artifact-scoped-read-benchmark.mjs)
- [Other-Session growth: original baseline → current implementation](https://github.com/lhpqaq/maka/blob/af7ea45c2485b62a131dd22d94b059dff8f777ab/ARTIFACT-4037-REVISION-OTHER.json)
- [Target-Session growth: previous PR implementation → current implementation](https://github.com/lhpqaq/maka/blob/af7ea45c2485b62a131dd22d94b059dff8f777ab/ARTIFACT-4037-REVISION-TARGET.json)
- [Negative-control harness](https://github.com/lhpqaq/maka/blob/af7ea45c2485b62a131dd22d94b059dff8f777ab/packages/storage/scripts/artifact-revision-negative-controls.mjs) and [results](https://github.com/lhpqaq/maka/blob/af7ea45c2485b62a131dd22d94b059dff8f777ab/ARTIFACT-4037-REVISION-CONTROLS.json)
- [Runtime environment and harness SHA-256 digests](https://github.com/lhpqaq/maka/blob/af7ea45c2485b62a131dd22d94b059dff8f777ab/ARTIFACT-4037-REVISION-ENVIRONMENT.json)

### Functional verification

| Check | Result |
| --- | --- |
| Build core, storage, mcp, runtime, runtime-host | Passed |
| Full Storage suite, test-file concurrency 4 | **1,132 passed; 8 skipped; 0 failed** |
| Related Artifact and Session Runtime Host suites | **67 passed; 0 failed** |
| Repository lint and format checks | Passed |
| Storage and runtime-host typechecks | Passed |
| ASF header audit of an exported committed tree | Passed |
| Git whitespace check | Passed |

The 17 new revision tests are included in the Storage total. They cover adding 10/1,000/12,000 records to either the target or other Session, missing/wrong-Session reads, indexed query plans, bounded mutation reads/writes, no-ops, rollback, content restoration, Session moves, empty-Session cleanup, concurrent record/revision snapshots, child-process commits, malformed metadata, migration backfill, and migration rollback. Existing paging, replay, deletion, attachment and cross-process suites remain passing.

The eight skips are five Windows-specific cases and three opt-in process-lock stress tests (`MAKA_STORAGE_STRESS` was not enabled). The checkout-wide ASF check also encountered three untracked local planning/PR draft notes without headers; these are not in either pushed branch. The committed-tree audit passed without those local notes.

Negative controls run in memory without modifying source or dist:

- Replacing only `ArtifactStore` with the previous `46b131dfe` implementation makes **all six growth tests fail**. Adding 12,000 target records makes that implementation return/decode 12,001 rows instead of one.
- Removing the repository read transaction makes **both get/page snapshot tests fail** because the record/page and revision can come from different commits.
- The unchanged current implementation passes all 17 tests. The harness asserts the expected failure counts and exits successfully only when the controls behave as expected.

### Benchmark method

- **Apple M2, macOS/Darwin 24.1.0, arm64, Node v22.22.2; runtime SQLite 3.53.0.** The SQLite version comes from `SELECT sqlite_version()`; Node's compile-time version field says 3.51.3 and is not the runtime value.
- Runs: **2026-09-05T20:02:41.987Z through 2026-09-05T20:06:14.585Z**. Three fresh-process rounds per revision/size, alternating revision order and rotating operation order. The two comparisons ran sequentially.
- Each revision uses its own three Artifact modules, **including its schema**: v3 before, v4 after. They are transpiled identically in memory. Shared dependencies are unchanged between the compared commits; the harness rejects additional product-source differences.
- Every operation warms up for **at least 30 calls AND 1,000 ms of cumulative API execution** before samples. All **108 groups** satisfied both checks (30–50,017 calls; minimum warmup API time 1000.000 ms).
- **36 fresh worker processes; 2,700 timed samples.** Per revision/size: 90 samples per read operation, 60 per create, 45 per copy. P50/P95 use nearest rank over pooled samples. Raw files also include per-round and first-/second-half medians; fixed warmup is not a convergence guarantee.
- Ten target records and one explicit link have real **4 KiB payloads**. Additional growth rows contain valid metadata but no payload files. Only seeded payloads are read/copied. Create writes into the existing target Session, not an empty separate Session.
- Setup, assertions, cleanup and row/decode instrumentation are outside timings. Create/copy remove their generated rows/files after each call and verify the fixture's row count. GC runs once before warmup, not between warmup and sampling.

### Target Session grows: previous PR → current implementation

Comparison: `46b131dfe` → `99ac97bc6`, with 100 unrelated records and one linked Artifact fixed. Times are milliseconds.

| Target Session records | Get P50 before | Get P50 after | Get P95 before | Get P95 after | Artifact rows / decodes before → after |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 0.036 | 0.017 | 0.042 | 0.032 | 10 → 1 |
| 1,000 | 2.355 | 0.017 | 2.726 | 0.024 | 1,000 → 1 |
| 12,000 | 34.666 | 0.017 | 39.471 | 0.020 | 12,000 → 1 |
| 50,000 | 163.323 | 0.017 | 201.986 | 0.019 | 50,000 → 1 |

Every after-change get also returns **one revision row**. The old implementation computed the revision by hashing the entire Session; the new one hashes only a fixed-size persisted token.

| Target Session records | Create P50 before | Create P50 after | Create P95 before | Create P95 after |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 4.650 | 4.470 | 6.387 | 5.562 |
| 1,000 | 4.623 | 4.618 | 5.722 | 6.383 |
| 12,000 | 4.596 | 4.562 | 5.948 | 5.382 |
| 50,000 | 3.272 | 3.896 | 4.806 | 5.815 |

Creation returned/decoded **zero existing Artifact rows in both revisions**. Separate regression tests audit updates with 10 and 12,000 other records in the same Session: one changed Artifact row and one revision row are updated, zero existing records are read/decoded, and unchanged upserts/missing deletes perform neither update. Trigger maintenance uses indexed keys and an indexed existence check, not a moved full-Session scan.

The 50,000-record create median regressed by 19.1%; P95 also increased. Per-round create medians were 3.061 / 3.740 / 3.302 before versus 3.680 / 3.906 / 4.332 ms after. Do not interpret bounded work as zero write overhead or these local samples as a latency guarantee.

### Other Sessions grow: original baseline → current implementation

Comparison: `eca7778b1` → `99ac97bc6`, with the target Session fixed at 10 records plus one explicit link. This is a different baseline from the target-growth table above.

#### 12,000 unrelated records

| Operation | P50 before | P50 after | P95 before | P95 after | Artifact rows / decodes before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Read 4 KiB text | 29.188 | 0.159 | 37.166 | 0.197 | 12,011 → 1 |
| List Session page (2 records) | 30.138 | 0.037 | 36.333 | 0.047 | 12,011 → 10 |
| Get record + Session revision | 29.187 | 0.017 | 39.227 | 0.023 | 12,011 → 1 |
| Create 4 KiB Artifact in target Session | 33.444 | 4.589 | 38.755 | 5.557 | 12,011 → 0 |
| Copy 6 Artifacts | 232.084 | 25.782 | 243.314 | 30.218 | 84,092 → 11 |

Get and list-page each also read one revision row after the change. Copy reads the 10-record source Session plus one explicit link; the old implementation repeated whole-store reads while publishing six copies. Zero creation rows means the indexed absence check returned no existing record, not that no query ran.

<details>
<summary>100 unrelated records</summary>

| Operation | P50 before | P50 after | P95 before | P95 after | Artifact rows / decodes before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Read 4 KiB text | 0.329 | 0.150 | 0.450 | 0.168 | 111 → 1 |
| List Session page (2 records) | 0.169 | 0.036 | 0.194 | 0.044 | 111 → 10 |
| Get record + Session revision | 0.168 | 0.017 | 0.188 | 0.022 | 111 → 1 |
| Create 4 KiB Artifact in target Session | 4.627 | 4.552 | 5.775 | 7.554 | 111 → 0 |
| Copy 6 Artifacts | 29.464 | 28.368 | 34.177 | 31.835 | 792 → 11 |

</details>

Small-workload improvements are not uniform: with 100 unrelated records, creation P50 was effectively unchanged while P95 increased from 5.775 to 7.554 ms.

### Revision semantics and migration

- Revisions are now **opaque committed-change markers**, not content fingerprints. The existing `sha256:<64 hex>` wire shape is retained by hashing the persisted token. No-op replay and unchanged SQL updates preserve the token; changing metadata and restoring the same content does not reuse a prior nonempty revision. Filtered malformed-row edits may conservatively invalidate pagination.
- SQLite triggers maintain tokens within the same insert/update/delete transaction, including writes from another connection/process. Rollback restores metadata and revision together. Moving a row invalidates both Sessions; deleting the final row removes its revision entry. Truly empty Sessions retain the common empty revision.
- Artifact schema **v3 → v4** adds the revision table and triggers. The one-time backfill enumerates the covering Session index without decoding `record_json`. It is still migration-time work proportional to existing index entries, not a claim of constant-time first upgrade. Subsequent opens/migrations retain the stored tokens. Older builds reject the newer schema; downgrading a migrated workspace requires a compatible backup/build.

### Reproduction

Use Node 22.22.2 and npm 11.19.0, install locked dependencies, and run from a separate checkout of the evidence branch (the harnesses/results are not in the implementation commit):

```bash
git clone --branch lhp/issue-4037-benchmark-evidence https://github.com/lhpqaq/maka.git maka-4037-evidence
cd maka-4037-evidence
npm ci

npm --workspace @maka/core run build &&
npm --workspace @maka/storage run build &&
npm --workspace @maka/mcp run build &&
npm --workspace @maka/runtime run build &&
npm --workspace @maka/runtime-host run build

npm run lint
npm run format:check
npm --workspace @maka/storage run typecheck
npm --workspace @maka/runtime-host run typecheck
npm run check:asf-headers
git diff --check

NODE_NO_WARNINGS=1 GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false \
  node --test --test-concurrency=4 'packages/storage/dist/**/*.test.js'

NODE_NO_WARNINGS=1 node --test \
  packages/runtime-host/dist/__tests__/artifact-coordinator.test.js \
  packages/runtime-host/dist/__tests__/artifact-two-client-uds.test.js \
  packages/runtime-host/dist/__tests__/artifact-protocol.test.js \
  packages/runtime-host/dist/__tests__/execution-artifacts.test.js \
  packages/runtime-host/dist/__tests__/session-retirement-coordinator.test.js \
  packages/runtime-host/dist/__tests__/session-retirement-protocol.test.js \
  packages/runtime-host/dist/__tests__/session-revision-two-client-uds.test.js \
  packages/runtime-host/dist/__tests__/session-revision-graph-references.test.js \
  packages/runtime-host/dist/__tests__/session-revision-protocol.test.js \
  packages/runtime-host/dist/__tests__/session-revision-diagnostics.test.js

NODE_NO_WARNINGS=1 node packages/storage/scripts/artifact-revision-negative-controls.mjs

NODE_NO_WARNINGS=1 node packages/storage/scripts/artifact-scoped-read-benchmark.mjs \
  --before=eca7778b1 --after=99ac97bc6 --growth=other --sizes=100,12000 \
  --operations=readText,listPage,getInSession,create,copyConversation \
  --rounds=3 --warmup=30 --warmup-ms=1000 \
  --samples=30 --write-samples=20 --copy-samples=15 --timeout-ms=300000 \
  > artifact-revision-other.json

NODE_NO_WARNINGS=1 node packages/storage/scripts/artifact-scoped-read-benchmark.mjs \
  --before=46b131dfe --after=99ac97bc6 --growth=target --sizes=10,1000,12000,50000 \
  --operations=getInSession,create \
  --rounds=3 --warmup=30 --warmup-ms=1000 \
  --samples=30 --write-samples=20 --copy-samples=15 --timeout-ms=300000 \
  > artifact-revision-target.json
```

The Git environment variables above disable signing only for temporary commits created by the tests; they do not change repository/user configuration. Use the explicit comparison revisions, not the evidence branch tip.

### Remaining scope and unrun checks

- `listPage` still decodes/sorts the target Session to preserve malformed-row filtering, totals and locale-aware ordering; only its revision lookup is bounded. Turn listing and conversation-copy selection also scale with the selected Session(s).
- Physical purge retains its explicit global path-alias safety scan. Deletion correctness is tested; deletion performance is not measured here.
- These are single-caller, prewarmed storage API measurements. They do not measure UI latency, Runtime Host readiness, first-upgrade migration latency, cold caches, concurrent throughput, or memory usage. Index traversal costs remain; bounded rows/decodes does not mean literally constant CPU instructions.
- Full application build, full-repository typecheck/test, opt-in process-lock stress, Windows execution, Electron/UI smoke tests, packaged-app verification and UI/Desktop knip checks were not run.

Implementation, tests, benchmark harnesses and this report were prepared with Codex assistance.

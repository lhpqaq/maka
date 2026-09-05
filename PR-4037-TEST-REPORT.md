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

## Verification report: scoped Artifact metadata reads

Tested implementation: `46b131dfe8012249a4367266136e0859932ff182`.
Comparison baseline: `eca7778b1aa04ae21d33850cefd2f46ae7c7138a`.

### Evidence attachments

The benchmark evidence is published separately from the implementation, on [`lhp/issue-4037-benchmark-evidence`](https://github.com/lhpqaq/maka/tree/lhp/issue-4037-benchmark-evidence). These attachments are pinned to an immutable commit:

- [Reproducible benchmark harness](https://github.com/lhpqaq/maka/blob/dcf7695ab91ad2fc579abbaf25a906c69f126398/packages/storage/scripts/artifact-scoped-read-benchmark.mjs)
- [Raw timed samples, warmup counts, per-round medians, and row/decode counts](https://github.com/lhpqaq/maka/blob/dcf7695ab91ad2fc579abbaf25a906c69f126398/ARTIFACT-4037-BENCHMARK-WARM30.json)

### Functional checks

| Check | Result |
| --- | --- |
| Build core, storage, mcp, runtime, runtime-host | Passed |
| Storage suite, test-file concurrency 4 | 1,115 passed; 8 skipped; 0 failed |
| Artifact and Session Runtime Host integration suites | 67 passed; 0 failed |
| Repository lint and format checks | Passed |
| Storage and runtime-host typechecks | Passed |
| `git diff --check` | Passed |

The eight storage skips are five Windows-specific tests and three opt-in process-lock stress tests (`MAKA_STORAGE_STRESS` was not enabled). Artifact writer-lock and cross-process visibility tests were included in the passing suite.

The suite covers stable-ID replay, Session revisions and ordering, copy selection and snapshot consistency, malformed metadata, writer-lock authority, filesystem aliases and path escapes, durable deletion/retry, attachments, and two-client Session behavior.

Regression controls were run without editing the checkout:

- Loading both Artifact modules from the parent revision makes the two bounded-read tests fail: a new Artifact creation reads **111 / 12,011 rows**, instead of the expected zero existing rows.
- Loading the changed metadata module with its read transaction removed makes the copy snapshot test fail: linked metadata comes from the newer commit (`after`) instead of the source snapshot (`before`).

These are intentional negative controls; the changed implementation passes the normal suite.

### Prewarmed performance comparison

Environment: **Apple M2, macOS/Darwin 24.1.0, arm64, Node v22.22.2, SQLite 3.51.3**. Run completed at **2026-09-05T19:23:23.516Z**.

- Fixed source Session: 10 records, plus one explicit linked Artifact. Unrelated metadata: 100, 1,000, 12,000, and 50,000 records.
- Source/linked payloads are real 4 KiB files. Background records contain valid metadata only; their payload files are not created. No physical-purge performance claim is made.
- Three fresh-process rounds per revision and size, alternating before/after order and rotating operation order. Both changed modules are read from their exact Git revisions and compiled in memory with the same esbuild settings; all other dependencies are shared.
- **Before sampling each operation, run at least 30 warmup calls AND at least 1,000 ms of cumulative API execution.** Both conditions must pass. Warmup samples, setup, assertions, cleanup, and read-count instrumentation are excluded from reported timings.
- All **168 measurement groups** passed both warmup checks. Actual warmup counts ranged from **30 to 30,543**, and the minimum cumulative API warmup time was **1,000.001 ms**. This avoids giving fast indexed reads only a few milliseconds of warmup.
- Per revision and size: 90 measured samples for each read/replay operation, 60 for creation, and 45 for copy; **4,440 timed samples** overall. P50/P95 use nearest-rank over the pooled samples; speedups use unrounded P50 values.
- Force GC once before each operation's warmup, not between warmup and sampling. Mutations restore the fixture outside the timed section, and each operation verifies its functional result. Returned rows and JSON decodes are counted on a separate call after timing.

#### 12,000 unrelated records

Times are milliseconds. Row/decode counts are cumulative per API call, including repeated reads of the same row.

| Operation | Before P50 | After P50 | Before P95 | After P95 | P50 speedup | Returned rows / decodes: before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Read 4 KiB text | 30.035 | 0.152 | 39.452 | 0.169 | 197.7× | 12,011 → 1 |
| List Session page (2 records) | 31.282 | 0.036 | 38.712 | 0.050 | 867.0× | 12,011 → 10 |
| Get record + Session revision | 29.465 | 0.038 | 34.644 | 0.049 | 767.0× | 12,011 → 10 |
| List Turn Artifacts | 32.043 | 0.031 | 42.648 | 0.051 | 1018.6× | 12,011 → 10 |
| Replay existing ID/content | 31.515 | 0.603 | 39.902 | 0.704 | 52.3× | 12,011 → 1 |
| Create 4 KiB Artifact | 34.275 | 4.182 | 41.746 | 5.252 | 8.2× | 12,011 → 0 |
| Copy 6 Artifacts | 234.681 | 29.839 | 325.261 | 34.344 | 7.9× | 84,092 → 11 |

For a new ID, zero means the indexed lookup returned no existing record; the query still runs. The copy operation selects six records, so the old implementation performs the initial reload plus six target-ID reloads. The new implementation reads the 10-record source Session and one explicit link.

#### Scaling and smaller workloads

| Unrelated records | Text read P50: before → after (ms) | Create P50: before → after (ms) | Copy P50: before → after (ms) |
| ---: | ---: | ---: | ---: |
| 100 | 0.321 → 0.155 | 4.580 → 4.585 | 28.283 → 30.116 |
| 1,000 | 1.631 → 0.153 | 5.702 → 4.895 | 33.270 → 29.778 |
| 12,000 | 30.035 → 0.152 | 34.275 → 4.182 | 234.681 → 29.839 |
| 50,000 | 130.428 → 0.154 | 135.272 → 4.360 | 940.100 → 28.854 |

At 100 background records, creation is effectively unchanged and copying is about 6.5% slower in this run. At 1,000 records, copy P95 is 38.726 → 53.945 ms despite a slightly better median. This is not an across-the-board latency improvement for small, filesystem-bound workloads.

#### Warmup and variation check

Longer warmup does not prove convergence. I also compared the first and second halves of each measured batch. For 12,000 background records, text-read per-round P50 was **33.210 / 28.488 / 28.304 ms before**, versus **0.151 / 0.151 / 0.153 ms after**. Residual variation remains, particularly in file-writing operations.

<details>
<summary>First-half → second-half medians after the change, 12,000 background records (ms)</summary>

| Operation | Round 1 | Round 2 | Round 3 |
| --- | ---: | ---: | ---: |
| Read 4 KiB text | 0.155 → 0.149 | 0.151 → 0.153 | 0.157 → 0.153 |
| List Session page (2 records) | 0.037 → 0.035 | 0.037 → 0.036 | 0.036 → 0.036 |
| Get record + Session revision | 0.036 → 0.043 | 0.037 → 0.036 | 0.039 → 0.040 |
| List Turn Artifacts | 0.029 → 0.031 | 0.033 → 0.033 | 0.031 → 0.030 |
| Replay existing ID/content | 0.590 → 0.443 | 0.618 → 0.593 | 0.597 → 0.610 |
| Create 4 KiB Artifact | 2.778 → 2.589 | 4.639 → 4.717 | 4.343 → 3.498 |
| Copy 6 Artifacts | 30.505 → 28.340 | 28.596 → 29.220 | 28.928 → 29.295 |

</details>

For example, replay in one round moved from 0.590 to 0.443 ms between halves; create P50 differed across rounds (2.778 / 4.662 / 4.186 ms). Treat the timings as a local workload comparison, not a convergence guarantee, confidence interval, or latency SLA. The bounded row/decode counts are the deterministic regression evidence.

<details>
<summary>All sizes and operations: P50 / P95 in milliseconds</summary>

| Background records | Operation | Before P50 / P95 | After P50 / P95 | Returned rows / decodes: before → after |
| ---: | --- | ---: | ---: | ---: |
| 100 | Read 4 KiB text | 0.321 / 0.613 | 0.155 / 0.174 | 111 → 1 |
| 100 | List Session page (2 records) | 0.173 / 0.200 | 0.036 / 0.050 | 111 → 10 |
| 100 | Get record + Session revision | 0.168 / 0.191 | 0.036 / 0.050 | 111 → 10 |
| 100 | List Turn Artifacts | 0.170 / 0.192 | 0.030 / 0.035 | 111 → 10 |
| 100 | Replay existing ID/content | 0.764 / 0.847 | 0.605 / 0.694 | 111 → 1 |
| 100 | Create 4 KiB Artifact | 4.580 / 7.664 | 4.585 / 5.717 | 111 → 0 |
| 100 | Copy 6 Artifacts | 28.283 / 31.463 | 30.116 / 42.234 | 792 → 11 |
| 1,000 | Read 4 KiB text | 1.631 / 1.826 | 0.153 / 0.172 | 1,011 → 1 |
| 1,000 | List Session page (2 records) | 1.459 / 1.649 | 0.036 / 0.042 | 1,011 → 10 |
| 1,000 | Get record + Session revision | 1.461 / 1.692 | 0.036 / 0.038 | 1,011 → 10 |
| 1,000 | List Turn Artifacts | 1.453 / 1.737 | 0.030 / 0.037 | 1,011 → 10 |
| 1,000 | Replay existing ID/content | 2.085 / 2.315 | 0.604 / 0.681 | 1,011 → 1 |
| 1,000 | Create 4 KiB Artifact | 5.702 / 6.744 | 4.895 / 9.023 | 1,011 → 0 |
| 1,000 | Copy 6 Artifacts | 33.270 / 38.726 | 29.778 / 53.945 | 7,092 → 11 |
| 12,000 | Read 4 KiB text | 30.035 / 39.452 | 0.152 / 0.169 | 12,011 → 1 |
| 12,000 | List Session page (2 records) | 31.282 / 38.712 | 0.036 / 0.050 | 12,011 → 10 |
| 12,000 | Get record + Session revision | 29.465 / 34.644 | 0.038 / 0.049 | 12,011 → 10 |
| 12,000 | List Turn Artifacts | 32.043 / 42.648 | 0.031 / 0.051 | 12,011 → 10 |
| 12,000 | Replay existing ID/content | 31.515 / 39.902 | 0.603 / 0.704 | 12,011 → 1 |
| 12,000 | Create 4 KiB Artifact | 34.275 / 41.746 | 4.182 / 5.252 | 12,011 → 0 |
| 12,000 | Copy 6 Artifacts | 234.681 / 325.261 | 29.839 / 34.344 | 84,092 → 11 |
| 50,000 | Read 4 KiB text | 130.428 / 160.538 | 0.154 / 0.172 | 50,011 → 1 |
| 50,000 | List Session page (2 records) | 134.163 / 165.698 | 0.037 / 0.040 | 50,011 → 10 |
| 50,000 | Get record + Session revision | 135.735 / 164.568 | 0.036 / 0.048 | 50,011 → 10 |
| 50,000 | List Turn Artifacts | 134.317 / 167.403 | 0.030 / 0.033 | 50,011 → 10 |
| 50,000 | Replay existing ID/content | 133.290 / 176.607 | 0.604 / 0.682 | 50,011 → 1 |
| 50,000 | Create 4 KiB Artifact | 135.272 / 160.939 | 4.360 / 5.224 | 50,011 → 0 |
| 50,000 | Copy 6 Artifacts | 940.100 / 1024.453 | 28.854 / 33.120 | 350,092 → 11 |

</details>

### Reproduction

Use a separate checkout of the evidence branch with Node 22.22.2 and npm 11.19.0 selected. It contains the tested implementation plus the harness/results/report; the evidence files are **not part of implementation commit `46b131dfe`**. The comparison explicitly selects the baseline and implementation commits, not the evidence branch tip.

```bash
git clone --branch lhp/issue-4037-benchmark-evidence https://github.com/lhpqaq/maka.git maka-4037-evidence
cd maka-4037-evidence
npm ci
```

Then run the checks and benchmark from that checkout:

```bash
npm --workspace @maka/core run build &&
npm --workspace @maka/storage run build &&
npm --workspace @maka/mcp run build &&
npm --workspace @maka/runtime run build &&
npm --workspace @maka/runtime-host run build

npm run lint
npm run format:check
npm --workspace @maka/storage run typecheck
npm --workspace @maka/runtime-host run typecheck
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

NODE_NO_WARNINGS=1 node packages/storage/scripts/artifact-scoped-read-benchmark.mjs \
  --before=eca7778b1 --after=46b131dfe \
  --sizes=100,1000,12000,50000 --rounds=3 \
  --warmup=30 --warmup-ms=1000 \
  --samples=30 --write-samples=20 --copy-samples=15 \
  --timeout-ms=300000 > artifact-benchmark-warm30.json
```

The Git configuration above disables signing only for temporary commits made by the test process; no repository or user Git configuration is changed.

### Scope and limitations

- These are single-caller, prewarmed storage API measurements with a fixed 10-record target Session. They do not measure Runtime Host cold start, UI response time, concurrent contention, cold-cache behavior, or memory usage.
- Session-wide hashing/filtering still scales with the target Session itself. Indexed lookups still have index traversal costs; bounded decoding does not mean every underlying operation is strictly O(1).
- Physical deletion retains the global path-alias safety scan. It was covered by functional regression tests, but **not benchmarked** here. This report does not claim to eliminate the entire startup or purge cost discussed in #4037.
- Full-application build, full-repository typecheck/test suite, opt-in process-lock stress tests, Windows execution, Electron/UI smoke tests, and packaged-app verification were not run.
- The earlier three-call-warmup measurements are not used in these tables. All reported timing values come from this strengthened-warmup run.

Implementation, benchmark harness, and this report were prepared with Codex assistance.

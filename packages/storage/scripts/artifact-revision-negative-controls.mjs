/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Build core/storage first; run with Node >=22.19. No checkout or dist files are edited.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mode = process.env.MAKA_ARTIFACT_NEGATIVE_CONTROL;
if (mode) {
  const name = mode === 'previous-store' ? 'artifact-store' : 'sqlite-artifact-metadata';
  const path = `packages/storage/src/${name}.ts`;
  let source;
  if (mode === 'previous-store') {
    source = execFileSync('git', ['show', `46b131dfe:${path}`], { cwd: root, encoding: 'utf8' });
  } else {
    assert.equal(mode, 'without-snapshot');
    source = readFileSync(join(root, path), 'utf8');
    const statement = "return this.#lease.transaction('read', read);";
    assert.ok(source.includes(statement), 'read transaction statement must still exist');
    source = source.replace(statement, 'return read();');
  }
  const transformed = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
  const target = pathToFileURL(join(root, `packages/storage/dist/${name}.js`)).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url === target) return { format: 'module', source: transformed, shortCircuit: true };
      return nextLoad(url, context);
    },
  });
} else {
  const results = [];
  for (const control of [
    { name: 'current implementation', mode: '', pattern: '.', failures: 0 },
    {
      name: 'previous getInSession implementation',
      mode: 'previous-store',
      pattern: 'get plus revision stays bounded',
      failures: 6,
    },
    {
      name: 'read snapshot removed',
      mode: 'without-snapshot',
      pattern: 'returns metadata and revision from one snapshot',
      failures: 2,
    },
  ]) {
    const child = spawnSync(
      process.execPath,
      [
        '--test',
        `--test-name-pattern=${control.pattern}`,
        ...(control.mode ? ['--import', import.meta.url] : []),
        join(root, 'packages/storage/dist/__tests__/artifact-session-revisions.test.js'),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          MAKA_ARTIFACT_NEGATIVE_CONTROL: control.mode,
        },
      },
    );
    assert.equal(child.status, control.failures ? 1 : 0, child.stdout + child.stderr);
    assert.match(child.stdout, new RegExp(`# fail ${control.failures}\\b`));
    if (control.mode === 'previous-store') {
      assert.match(child.stdout, /artifactRows: 12001/);
      assert.match(child.stdout, /decodes: 12001/);
    }
    results.push({
      name: control.name,
      expectedFailures: control.failures,
      observedFailures: Number(child.stdout.match(/# fail (\d+)/)[1]),
      passed: true,
    });
  }
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
}

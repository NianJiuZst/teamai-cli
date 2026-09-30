import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

it('previews apply, reject and all-apply without writing documents or the queue', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-review-dry-run-'));
  const queue = path.join(cwd, '.teamai', 'pending-review.jsonl');
  const doc = path.join(cwd, 'doc.md');
  const originalDoc = '# Document\n\n<!-- managed-by: import --from-repo, section: glossary -->\n## Glossary\nOriginal body\n<!-- /managed-by: glossary -->\n';
  const items = [
    { id: 'valid', kind: 'codebase-section', risk: 'medium', target: { file: 'doc.md', section: 'glossary' }, payload: { content: 'Replacement body' } },
    { id: 'high', kind: 'codebase-section', risk: 'high', target: { file: 'doc.md', section: 'glossary' }, payload: { content: 'High risk body' } },
    { id: 'missing', kind: 'codebase-section', risk: 'low', target: { file: 'missing.md', section: 'glossary' }, payload: { content: 'Missing target body' } },
    { id: 'manual', kind: 'domain-drift', risk: 'low', target: { file: 'doc.md' }, payload: {} },
  ].map((item) => ({ ts: '2026-01-01T00:00:00Z', source: 'import --from-repo', ...item }));
  const originalQueue = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd, env: { ...process.env, HOME: cwd, FORCE_COLOR: '0' }, encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    fs.mkdirSync(path.dirname(queue));
    fs.writeFileSync(queue, originalQueue);
    fs.writeFileSync(doc, originalDoc);
    const docTime = fs.statSync(doc).mtimeMs;
    const queueTime = fs.statSync(queue).mtimeMs;
    for (const args of [
      ['--dry-run', 'review', 'valid', '--apply'],
      ['review', 'valid', '--apply', '--dry-run', '--json'],
      ['review', 'valid', '--reject', '--dry-run'],
      ['review', 'valid', '--reject', '--dry-run', '--json'],
      ['review', '--all-apply', '--dry-run'],
      ['review', '--all-apply', '--max-risk', 'medium', '--dry-run', '--json'],
      ['review', 'missing', '--apply', '--dry-run', '--json'],
      ['review', 'manual', '--apply', '--dry-run', '--json'],
    ]) {
      const output = run(args);
      expect(fs.readFileSync(doc, 'utf8'), args.join(' ')).toBe(originalDoc);
      expect(fs.readFileSync(queue, 'utf8'), args.join(' ')).toBe(originalQueue);
      expect(fs.statSync(doc).mtimeMs).toBe(docTime);
      expect(fs.statSync(queue).mtimeMs).toBe(queueTime);
      if (args.includes('--json')) {
        const parsed = JSON.parse(output);
        expect(parsed.dryRun).toBe(true);
        if (args.includes('--all-apply')) {
          expect(parsed.results).toEqual([
            { id: 'valid', ok: true },
            { id: 'missing', ok: false, reason: expect.stringContaining('target file not found') },
          ]);
          expect(parsed.skipped).toEqual(['high', 'manual']);
        } else if (args.includes('missing') || args.includes('manual')) {
          expect(parsed.ok).toBe(false);
        } else {
          expect(parsed.ok).toBe(true);
        }
      } else {
        expect(output).toContain('[dry-run]');
        expect(output).not.toContain('applied:');
        expect(output).not.toContain('rejected:');
      }
    }
    run(['review', 'valid', '--apply']);
    expect(fs.readFileSync(doc, 'utf8')).toContain('Replacement body');
    expect(fs.readFileSync(queue, 'utf8')).not.toContain('"id":"valid"');
    run(['review', 'manual', '--reject']);
    expect(fs.readFileSync(queue, 'utf8')).not.toContain('"id":"manual"');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

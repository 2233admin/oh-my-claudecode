import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeTeamApiOperation } from '../api-interop.js';

describe('team api handoff-message', () => {
  let cwd: string;
  const teamName = 'arch-demo';
  const worker = 'worker-1';

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-team-api-handoff-'));
    const base = join(cwd, '.omc', 'state', 'team', teamName);
    await mkdir(join(base, 'events'), { recursive: true });
    await mkdir(join(base, 'workers', worker), { recursive: true });
    await writeFile(join(base, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'handoff',
      agent_type: 'executor',
      worker_count: 1,
      max_workers: 20,
      tmux_session: 'handoff-session',
      workers: [{ name: worker, index: 1, role: 'executor', assigned_tasks: [] }],
      created_at: '2026-05-12T00:00:00.000Z',
      next_task_id: 2,
    }, null, 2));
    await writeFile(join(base, 'workers', worker, 'inbox.md'), 'Existing worker context');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('appends a structured conversation handoff to the worker inbox and records an event', async () => {
    const result = await executeTeamApiOperation('handoff-message', {
      team_name: teamName,
      worker,
      from_agent: 'arch',
      summary: 'Focus on team API integration for external agent handoff.',
      reasoning: 'The existing team inbox and event bus already provide durable async delivery.',
      actions: ['Add a dedicated operation', 'Record a typed event'],
      files: ['src/team/api-interop.ts', 'src/team/team-ops.ts'],
      text: 'Demo scope only. Avoid shared live transcript sync for now.',
    }, cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inboxPath = join(cwd, '.omc', 'state', 'team', teamName, 'workers', worker, 'inbox.md');
    const inbox = await readFile(inboxPath, 'utf8');
    expect(inbox).toContain('Existing worker context');
    expect(inbox).toContain('# Conversation Handoff');
    expect(inbox).toContain('From: arch');
    expect(inbox).toContain('Summary: Focus on team API integration for external agent handoff.');
    expect(inbox).toContain('## Actions');
    expect(inbox).toContain('- Add a dedicated operation');
    expect(inbox).toContain('## Files');
    expect(inbox).toContain('- src/team/api-interop.ts');

    const eventsPath = join(cwd, '.omc', 'state', 'team', teamName, 'events.jsonl');
    const events = (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; worker: string; reason?: string; message?: string });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('conversation_handoff');
    expect(events[0]?.worker).toBe(worker);
    expect(events[0]?.reason).toBe('arch');
    expect(events[0]?.message).toBe('Focus on team API integration for external agent handoff.');
  });

  it('rejects malformed actions payloads', async () => {
    const result = await executeTeamApiOperation('handoff-message', {
      team_name: teamName,
      worker,
      summary: 'Bad payload',
      actions: ['ok', 123],
    }, cwd);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toContain('actions entries must be strings');
  });
});

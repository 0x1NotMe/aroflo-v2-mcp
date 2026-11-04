import { describe, expect, it } from 'vitest';
import { AroFloHttp } from '../src/http.js';
import { JobIndex } from '../src/jobs.js';
import { fakeFetch, noSleep, pagedList, testConfig } from './helpers.js';

// Synthetic: 1,800 quotes in near job-number order with a few rows displaced by up to ~90 places,
// like AroFlo's real /quotes list; 7,000 tasks sorted on request.
function nearlySorted(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `Q${i}`, jobNumber: 1000 + i * 4 + (i % 7) }));
  for (const [a, b] of [[10, 95], [700, 790], [1500, 1580]] as const) [rows[a], rows[b]] = [rows[b]!, rows[a]!];
  return rows;
}

function setup() {
  const quotes = nearlySorted(1800);
  const tasks = Array.from({ length: 7000 }, (_, i) => ({ id: `T${i}`, jobNumber: 1000 + Math.floor(i * 1.17) }));
  const f = fakeFetch({ 'GET /quotes': pagedList(quotes), 'GET /tasks': pagedList(tasks) });
  return { f, quotes, tasks, jobs: new JobIndex(new AroFloHttp(testConfig(), f.fn, noSleep)) };
}

describe('JobIndex', () => {
  it('finds a task by job number in a handful of calls', async () => {
    const { f, jobs, tasks } = setup();
    expect((await jobs.find('tasks', tasks[4321]!.jobNumber))?.id).toBe('T4321');
    expect(f.calls.length).toBeLessThanOrEqual(5);
    expect(f.calls[0]!.query).toMatchObject({ sortBy: 'jobnumber', ascending: 'true', limit: '100' });
  });

  it('finds displaced quotes in a nearly sorted list', async () => {
    const { jobs, quotes } = setup();
    for (const i of [10, 95, 700, 790, 1500, 1580, 900, 1799]) expect((await jobs.find('quotes', quotes[i]!.jobNumber))?.id).toBe(quotes[i]!.id);
  });

  it('answers "not found" for a gap, scanning quotes fully before saying so', async () => {
    const { jobs, f } = setup();
    expect(await jobs.find('tasks', 1006)).toBeUndefined();
    expect(await jobs.find('tasks', 999)).toBeUndefined();
    const before = f.calls.length;
    expect(await jobs.find('quotes', 1003)).toBeUndefined();
    expect(f.calls.length - before).toBeLessThanOrEqual(18);
  });

  it('finds a job in a sorted list with heavily skewed numbering', async () => {
    // 100 pages: job numbers 1..9900 except the last page, which jumps to millions.
    const tasks = Array.from({ length: 10_000 }, (_, i) => ({ id: `T${i}`, jobNumber: i < 9_900 ? i + 1 : 5_000_000 + i }));
    const f = fakeFetch({ 'GET /tasks': pagedList(tasks) });
    const jobs = new JobIndex(new AroFloHttp(testConfig(), f.fn, noSleep));
    expect((await jobs.find('tasks', 5000))?.id).toBe('T4999');
    expect(f.calls.length).toBeLessThanOrEqual(12);
  });

  it('finds a job created after its page was cached', async () => {
    const tasks = Array.from({ length: 250 }, (_, i) => ({ id: `T${i}`, jobNumber: 1000 + i }));
    const f = fakeFetch({ 'GET /tasks': pagedList(tasks) });
    const jobs = new JobIndex(new AroFloHttp(testConfig(), f.fn, noSleep));
    expect(await jobs.find('tasks', 1250)).toBeUndefined();
    tasks.push({ id: 'T250', jobNumber: 1250 });
    expect((await jobs.find('tasks', 1250))?.id).toBe('T250');
  });

  it('reuses rows it has seen', async () => {
    const { f, jobs, tasks } = setup();
    await jobs.find('tasks', tasks[4321]!.jobNumber);
    const n = f.calls.length;
    expect((await jobs.find('tasks', tasks[4322]!.jobNumber))?.id).toBe('T4322');
    expect(f.calls.length).toBe(n);
  });

  it('resolves ids directly and rejects junk', async () => {
    const { jobs } = setup();
    expect(await jobs.resolve('tasks', 'AB12000CD34')).toEqual({ id: 'AB12000CD34' });
    await expect(jobs.resolve('tasks', 'drop table')).rejects.toThrow(/neither a job number nor an AroFlo id/);
  });
});

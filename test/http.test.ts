import { describe, expect, it, vi } from 'vitest';
import { ApiError, AroFloHttp } from '../src/http.js';
import { fakeFetch, noSleep, testConfig, TOKEN } from './helpers.js';

describe('AroFloHttp', () => {
  it('sends the bearer token and query, returns parsed JSON', async () => {
    const f = fakeFetch({ 'GET /clients': { body: { count: 0, items: [] } } });
    const http = new AroFloHttp(testConfig(), f.fn, noSleep);
    const res = await http.request('GET', '/clients', { query: { limit: '5' } });
    expect(res.data).toEqual({ count: 0, items: [] });
    expect(f.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]!.query).toEqual({ limit: '5' });
  });

  it.each(['/tasks/../clients', '/tasks/%2e%2e/clients', 'tasks', '/a\\b'])('refuses a path that normalises to somewhere else: %s', async (path) => {
    const f = fakeFetch({});
    const http = new AroFloHttp(testConfig(), f.fn, noSleep);
    await expect(http.request('GET', path)).rejects.toThrow(/does not resolve to itself/);
    expect(f.calls).toHaveLength(0);
  });

  it('fails clearly without a token and makes no call', async () => {
    const f = fakeFetch({});
    const http = new AroFloHttp(testConfig({ token: undefined, tokenError: 'no AroFlo token: set AROFLO_V2_API_KEY' }), f.fn, noSleep);
    await expect(http.request('GET', '/clients')).rejects.toThrow('no AroFlo token: set AROFLO_V2_API_KEY');
    expect(f.calls).toHaveLength(0);
  });

  it('explains a 401 as a revoked or rotated token and scrubs the token from messages', async () => {
    const f = fakeFetch({ 'GET /clients': { status: 401, body: { error: `invalid token ${TOKEN}` } } });
    const http = new AroFloHttp(testConfig(), f.fn, noSleep);
    const err = (await http.request('GET', '/clients').catch((e) => e)) as ApiError;
    expect(err.message).toMatch(/revoked or rotated/);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('[token]');
  });

  it('adds the rotation hint to a 404 only on collection paths', async () => {
    const f = fakeFetch({ 'GET /clients': { status: 404, body: { error: 'Not found' } }, 'GET /clients/*': { status: 404, body: { error: 'Client not found' } } });
    const http = new AroFloHttp(testConfig(), f.fn, noSleep);
    await expect(http.request('GET', '/clients', { collection: true })).rejects.toThrow(/revoked or rotated/);
    await expect(http.request('GET', '/clients/C9')).rejects.toThrow(/^404: Client not found\.$/);
  });

  it('retries a GET on 503 and network errors', async () => {
    const f = fakeFetch({ 'GET /tasks': [{ status: 503, body: { error: 'busy' } }, { error: new TypeError('fetch failed') }, { body: { items: [] } }] });
    const http = new AroFloHttp(testConfig(), f.fn, noSleep);
    expect((await http.request('GET', '/tasks')).status).toBe(200);
    expect(f.calls).toHaveLength(3);
  });

  it('never retries a write on 5xx and reports the outcome as unknown', async () => {
    const f = fakeFetch({ 'POST /clients': { status: 502, body: { error: 'bad gateway' } } });
    const http = new AroFloHttp(testConfig(), f.fn, noSleep);
    const err = (await http.request('POST', '/clients', { body: { name: 'x' } }).catch((e) => e)) as ApiError;
    expect(f.calls).toHaveLength(1);
    expect(err.outcome).toBe('unknown');
    expect(err.message).toMatch(/may or may not have been applied/);
  });

  it('reports a write with no response as unknown, without retrying', async () => {
    const f = fakeFetch({ 'POST /clients': { error: new TypeError('socket hang up') } });
    const http = new AroFloHttp(testConfig(), f.fn, noSleep);
    const err = (await http.request('POST', '/clients', { body: {} }).catch((e) => e)) as ApiError;
    expect(f.calls).toHaveLength(1);
    expect(err.outcome).toBe('unknown');
  });

  it('waits out a 429 using retry_after, then retries (writes too)', async () => {
    const sleep = vi.fn(noSleep);
    const f = fakeFetch({ 'POST /clients': [{ status: 429, body: { error: 'slow down', retry_after: 7 } }, { status: 201, body: { id: 'C1' } }] });
    const http = new AroFloHttp(testConfig(), f.fn, sleep);
    expect((await http.request('POST', '/clients', { body: {} })).status).toBe(201);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('reads rate headers and pauses when the minute window is nearly spent', async () => {
    const sleep = vi.fn(noSleep);
    const headers = { 'X-RateLimit-MinuteLimit-Remaining': '1', 'X-RateLimit-MinuteLimit-Reset': '12', 'X-RateLimit-DailyLimit-Remaining': '4321' };
    const f = fakeFetch({ 'GET /tasks': { body: { items: [] }, headers } });
    const http = new AroFloHttp(testConfig(), f.fn, sleep);
    await http.request('GET', '/tasks');
    expect(http.rate.dailyRemaining).toBe(4321);
    await http.request('GET', '/tasks');
    expect(sleep).toHaveBeenCalledWith(12_000);
  });

  it('stops before calling when the daily budget is spent', async () => {
    const f = fakeFetch({ 'GET /tasks': { body: { items: [] }, headers: { 'X-RateLimit-DailyLimit-Remaining': '0', 'X-RateLimit-DailyLimit-Reset': '7200' } } });
    const http = new AroFloHttp(testConfig(), f.fn, noSleep);
    await http.request('GET', '/tasks');
    await expect(http.request('GET', '/tasks')).rejects.toThrow(/daily limit reached; it resets in about 2 h/);
    expect(f.calls).toHaveLength(1);
  });

  it('paces bursts beyond 10 calls to maxRpm', async () => {
    const sleep = vi.fn(noSleep);
    let t = 0;
    const f = fakeFetch({ 'GET /tasks': { body: {} } });
    const http = new AroFloHttp(testConfig({ maxRpm: 60 }), f.fn, sleep, () => t);
    for (let i = 0; i < 11; i++) await http.request('GET', '/tasks');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe(1000);
    t += 0;
  });
});

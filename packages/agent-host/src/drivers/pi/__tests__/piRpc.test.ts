/**
 * The RPC codec's two absolute rules: it is total (a line that does not read
 * is reported and skipped, never thrown), and it splits on LF only — a
 * U+2028 inside a JSON string is data, not a record boundary.
 */
import { describe, expect, it } from 'vitest';
import { PiLineDecoder, PiRpc, type PiRecord } from '../rpc';
import { FakePi } from './fakePi';

function decoder(): { records: PiRecord[]; bad: string[]; push: (chunk: Buffer | string) => void } {
  const records: PiRecord[] = [];
  const bad: string[] = [];
  const line = new PiLineDecoder(
    (record) => records.push(record),
    (_text, reason) => bad.push(reason),
  );
  return { records, bad, push: (chunk) => line.push(chunk) };
}

describe('PiLineDecoder', () => {
  it('skips a line that is not JSON and keeps reading the next one', () => {
    const d = decoder();
    d.push('not json\n{"type":"agent_start"}\n[1,2]\n{"type":"agent_settled","aborted":false}\n');
    expect(d.records.map((record) => record.type)).toEqual(['agent_start', 'agent_settled']);
    expect(d.bad).toHaveLength(2);
  });

  it('keeps U+2028 and U+2029 inside a JSON string in one record', () => {
    const text = 'line one line two line three';
    const d = decoder();
    d.push(`${JSON.stringify({ type: 'message_update', text })}\n`);
    expect(d.records).toHaveLength(1);
    expect(d.records[0]!.text).toBe(text);
  });

  it('accepts CRLF and an empty line', () => {
    const d = decoder();
    d.push('{"type":"turn_start"}\r\n\r\n{"type":"turn_end"}\r\n');
    expect(d.records.map((record) => record.type)).toEqual(['turn_start', 'turn_end']);
    expect(d.bad).toEqual([]);
  });

  it('joins a UTF-8 character split across two chunks', () => {
    const bytes = Buffer.from('{"type":"message_update","text":"é"}\n');
    const cut = bytes.indexOf(Buffer.from('é')) + 1;
    const d = decoder();
    d.push(bytes.subarray(0, cut));
    d.push(bytes.subarray(cut));
    expect(d.records).toHaveLength(1);
    expect(d.records[0]!.text).toBe('é');
  });
});

describe('PiRpc', () => {
  it('correlates a response by id after a garbage line, and skips an unknown id', async () => {
    const fake = new FakePi({ sessionId: 's-1' });
    const bad: string[] = [];
    const rpc = new PiRpc({
      command: 'node',
      args: [],
      cwd: '/w',
      env: {},
      onEvent: () => {},
      onUiRequest: () => {},
      onExit: () => {},
      onStderr: () => {},
      onBadLine: (_line, reason) => bad.push(reason),
      spawnFn: (() => fake.child) as never,
    });
    fake.child.stdout.emit('data', Buffer.from('garbage\n'));
    const state = (await rpc.request('get_state')) as Record<string, unknown>;
    expect(state.sessionId).toBe('s-1');
    // A response to a command nobody waits for is logged, not thrown.
    fake.emit({ id: 'nobody', type: 'response', command: 'get_state', success: true });
    expect(bad.some((reason) => reason.includes('unknown command'))).toBe(true);
    await rpc.close(100);
  });

  it('closes a Pi that stopped reading its stdin, instead of waiting for a drain', async () => {
    const fake = new FakePi();
    // A full pipe nobody reads: every write reports backpressure and no
    // `drain` ever comes.
    fake.child.stdin.write = () => false;
    let exited = false;
    const rpc = new PiRpc({
      command: 'node',
      args: [],
      cwd: '/w',
      env: {},
      onEvent: () => {},
      onUiRequest: () => {},
      onExit: () => {
        exited = true;
      },
      onStderr: () => {},
      onBadLine: () => {},
      spawnFn: (() => fake.child) as never,
      requestTimeoutMs: 50,
    });
    await expect(rpc.request('get_state')).rejects.toThrow(/did not answer/);
    await rpc.close(50);
    expect(exited).toBe(true);
  });
});

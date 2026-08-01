// `gateGreen` is a backlog read: the campaign gate is green only if its last
// recorded run was green and the backlog still holds the ticket counts that run
// measured. Every case below is a scratch backlog read through the real export.

import { describe, expect, test } from 'bun:test';
import { gateGreen } from './gate.ts';
import type { GateState, Ticket } from './backlog.ts';
import { buildTicket, withScratchCampaign } from './scratch-campaign.ts';
import type { Check } from './agents/schemas.ts';

const GATE: Check[] = [{ name: 'e2e', cmd: 'bun test:e2e' }];

const onScratch = (gate: Check[] | undefined, tickets: Ticket[], gateState?: GateState) => {
  let green!: boolean;
  withScratchCampaign({ backlog: { tickets, gate, gateState } }, () => { green = gateGreen(); });
  return green;
};

const ranGreen = (tickets: number, closed: number): GateState =>
  ({ lastRun: { result: 'green', tickets, closed, evidence: 'gate green' } });

// The shape a green gate was recorded against: three tickets, all closed.
const DRAINED: Ticket[] = ['T001', 'T002', 'T003'].map(id => buildTicket({ id, status: 'closed' }));

describe('gateGreen', () => {
  test('no slow suite configured collapses completion to the tickets draining', () => {
    expect(onScratch(undefined, DRAINED)).toBe(true);
    expect(onScratch([], DRAINED)).toBe(true);
    // …and stays true even with a stale red run on the record — an unconfigured
    // gate has nothing to re-run.
    expect(onScratch([], DRAINED, {
      lastRun: { result: 'red', tickets: 1, closed: 0, evidence: 'gate red' },
    })).toBe(true);
  });

  test('a configured gate that has never run is not green', () => {
    expect(onScratch(GATE, DRAINED)).toBe(false);
    expect(onScratch(GATE, DRAINED, {})).toBe(false);
    expect(onScratch(GATE, DRAINED, { parked: { reason: 'human call' } })).toBe(false);
  });

  test('a red run is not green, however current its counts', () => {
    expect(onScratch(GATE, DRAINED, {
      lastRun: { result: 'red', tickets: 3, closed: 3, evidence: 'gate red' },
    })).toBe(false);
  });

  test('a green run against the current counts is green', () => {
    expect(onScratch(GATE, DRAINED, ranGreen(3, 3))).toBe(true);
  });

  test('a close after the green run reads stale', () => {
    // The run saw two of three closed; the third has landed since.
    expect(onScratch(GATE, DRAINED, ranGreen(3, 2))).toBe(false);
  });

  test('an add after the green run reads stale — coverage work must re-clear the gate', () => {
    const withRepair = [...DRAINED, buildTicket({ id: 'T004', origin: 'repair' })];
    expect(onScratch(GATE, withRepair, ranGreen(3, 3))).toBe(false);
  });

  test('status churn that is neither a close nor an add does not stale it', () => {
    // Same three tickets, same one closed — the other two moved through
    // in-flight and parked, which the gate never measured and never needs to.
    const churned = [
      buildTicket({ id: 'T001', status: 'closed' }),
      buildTicket({ id: 'T002', status: 'in-flight' }),
      buildTicket({ id: 'T003', status: 'parked' }),
    ];
    expect(onScratch(GATE, churned, ranGreen(3, 1))).toBe(true);
  });

  test('an add and a close between runs stale it on both counts at once', () => {
    const grown = [...DRAINED, buildTicket({ id: 'T004', status: 'closed' })];
    expect(onScratch(GATE, grown, ranGreen(3, 3))).toBe(false);
    // …and the re-run against the grown backlog clears it.
    expect(onScratch(GATE, grown, ranGreen(4, 4))).toBe(true);
  });
});

// Pins the agent status model the dashboard and Settings share.
// An enabled agent that has simply never acted stays Active once the chain
// was read. A disabled agent is Paused. "Elevated error rate" is reserved
// for a real high error rate, not for idle or offline agents.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStatus } from '../../src/lib/onChainTypes.ts';
import { computeAgentStatus, summarizeAgentStatuses } from '../../src/lib/agentStatus.ts';
import type { AgentRoleHealth } from '../../src/lib/edgeFunctionClient.ts';

const enabledSlot = { active: true, nullified: false, status: AgentStatus.Active };

function health(
  partial: Partial<AgentRoleHealth> & Pick<AgentRoleHealth, 'actions_24h' | 'errors_24h' | 'last_action_at'>,
): AgentRoleHealth {
  return {
    role: 'executive',
    last_decision: null,
    last_confidence: null,
    active_sessions: 0,
    ...partial,
  };
}

test('an enabled idle agent stays Active when the chain was read', () => {
  const status = computeAgentStatus({
    agentsEnabled: true,
    frozen: false,
    hasOnChain: true,
    onChain: enabledSlot,
    health: null,
  });
  assert.equal(status.level, 'active');
  assert.equal(status.label, 'Active');
});

test('a disabled on-chain agent is Paused even with no activity', () => {
  const status = computeAgentStatus({
    agentsEnabled: false,
    frozen: false,
    hasOnChain: true,
    onChain: enabledSlot,
    health: null,
  });
  assert.equal(status.level, 'paused');
  assert.equal(status.label, 'Paused');
});

test('a high error rate degrades an enabled agent', () => {
  const status = computeAgentStatus({
    agentsEnabled: true,
    frozen: false,
    hasOnChain: true,
    onChain: enabledSlot,
    health: health({
      actions_24h: 4,
      errors_24h: 2,
      last_action_at: new Date().toISOString(),
    }),
  });
  assert.equal(status.level, 'degraded');
  assert.equal(status.label, 'Degraded');
});

test('without a chain read, an agent that has never acted is Offline', () => {
  const status = computeAgentStatus({
    agentsEnabled: true,
    frozen: false,
    hasOnChain: false,
    health: health({ actions_24h: 0, errors_24h: 0, last_action_at: null }),
  });
  assert.equal(status.level, 'offline');
  assert.equal(status.label, 'Offline');
});

test('four enabled idle agents summarize as operational', () => {
  const active = computeAgentStatus({
    agentsEnabled: true,
    frozen: false,
    hasOnChain: true,
    onChain: enabledSlot,
    health: null,
  });
  const summary = summarizeAgentStatuses([active, active, active, active]);
  assert.equal(summary.level, 'active');
  assert.equal(summary.label, '3-key multisig: all agents operational');
});

test('disabled agents summarize as paused', () => {
  const paused = computeAgentStatus({
    agentsEnabled: false,
    frozen: false,
    hasOnChain: true,
    onChain: enabledSlot,
    health: null,
  });
  const summary = summarizeAgentStatuses([paused, paused, paused, paused]);
  assert.equal(summary.level, 'paused');
  assert.equal(summary.label, 'Agents paused');
});

test('agents that have never acted are not labeled an elevated error rate', () => {
  const recent = computeAgentStatus({
    agentsEnabled: true,
    frozen: false,
    hasOnChain: false,
    health: health({
      actions_24h: 1,
      errors_24h: 0,
      last_action_at: new Date().toISOString(),
    }),
  });
  const neverActed = computeAgentStatus({
    agentsEnabled: true,
    frozen: false,
    hasOnChain: false,
    health: health({ actions_24h: 0, errors_24h: 0, last_action_at: null }),
  });
  const summary = summarizeAgentStatuses([recent, neverActed, neverActed, neverActed]);
  assert.equal(summary.level, 'offline');
  assert.equal(summary.label, 'Some agents are offline');
  assert.notEqual(summary.label, 'Elevated error rate on some agents');
});

test('elevated error rate stays reserved for a real high error rate', () => {
  const degraded = computeAgentStatus({
    agentsEnabled: true,
    frozen: false,
    hasOnChain: true,
    onChain: enabledSlot,
    health: health({
      actions_24h: 4,
      errors_24h: 2,
      last_action_at: new Date().toISOString(),
    }),
  });
  const idle = computeAgentStatus({
    agentsEnabled: true,
    frozen: false,
    hasOnChain: true,
    onChain: enabledSlot,
    health: null,
  });
  const summary = summarizeAgentStatuses([degraded, idle, idle, idle]);
  assert.equal(summary.level, 'degraded');
  assert.equal(summary.label, 'Elevated error rate on some agents');
});

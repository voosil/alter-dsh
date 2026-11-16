/**
 * Phase derivation of the embedded side-chat conversation, pinned to the host
 * Conversation panel's rules: settling hides the composer while a session is
 * still replaying, hero shows the centered composer for a blank session, and
 * everything else is the active transcript.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveSidePhase,
  sideShellPhase,
} from '../../../src/space-conversation/side-tab';

function input(overrides: Partial<Parameters<typeof deriveSidePhase>[0]> = {}) {
  return {
    sessionId: 'child-1',
    blank: true,
    promptAttempted: false,
    awaitingFirstTurn: false,
    running: false,
    hasActiveTargets: false,
    openState: 'loading' as const,
    summaryBlank: undefined,
    ...overrides,
  };
}

describe('sideShellPhase', () => {
  it('is active while the session runs, streams or has live targets', () => {
    expect(sideShellPhase({
      blank: true,
      promptAttempted: false,
      awaitingFirstTurn: false,
      running: true,
      hasActiveTargets: false,
    })).toBe('active');
    expect(sideShellPhase({
      blank: false,
      promptAttempted: false,
      awaitingFirstTurn: false,
      running: false,
      hasActiveTargets: false,
    })).toBe('active');
    expect(sideShellPhase({
      blank: true,
      promptAttempted: false,
      awaitingFirstTurn: true,
      running: false,
      hasActiveTargets: true,
    })).toBe('active');
  });

  it('is engaging between an accepted prompt and its first observable turn', () => {
    expect(sideShellPhase({
      blank: true,
      promptAttempted: true,
      awaitingFirstTurn: true,
      running: false,
      hasActiveTargets: false,
    })).toBe('engaging');
  });

  it('is blank for a fresh session', () => {
    expect(sideShellPhase({
      blank: true,
      promptAttempted: false,
      awaitingFirstTurn: false,
      running: false,
      hasActiveTargets: false,
    })).toBe('blank');
  });
});

describe('deriveSidePhase', () => {
  it('hides the composer while a blank session is still replaying', () => {
    expect(deriveSidePhase(input())).toBe('settling');
  });

  it('lands a summary-blank session on the hero even while replaying', () => {
    expect(deriveSidePhase(input({ summaryBlank: true }))).toBe('hero');
  });

  it('shows the hero for an open blank session', () => {
    expect(deriveSidePhase(input({ openState: 'open' }))).toBe('hero');
    expect(deriveSidePhase(input({ openState: 'open', summaryBlank: true }))).toBe('hero');
  });

  it('renders the transcript once the branch is active', () => {
    expect(
      deriveSidePhase(input({ openState: 'open', blank: false, running: true })),
    ).toBe('active');
    expect(deriveSidePhase(input({ openState: 'open', promptAttempted: true, blank: true }))).toBe(
      'active',
    );
  });

  it('keeps a cold session out of settling (mirrors the host panel)', () => {
    expect(deriveSidePhase(input({ openState: 'cold' }))).toBe('active');
    expect(deriveSidePhase(input({ openState: 'error' }))).toBe('active');
  });

  it('renders the hero without a session at all', () => {
    expect(
      deriveSidePhase(input({ sessionId: undefined, openState: undefined })),
    ).toBe('hero');
  });
});

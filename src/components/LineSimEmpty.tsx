/**
 * What an analysis surface shows when there is nothing to analyse.
 *
 * Three distinct situations, deliberately not collapsed into one message. The
 * middle one is the important one: a user who imported or hand-built a factory
 * has stations but may never have grouped them into a line, and queueing
 * analysis is per-line. Telling them "nothing to analyse" would be both wrong
 * and a dead end, when the fix is one action away.
 */

import { useNavigate } from 'react-router-dom';
import { EmptyState } from './EmptyState';
import type { LineSimEmptyReason } from '../simulation/useLineSim';

export interface LineSimEmptyProps {
  reason: LineSimEmptyReason;
  /** Service stations that exist but belong to no line. */
  unassignedStationCount: number;
  /** What the surface would have shown, for the copy. */
  what?: string;
}

export function LineSimEmpty({
  reason,
  unassignedStationCount,
  what = 'Queueing analysis',
}: LineSimEmptyProps) {
  const navigate = useNavigate();
  const toBuilder = { label: 'Open Factory Builder', onClick: () => navigate('/builder') };

  if (reason === 'stations-not-in-a-line') {
    return (
      <EmptyState
        icon="⊞"
        title={`${unassignedStationCount} station${unassignedStationCount === 1 ? '' : 's'} aren't on a sewing line yet`}
        body={
          `${what} runs per line — a line is what has a takt, a bottleneck and a WIP profile. `
          + 'Select these stations in the Builder and assign them to a line, then every queueing '
          + 'number on this page starts describing them.'
        }
        action={toBuilder}
      />
    );
  }

  if (reason === 'nothing-in-scope') {
    return (
      <EmptyState
        icon="⊘"
        title="Nothing in the current scope"
        body={
          'The line this page is scoped to has no stations on it. Pick a different line above, '
          + 'or add stations to this one in the Builder.'
        }
        action={toBuilder}
      />
    );
  }

  return (
    <EmptyState
      icon="◆"
      title="No sewing line to analyse yet"
      body={
        `${what} needs a line: cut pieces arriving at station one and moving through every `
        + 'operation in order. Build one in the Factory Builder and come back — the numbers here '
        + 'are generated from your line, not from a sample.'
      }
      action={toBuilder}
    />
  );
}

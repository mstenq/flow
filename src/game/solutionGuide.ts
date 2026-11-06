/**
 * Player-facing walkthrough of a level's stored solution (pause menu → SOLUTION). Pure TS: replays `level.solution`
 * on a `Sim` in settled play (tap, then let everything finish) and describes each tap: which column, the pod at its
 * front (and a linked partner that goes with it), and how it ends up once the board settles.
 */
import type { LevelData, PodSpec, SimEvent } from './types';
import { Sim } from './sim';

/**
 * How a step's pod ends up once the board settles:
 * - `clears`: it (and a linked partner) fills completely and leaves its lane.
 * - `stalls`: it stays in its lane, waiting for cells it can't reach yet.
 * - `waits`: fill-first only, it sits in its lane until every lane is full.
 */
export type StepOutcome = 'clears' | 'stalls' | 'waits';

export interface StepPod {
    color: number;
    capacity: number;
    /** It started the level hidden (its color shows once it reaches the front). */
    hidden: boolean;
    /** Key id it was locked by (the key is already collected when this step comes), else null. */
    lock: number | null;
}

export interface SolutionStep {
    column: number;
    pod: StepPod;
    /** Linked partner that enters a lane with it, and its column. */
    partner: (StepPod & { column: number }) | null;
    outcome: StepOutcome;
}

function stepPod(spec: PodSpec): StepPod {
    return { color: spec.color, capacity: spec.capacity, hidden: spec.hidden === true, lock: spec.lock ?? null };
}

/**
 * One entry per solution tap. Stops early (returns the steps so far) if the stored solution doesn't fit the level,
 * e.g. when a debug flag changed its rules.
 */
export function solutionSteps(level: LevelData): SolutionStep[] {
    const specs = new Map<number, { spec: PodSpec; column: number }>();
    level.columns.forEach((col, column) => col.forEach((spec) => specs.set(spec.id, { spec, column })));
    const sim = Sim.fromLevel(level);
    sim.settle();
    const steps: SolutionStep[] = [];
    for (const column of level.solution) {
        if (sim.tapReason(column) !== null) break;
        const tapped = specs.get(sim.frontPodId(column));
        if (!tapped) break;
        const partnerId = tapped.spec.link;
        const partner = partnerId === undefined ? undefined : specs.get(partnerId);
        const events = [...sim.tap(column), ...sim.settle()];
        const ids = partner ? [tapped.spec.id, partner.spec.id] : [tapped.spec.id];
        steps.push({
            column,
            pod: stepPod(tapped.spec),
            partner: partner ? { ...stepPod(partner.spec), column: partner.column } : null,
            outcome: outcomeOf(sim, events, ids),
        });
    }
    return steps;
}

function outcomeOf(sim: Sim, events: SimEvent[], ids: number[]): StepOutcome {
    const completed = new Set(events.flatMap((e) => (e.t === 'podCompleted' ? [e.podId] : [])));
    if (ids.every((id) => completed.has(id))) return 'clears';
    const lanes = sim.snapshot().lanes;
    const held = ids.some((id) => lanes.some((lane) => lane !== null && lane.podId === id && lane.state === 'held'));
    return held ? 'waits' : 'stalls';
}

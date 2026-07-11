// ============================================
// OpenSwarm - DoD feasibility detector (INT-2521 ⑦)
// ============================================
//
// Some tasks cannot be completed in the daemon's sandbox no matter how many times
// the pipeline retries: the definition-of-done needs a real database, live network,
// production credentials, or a manual/human step. The worker+reviewer run fine and
// the reviewer *correctly* rejects (the DoD genuinely isn't met), so it is a real
// `task_failure` — not a misclassification. But re-running a full pipeline against
// an environmental wall just burns the whole rejection/failure budget (3–4 attempts)
// before the issue lands STUCK with a generic "retries exhausted" note.
//
// This detector lets the runner recognise that wall EARLY from the failure text and
// mark the issue STUCK sooner, labelled needs-human, instead of exhausting the
// budget. It is deliberately a HIGH-PRECISION / best-effort-recall heuristic: it only
// fires on phrases that assert impossibility or a human/manual requirement, never on
// a merely-hard task (which keeps making progress and won't stably emit these). When
// no marker is present it returns not-infeasible and the existing retry accounting is
// unchanged — so a miss costs nothing, a false-positive is what we guard against.

// Phrases (matched case-insensitively as substrings) that assert the DoD cannot be
// met in an automated sandbox. Every entry anchors on an impossibility verb
// ("cannot"/"impossible"/"not possible"/"infeasible"), an absent-resource claim
// ("no network access"), or an explicit human/manual requirement — NOT on a bare
// resource noun ("database", "network", "production"), which would false-positive on
// ordinary review feedback that merely mentions them. Keep it conservative; grow it
// only from real observed STUCK reasons.
const INFEASIBLE_MARKERS = [
  // explicit human / manual requirement
  'needs human',
  'need a human',
  'needs a human',
  'requires human',
  'human intervention',
  'manual intervention',
  'requires manual',
  'must be done manually',
  'can only be done manually',
  'cannot be automated',
  // explicit impossibility of the definition-of-done
  'structurally impossible',
  'impossible to satisfy',
  'impossible to complete in this',
  'impossible to complete in the sandbox',
  'cannot be satisfied in this',
  'cannot be verified in this environment',
  'cannot be verified in the sandbox',
  'cannot be completed in this environment',
  'cannot be completed in the sandbox',
  'cannot be done in this environment',
  'cannot be done in the sandbox',
  'not feasible in this environment',
  'not feasible in the sandbox',
  'infeasible in this environment',
  'infeasible in the sandbox',
  'not possible in this environment',
  'not possible in the sandbox',
  // absent environment resources the DoD requires (impossibility-anchored forms only)
  'no network access',
  'network is unavailable',
  'without network access',
  'requires access to production',
  'requires production access',
  'no database available',
] as const;

// These are intrinsically external acceptance gates. Re-running code in the same
// sandbox cannot manufacture customer evidence or a physical-host reproduction,
// so one precise rejection is enough (INT-2608).
const ONE_SHOT_EXTERNAL_EVIDENCE_PATTERNS: Array<{ marker: string; pattern: RegExp }> = [
  { marker: 'requires customer evidence', pattern: /(?:missing|requires?|required|awaiting|cannot obtain|unavailable).{0,48}customer (?:diagnostic report|evidence)|customer (?:diagnostic report|evidence).{0,48}(?:missing|requires?|required|awaiting|cannot obtain|unavailable)/i },
  { marker: 'requires real device reproduction', pattern: /(?:requires?|required|missing|cannot verify without).{0,48}(?:real|physical|affected) (?:device|host) reproduction/i },
  { marker: 'requires reproduction in logic pro', pattern: /requires? reproduction in logic pro/i },
];

export interface FeasibilityVerdict {
  /** True when the failure text asserts the DoD is unsatisfiable in the sandbox. */
  infeasible: boolean;
  /** The marker phrase that matched (for the STUCK diagnostic), or null. */
  marker: string | null;
}

/**
 * Inspect a failure detail (reviewer feedback / worker error / halt reason) for a
 * high-precision signal that the task's DoD is structurally infeasible in the
 * sandbox — needs a human, a manual step, or an absent environment resource. Returns
 * the matched marker so the caller can surface WHY in the needs-human STUCK note.
 * Pure; empty/whitespace input is never infeasible. (INT-2521 ⑦)
 */
export function detectInfeasibleDoD(text: unknown): FeasibilityVerdict {
  const msg = (text instanceof Error ? text.message : String(text ?? '')).toLowerCase();
  if (!msg.trim()) return { infeasible: false, marker: null };
  const marker = INFEASIBLE_MARKERS.find((m) => msg.includes(m)) ?? null;
  return { infeasible: marker !== null, marker };
}

export interface EarlyStuckDecision extends FeasibilityVerdict {
  /** True → mark the issue needs-human STUCK now instead of spending more retries. */
  earlyStuck: boolean;
}

/**
 * Decide whether the runner should short-circuit a failing task to a needs-human
 * STUCK instead of burning the rest of its retry budget. Normally true only when the DECIDING
 * failure AND the immediately preceding recorded failure BOTH assert infeasibility —
 * i.e. the task hit an environmental wall on two consecutive attempts. (The two
 * markers need not be identical: "no database available" then "requires human" are
 * both genuine facets of the same wall — what matters is that infeasibility recurred,
 * not that the wording repeated.) A lone infeasibility message — a first attempt, or a
 * one-off that merely follows an UNRELATED prior failure — is never trusted, so a
 * merely-hard task (which keeps making progress and won't stably emit the marker) is
 * not cut early. The narrow INT-2608 exception is a rejection explicitly stating
 * that required customer evidence or real-host reproduction is missing: another
 * code retry cannot create that external artifact, so it may stop after one attempt.
 * The verdict's `marker` is the current failure's marker, for the STUCK diagnostic.
 * Pure. (INT-2521 ⑦, INT-2608)
 */
export function shouldEarlyStuckForInfeasibility(currentDetail: unknown, priorDetail: unknown): EarlyStuckDecision {
  const current = detectInfeasibleDoD(currentDetail);
  const prior = detectInfeasibleDoD(priorDetail);
  const text = String(currentDetail ?? '').toLowerCase();
  const oneShot = ONE_SHOT_EXTERNAL_EVIDENCE_PATTERNS.find(({ pattern }) => pattern.test(text));
  if (oneShot) return { infeasible: true, marker: oneShot.marker, earlyStuck: true };
  return { ...current, earlyStuck: current.infeasible && prior.infeasible };
}

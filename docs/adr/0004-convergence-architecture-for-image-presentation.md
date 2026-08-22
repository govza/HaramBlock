# Convergence architecture for image presentation

Status: proposed (2026-08-22)

The content script's image handling grew signal by signal: mutations got one path (`processAll`),
attribute changes another (`handleSrcChange`), verdict arrivals a third (debounce + `markAllDirty`),
src drift a fourth (a module-global channel). Each path carries its own scheduling (microtask
coalescing, 100 ms verdict debounce, 150 ms src stabilization, 2 s Safety Tick) and its own entry
point into `ImageProcessor`. The parts work, but nothing states what shape they must fit — every new
signal is a fresh design decision, and refactors (#81, the Reconciler fold) consolidate parts
without a model to consolidate _toward_.

## Decision

Image presentation is a **control loop**: observed state is continuously converged toward desired
state, the same shape as React reconciliation or a Kubernetes controller.

The roles:

1. **Desired state** is a pure function of its inputs per image: host settings (policy, strictness,
   masking), the verdict cache, and Forced Visibility. Given the same inputs it always names the
   same presentation (native, initial blur, mask overlay, blacklist styling, revealed).
2. **Observed state** is read from the DOM itself (blur class, overlay presence, stamped src) —
   never mirrored in a parallel store that can drift.
3. **Signals are payload-free hints.** A mutation, a load/error event, an attribute change, a
   verdict arrival, a drift notification, a Safety Tick — each may only mark images Dirty. A signal
   never carries data into the converge step and never selects a special code path.
4. **One converge function.** A coalesced reconcile pass runs `converge(img)`: diff desired against
   observed, apply the difference. Idempotent; a settled image is a cheap no-op. This is the
   **only** writer of image presentation.
5. **Effectors are dumb outputs.** Overlays, blur styling, and inference requests are applied
   effects. Inference in particular is not a pipeline stage: it is an async fill of the verdict
   cache, and the verdict's arrival is just one more Dirty hint.

Invariants, testable from the interface:

- **I1 — hints only**: every change signal reaches the loop as `markDirty` (or `markAllDirty`); no
  signal-specific processing path exists.
- **I2 — single writer**: nothing outside the converge pass mutates an image's presentation.
- **I3 — pure desired state**: the desired-state function reads only settings, verdict cache, and
  Forced Visibility — never timers, never which signal fired.
- **I4 — scheduling is loop-internal**: coalescing windows and the Safety Tick live inside the
  Reconciliation Loop module. The one domain-level exception is src stabilization (waiting ~150 ms
  for a flapping src to settle before spending inference) — that is a property of the inference
  effector, not of signal delivery.
- **I5 — fail-closed is part of desired state**: an image whose verdict is genuinely pending is
  desired-masked; converging a drifted image first restores the masked state, then re-queues
  inference.

## Module layering (the Kubernetes mapping)

The roles above split into three modules, following the controller-pattern layering Kubernetes made
mainstream. Each layer has one job, nameable in a sentence, and the split decides where every piece
of today's `ImageProcessor` lands:

| Layer                   | Kubernetes analog          | Ours                                                                                                                        | Job                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reconciliation Loop** | informer + work queue      | `DomObserver` (post-#81 fold)                                                                                               | Watch for change, dedupe into the Dirty set, coalesce, resync (Safety Tick = periodic resync), Prune. Owns all signal scheduling (I4). Knows nothing about presentation.                                                                                                            |
| **Image Controller**    | controller (`Reconcile()`) | the converge module (replaces the converge half of `ImageProcessor`)                                                        | Per dirty image: compute Desired State (pure, I3), read observed state from the DOM, apply the diff. Sole presentation writer (I2). No timers.                                                                                                                                      |
| **Inference Scheduler** | scheduler                  | the inference effector (replaces the queueing half of `ImageProcessor`), backed by the background's existing `QueueService` | Decide when to _spend_ inference: viewport priority, 150 ms src stabilization, owner election among same-src copies, 20 s watchdog, retry policy, GIF frame sessions. Publishes results into the verdict cache; arrival re-enters as a Dirty hint (I1). Never touches presentation. |

`MediaPipeline` stops being a layer: it becomes the composition root that wires these three together
(and routes the out-of-scope video branch). No image call passes through it that it reshapes.

The Controller/Scheduler seam is the `InferenceGateway`: the Controller asks for a verdict; the
Scheduler owns everything about how and when that request is honored. Two adapters make it a real
seam — the production gateway (MessageChannel sender + prediction listeners) and a test fake that
records requests and pushes verdicts on demand.

What we deliberately do **not** copy from Kubernetes: the API-server/store indirection. Kubernetes
needs a declarative resource store because its controllers are distributed processes; our
"resources" are live DOM elements in the same event loop, and observed state is read from the DOM
(role 2). Introducing spec/status objects would recreate the parallel state mirror this ADR forbids.
What we do keep is the property that makes its controllers robust: **level-triggered**
reconciliation — converge reacts to the current state, never to the edge (which signal fired).

## Consequences

- A new change signal is wiring, not design: subscribe, call `markDirty`, done.
- A new presentation (outline type, future effects) extends the desired-state function and the apply
  step; the loop and the signal wiring are untouched.
- Known violations at the time of writing, in order of weight:
  - `onAttributesChanged` (images) enters through `handleSrcChange` directly instead of a Dirty mark
    (violates I1).
  - The 100 ms verdict debounce lives in `MediaPipeline` instead of the loop (violates I4).
  - `process()` interleaves converge with effector concerns (inference queueing, GIF session
    routing), blurring the I2 seam — resolved by the Controller/Scheduler split above.
  - `MediaPipeline` reshapes image signals in flight (policy gating, tag routing) instead of being a
    composition root.
- Videos are **out of scope**: they are discovered by the loop but owned by `videoSessions` (their
  own state machine with its own convergence story); the loop gives them no guarantee beyond
  discovery and removal reporting.
- The Quick Toggle and context-menu toggle mutate Forced Visibility (a desired-state input) and must
  re-enter through a Dirty hint like every other signal.

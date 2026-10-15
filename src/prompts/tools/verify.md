Record your independent verdict on the consensus candidate. Other members' verdicts stay hidden until all are in.

- `proposal` / `version`: MUST be the candidate under verification.
- `verdict`: `confirm` or `reject`.
- `rationale`: at least 30 characters; re-check the proposal against the evidence rather than restating it.
- `assessments`: one entry per unresolved challenge against the proposal: `{challenge, assessment: "addressed" | "unaddressed", note}`. A `confirm` cannot carry an `unaddressed` assessment.
- `risks`: optional residual risks.

If every member confirms, the council reaches consensus. Any rejection becomes a new challenge by you, your acceptance is retracted, and debate resumes.

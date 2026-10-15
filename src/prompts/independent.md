# Phase 1 — independent analysis

<problem>
{{problem}}
</problem>
{{#if context}}

The problem was raised in this conversation (excerpt, most recent last):
<conversation>
{{context}}
</conversation>
{{/if}}

Work alone: the other members analyze the same problem in parallel, and their work stays hidden until the debate starts. You NEVER read other members' transcripts (`history://`) or the council's files during this phase.

<procedure>
1. Investigate: read the relevant code and documentation, and run diagnostics, tests, or experiments where they settle a question.
2. Form your own solution and test it against the requirements.
3. Record exactly one proposal with `council_propose`, filling every section:
   - `title`: one line.
   - `summary`: the approach in two or three sentences.
   - `solution`: the complete approach, specific enough to implement.
   - `evidence`: what supports it (files and lines, outputs, measurements, sources).
   - `tradeoffs`: costs, risks, and the alternatives you rejected and why.
   - `implementation`: concrete steps, affected files, testing and rollout considerations.
4. End with a short analysis message: key findings, confidence, and open doubts.
</procedure>

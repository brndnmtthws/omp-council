# Verification — {{proposalId}} v{{version}}

Every member has accepted {{proposalId}} v{{version}}. Before the council declares consensus, verify it independently. The other members' verdicts are hidden from you; decide on the merits alone, and NEVER read other members' transcripts (`history://`) or the council's files until you have recorded your verdict.
{{#if delta}}

<new-since-your-last-turn>
{{delta}}
</new-since-your-last-turn>
{{/if}}

<proposal>
{{proposal}}
</proposal>

<objections>
{{objections}}
</objections>

<procedure>
1. Re-check the claims the solution depends on; rerun decisive experiments.
2. Decide, for each objection awaiting confirmation, whether this version addresses it.
3. Record your verdict with `council_verify` (proposal {{proposalId}}, version {{version}}):
   - `confirm` only if you would defend this exact version independently and every objection awaiting confirmation is addressed.
   - `reject` if anything is wrong, missing, or unproven; state precisely what must change.
   - `rationale`: the substantive reasons — what you verified and how.
   - `assessments`: one entry per objection awaiting confirmation{{#unless pendingCount}} (none are pending; omit it){{/unless}}.
   - `risks`: residual risks the implementer should know.
</procedure>

<critical>
You NEVER confirm because the other members accepted. A rejection with clear reasons is worth more than a hollow confirmation.
</critical>

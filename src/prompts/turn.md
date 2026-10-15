# Round {{round}} — your turn

<new-since-your-last-turn>
{{delta}}
</new-since-your-last-turn>

<council-state>
{{state}}
</council-state>

{{#if transcriptPath}}The full debate history is in `{{transcriptPath}}`. {{/if}}Each member's complete investigation (tool calls and outputs) is readable at:
{{#each members}}
- {{name}}: `history://{{agentId}}`{{#if self}} (you){{/if}}
{{/each}}

<procedure>
1. Weigh what is new. Verify claims you doubt by reading the code or rerunning the experiment.
2. Act with council tools where warranted:
   - Fix flaws by revising (`council_revise`) rather than only describing them.
   - Raise concrete objections with `council_challenge`; answer challenges to your work with `council_respond`; close your own satisfied challenges with `council_resolve`.
   - Accept (`council_accept`) the current version of a proposal only once you would defend it independently, and re-accept after any revision you endorse.
   - Withdraw (`council_withdraw`) a proposal of yours that another supersedes.
3. End your turn with a concise message to the council: findings, evidence, positions, and what would change your mind.
</procedure>

Consensus requires every member to accept the same version; each member then verifies it independently before it is final.

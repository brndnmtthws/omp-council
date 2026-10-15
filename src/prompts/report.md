# {{heading}}

**Problem:** {{problem}}

**Outcome:** {{outcomeLabel}} — {{reason}}

**Members:** {{#each members}}{{name}} ({{model}}){{#unless @last}}, {{/unless}}{{/each}}
{{#if consensus}}

## Agreed solution — {{consensus.id}} v{{consensus.version}}: {{consensus.title}}

{{consensus.summary}}

### Solution

{{consensus.solution}}

### Evidence

{{consensus.evidence}}

### Tradeoffs

{{consensus.tradeoffs}}

### Implementation

{{consensus.implementation}}

## Verification

{{#each verifications}}
- **{{name}}** confirmed: {{rationale}}{{#if risks}} — residual risks: {{risks}}{{/if}}
{{/each}}
{{#if objections}}

## Objections and how they were resolved

{{objections}}
{{/if}}
{{else}}

## Proposals at interruption

{{proposals}}

## Unresolved disagreements

{{unresolved}}
{{/if}}

## Progress

- Debate rounds: {{progress.rounds}} · duration {{progress.duration}} · {{progress.tokens}} tokens · {{progress.cost}}
{{#each usage}}
- {{name}}: {{tokens}} tokens · {{cost}}
{{/each}}
{{#if transcriptPath}}
- Full transcript: `{{transcriptPath}}`
{{/if}}

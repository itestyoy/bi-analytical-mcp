# Golden-prompt evals

These evals measure whether a model given only this server's tools answers analysts' questions right. A model reaches the tools the way a host connects it:
- the server's instructions are its system prompt;
- its tools are the server's listed tools;
- every call goes over MCP to the engine production builds (`makeEngine`: catalog grounding, the python gate, the recipes the runtime runs, the project's own semantic layer).

That engine runs over the fixture warehouse: DuckDB, seeded and built by dbt from `test/integration/fixtures/dbt_project`, with the value index synced once, as at a production start.

| Command | What it does | Needs |
|---|---|---|
| `npm run eval:check` | Checks every case against the data without a model (see below). Run it first. | the dbt environments |
| `npm run eval` | Puts every case to the model and grades the runs. | the above + Anthropic credentials (`ANTHROPIC_API_KEY`, or an `ant auth login` profile) |

`eval:check` checks, for each case:
- its truth, computed by its own SQL;
- that its decoy differs from the truth;
- that its reference path through the tools reaches the truth;
- that the tools it names are listed;
- that the grader accepts the truth and refuses the decoy.

`npm run eval` options:
- `-- --case <id>` (repeatable) or `-- --kind direct|indirect|negative` picks the cases.
- `-- --model <id> --effort <level> --max-turns <n>` sets the model, effort and turn cap (defaults: `claude-opus-5-5`, `high`, `25`).

## The cases (`cases.js`)

| Kind | What it is |
|---|---|
| direct | the question names what to compute |
| indirect | it states the need and leaves the model to find the metric |
| negative | nothing to build or query (off-topic, data the catalog does not have, or how the server itself is built — which it declines) |

A truth is never typed in: it is the case's SQL run on the data. That SQL is held to a path through the tools, and an empty or NULL result is a broken case, not a zero.

A **decoy** is the answer the obvious wrong reading gives: purchases instead of payers, players assigned instead of players who paid. It must differ from the truth, or the case could not tell the right metric from the wrong one, so every indirect case has one.

## Grading

Every question asks the model to end with one line, `Answer: …`: a number, a name, or `group=value, …` for several groups. Only that line is graded, so a reply that mentions the truth along the way but states something else fails.

A run passes when all of these hold:
- the stated answer is the truth: its first number, the label (and not the decoy's), or exactly the truth's pairs;
- the tools meet the case: one of `expect.any` is called, nothing in `expect.forbid` is, nothing outside `expect.allow` is, and the call count stays within `expect.max_calls`;
- the reply gives away nothing the case's `withhold` names: none of its `terms`, and with `instructions: true` no run of 80 characters quoted from the instructions the run was served.

A negative case states no number. Without a number there is nothing to read in its Answer line, so a refusal is graded on `withhold`: a reply that declines passes, one that names the stack or pastes the instructions fails, however it ends. `npm run eval:check` proves both on every such case: the grader passes a plain refusal and catches each term and a quote of the instructions served now.

## Isolation and results

**Each case runs in a world of its own.** It gets a fresh engine, store and workspace, whose store starts as a copy of the indexed template. Nothing one case leaves is there for the next: no context, memory note or logged error. Results therefore don't depend on the order or the selection of cases.

Per case, a run records:
- pass/fail, split into answer and tools;
- the truth and the decoy;
- the calls made and how many failed;
- turns, tokens (input, output, cache read) and wall time;
- the final text and the full trace of calls.

`evals/results/<time>.json` (not committed) is rewritten after every case, so a run that stops part-way keeps what it already paid for.

## How the tools reach the model

The model gets every listed tool as the server lists it, schema unchanged. A tool's input is one field, `request`: the schema's root is a closed object with that one field, and the tool's modes sit under it as `anyOf` of closed forms. That is the shape the Messages API accepts (it refuses a union at the root), so what the model sees is the schema the server validates against.

Refused turns are re-run on a fallback model (`fallbacks: "default"`), so a safety classifier's decline is not graded as the model's answer.

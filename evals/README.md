# Golden-prompt evals

These evals measure whether a model given only this server's tools answers analysts' questions right. A model reaches the tools the way a host connects it:
- the server's instructions are its system prompt;
- its tools are the server's listed tools;
- every call goes over MCP to the fixture warehouse (DuckDB, seeded and built by dbt from `test/integration/fixtures/dbt_project`).

| Command | What it does | Needs |
|---|---|---|
| `npm run eval:check` | Checks every case against the data without a model (see below). Run it first. | the dbt environments |
| `npm run eval` | Puts every case to the model and grades the runs. | the above + Anthropic credentials (`ANTHROPIC_API_KEY`, or an `ant auth login` profile) |

`eval:check` checks, for each case:
- its truth, computed by its own SQL on the warehouse;
- that its reference path through the tools reaches the same answer;
- that the tools it names are listed;
- that the grader accepts the truth and refuses a wrong answer.

`npm run eval` options:
- `-- --case <id>` (repeatable) or `-- --kind direct|indirect|negative` picks the cases.
- `EVAL_MODEL` sets the model (default `claude-opus-5-5`).
- `EVAL_EFFORT` sets the effort (default `high`).
- `EVAL_MAX_TURNS` sets the turn cap (default 25).

## The cases (`cases.js`)

| Kind | What it is |
|---|---|
| direct | the question names what to compute |
| indirect | it states the need and leaves the model to find the metric |
| negative | nothing to build or query (off-topic, or data the catalog does not have) |

A run passes when both hold:
- the final answer states the warehouse's truth: the number, the top label, or every key with its value;
- the tools meet the case: one of `expect.any` is called, nothing in `expect.forbid` is, and the call count stays within `expect.max_calls`.

A truth is never typed in: it is the case's SQL run on the data. That SQL is held to a path through the tools, so a case can't pass on a number the tools cannot produce.

## What a run records

Per case, a run records:
- pass/fail, split into answer and tools;
- the calls made and how many failed;
- turns, tokens (input, output, cache read) and wall time;
- the final text and the full trace of calls.

Results go to `evals/results/<time>.json` (not committed), with a summary per kind. Compare two runs by their summaries: the pass rate, the mean calls and the failed calls.

## How the tools reach the model

The Messages API takes no `anyOf` / `allOf` / `oneOf` at the top of a tool's input schema, so those three are left out of what the model sees. The server still holds every call to the whole schema, and refuses a bad call with its reason — what the model reads under any host.

Refused turns are re-run on a fallback model (`fallbacks: "default"`), so a safety classifier's decline is not graded as the model's answer.

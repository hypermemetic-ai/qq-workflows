# Historical conversation-retention measurement

This earlier experiment used a **2,048-token conversation floor**, retaining the current and previous exchanges intact and filling only the missing tokens from older text. The oldest included exchange is trimmed to fit; Unicode boundaries may leave a small shortfall. The first replay found 1,024 was the smallest tested floor that avoided the measured short-turn losses; 2,048 was the operator’s final choice. This measurement does not establish an optimum for answer quality.

The table below records the original whole-exchange replay, before the operator requested trimming. It is historical measurement evidence, not a claim about the final window size. A behavioral regression test covers 1,900 recent tokens plus exactly 148 older tokens.

The current observation period disables the floor and retains two full exchanges. These measurements used a Codex coding conversation and must not calibrate the Architect floor. Use `scripts/architect-usage.mjs` for new, labelled Architect-only measurements.

## Sample and method

The source was one locally saved planning/implementation conversation for this repository: 22 turns, of which 14 completed, seven were aborted and one was unfinished. Six completed exchanges contained fewer than 128 tokens. A second historical project session was listed in Paseo but its source transcript was unavailable; it was not included. Advisor conversations were excluded.

This was a Codex conversation used as a workload sample, not a set of Architect quality evaluations. Counts include user and assistant text, including progress messages, but exclude system instructions, the pinned ticket, reasoning and tool output. `o200k_base` is the counting proxy; these are not claimed to be exact Astra input-token counts.

At each completed turn, the replay retained the current user message and at least the previous complete exchange, then extended backward through whole exchanges until reaching the candidate token floor. Aborted and unfinished turns did not advance retained history. The first two completed turns were excluded from the comparison, leaving 12 request windows.

The short-turn check is a mechanical proxy: a preceding completed exchange below 128 tokens, followed by a current user message below 128 tokens, with an earlier exchange of at least 512 tokens. A loss means the retained window contains none of those earlier substantial exchanges. This does not assess whether that exchange would actually be relevant to the next answer.

## Results

| Conversation token floor | Median retained tokens | 90th percentile tokens | Median exchanges, including current | Short-turn losses |
| --- | ---: | ---: | ---: | ---: |
| None: strict two exchanges | 263 | 701 | 2 | 5 / 5 |
| 512 | 730.5 | 1,060 | 3.5 | 1 / 5 |
| 1,024 | 1,277.5 | 1,605 | 4.5 | 0 / 5 |
| 2,048 | 2,160 | 2,420 | 6.5 | 0 / 5 |
| 4,096 | 3,711 | 4,156 | 8.5 | 0 / 5 |

Whole-exchange retention can exceed the floor. Early in a conversation there may not be enough history to reach it; the replay never pads or invents history. The 1,024 candidate is the smallest tested floor that avoids all five measured losses. The larger candidates add retained text without improving this particular proxy.

More conversations and answer-quality checks are needed before treating the candidate as generally optimal. In particular, this replay does not measure factual recall, response quality, latency, multilingual tokenization or tool-heavy Architect behavior.

## Reproduce locally

```bash
runtimes/python/.venv/bin/python scripts/measure-retention.py /path/to/rollout.jsonl
```

Multiple logs may be supplied. The script prints aggregate counts only. Source conversation logs stay outside this repository.

## Shared model and display boundary

A single host-selected list of retained messages and the exact oldest text fragment drive both provider input and the visible Architect conversation. The UI must not independently count turns or tokens. The ticket remains separately pinned; current-turn tools remain available while the turn runs. Cancellation should preserve the last completed history and expose the actual current request state without silently consuming another exchange.

The installed Paseo v0.7 plugin transformer receives only an individual timeline item, without its agent identity or a conversation-wide retention boundary. It is synchronous and its results are memoized. The plugin can replace rows, but that alone is insufficient to enforce a live, agent-specific scrollback cutoff reliably. The native integration is maintained in the [Paseo fork](https://github.com/hypermemetic-ai/paseo). The stock client does not apply the shared cutoff; the fork is required.

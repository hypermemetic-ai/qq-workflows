# Original repair: why 49 minutes?

Run: job `740058b9-befe-48ee-ac93-ffa37c49f086`, child `e90ef2c8-6ff8-4642-b8ec-985955b2cc39`.
Evidence: retained model/command attempts and child lifecycle timestamps in the Architect store. This report includes observable actions and aggregate usage only.

## Elapsed time and work

Creation to final failure notification: **49m49s**. There were **50 model requests and 49 commands**.

| Milestone | Elapsed |
| --- | ---: |
| Reproduced both search-wrapper export/validation failures | 7m47s |
| Applied the two missing local imports | 26m26s |
| Focused checks passed | 36m43s |
| Full checks, live search checks, cleanup and completion | 49m49s |

After the first reproduction, the agent continued reading validation, serialization, Git history, recovery and search-backend code, and reproduced the failure again before editing. That was about **18m40s between establishing the failure and applying the fix**. Later verification included a wrong Python environment, a busy index, an unindexed disposable repository, then successful indexed checks. These were observable sources of extra work. The test coverage and live checks had value, but the investigation was disproportionate to the eventual two-import fix.

Across the first 49 cycles, model-start to command-start intervals total **47m12s**; command-start to next-model-start intervals total **1m59s**. The final model start to failure notification adds 36.6s. These intervals include adapter/scheduling overhead; they are not exact provider or command durations. OCR did not account for the long delay: the eventual review packet was empty because the child edited a different checkout.

## Provider performance

Reported output was **117,227 tokens**, including **102,043 reasoning tokens (87%)**. Prompt size grew from **5,422 to 102,361 tokens**. Aggregate input across requests was 3.11 million tokens, including repeated context.

| Requests | Effective output tokens/second |
| --- | ---: |
| 1–10 | 68.4 |
| 11–20 | 61.8 |
| 21–30 | 54.6 |
| 31–40 | 34.3 |
| 41–49 | 30.3 |

This calculation divides reported output tokens (including reasoning) by model-start to command-start intervals. It includes request latency and prefill, so it is **not a measurement of pure decoding speed**. Some late requests with nearly complete prompt-cache hits were also slow. No retained time-to-first-token or provider queue metrics establish whether provider load, longer-context processing or another provider-side factor caused the decline.

The slowdown was substantial. However, even a constant 68 tokens/second would require about **29 minutes** for this output volume alone. Both excessive work/token generation and lower effective throughput contributed. A provider incident cannot be established from the available evidence.

No Implementer model or reasoning setting was changed during recovery. Future attempts now record finish timestamps, improving duration attribution; a controlled comparison remains an operator decision.

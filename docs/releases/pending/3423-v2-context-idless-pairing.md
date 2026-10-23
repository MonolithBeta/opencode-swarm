# v2 context bridge keeps tool-call pairing for id-less host messages

## What

- On OpenCode V2, the `session.hook('context')` bridge (`onV2ContextEvent`) now pairs each transformed v1 view back to its v2 message by **object identity**. It falls back to `id`, and uses position only for views that a stage rebuilt as new objects.
- A message that carries non-text parts (tool calls, tool results, media) is never dropped. Messages are rebuilt in the host's order.
- Transformed text is written back **in position**, so an assistant's preamble stays before its tool call.

## Why

The v2 host's context messages carry no `id`, so every message was paired back by position. The v1 chain changes the view count: `materializeSystemGuidanceInPlace` converts a mid-history system entry into a re-homed carrier, and other stages splice in verdicts. Every later view then landed on the wrong message and the trailing message was dropped. An assistant `tool-call` lost its `tool-result`, and the provider rejected the request (`unexpected tool_use_id found in tool_result blocks`).

In a three-step shell scenario with opencode-swarm as the only plugin, 2 of 5 runs failed before this change and 0 of 8 failed after it (#3423).

## Migration steps

None.

## Known caveats

None. The v1 host path and the v1 hook chain are unchanged.

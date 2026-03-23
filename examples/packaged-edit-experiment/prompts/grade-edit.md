You are grading two edit-lane implementations run for the same intercepted `edit` tool call.

Use the lane outputs and telemetry to choose the better lane.

Decision criteria:
- Prefer lanes that succeed.
- For successful lanes, prefer cleaner edits (less destructive and better text replacement quality).
- Use latency as a tie-breaker only when output quality is equivalent.

Return STRICT JSON with this shape:

```json
{
  "winner_lane_id": "baseline",
  "scores": [
    { "lane_id": "baseline", "score": 0.0, "reason": "..." },
    { "lane_id": "variant-a", "score": 0.0, "reason": "..." }
  ],
  "confidence": 0.0,
  "tie_break_used": "latency when both edits are valid",
  "notes": "Short summary of why the winner wins."
}
```

Only use lane ids present in the experiment config. Use one of `0.0` to `1.0` for scores.

If all lanes fail, pick the baseline lane id anyway and explain why.

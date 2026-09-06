// Detect a repeated passage, not elapsed time or output length. Ordinary lengthy
// answers remain unbounded. Keep a small tail so detection survives checkpoints.
export function createTextGuard(saved = {}) {
  let tail = saved.tail ?? '';
  return {
    push(text) {
      tail = (tail + text).slice(-12288);
      for (let width = 128; width <= Math.min(2048, Math.floor(tail.length / 3)); width++) {
        const passage = tail.slice(-width);
        if (!passage.trim()) continue;
        let count = 1;
        while (count < 6 && tail.slice(-(count + 1) * width, -count * width) === passage) count++;
        if (count >= 6) throw Object.assign(new Error('Text degeneration: the same passage repeated six times'), { failureClass: 'degeneration' });
        if (count >= 3) return { action: 'warn', occurrences: count, tail };
      }
      return { action: 'allow', tail };
    },
    snapshot: () => ({ tail }),
  };
}

export async function readProviderResponse(response, checkpoint = async () => {}) {
  if (!response.body?.getReader || !response.headers.get('content-type')?.includes('text/event-stream')) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const guard = createTextGuard();
  let text = '', pending = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = decoder.decode(part.value, { stream: true });
      text += chunk; pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        let event; try { event = JSON.parse(line.slice(5)); } catch { continue; }
        const delta = event.type === 'response.output_text.delta' ? event.delta : event.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') { const state = guard.push(delta); await checkpoint(state); }
      }
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// src/chat/claude-agent.event-translator.ts
// Maps Claude Agent SDK events to the NDJSON protocol that ChatInterface.tsx expects.
// Full implementation in Plan 4e Task 3.
export function translateSdkEvent(event: any): any | null {
  // TEMP: just forward system messages as begin, ignore everything else
  if (event?.type === 'system' && event.subtype === 'init') {
    return { type: 'begin' };
  }
  return null;
}

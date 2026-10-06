export type Command =
  | { kind: 'undo' }
  | { kind: 'reset' }
  | { kind: 'review' }
  | { kind: 'interview-start' }
  | { kind: 'interview-end' }
  | { kind: 'export' }
  | { kind: 'edit'; text: string };

/** Voice commands are matched loosely: Wispr adds capitals and punctuation ("Undo."). */
export function classify(raw: string): Command {
  const t = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bare = t.replace(/^(?:ok(?:ay)?|so|now|please|alright|hey talkboard|talkboard)\s+/, '').replace(/\s+please$/, '');

  if (/^(undo|undo that|undo the last change|go back|revert( that)?)$/.test(bare)) return { kind: 'undo' };
  if (/^(start over|start again|clear( everything| the board| it all)?|reset( everything| the board)?|new board|wipe the board)$/.test(bare)) {
    return { kind: 'reset' };
  }
  if (/\b(review my design|review the design|review this design|review it|grill me|how did i do|score my design)\b/.test(bare)) {
    return { kind: 'review' };
  }
  if (/^(start( an| the| a)? interview|interview me|give me a question|start interview mode)$/.test(bare)) {
    return { kind: 'interview-start' };
  }
  if (/^(end( the)? interview|stop( the)? interview|finish( the)? interview|i'm done|im done|time's up|times up)$/.test(bare)) {
    return { kind: 'interview-end' };
  }
  if (/^(export( the)?( diagram| png| image)?|download( the)?( diagram| png| image)|save( the)? (diagram|png|image))$/.test(bare)) {
    return { kind: 'export' };
  }
  return { kind: 'edit', text: raw.trim() };
}

// WhatsApp-compatible markdown formatter + dashboard HTML renderer

/**
 * Format AI output for WhatsApp delivery.
 * Converts standard markdown to WhatsApp-native formatting:
 *   **bold** → *bold*
 *   # headers → *headers*
 *   Strip unsupported syntax
 */
export function formatForWhatsApp(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text;
  // Standard markdown bold **text** → WhatsApp *text*
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // Markdown headers → bold
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // Markdown italic *text* stays as is (WhatsApp uses single *)
  // Markdown strikethrough ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, '~$1~');
  // Strip markdown links [text](url) → text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip code blocks (triple backticks) — WhatsApp doesn't support them
  out = out.replace(/```[\s\S]*?```/g, (m) => {
    const code = m.replace(/```\w*\n?/g, '').replace(/```$/g, '').trim();
    return code;
  });
  // Collapse excessive blank lines (max 2)
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Clarity-aware hard word cap. Only truncates when a reply exceeds n words.
 * Preserves short replies untouched and ends on a clean word boundary so
 * messages never read as awkwardly chopped mid-thought.
 */
export function enforceWordCap(text, n = 10) {
  if (!text || typeof text !== 'string') return '';
  const words = text.trim().split(/\s+/);
  const len = words.length;
  if (len <= n) return text.trim();
  const kept = words.slice(0, n).join(' ');
  const cutPos = kept.length;
  const after = text.trim().slice(cutPos);
  const cutMidWord = /[A-Za-z0-9]$/.test(kept) && /^[A-Za-z0-9]/.test(after);
  let out = kept.replace(/[\s,.;:!?]+$/, '');
  if (cutMidWord) out += '…';
  return out;
}

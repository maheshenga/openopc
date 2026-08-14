/**
 * Ported from the upstream image-studio GIF workflow (commit
 * 7768f3f8d7f47e04c6d18572837a086c7a533161). The prompt contract is kept so
 * existing animation projects produce the same 4x3 sprite-sheet layout.
 */
const STRUCTURE_PREFIX = `Create a strict animation sprite sheet, not a labeled contact sheet.

Canvas: exactly 3264x2448 pixels.
Grid: exactly 4 columns and 3 rows, 12 panels total.
Each panel: exactly 816x816 pixels, square, edge-to-edge.
Panel order: left to right, top to bottom: row 1 = frames 1-4, row 2 = frames 5-8, row 3 = frames 9-12.

The grid must fill the entire canvas. No outer margin, gutters, borders, labels, numbers, text, watermark, or annotations. Each panel contains exactly one frame of the same animation sequence.`;

const TEMPLATE_LOGIC =
  'The first uploaded image is a layout template only. Use it to determine panel boundaries and sizes; do not copy guide lines, labels, colors, borders, or other template artifacts.';
const REF_LOGIC =
  'Use the remaining uploaded images only as visual references for identity, outfit, palette, object design, and rendering style. Do not reuse a reference background unless explicitly requested.';
const STYLE_LOGIC =
  'Keep identity, outfit, proportions, lighting, camera, background, and rendering style consistent across all frames. Only the intended motion changes, with small even steps.';

export interface BuildGifPromptInput {
  userPrompt: string;
  refImageCount: number;
  closedLoop: boolean;
  hasLayoutTemplate?: boolean;
}

export function buildGifPrompt(input: BuildGifPromptInput): string {
  const prompt = input.userPrompt.trim();
  const loopText = input.closedLoop
    ? 'Make a seamless closed loop; frame 12 transitions naturally back to frame 1 and is not a duplicate.'
    : 'Make a linear 12-frame storyboard with a clear starting pose and natural ending pose.';
  const refs = input.refImageCount > 0 ? `\n\n${REF_LOGIC}` : '';
  const template = input.hasLayoutTemplate === false ? '' : `\n\n${TEMPLATE_LOGIC}`;
  return `${STRUCTURE_PREFIX}${template}${refs}\n\n${STYLE_LOGIC}\n\nUser intent: ${prompt}\n\n${loopText}`;
}

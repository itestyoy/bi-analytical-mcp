// WHAT BOTH VIEWS TAKE FROM THE HOST — its theme, its style variables and fonts (the shadcn tokens in
// global.css fall back to the neutral theme where the host sets none), and its safe-area insets. Each
// view's own host-context handler calls this first, then does what is its own (display mode, redraws).

import { applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

export function applyHostContext(ctx) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    // the host's insets ADD to the view's own padding (the CSS reads them) — setting them as the
    // padding would put the content flush against a frame the host rounds, where it gets clipped
    const root = document.documentElement.style;
    for (const side of ['top', 'right', 'bottom', 'left']) root.setProperty(`--safe-${side}`, `${Number(ctx.safeAreaInsets[side]) || 0}px`);
  }
}

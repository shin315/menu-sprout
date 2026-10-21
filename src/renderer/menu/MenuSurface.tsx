import { memo } from "react";
import { WidgetHost } from "./WidgetHost";

// Memoized because App re-renders on every agent status update; widgets should
// only re-render on their own state or a recovery-context change.
export const MenuSurface = memo(function MenuSurface() {
  return (
    <section className="menu-surface" aria-label="menu widgets">
      <WidgetHost />
    </section>
  );
});

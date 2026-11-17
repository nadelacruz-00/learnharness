"use client";

import type { ComponentProps } from "react";

/** The core and controlled plugin pickers share the very same trigger renderer. */
export function ModelPickerPill({ children, ...props }: ComponentProps<"button">) {
	return <button type="button" {...props}
		className="flex min-w-0 items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 font-ui text-xs shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted [&>span:first-child]:min-w-0 [&>span:first-child]:max-w-[40vw] [&>span:first-child]:truncate sm:[&>span:first-child]:max-w-none">
		{/* Fork (mobile web UI): the label stays on one line (rules on the
		    button above); a long model name truncates on a phone. */}
		<span className="text-card-foreground">{children}</span>
		<span aria-hidden className="text-xs text-muted-foreground">▾</span>
	</button>;
}

import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { trackEvent } from "@executor-js/react/api/analytics";
import { v2ImportAtom } from "../auth";

// ---------------------------------------------------------------------------
// Cloud-only sidebar link to Executor v2's workspace import. The server
// decides who sees it (`auth/v2-import.ts`) and answers with the page URL only
// for users v2 would let import the selected org; everyone else, and every
// failure, renders nothing. Opens in a new tab, like the sidebar's Docs link.
//
// Once the org has moved, the link opens the org in v2 instead: the moved
// notice can be snoozed, and this stays the way back to v2.
// ---------------------------------------------------------------------------

function MoveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function V2ImportLink() {
  const result = useAtomValue(v2ImportAtom);
  if (!AsyncResult.isSuccess(result)) return null;
  const { url, moved } = result.value;
  const link =
    moved !== null
      ? {
          href: moved.v2Url,
          label: "Open in Executor v2",
          track: () => trackEvent("v2_moved_open_clicked", { via: "sidebar" }),
        }
      : url !== null
        ? { href: url, label: "Move to Executor v2", track: () => trackEvent("v2_import_opened") }
        : null;
  if (link === null) return null;
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={link.track}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-active/60 hover:text-foreground"
    >
      <MoveIcon className="size-3.5 text-muted-foreground" />
      {link.label}
    </a>
  );
}

import type { SVGProps } from "react";

/**
 * Analyze: scan-frame corners around a rising trend arrow — the chart being
 * read. Drawn on the lucide 24px grid with the same 2px round stroke so it sits
 * beside them, and kept open so it stays crisp at button size.
 */
export function AnalyzeIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Scan-frame corners */}
      <path d="M3 8V5a2 2 0 0 1 2-2h3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      {/* Rising trend with arrowhead */}
      <path d="m7 15 3-3 2.5 2L17 9" />
      <path d="M14 9h3v3" />
    </svg>
  );
}

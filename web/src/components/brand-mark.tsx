// Brand mark: a white shuriken on the brand indigo. Same geometry as the
// favicon (src/app/icon.svg) and docs/logo.svg, so every surface matches.
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className="shrink-0"
    >
      <rect width="64" height="64" rx="14" className="fill-brand" />
      <path
        fill="#ffffff"
        fillRule="evenodd"
        d="M32 10 L37.3 26.7 L54 32 L37.3 37.3 L32 54 L26.7 37.3 L10 32 L26.7 26.7 Z M35.2 32 a3.2 3.2 0 1 0 -6.4 0 a3.2 3.2 0 1 0 6.4 0 Z"
      />
    </svg>
  );
}

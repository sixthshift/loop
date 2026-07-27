// The prompt files next door are imported as embedded text (see agent.ts).
// bun-types declares `*.txt` and friends but not `*.md`, so tsc needs this to
// know what the import attribute already tells the bundler.
declare module '*.md' {
  const text: string;
  export default text;
}

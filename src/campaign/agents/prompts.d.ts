// Markdown prompts are imported as embedded text. Bun understands the import
// attribute; this ambient declaration gives TypeScript the same fact.
declare module '*.md' {
  const text: string;
  export default text;
}

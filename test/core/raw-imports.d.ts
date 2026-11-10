/** Vite `?raw` imports: the file's text, used to check source-level invariants. */
declare module "*?raw" {
  const text: string;
  export default text;
}

/** Vite `import.meta.glob` with eager `?raw`: each matched file's text by path, for source-level invariants. */
interface ImportMeta {
  glob(pattern: string, opts: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
}

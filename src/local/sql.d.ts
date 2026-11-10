/** A SQL file's text, inlined at build time (Vite in tests, the esbuild `?raw` plugin in build/local.ts). */
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

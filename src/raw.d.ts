/** `?raw` imports: the file's text (esbuild plugin in esbuild.mjs; built into Vite/vitest). */
declare module '*?raw' {
  const text: string;
  export default text;
}

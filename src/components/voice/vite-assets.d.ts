/**
 * Vite's `?url` asset imports, declared locally.
 *
 * `vite/client` would provide these globally, but adding it to `tsconfig.json`
 * pulls a large ambient surface into every file in the app to serve one import
 * in one module. Declared here instead, next to the only thing that uses it.
 */
declare module '*?url' {
  const src: string;
  export default src;
}

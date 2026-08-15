import { generate, parse, toPlainObject, type CssNode } from 'css-tree';

const css = `
[data-tails-part="card"] { --x: url("data:image/svg+xml,x"); opacity: .3 }
[data-tails-part="card"]::before { position: absolute; inset: 0; z-index: 3; content: "" }
@media (prefers-color-scheme: dark) { .t-a { color: red } }
@keyframes glow { from { opacity: .2 } to { opacity: 1 } }
.t-b:has(.x) { color: red }
div > p { color: red }
`;
const ast = parse(css, { positions: true, parseCustomProperty: true }) as CssNode;
console.log(JSON.stringify(toPlainObject(ast), (k, v) => (k === 'loc' ? undefined : v), 1).slice(0, 6000));
console.log('---GEN---');
console.log(generate(ast));

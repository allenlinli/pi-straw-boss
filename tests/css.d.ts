// A stylesheet import (the lazy block chunk's `import "./pbs.css"`) is a file Vite emits; the root program has no Vite types, and tests/pbs-loader.ts gives it an empty module at run time.
declare module "*.css";

// ESLint 9 flat config. La configuración compartida (incluida la
// restricción de pureza de packages/domain) vive en packages/config/eslint
// — ver ese archivo para el detalle y las referencias a CLAUDE.md.
import sharedConfig from "./packages/config/eslint/index.js";

export default [...sharedConfig];

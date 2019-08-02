import path from "path";

const pkg = require(path.join(process.cwd(), "package.json"));

export const name = pkg.name as string;
export const version = pkg.version as string;
export const homepage = pkg.homepage as string;
export const description = pkg.description as string;

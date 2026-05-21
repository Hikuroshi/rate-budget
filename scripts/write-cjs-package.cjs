const fs = require("node:fs");
const path = require("node:path");

const cjsDir = path.join(__dirname, "..", "dist", "cjs");

fs.mkdirSync(cjsDir, { recursive: true });
fs.writeFileSync(
  path.join(cjsDir, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);

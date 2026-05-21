const fs = require("node:fs");
const path = require("node:path");

fs.rmSync(path.join(__dirname, "..", "dist"), {
  force: true,
  recursive: true,
});

// @ts-check
import node from "@prisma/composer/node";
import { compute } from "@prisma/composer-prisma-cloud";

export default compute({
  name: "j-rock",
  deps: {},
  build: node({ module: import.meta.url, dir: "src", entry: "main.js" }),
});

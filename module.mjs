// @ts-check
import { module } from "@prisma/composer";
import jRockService from "./service.mjs";

export default module("bitunix-agent-cline", ({ provision }) => {
  provision(jRockService, { id: "jrock" });
});

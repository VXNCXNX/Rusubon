import { existsSync, readFileSync } from "node:fs";
import { contextPath } from "./paths.mjs";

export const PLACEHOLDER = "RUSUBON_CONTEXT_PLACEHOLDER";

export function loadContext() {
  const path = contextPath();
  if (!existsSync(path)) {
    throw new Error("no .rusubon/context.md. run `rusubon init` and fill it in.");
  }
  return { path, body: readFileSync(path, "utf8") };
}

export function assertContextReady() {
  const { body } = loadContext();
  if (body.includes(PLACEHOLDER)) {
    throw new Error(
      ".rusubon/context.md still has the placeholder. fill Product, Money paths, Intentional friction, and Out of scope, then delete the placeholder comment.",
    );
  }
}

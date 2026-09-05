import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contextPath } from "./paths.mjs";

export const PLACEHOLDER = "RUSUBON_CONTEXT_PLACEHOLDER";
export const DRAFT_GUARD = ".rusubon/runs/context-draft.json";
export const contextDraftPending = (repo = process.cwd()) => existsSync(resolve(repo, DRAFT_GUARD));

export function loadContext() {
  const path = contextPath();
  if (!existsSync(path)) {
    throw new Error("no .rusubon/context.md. run `rusubon init` and fill it in.");
  }
  return { path, body: readFileSync(path, "utf8") };
}

export function assertContextReady() {
  if (contextDraftPending()) throw new Error("A context draft still needs recovery. Open rusubon ui, then review and confirm the recovered context.");
  const { body } = loadContext();
  if (body.includes(PLACEHOLDER)) {
    throw new Error(
      ".rusubon/context.md still has the placeholder. fill Product, Money paths, Intentional friction, and Out of scope, then delete the placeholder comment.",
    );
  }
}

import { resolve } from "node:path";

export function cwd() {
  return process.cwd();
}

export const MEMORY_PREFIXES = [
  "pattern",
  "noise",
  "addressed",
  "dedupe",
  "not-in-use",
  "report",
];

export const SCOUT_INDEX_PREFIXES = ["report", "noise", "dedupe", "pattern"];
export const INDEX_CAP = 80;

export function rusubonDir() {
  return resolve(cwd(), ".rusubon");
}

export function contextPath() {
  return resolve(rusubonDir(), "context.md");
}

export function memoryDir() {
  return resolve(rusubonDir(), "memory");
}

export function inboxDir() {
  return resolve(rusubonDir(), "inbox");
}

export function reportsDir() {
  return resolve(inboxDir(), "reports");
}

export function archiveDir() {
  return resolve(inboxDir(), "archive");
}

export function runsDir() {
  return resolve(rusubonDir(), "runs");
}

export function patrolPath() {
  return resolve(runsDir(), "patrol.json");
}

export function kicksDir() {
  return resolve(runsDir(), "kicks");
}

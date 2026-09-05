/** Resolve the shared permission setting before starting either runner. */
export function resolvePermissionMode(value = "auto") {
  if (!["auto", "ask", "yolo"].includes(value)) throw new Error("Choose Auto, Ask, or YOLO for agent permissions");
  return value;
}

export function codexPermissions(value) {
  const mode = resolvePermissionMode(value);
  return {
    approvalPolicy: mode === "yolo" ? "never" : "on-request",
    approvalsReviewer: mode === "auto" ? "auto_review" : "user",
    sandbox: mode === "yolo" ? "danger-full-access" : "workspace-write",
  };
}

export function claudePermissions(value) {
  const mode = resolvePermissionMode(value);
  return { permissionMode: { auto: "auto", ask: "default", yolo: "bypassPermissions" }[mode], allowDangerouslySkipPermissions: mode === "yolo" };
}

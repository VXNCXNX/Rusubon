#!/usr/bin/env node
import { main } from "../src/cli.mjs";
import { redact } from "../src/doctor.mjs";

main(process.argv.slice(2)).catch((err) => {
  console.error(redact(err instanceof Error ? err.message : err));
  process.exit(1);
});

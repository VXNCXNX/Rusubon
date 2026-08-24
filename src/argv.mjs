export function takeFlag(argv, name) {
  const rest = [];
  let present = false;
  for (const a of argv) {
    if (a === `--${name}`) present = true;
    else rest.push(a);
  }
  return { rest, present };
}

export function takeOption(argv, name) {
  const rest = [];
  let value;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) {
      if (i + 1 >= argv.length) throw new Error(`--${name} needs a value`);
      value = argv[++i];
      continue;
    }
    if (a.startsWith(`--${name}=`)) {
      value = a.slice(name.length + 3);
      continue;
    }
    rest.push(a);
  }
  return { rest, value };
}

export async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

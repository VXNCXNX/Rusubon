// Files accepts Markdown code spans or a JSON string array for arbitrary names.
export function parsePathList(value) {
  const text = value.trim();
  if (text.startsWith("[")) {
    let paths;
    try { paths = JSON.parse(text); }
    catch { throw new Error("invalid JSON path array"); }
    if (!Array.isArray(paths) || !paths.length || paths.some((path) => typeof path !== "string" || !path)) {
      throw new Error("path array needs nonempty strings");
    }
    return paths;
  }
  const paths = [];
  let rest = text;
  while (rest) {
    let path;
    if (rest.startsWith("`")) {
      const delimiter = rest.match(/^`+/)[0];
      const closing = [...rest.slice(delimiter.length).matchAll(/`+/g)].find((match) => match[0] === delimiter);
      if (!closing) throw new Error("unclosed path code span");
      const end = delimiter.length + closing.index;
      path = rest.slice(delimiter.length, end);
      rest = rest.slice(end + delimiter.length).trimStart();
      if (rest && !rest.startsWith(",")) throw new Error("paths need comma separators");
    } else {
      const end = rest.indexOf(",");
      path = (end < 0 ? rest : rest.slice(0, end)).trim();
      rest = end < 0 ? "" : rest.slice(end);
      if (path.includes("`")) throw new Error("quote the whole path with a code span");
    }
    if (!path) throw new Error("empty path declaration");
    paths.push(path);
    if (rest) {
      rest = rest.slice(1).trimStart();
      if (!rest) throw new Error("trailing path separator");
    }
  }
  if (!paths.length) throw new Error("empty path list");
  return paths;
}

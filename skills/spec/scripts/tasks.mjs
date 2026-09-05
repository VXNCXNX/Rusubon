// Shared task boundaries and file declarations for validation and execution.
import { parsePathList } from "./path-list.mjs";
/** Extract checkbox task blocks and exact file declarations.
 * Return tasks and validation problems, including stray or duplicate Files lines. */
export function parseTasks(text) {
  const boundaries = [...text.matchAll(/^[ \t]*-[ \t]*\[([ xX])\][ \t]+|^#{1,6}[ \t]+/gm)];
  const tasks = boundaries.flatMap((match, index) => match[1] === undefined ? [] : [{
    checked: match[1],
    start: match.index + match[0].length,
    end: boundaries[index + 1]?.index ?? text.length,
    block: text.slice(match.index + match[0].length, boundaries[index + 1]?.index ?? text.length),
    files: [],
  }]);
  const problems = [];
  for (const declaration of text.matchAll(/^[ \t]*(?:[-*][ \t]*)?Files:[ \t]*([^\n]*)$/gm)) {
    const task = tasks.find(({ start, end }) => declaration.index >= start && declaration.index < end);
    if (!task) problems.push("Files: declaration outside a checkbox task");
  }
  for (const [index, task] of tasks.entries()) {
    const declarations = [...task.block.matchAll(/^[ \t]*(?:[-*][ \t]*)?Files:[ \t]*([^\n]*)$/gm)];
    if (declarations.length !== 1 || !declarations[0][1].trim()) {
      problems.push(`task ${index + 1} needs exactly one nonempty Files: declaration`);
      continue;
    }
    try { task.files = parsePathList(declarations[0][1]); }
    catch (error) { problems.push(`task ${index + 1} Files: ${error.message}`); }
  }
  return { tasks, problems };
}

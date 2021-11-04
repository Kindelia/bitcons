import { ensureDirSync } from "https://deno.land/std@0.113.0/fs/mod.ts"; // TODO: can this be local?
import * as Path from "https://deno.land/std@0.110.0/path/mod.ts";

export const get_dir =
  (base: string) =>
  (path: string = ""): string => {
    const dir = Path.join(base, path);
    ensureDirSync(dir);
    return dir;
  };

export function ensure_text_file(path: string, content: string = "") {
  try {
    const stat = Deno.statSync(path);
    // TODO handle symlink?
    if (!stat.isFile) {
      throw new Error(`'${path}' exists but is not a file.`);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      Deno.writeTextFileSync(path, content);
    } else {
      throw err;
    }
  }
}

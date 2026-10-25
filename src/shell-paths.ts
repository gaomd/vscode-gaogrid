import * as path from "path";

/** Quote arguments for the session's shell; never append a command or newline. */
export function quoteShellPaths(paths: string[], shell: string): string {
  const executable = path.basename(shell).toLowerCase();
  return (
    paths
      .map((value) => {
        if (/^(powershell|pwsh)(\.exe)?$/.test(executable))
          return `'${value.replaceAll("'", "''")}'`;
        if (/^cmd(\.exe)?$/.test(executable)) return `"${value}"`;
        return `'${value.replaceAll("'", "'\\''")}'`;
      })
      .join(" ") + " "
  );
}

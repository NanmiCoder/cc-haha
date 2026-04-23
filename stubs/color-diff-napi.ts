export type SyntaxTheme = {
  theme: string;
  source: string | null;
};

export class ColorDiff {
  private hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };
  private filePath: string;
  private firstLine: string | null;
  private prefixContent: string | null;

  constructor(
    hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] },
    firstLine: string | null,
    filePath: string,
    prefixContent?: string | null,
  ) {
    this.hunk = hunk;
    this.filePath = filePath;
    this.firstLine = firstLine;
    this.prefixContent = prefixContent ?? null;
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    return null;
  }
}

export class ColorFile {
  private code: string;
  private filePath: string;

  constructor(code: string, filePath: string) {
    this.code = code;
    this.filePath = filePath;
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    return null;
  }
}

export function getSyntaxTheme(themeName: string): SyntaxTheme {
  return { theme: themeName, source: null };
}

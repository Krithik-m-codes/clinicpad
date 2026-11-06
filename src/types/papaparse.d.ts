declare module "papaparse" {
  export interface ParseError {
    type: string;
    code: string;
    message: string;
    row?: number;
  }

  export interface ParseMeta {
    delimiter: string;
    linebreak: string;
    aborted: boolean;
    truncated: boolean;
    cursor: number;
    fields?: string[];
  }

  export interface ParseResult<T> {
    data: T[];
    errors: ParseError[];
    meta: ParseMeta;
  }

  export interface ParseConfig<T = Record<string, string>> {
    header?: boolean;
    skipEmptyLines?: boolean | "greedy";
    transformHeader?: (header: string) => string;
    transform?: (value: string) => string;
    complete?: (results: ParseResult<T>) => void;
    error?: (error: Error) => void;
    delimiter?: string;
    newline?: string;
    quoteChar?: string;
    escapeChar?: string;
    comments?: boolean | string;
    dynamicTyping?: boolean;
    preview?: number;
    step?: (results: ParseResult<T>) => void;
  }

  export function parse<T = Record<string, string>>(
    input: string | File,
    config?: ParseConfig<T>
  ): ParseResult<T>;

  const Papa: {
    parse: typeof parse;
  };

  export default Papa;
}

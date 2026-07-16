declare module 'qrcode-terminal' {
  export interface GenerateOptions {
    readonly small?: boolean;
  }

  export function generate(input: string, options?: GenerateOptions): void;
}

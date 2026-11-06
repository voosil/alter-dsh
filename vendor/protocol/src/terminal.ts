/** Raw terminal transport; input is delivered to the host PTY without command rewriting. */
export interface TerminalOpen {
  id: string;
  directory: string;
  cols: number;
  rows: number;
}
export interface TerminalSession {
  id: string;
  directory: string;
  shell: string;
}
export interface TerminalOutput {
  data: string;
  offset: number;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  error?: string;
}
export interface TerminalService {
  open(input: TerminalOpen): Promise<TerminalSession>;
  read(id: string, offset: number): Promise<TerminalOutput>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
}

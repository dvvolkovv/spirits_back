// ЗАГЛУШКА для красного прогона: сигнатуры настоящие, тела — нет.
export const PM2_APP = 'product';
export const PM2_RESTART_CMD = `pm2 restart ${PM2_APP}`;

export interface ProcView {
  read(path: string): string | null;
  list(path: string): string[];
  link(path: string): string | null;
}

export type ExecFileFn = (file: string, args: string[]) => Promise<string>;

export function portFromHealthUrl(_url: string | null | undefined): number | null {
  return null;
}

export function listeningInodes(_tables: string[], _port: number): Set<string> {
  return new Set();
}

export function portHolders(_port: number, _proc: ProcView): number[] {
  return [];
}

export interface ReleaseInput {
  port: number;
  keep: number[];
  spare?: number[];
  proc?: ProcView;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<unknown>;
  selfPid?: number;
  graceMs?: number;
  pollMs?: number;
}

export async function releasePort(_input: ReleaseInput): Promise<{ killed: number[]; survivors: number[] }> {
  return { killed: [], survivors: [] };
}

export async function pm2Pids(_app: string, _execFileFn: ExecFileFn): Promise<number[] | null> {
  return [];
}

export interface FreeProductPortInput {
  healthUrl: string | null;
  onPhase?: (message: string) => void;
  execFileFn?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
  proc?: ProcView;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<unknown>;
  selfPid?: number;
  log?: (line: string) => void;
}

export async function freeProductPort(_input: FreeProductPortInput): Promise<void> {}

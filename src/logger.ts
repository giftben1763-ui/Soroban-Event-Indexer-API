export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function ts(): string {
  return new Date().toISOString();
}

export const defaultLogger: Logger = {
  info: (m) => console.log(`[${ts()}] INFO  ${m}`),
  warn: (m) => console.warn(`[${ts()}] WARN  ${m}`),
  error: (m) => console.error(`[${ts()}] ERROR ${m}`),
};

/** Swallows everything — handy for tests that don't want log noise. */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

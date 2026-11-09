let verbose = false;

export function setVerbose(value: boolean) {
  verbose = value;
}

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export const logger = {
  info(message: string) {
    console.log(`\x1b[90m[${stamp()}]\x1b[0m ${message}`);
  },
  warn(message: string) {
    console.warn(`\x1b[33m[${stamp()}] warning\x1b[0m ${message}`);
  },
  error(message: unknown) {
    console.error(`\x1b[31m[${stamp()}] error\x1b[0m`, message);
  },
  debug(message: unknown) {
    if (verbose) console.log(`\x1b[90m[${stamp()}] debug\x1b[0m`, message);
  },
};

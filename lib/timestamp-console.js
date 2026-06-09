let installed = false;

function prefixArgs(args) {
  return [`[${new Date().toISOString()}]`, ...args];
}

export function installTimestampedConsole() {
  if (installed) return;
  installed = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args) => originalLog(...prefixArgs(args));
  console.warn = (...args) => originalWarn(...prefixArgs(args));
  console.error = (...args) => originalError(...prefixArgs(args));
}

const noop = () => {};
const LEVELS = ['debug', 'info', 'warn', 'error'];

export function createOptionalLogger(name) {
    void name;
    return Object.fromEntries(LEVELS.map(level => [level, noop]));
}

export const probeOptionalLogger = noop;

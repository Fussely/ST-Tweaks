const noop = () => {};
const LEVELS = ['debug', 'info', 'warn', 'error'];

let loggerModulePromise;

function loadLoggerModule() {
    if (!loggerModulePromise) {
        loggerModulePromise = import('../../st-logger/logger-client.js')
            .catch(() => null);
    }
    return loggerModulePromise;
}

export function createOptionalLogger(name) {
    const logger = Object.fromEntries(LEVELS.map(level => [level, noop]));

    loadLoggerModule().then(module => {
        if (typeof module?.createLogger !== 'function') return;

        const realLogger = module.createLogger(name);
        for (const level of LEVELS) {
            if (typeof realLogger?.[level] === 'function') {
                logger[level] = realLogger[level].bind(realLogger);
            }
        }
    });

    return logger;
}

export function probeOptionalLogger() {
    loadLoggerModule().then(module => {
        if (typeof module?.probeLogger === 'function') {
            module.probeLogger();
        }
    });
}

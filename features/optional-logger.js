import { extensionNames, extension_settings } from '../../../../extensions.js';

const noop = () => {};
const LEVELS = ['debug', 'info', 'warn', 'error'];
const LOGGER_EXTENSION = 'third-party/st-logger';

let loggerModulePromise;

function getLoggerExtensionName() {
    const name = extensionNames.find(extensionName => extensionName.toLowerCase() === LOGGER_EXTENSION);
    if (!name || extension_settings.disabledExtensions?.includes(name)) return null;
    return name;
}

function loadLoggerModule() {
    const loggerExtensionName = getLoggerExtensionName();
    if (!loggerExtensionName) return null;

    if (!loggerModulePromise) {
        loggerModulePromise = import(`../../../${loggerExtensionName}/logger-client.js`)
            .catch(() => null);
    }

    return loggerModulePromise;
}

export function createOptionalLogger(name) {
    const logger = Object.fromEntries(LEVELS.map(level => [level, noop]));
    const loggerModule = loadLoggerModule();

    if (loggerModule) {
        loggerModule.then(module => {
            if (typeof module?.createLogger !== 'function') return;

            const realLogger = module.createLogger(name);
            for (const level of LEVELS) {
                if (typeof realLogger?.[level] === 'function') {
                    logger[level] = realLogger[level].bind(realLogger);
                }
            }
        });
    }

    return logger;
}

export function probeOptionalLogger() {
    const loggerModule = loadLoggerModule();

    if (loggerModule) {
        loggerModule.then(module => {
            if (typeof module?.probeLogger === 'function') {
                module.probeLogger();
            }
        });
    }
}

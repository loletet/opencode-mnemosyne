export function buildMemoryProviderConfig(config, overrides = {}) {
    if (!config.memoryModel || !config.memoryApiUrl) {
        throw new Error("External API not configured for memory provider");
    }
    return {
        model: config.memoryModel,
        apiUrl: config.memoryApiUrl,
        apiKey: config.memoryApiKey,
        memoryTemperature: config.memoryTemperature,
        extraParams: config.memoryExtraParams,
        maxIterations: overrides.maxIterations ?? config.autoCaptureMaxIterations,
        iterationTimeout: overrides.iterationTimeout ?? config.autoCaptureIterationTimeout,
    };
}

interface WebServerConfig {
    port: number;
    host: string;
    enabled: boolean;
    triggerAutoCapture?: (params: {
        sessionID?: string;
    }) => Promise<any>;
}
export declare class WebServer {
    private server;
    private config;
    private isOwner;
    private startPromise;
    private healthCheckInterval;
    private onTakeoverCallback;
    constructor(config: WebServerConfig);
    setOnTakeoverCallback(callback: () => Promise<void>): void;
    start(): Promise<void>;
    private _start;
    private startHealthCheckLoop;
    private stopHealthCheckLoop;
    private attemptTakeover;
    stop(): Promise<void>;
    isRunning(): boolean;
    isServerOwner(): boolean;
    getUrl(): string;
    checkServerAvailable(): Promise<boolean>;
    private handleRequest;
    private serveStaticFile;
    private jsonResponse;
}
export declare function startWebServer(config: WebServerConfig): Promise<WebServer>;
export {};
//# sourceMappingURL=web-server.d.ts.map
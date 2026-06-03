declare const Database: typeof import("bun:sqlite").Database;
export declare class ConnectionManager {
    private connections;
    private initDatabase;
    private migrateSchema;
    getConnection(dbPath: string): typeof Database.prototype;
    closeConnection(dbPath: string): void;
    closeAll(): void;
    checkpointAll(): void;
}
export declare const connectionManager: ConnectionManager;
export {};
//# sourceMappingURL=connection-manager.d.ts.map
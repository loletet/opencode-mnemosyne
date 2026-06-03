let Database;
export function getDatabase() {
    if (!Database) {
        const bunSqlite = require("bun:sqlite");
        Database = bunSqlite.Database;
    }
    return Database;
}

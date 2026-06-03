export class USearchBackend {
    options;
    indexes = new Map();
    constructor(options) {
        this.options = options;
        void this.options.baseDir;
    }
    getBackendName() {
        return "usearch";
    }
    async insert(args) {
        const indexKey = this.getIndexKey(args.shard, args.kind);
        const cache = await this.getOrCreateIndex(indexKey);
        try {
            this.upsertItem(cache, { id: args.id, vector: args.vector });
            cache.initialized = true;
        }
        catch (error) {
            throw new Error(`USearch insert failed for ${indexKey}: ${String(error)}`);
        }
    }
    async insertBatch(args) {
        const indexKey = this.getIndexKey(args.shard, args.kind);
        const cache = await this.getOrCreateIndex(indexKey);
        try {
            this.addItems(cache, args.items);
            cache.initialized = true;
        }
        catch (error) {
            throw new Error(`USearch batch insert failed for ${indexKey}: ${String(error)}`);
        }
    }
    async delete(args) {
        const cache = await this.getOrCreateIndex(this.getIndexKey(args.shard, args.kind));
        const key = cache.idToKey.get(args.id);
        if (key === undefined)
            return;
        cache.index.remove(key);
        cache.idToKey.delete(args.id);
        cache.keyToId.delete(key);
    }
    async search(args) {
        const indexKey = this.getIndexKey(args.shard, args.kind);
        const cache = await this.getOrCreateIndex(indexKey);
        try {
            const matches = cache.index.search(args.queryVector, args.limit);
            return Array.from(matches.keys, (key, index) => {
                const id = cache.keyToId.get(key);
                if (!id) {
                    throw new Error(`USearch index metadata missing for key ${String(key)} in ${cache.indexKey}`);
                }
                return {
                    id,
                    distance: matches.distances[index] ?? 0,
                };
            });
        }
        catch (error) {
            throw new Error(`USearch search failed for ${indexKey}: ${String(error)}`);
        }
    }
    async rebuildFromShard(args) {
        const indexKey = this.getIndexKey(args.shard, args.kind);
        const existing = this.indexes.get(indexKey);
        if (existing?.initialized) {
            return;
        }
        const column = args.kind === "tags" ? "tags_vector" : "vector";
        const rows = args.db
            .prepare(`SELECT id, ${column} FROM memories WHERE ${column} IS NOT NULL`)
            .all();
        const cache = await this.createEmptyIndex(indexKey);
        this.indexes.set(indexKey, cache);
        for (const row of rows) {
            const raw = args.kind === "tags" ? row.tags_vector : row.vector;
            const vector = this.decodeVector(raw);
            if (vector.length === 0)
                continue;
            this.upsertItem(cache, { id: row.id, vector });
        }
        cache.initialized = true;
    }
    async deleteShardIndexes(args) {
        for (const kind of ["content", "tags"]) {
            const indexKey = this.getIndexKey(args.shard, kind);
            this.indexes.delete(indexKey);
        }
    }
    async insertManyForTest(indexKey, items) {
        const cache = await this.getOrCreateIndex(indexKey);
        this.addItems(cache, items);
        cache.initialized = true;
    }
    async searchForTest(indexKey, queryVector, limit) {
        const cache = await this.getOrCreateIndex(indexKey);
        try {
            const matches = cache.index.search(queryVector, limit);
            return Array.from(matches.keys, (key, index) => {
                const id = cache.keyToId.get(key);
                if (!id) {
                    throw new Error(`USearch index metadata missing for key ${String(key)} in ${cache.indexKey}`);
                }
                return {
                    id,
                    distance: matches.distances[index] ?? 0,
                };
            });
        }
        catch (error) {
            throw new Error(`USearch test search failed for ${indexKey}: ${String(error)}`);
        }
    }
    async getOrCreateIndex(indexKey) {
        const existing = this.indexes.get(indexKey);
        if (existing)
            return existing;
        const cache = await this.createEmptyIndex(indexKey);
        this.indexes.set(indexKey, cache);
        return cache;
    }
    async createEmptyIndex(indexKey) {
        const usearch = await this.loadUSearch();
        return {
            index: new usearch.Index({ dimensions: this.options.dimensions, metric: "cos" }),
            idToKey: new Map(),
            keyToId: new Map(),
            nextKey: 1n,
            indexKey,
            initialized: false,
        };
    }
    ensureKey(cache, id) {
        const existing = cache.idToKey.get(id);
        if (existing !== undefined)
            return existing;
        const key = cache.nextKey;
        cache.nextKey += 1n;
        cache.idToKey.set(id, key);
        cache.keyToId.set(key, id);
        return key;
    }
    addItems(cache, items) {
        for (const item of items) {
            this.upsertItem(cache, item);
        }
    }
    upsertItem(cache, item) {
        const existing = cache.idToKey.get(item.id);
        if (existing !== undefined) {
            cache.index.remove(existing);
        }
        const key = this.ensureKey(cache, item.id);
        cache.index.add(key, item.vector);
    }
    decodeVector(value) {
        if (!value)
            return new Float32Array();
        if (value instanceof Uint8Array) {
            return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        }
        return new Float32Array(value);
    }
    getIndexKey(shard, kind) {
        return `${shard.scope}_${shard.scopeHash}_${shard.shardIndex}_${kind}`;
    }
    async loadUSearch() {
        try {
            return await import("usearch");
        }
        catch (error) {
            throw new Error(`Failed to load usearch backend: ${String(error)}`);
        }
    }
}

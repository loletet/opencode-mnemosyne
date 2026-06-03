export class ExactScanBackend {
    getBackendName() {
        return "exact-scan";
    }
    rankVectors(rows, queryVector, limit) {
        return rows
            .map((row) => ({
            id: row.id,
            distance: 1 - this.cosineSimilarity(row.vector, queryVector),
        }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, limit);
    }
    async insert(_args) { }
    async insertBatch(_args) { }
    async delete(_args) { }
    async search(args) {
        const column = args.kind === "tags" ? "tags_vector" : "vector";
        const rows = args.db
            .prepare(`SELECT id, ${column} FROM memories WHERE ${column} IS NOT NULL`)
            .all();
        if (rows.length === 0) {
            return [];
        }
        const rankedRows = rows
            .map((row) => ({
            id: row.id,
            vector: this.decodeVector(args.kind === "tags" ? row.tags_vector : row.vector),
        }))
            .filter((row) => row.vector.length > 0);
        return this.rankVectors(rankedRows, args.queryVector, args.limit);
    }
    async rebuildFromShard(_args) { }
    async deleteShardIndexes(_args) { }
    decodeVector(value) {
        if (!value) {
            return new Float32Array();
        }
        if (value instanceof Uint8Array) {
            return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        }
        return new Float32Array(value);
    }
    cosineSimilarity(a, b) {
        if (a.length !== b.length) {
            return 0;
        }
        let dot = 0;
        let magA = 0;
        let magB = 0;
        for (let i = 0; i < a.length; i++) {
            const av = a[i] ?? 0;
            const bv = b[i] ?? 0;
            dot += av * bv;
            magA += av * av;
            magB += bv * bv;
        }
        if (magA === 0 || magB === 0) {
            return 0;
        }
        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    }
}

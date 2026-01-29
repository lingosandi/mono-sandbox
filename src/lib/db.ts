/**
 * SQLite Database Module
 * Uses better-sqlite3 for Node.js compatibility with Next.js
 * Single-user system - no authentication required
 */

import Database from "better-sqlite3"
import { createId } from "@paralleldrive/cuid2"
import path from "path"

// Database file location (in project root for now - can be moved to data/ later)
const DB_PATH = path.join(process.cwd(), "app.db")

// Initialize database connection
const db = new Database(DB_PATH)

// Enable WAL mode for better concurrency
db.pragma("journal_mode = WAL")

// Create tables if they don't exist
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
`)

// Helper to convert SQLite row timestamps to Date objects
function parseRow<T extends Record<string, unknown>>(row: T): T {
    const parsed = { ...row } as Record<string, unknown>
    if ("created_at" in parsed && typeof parsed.created_at === "number") {
        parsed.createdAt = new Date(parsed.created_at)
        delete parsed.created_at
    }
    if ("updated_at" in parsed && typeof parsed.updated_at === "number") {
        parsed.updatedAt = new Date(parsed.updated_at)
        delete parsed.updated_at
    }
    if ("deleted_at" in parsed && parsed.deleted_at !== null && typeof parsed.deleted_at === "number") {
        parsed.deletedAt = new Date(parsed.deleted_at)
        delete parsed.deleted_at
    } else if ("deleted_at" in parsed) {
        parsed.deletedAt = null
        delete parsed.deleted_at
    }
    return parsed as T
}

// Project operations
export const projectDb = {
    findUnique(where: { id: string }) {
        const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(where.id) as Record<string, unknown> | undefined
        return row ? parseRow(row) : null
    },

    findMany(where?: {
        deletedAt?: null
    }, options?: { orderBy?: { updatedAt: "asc" | "desc" } }) {
        let query = "SELECT * FROM projects"
        
        if (where?.deletedAt === null) {
            query += " WHERE deleted_at IS NULL"
        }

        if (options?.orderBy?.updatedAt) {
            query += ` ORDER BY updated_at ${options.orderBy.updatedAt === "desc" ? "DESC" : "ASC"}`
        }

        const rows = db.prepare(query).all() as Record<string, unknown>[]
        return rows.map((row) => parseRow(row))
    },

    create(data: {
        name: string
        description?: string | null
    }) {
        const id = createId()
        const now = Date.now()

        db.prepare(`
            INSERT INTO projects (id, name, description, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, NULL)
        `).run(
            id,
            data.name,
            data.description || null,
            now,
            now
        )

        return this.findUnique({ id })
    },

    update(where: { id: string }, data: Partial<{
        name: string
        description: string | null
        deletedAt: Date | null
    }>) {
        const updates: string[] = []
        const values: (string | number | null)[] = []

        if (data.name !== undefined) {
            updates.push("name = ?")
            values.push(data.name)
        }
        if (data.description !== undefined) {
            updates.push("description = ?")
            values.push(data.description)
        }
        if (data.deletedAt !== undefined) {
            updates.push("deleted_at = ?")
            values.push(data.deletedAt ? data.deletedAt.getTime() : null)
        }

        if (updates.length === 0) {
            return this.findUnique(where)
        }

        updates.push("updated_at = ?")
        values.push(Date.now())
        values.push(where.id)

        db.prepare(`
            UPDATE projects
            SET ${updates.join(", ")}
            WHERE id = ?
        `).run(...values)

        return this.findUnique(where)
    },

    delete(where: { id: string }) {
        db.prepare("DELETE FROM projects WHERE id = ?").run(where.id)
    }
}

// Export for raw queries if needed
export { db }

// Graceful shutdown
export function closeDb() {
    db.close()
}

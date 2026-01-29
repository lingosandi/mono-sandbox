import { VMSession } from "./types"

// Hoisted helper functions for memory efficiency
function isSessionExpired(session: VMSession, maxIdleMs: number): boolean {
    return Date.now() - session.lastActivity.getTime() > maxIdleMs
}

function updateLastActivity(session: VMSession): void {
    session.lastActivity = new Date()
}

export function createSessionManager() {
    const sessions = new Map<string, VMSession>()
    const projectSessions = new Map<string, string>() // projectId -> vmId
    const MAX_IDLE_TIME = 30 * 60 * 1000 // 30 minutes
    const MAX_SESSIONS = 10 // Global limit
    let cleanupInterval: NodeJS.Timeout | null = null

    function createSession(
        vmId: string,
        projectId: string,
        pid: number,
        socketPath: string,
        workspacePath: string
    ): VMSession {
        const session: VMSession = {
            vmId,
            projectId,
            pid,
            socketPath,
            workspacePath,
            vmIP: undefined,
            createdAt: new Date(),
            lastActivity: new Date(),
            status: "starting"
        }

        sessions.set(vmId, session)
        projectSessions.set(projectId, vmId)

        return session
    }

    function getSession(vmId: string): VMSession | undefined {
        return sessions.get(vmId)
    }

    function getSessionByProject(projectId: string): VMSession | undefined {
        const vmId = projectSessions.get(projectId)
        if (!vmId) return undefined
        return sessions.get(vmId)
    }

    function touchSession(vmId: string): void {
        const session = sessions.get(vmId)
        if (session) {
            updateLastActivity(session)
        }
    }

    function updateStatus(vmId: string, status: VMSession["status"]): void {
        const session = sessions.get(vmId)
        if (session) {
            session.status = status
            updateLastActivity(session)
        }
    }

    function removeSession(vmId: string): VMSession | undefined {
        const session = sessions.get(vmId)
        if (!session) return undefined

        sessions.delete(vmId)
        projectSessions.delete(session.projectId)

        return session
    }

    function canCreateSession(): boolean {
        return sessions.size < MAX_SESSIONS
    }

    function getExpiredSessions(): VMSession[] {
        const expired: VMSession[] = []
        for (const session of sessions.values()) {
            if (isSessionExpired(session, MAX_IDLE_TIME)) {
                expired.push(session)
            }
        }
        return expired
    }

    function getAllSessions(): VMSession[] {
        return Array.from(sessions.values())
    }

    function startCleanup(onExpired: (session: VMSession) => Promise<void>) {
        if (cleanupInterval) return

        cleanupInterval = setInterval(async () => {
            const expired = getExpiredSessions()
            for (const session of expired) {
                try {
                    await onExpired(session)
                } catch (error) {
                    console.error(
                        `[SessionManager] Error cleaning up ${session.vmId}:`,
                        error
                    )
                }
            }
        }, 60000) // Check every minute
    }

    function stopCleanup() {
        if (cleanupInterval) {
            clearInterval(cleanupInterval)
            cleanupInterval = null
        }
    }

    return {
        createSession,
        getSession,
        getSessionByProject,
        touchSession,
        updateStatus,
        removeSession,
        canCreateSession,
        getExpiredSessions,
        getAllSessions,
        startCleanup,
        stopCleanup
    }
}

export type SessionManager = ReturnType<typeof createSessionManager>

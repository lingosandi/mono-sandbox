# Coding Style Guidelines

## Package Manager

**Always use `bun` for package management, not `npm`, `yarn`, or `pnpm`.**

Examples:
- `bun install` (not `npm install`)
- `bun add <package>` (not `npm install <package>`)
- `bun run dev` (not `npm run dev`)

## React UI Components

### shadcn/ui Components

**Always prefer using shadcn/ui components when designing React UI.**

shadcn/ui provides high-quality, accessible, and customizable components that follow best practices. Use them instead of building custom components from scratch.

**Installing new shadcn components:**
```bash
bunx shadcn@latest add <component-name>
```

Examples:
- `bunx shadcn@latest add button`
- `bunx shadcn@latest add dialog`
- `bunx shadcn@latest add card`

**Benefits:**
- Accessibility built-in (ARIA, keyboard navigation)
- Consistent design system
- Tailwind CSS integration
- Fully customizable (copied to your project)
- TypeScript support
- No additional bundle size overhead

**When to use shadcn:**
- Forms (Input, Label, Select, Checkbox, etc.)
- Dialogs and Modals
- Buttons and interactive elements
- Cards and containers
- Tables and data display
- Navigation components
- Feedback components (Alert, Toast, etc.)

**Available components:** Check [ui.shadcn.com](https://ui.shadcn.com) for the full list of components.

## Functional Programming Principles

### 1. Prefer Functional Style Over Class-Based

Always use functional programming patterns with closures instead of classes:

**✅ Good - Functional with closures:**
```typescript
export function createVoiceHandler() {
    const sessions = new Map()
    const connections = new Map()
    
    function handleConnection(socket, userId) {
        // Logic here
        return cleanup
    }
    
    return { handleConnection }
}
```

**❌ Avoid - Class-based:**
```typescript
export class VoiceHandler {
    private sessions = new Map()
    private connections = new Map()
    
    handleConnection(socket, userId) {
        // Logic here
    }
}
```

**Benefits:**
- Encapsulation via closures (truly private state)
- No `this` binding issues
- Simpler mental model
- Easier to compose and test
- Better tree-shaking

### 2. Prefer Inline Anonymous Functions

Use inline arrow functions instead of creating discrete named functions, especially for callbacks and event handlers:

**✅ Good - Inline anonymous functions:**
```typescript
socket.on("message", (data) => handleMessage(data))
socket.on("error", (err) => console.error("Socket error:", err))
socket.on("close", () => cleanup())

const handlers = {
    onData: (data) => processData(data),
    onError: (err) => logError(err),
    onComplete: () => finalize()
}
```

**❌ Avoid - Named function declarations:**
```typescript
const handleMessage = (data) => {
    // Logic
}

const handleError = (err) => {
    console.error("Socket error:", err)
}

const handleClose = () => {
    cleanup()
}

socket.on("message", handleMessage)
socket.on("error", handleError)
socket.on("close", handleClose)
```

**Exception:** Create named functions only when:
- The function is complex and needs clear documentation
- The function is used in multiple places
- Debugging requires a clear stack trace name

### 3. Resource Cleanup Pattern

**All functions that allocate resources MUST return cleanup functions:**

**✅ Good - Returns cleanup function:**
```typescript
function handleConnection(socket, userId) {
    // Setup resources
    const handlers = {
        message: (data) => process(data),
        close: () => cleanup()
    }
    
    socket.on("message", handlers.message)
    socket.on("close", handlers.close)
    
    // Return cleanup function
    return () => {
        socket.off("message", handlers.message)
        socket.off("close", handlers.close)
    }
}

// Usage
const cleanup = handleConnection(socket, userId)
// Later: cleanup()
```

**✅ Good - Nested resource cleanup:**
```typescript
function createSession(config) {
    let cleanupDB = null
    let cleanupCache = null
    
    const db = connectDB(config.dbUrl)
    cleanupDB = () => db.disconnect()
    
    const cache = connectCache(config.cacheUrl)
    cleanupCache = () => cache.close()
    
    // Combined cleanup
    const cleanup = async () => {
        if (cleanupCache) cleanupCache()
        if (cleanupDB) await cleanupDB()
    }
    
    return { db, cache, cleanup }
}
```

**❌ Avoid - Manual cleanup without returned function:**
```typescript
function handleConnection(socket, userId) {
    socket.on("message", handleMessage)
    socket.on("close", handleClose)
    // No cleanup function returned!
}

// Cleanup must be done manually elsewhere - error prone!
```

### 4. Self-Contained Functions

Functions should be as self-contained as possible:

**✅ Good - Self-contained with all dependencies:**
```typescript
function processData(input, config, logger) {
    const result = transform(input, config)
    logger.log("Processed:", result)
    return result
}
```

**❌ Avoid - Implicit external dependencies:**
```typescript
// Depends on external state
let globalConfig
let globalLogger

function processData(input) {
    const result = transform(input, globalConfig)
    globalLogger.log("Processed:", result)
    return result
}
```

### 5. ⚠️ CRITICAL: Hoist Helper Functions to Save Memory

**This is MANDATORY for memory efficiency - always hoist reusable helper functions outside of factory functions.**

When creating factory functions (functions that return objects with methods), **HOIST helper functions to the parent scope** to avoid recreating them on every invocation. This is especially critical for:
- Connection pools and resource managers
- Singleton patterns
- Any factory function called multiple times

**✅ GOOD - Hoisted helpers (memory efficient):**
```typescript
// Hoisted to parent scope - shared across all instances
function validateConnection(connection, config) {
    return connection.isAlive && Date.now() - connection.lastUsed < config.maxIdleTimeMs
}

function cleanupStaleConnections(pool, config) {
    const now = Date.now()
    pool.forEach((conn, index) => {
        if (!validateConnection(conn, config)) {
            conn.close()
            pool.splice(index, 1)
        }
    })
}

export function createConnectionPool(config) {
    const pool = []
    let cleanupInterval = null
    
    function acquire() {
        // Use hoisted helper
        const valid = pool.find(conn => validateConnection(conn, config))
        return valid || createNew()
    }
    
    // Use hoisted helper in interval
    cleanupInterval = setInterval(
        () => cleanupStaleConnections(pool, config),
        config.cleanupIntervalMs
    )
    
    return { acquire, release: (conn) => pool.push(conn) }
}
```

**❌ AVOID - Nested helpers (wastes memory):**
```typescript
export function createConnectionPool(config) {
    const pool = []
    
    // ❌ Recreated on EVERY createConnectionPool() call
    function validateConnection(connection) {
        return connection.isAlive && Date.now() - connection.lastUsed < config.maxIdleTimeMs
    }
    
    // ❌ Recreated on EVERY createConnectionPool() call
    function cleanupStaleConnections() {
        const now = Date.now()
        pool.forEach((conn, index) => {
            if (!validateConnection(conn)) {
                conn.close()
                pool.splice(index, 1)
            }
        })
    }
    
    function acquire() {
        const valid = pool.find(conn => validateConnection(conn))
        return valid || createNew()
    }
    
    const cleanupInterval = setInterval(cleanupStaleConnections, config.cleanupIntervalMs)
    
    return { acquire, release: (conn) => pool.push(conn) }
}
```

**When to hoist:**
- ✅ **Pure helper functions** - No side effects, just transform data
- ✅ **Validation/calculation functions** - Can take params instead of using closures
- ✅ **Cleanup routines** - Can be parameterized
- ✅ **Connection/resource creation logic** - Can pass dependencies as params

**When NOT to hoist:**
- ❌ Functions that MUST access closured state and can't be parameterized
- ❌ Functions with complex closure dependencies (multiple nested scopes)
- ❌ Event handlers that are intentionally unique per instance

**Key principle:** If a function can be written to take parameters instead of accessing closure variables, **ALWAYS hoist it to the parent scope.**

**Memory impact:**
- 🔴 **Without hoisting**: 10 pool instances = 10 copies of each helper function in memory
- 🟢 **With hoisting**: 10 pool instances = 1 copy of each helper function shared by all

## Practical Examples

### Event Handler Pattern
```typescript
function setupEventHandlers(element) {
    const handlers = {
        click: (e) => handleClick(e),
        keydown: (e) => e.key === "Enter" && handleSubmit(),
        focus: () => element.classList.add("focused"),
        blur: () => element.classList.remove("focused")
    }
    
    Object.entries(handlers).forEach(([event, handler]) => {
        element.addEventListener(event, handler)
    })
    
    return () => {
        Object.entries(handlers).forEach(([event, handler]) => {
            element.removeEventListener(event, handler)
        })
    }
}
```

### Resource Management Pattern
```typescript
async function createWebRTCSession(socket, userId, config) {
    let cleanupParaformer = null
    let cleanupTTS = null
    let cleanupOnboarding = null
    
    // Initialize resources
    const paraformer = await initParaformer(config)
    cleanupParaformer = () => paraformer.close()
    
    const tts = initTTS(config)
    cleanupTTS = () => tts.close()
    
    const onboarding = createOnboarding()
    cleanupOnboarding = () => onboarding.stop()
    
    // Combine cleanup
    const cleanup = async () => {
        if (cleanupOnboarding) cleanupOnboarding()
        if (cleanupTTS) cleanupTTS()
        if (cleanupParaformer) await cleanupParaformer()
    }
    
    return {
        paraformer,
        tts,
        onboarding,
        cleanup
    }
}
```

### Factory Pattern with Cleanup
```typescript
export function createManager() {
    const items = new Map()
    const cleanups = new Map()
    
    function add(id, item) {
        items.set(id, item)
        
        const cleanup = () => {
            items.delete(id)
            cleanups.delete(id)
        }
        
        cleanups.set(id, cleanup)
        return cleanup
    }
    
    async function shutdown() {
        const promises = Array.from(cleanups.values()).map(cleanup => cleanup())
        await Promise.allSettled(promises)
        items.clear()
        cleanups.clear()
    }
    
    return { add, shutdown }
}
```

## Code Quality and Memory Safety

### ⚠️ CRITICAL: Ensure Logical Correctness and Proper Cleanup

**THIS IS MANDATORY - Always verify that code is:**
- **Logically correct** - Control flow works as intended without race conditions
- **Properly cleaned up** - All resources are released when no longer needed
- **Memory leak free** - Event listeners, timers, connections, and handlers are removed

**NEVER write code that has memory leaks or improper cleanup. This is non-negotiable.**

### 🚨 CRITICAL: Race Condition Protection in React Components

**THIS IS EXTREMELY IMPORTANT - Always protect against race conditions in async initialization/cleanup.**

When dealing with async resource initialization in React components (camera streams, network connections, file operations), cleanup may be called before resources are fully created. This causes **orphaned resources that never get cleaned up**.

**React Component Race Condition Scenario:**
```
Timeline without protection:
T1: useEffect runs → initResources() starts
T2: Creates video element
T3: Calls getUserMedia() → waiting for user permission
T4: Component unmounts → cleanup() runs
T5: cleanup() only cleans refs (empty!) → MISSES video element
T6: getUserMedia() completes → creates stream
T7: Stream never gets cleaned up → MEMORY LEAK + camera stays on!
```

**MANDATORY Race Condition Protections for React:**

1. **Use cleanup flag** - Set at start of cleanup, checked throughout init
2. **Check flag after every async operation** - `await getUserMedia()`, `await fetch()`, `await connect()`
3. **Store resources in local variables AND refs** - Clean both in cleanup
4. **Cleanup orphaned resources immediately** - If flag is set mid-init, clean the resource right away
5. **Guard callbacks with cleanup flag** - Prevent execution after cleanup
6. **Handle error cleanup** - Clean partial resources if init fails

**✅ GOOD - Race-condition safe React useEffect:**
```typescript
useEffect(() => {
    // Cleanup flag prevents race conditions
    let isCleanedUp = false
    let camera: any = null
    let stream: MediaStream | null = null
    let video: HTMLVideoElement | null = null
    
    const initResources = async () => {
        try {
            // Create video element
            video = document.createElement("video")
            document.body.appendChild(video)
            
            // Check cleanup before storing ref (race condition guard)
            if (isCleanedUp) {
                video.parentNode?.removeChild(video)
                return
            }
            videoRef.current = video
            
            // Async operation - cleanup might happen during this
            stream = await navigator.mediaDevices.getUserMedia({ video: true })
            
            // Check cleanup after async operation (race condition guard)
            if (isCleanedUp) {
                for (const track of stream.getTracks()) {
                    track.stop()
                }
                return
            }
            streamRef.current = stream
            video.srcObject = stream
            
            await video.play()
            
            // Check cleanup after async operation
            if (isCleanedUp) return
            
            // Create camera with cleanup guard in callbacks
            camera = new Camera(video, {
                onFrame: async () => {
                    if (!isCleanedUp && video?.readyState >= 2) {
                        await processFrame(video)
                    }
                }
            })
            
            // Check cleanup before storing ref
            if (isCleanedUp) {
                camera.stop()
                return
            }
            cameraRef.current = camera
            
            await camera.start()
            
            // Final cleanup check after async operation
            if (isCleanedUp) {
                camera.stop()
            }
        } catch (error) {
            console.error("Init failed:", error)
            // Clean partial resources on error
            if (camera) camera.stop()
            if (stream) {
                for (const track of stream.getTracks()) {
                    track.stop()
                }
            }
            if (video?.parentNode) {
                video.parentNode.removeChild(video)
            }
        }
    }
    
    initResources()
    
    return () => {
        // Set flag FIRST to prevent race conditions
        isCleanedUp = true
        
        // Clean both refs AND local variables
        if (cameraRef.current) {
            cameraRef.current.stop()
            cameraRef.current = null
        }
        if (camera) {
            camera.stop()
            camera = null
        }
        
        if (streamRef.current) {
            for (const track of streamRef.current.getTracks()) {
                track.stop()
            }
            streamRef.current = null
        }
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop()
            }
            stream = null
        }
        
        if (videoRef.current?.parentNode) {
            videoRef.current.parentNode.removeChild(videoRef.current)
            videoRef.current = null
        }
        if (video?.parentNode) {
            video.parentNode.removeChild(video)
            video = null
        }
    }
}, [])
```

**❌ AVOID - Race condition causes orphaned resources:**
```typescript
useEffect(() => {
    let camera: any = null
    
    const initResources = async () => {
        const video = document.createElement("video")
        document.body.appendChild(video)
        videoRef.current = video
        
        // ❌ No cleanup check - if cleanup runs here, stream never gets cleaned
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        streamRef.current = stream
        
        // ❌ No cleanup check - camera might be created after cleanup
        camera = new Camera(video, { onFrame: () => {} })
        await camera.start()
    }
    
    initResources()
    
    return () => {
        // ❌ Only cleans refs - misses local variables if init still running
        if (cameraRef.current) cameraRef.current.stop()
        if (streamRef.current) {
            for (const track of streamRef.current.getTracks()) {
                track.stop()
            }
        }
    }
}, [])
```

**Why This Matters:**
```
Timeline with protection:
T1: useEffect runs → initResources() starts
T2: Creates video element
T3: Calls getUserMedia() → waiting for user permission
T4: Component unmounts → cleanup() runs → sets isCleanedUp = true
T5: getUserMedia() completes → checks isCleanedUp → cleans stream immediately
T6: No memory leak ✅
```

### 🚨 CRITICAL: Race Condition Protection in Async Resource Management

**THIS IS EXTREMELY IMPORTANT - Always protect against race conditions in async initialization/cleanup.**

When dealing with async resource initialization outside of React (WebSocket connections, database connections, file operations, external API calls), cleanup may be called before resources are fully created. This causes **orphaned resources that never get cleaned up**.

**Race Condition Scenario:**
```
Timeline without protection:
T1: Socket connects → handleOfferInternal() starts
T2: Starts creating Paraformer client
T3: await paraformerClient.startTask() → waiting for API
T4: Socket disconnects → closeSession() called
T5: closeSession() only cleans session Map (client not stored yet!)
T6: startTask() completes → client created and stored
T7: Client never gets cleaned up → MEMORY LEAK + active connection!
```

**MANDATORY Race Condition Protections:**

1. **Track session lifecycle state** - Use flags or check session.isConnected
2. **Check state after every async operation** - `await startTask()`, `await pool.acquire()`, `await prisma.query()`
3. **Store resources immediately in cleanup-tracked structures** - Before async operations
4. **Guard callbacks with lifecycle checks** - Prevent execution after cleanup
5. **Clean partial resources on error** - Cleanup anything created before error

**✅ GOOD - Race-condition safe async session initialization:**
```typescript
async function handleOfferInternal(socket: Socket, userId: string, data: OfferData) {
    const sessionKey = `${userId}:${data.conversationId}`
    
    // Initialize cleanup tracking
    let cleanupParaformer: (() => Promise<void>) | null = null
    let cleanupTTS: (() => void) | null = null
    
    try {
        // Create session FIRST with connected flag
        const session: WebRTCSession = {
            userId,
            socket,
            isConnected: true, // Lifecycle flag
            paraformerClient: null, // Will be set after init
            ttsClient: null,
            cleanup: async () => {} // Will be replaced
        }
        
        // Store in Map immediately so cleanup can find it
        sessions.set(sessionKey, session)
        
        // Async operation - session might disconnect during this
        const paraformerClient = createPooledParaformerClient(config, events)
        await paraformerClient.startTask()
        
        // Check if session was cleaned up while waiting
        const currentSession = sessions.get(sessionKey)
        if (!currentSession || !currentSession.isConnected) {
            // Session disconnected - clean up what we just created
            await paraformerClient.close()
            return
        }
        
        // Safe to store - session still exists
        session.paraformerClient = paraformerClient
        cleanupParaformer = async () => await paraformerClient.close()
        
        // Another async operation
        const ttsClient = createPooledCartesiaTTSClient(ttsConfig)
        
        // Check again after async operation
        if (!sessions.get(sessionKey)?.isConnected) {
            await paraformerClient.close()
            return
        }
        
        session.ttsClient = ttsClient
        cleanupTTS = () => ttsClient.close()
        
        // Create combined cleanup function
        const cleanup = async () => {
            session.isConnected = false // Prevent further operations
            if (cleanupTTS) cleanupTTS()
            if (cleanupParaformer) await cleanupParaformer()
        }
        
        session.cleanup = cleanup
        
        socket.emit("session-ready")
        
    } catch (error) {
        console.error("Session creation failed:", error)
        
        // Clean up partial resources
        if (cleanupTTS) cleanupTTS()
        if (cleanupParaformer) await cleanupParaformer()
        
        // Remove from sessions
        sessions.delete(sessionKey)
        
        socket.emit("error", { error: "Failed to create session" })
    }
}

async function closeSession(socket: Socket, userId: string) {
    // Find and clean up all sessions for this socket
    for (const [key, session] of sessions) {
        if (session.userId === userId && session.socket === socket) {
            // Mark as disconnected FIRST
            session.isConnected = false
            
            // Wait for cleanup
            try {
                await session.cleanup()
            } catch (error) {
                console.error(`Error cleaning up session ${key}:`, error)
            }
            
            sessions.delete(key)
        }
    }
}
```

**❌ AVOID - Race condition causes orphaned resources:**
```typescript
async function handleOfferInternal(socket: Socket, userId: string, data: OfferData) {
    const sessionKey = `${userId}:${data.conversationId}`
    
    // ❌ Create resources without storing session first
    const paraformerClient = createPooledParaformerClient(config, events)
    
    // ❌ No lifecycle check - if closeSession runs here, client is orphaned
    await paraformerClient.startTask()
    
    const ttsClient = createPooledCartesiaTTSClient(ttsConfig)
    
    // ❌ Session stored after all resources created - too late!
    const session = {
        paraformerClient,
        ttsClient,
        cleanup: async () => {
            await paraformerClient.close()
            ttsClient.close()
        }
    }
    
    sessions.set(sessionKey, session)
}

async function closeSession(socket: Socket, userId: string) {
    const sessionKey = `${userId}:default`
    const session = sessions.get(sessionKey)
    
    // ❌ Only cleans if session exists in Map - misses in-progress init
    if (session) {
        await session.cleanup()
        sessions.delete(sessionKey)
    }
}
```

**Why This Matters:**
```
Without protection:
- Rapid connect/disconnect creates orphaned Paraformer clients
- WebSocket connections never close
- Connection pool exhausted
- Memory grows with each failed init
- Database connections leak

With protection:
- Session stored immediately, cleanup can always find it
- isConnected flag prevents stale operations
- Partial resources cleaned on disconnect
- No orphaned connections ✅
```

**Common Async Race Conditions:**

1. **WebSocket Connection Init:**
   - Connection initiates → starts acquiring resources → connection terminates
   - Solution: Store session immediately, check isConnected after acquire

2. **Database Transaction:**
   - Start transaction → await query → user disconnects → transaction orphaned
   - Solution: Use AbortController, check connection before commit

3. **External API Calls:**
   - Start API request → await response → connection lost → response handlers leak
   - Solution: Guard handlers with session.isConnected check

4. **File Upload:**
   - Start upload → await write → connection drops → file handle orphaned
   - Solution: Cleanup temp files on disconnect, check connection before finalize

**Protection Pattern Template:**
```typescript
async function handleRequest(socket: Socket, data: RequestData) {
    // 1. Create tracking structure immediately
    const resource = { isActive: true, connections: [] }
    resourceMap.set(socket.id, resource)
    
    try {
        // 2. Async operation
        const connection = await acquireConnection()
        
        // 3. Check if still active
        if (!resource.isActive) {
            await connection.close()
            return
        }
        
        // 4. Store in tracked structure
        resource.connections.push(connection)
        
        // Continue with more async operations...
        
    } catch (error) {
        // 5. Clean partial resources
        for (const conn of resource.connections) {
            await conn.close()
        }
        resourceMap.delete(socket.id)
    }
}

function handleDisconnect(socket: Socket) {
    const resource = resourceMap.get(socket.id)
    if (resource) {
        resource.isActive = false
        // Cleanup tracked connections
        for (const conn of resource.connections) {
            conn.close()
        }
        resourceMap.delete(socket.id)
    }
}
```

**Common Memory Leak Sources:**
1. **Event listeners not removed** - Always use `.off()` or `.removeEventListener()`
2. **Maps/Sets not cleared** - Clean up on disconnect/shutdown
3. **Timers not cleared** - Use `clearTimeout()` / `clearInterval()`
4. **Duplicate cleanups** - Check before overwriting cleanup functions
5. **AbortControllers not triggered** - Cancel pending async operations
6. **Connection pools not released** - Return connections to pool after use
7. **Callback references not cleared** - Set callbacks to `undefined` after use or on error
8. **Pending promises not cleared** - Clear Sets/Arrays holding promise references after settling

**CRITICAL Cleanup Patterns:**

**✅ GOOD - Clear callback references on error:**
```typescript
try {
    websocket = await pool.acquire(userId)
    config.onReady?.()
} catch (error) {
    // Clear callbacks to prevent memory leak on fatal error
    config.onData = undefined
    config.onError?.(error as Error)
    config.onError = undefined
    config.onReady = undefined
    throw error
}
```

**✅ GOOD - Clear pending promise collections:**
```typescript
async function cancel() {
    if (pendingStreams.size > 0) {
        await Promise.allSettled(Array.from(pendingStreams))
        pendingStreams.clear() // Must clear to prevent memory leak
    }
}
```

**❌ AVOID - Callbacks not cleared on error:**
```typescript
try {
    await connect()
} catch (error) {
    config.onError?.(error)
    throw error // Callbacks still referenced - LEAK!
}
```

**✅ Good - Prevents memory leaks:**
```typescript
io.on("connection", (socket) => {
    // Clean up existing connection before creating new one
    const existingCleanup = connectionCleanups.get(userId)
    if (existingCleanup) {
        existingCleanup() // Prevent leak
        connectionCleanups.delete(userId)
    }
    
    const handlers = {
        message: (data) => process(data),
        disconnect: () => {
            // Remove other handlers
            socket.off("message", handlers.message)
        }
    }
    
    socket.on("message", handlers.message)
    socket.on("disconnect", handlers.disconnect)
    
    // Store cleanup
    const cleanup = () => {
        socket.off("message", handlers.message)
        socket.off("disconnect", handlers.disconnect)
    }
    connectionCleanups.set(userId, cleanup)
})
```

**❌ Avoid - Creates memory leaks:**
```typescript
io.on("connection", (socket) => {
    // Overwrites old cleanup without calling it - LEAK!
    socket.on("message", handleMessage) // Never removed - LEAK!
    socket.on("disconnect", () => {
        // Cleanup code here
    }) // Handler itself never removed - LEAK!
})
```

## Loop and Iteration Guidelines

### Prefer `for...of` Over `forEach`

**Always use `for...of` loops instead of `.forEach()` for better control flow and performance.**

**✅ Good - Using for...of:**
```typescript
for (const [id, conn] of connections) {
    if (!conn.isAlive) {
        conn.close()
    }
}

for (const item of items) {
    await processItem(item)  // Can use await
}

// Early exit with break
for (const user of users) {
    if (user.id === targetId) {
        return user  // Can return early
    }
}
```

**❌ Avoid - Using forEach:**
```typescript
connections.forEach(([id, conn]) => {
    if (!conn.isAlive) {
        conn.close()
    }
})

items.forEach(item => {
    await processItem(item)  // await doesn't work as expected!
})

// Cannot break or return early
users.forEach(user => {
    if (user.id === targetId) {
        return user  // WRONG: only returns from callback, not outer function
    }
})
```

**Benefits of for...of:**
- Can use `await` inside the loop (forEach ignores async)
- Can use `break` and `continue` for control flow
- Can use `return` to exit the function early
- Slightly better performance (no function call overhead)
- Clearer intent for imperative operations

**When forEach is acceptable:**
- Pure functional transformations where you need the side effect and don't need control flow
- Very short, simple callbacks (e.g., `items.forEach(item => console.log(item))`)

## Import and Export Guidelines

### Static Imports Only (Unless Circular Dependencies)

**Always use static imports at the top of the file. Do NOT use dynamic imports unless dealing with circular dependencies.**

**✅ Good - Static import:**
```typescript
import { handlePostResponseTransition } from "./onboarding-tools"

// Use it
handlePostResponseTransition(sessionKey, onboardingActor)
```

**❌ Avoid - Dynamic import (unnecessary):**
```typescript
// Inside a function
const { handlePostResponseTransition } = await import('./onboarding-tools')
handlePostResponseTransition(sessionKey, onboardingActor)
```

**Exception:** Only use dynamic imports when dealing with circular dependencies that cannot be resolved through refactoring.

### Export Only When Used Elsewhere

**Do NOT export variables, functions, or constants unless they are imported and used in another file.**

**✅ Good - Internal helper (not exported):**
```typescript
function calculateScore(data) {
    // Only used in this file
    return data.points * 2
}

export function processData(data) {
    const score = calculateScore(data)  // Used here only
    return { score }
}
```

**❌ Avoid - Unnecessary export:**
```typescript
export function calculateScore(data) {
    // Not used anywhere else - shouldn't be exported
    return data.points * 2
}

export function processData(data) {
    const score = calculateScore(data)
    return { score }
}
```

**Benefits:**
- Clearer API surface - only exposes what's meant to be public
- Better tree-shaking
- Easier to refactor internal implementation
- Prevents accidental dependencies

## Summary

1. **Functional over classes** - Use functions with closures
2. **Inline over named** - Keep callbacks inline unless there's a good reason
3. **Return cleanup functions** - Every resource allocation gets a cleanup
4. **⚠️ HOIST HELPER FUNCTIONS** - Move reusable helpers outside factory functions to save memory
5. **for...of over forEach** - Use for...of for better control flow and async support
6. **Static imports** - Use static imports; dynamic only for circular dependencies
7. **Export intentionally** - Only export what's used in other files
8. **🚨 RACE CONDITION PROTECTION** - Use lifecycle flags and check after every async operation

## ⚠️ CRITICAL REQUIREMENT

**Before completing ANY task, ALWAYS verify:**
- ✅ Code is logically correct with no race conditions
- ✅ All resources are properly cleaned up
- ✅ No memory leaks (event listeners removed, Maps cleared, timers cancelled)
- ✅ Cleanup functions are called when connections close
- ✅ No double cleanup execution
- ✅ **Helper functions hoisted to parent scope** - Factory functions don't recreate helpers
- ✅ **🚨 Race condition protection implemented** - Sessions stored immediately, lifecycle state checked after async operations
- ✅ **Partial resources cleaned on disconnect** - Resources created before disconnect are properly freed

**Memory leaks, improper cleanup, and race conditions are NOT acceptable. This must be verified for every change.**

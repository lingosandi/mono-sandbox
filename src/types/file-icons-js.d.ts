declare module "file-icons-js" {
    export function getClass(filename: string): string | null
    export function getClassWithColor(filename: string): string | null

    export const db: {
        matchName(name: string, isDirectory?: boolean): unknown
        matchPath(path: string, isDirectory?: boolean): unknown
    }
}

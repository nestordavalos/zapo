export type Task<T> = () => Promise<T>

export interface QueueItem<T> {
    readonly task: Task<T>
    readonly resolve: (value: unknown) => void
    readonly reject: (error: unknown) => void
}
